/**
 * One-shot Neon -> D1 data migration.
 *
 * Reads the offline dump produced from Neon (scripts/migration-data/neon-dump.json,
 * gitignored because it contains live session tokens and OAuth credentials),
 * converts every Postgres value to its SQLite representation, and emits a .sql
 * file to load with:
 *
 *   wrangler d1 execute tome-db --local  --file scripts/migration-data/d1-seed.sql
 *   wrangler d1 execute tome-db --remote --file scripts/migration-data/d1-seed.sql
 *
 * Why generate SQL rather than insert directly? Because it is inspectable
 * before it touches anything, and re-runnable. A migration you can read is
 * worth more than one that is slightly shorter.
 *
 * The conversions, which are the whole job:
 *
 *   timestamptz  -> epoch SECONDS (integer). Not milliseconds — the schema
 *                   uses `mode: "timestamp"`, and getting this wrong puts
 *                   every row in either 1970 or the year 56000.
 *   boolean      -> 0 / 1
 *   text[]       -> JSON array string. books.authors additionally derives
 *                   the denormalized `authors_text` search column.
 *   uuid[]       -> JSON array string (pack_rips.pulled_book_ids)
 *   jsonb        -> JSON text
 *   uuid         -> text, unchanged (the ids carry over verbatim, which is
 *                   what keeps every FK and every existing session valid)
 *
 * Table order matters: parents before children, so foreign keys resolve as
 * the file is replayed top to bottom.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { toAuthorsText } from "../src/db/authors";

const DUMP = "scripts/migration-data/neon-dump.json";
const OUT = "scripts/migration-data/d1-seed.sql";

interface Dump {
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
  columns: Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
  }>;
}

/**
 * Insert order — parents first so FKs resolve on replay. `verifications` has
 * no FKs; `follows` and the ledger tables come last because they point at
 * users, books, packs and rips.
 */
const TABLE_ORDER = [
  "users",
  "sessions",
  "accounts",
  "verifications",
  "books",
  "packs",
  "pack_books",
  "collection_cards",
  "reading_entries",
  "pack_rips",
  "shard_events",
  "shard_balances",
  "economy_config",
  "follows",
] as const;

/** Columns that were `timestamptz` on Postgres and are epoch seconds here. */
const TIMESTAMP_COLUMNS = new Set<string>();
/** Columns that were `boolean`. */
const BOOLEAN_COLUMNS = new Set<string>();
/** Columns that were an array type (udt_name starts with `_`). */
const ARRAY_COLUMNS = new Set<string>();
/** Columns that were `jsonb`/`json`. */
const JSON_COLUMNS = new Set<string>();
/**
 * Columns that were a numeric Postgres type. postgres-js returns `bigint` and
 * `numeric` as JS *strings* to avoid precision loss (books.hardcover_id is the
 * one that matters here), and quoting those into an INTEGER column would lean
 * on SQLite's type affinity to silently coerce them back. Affinity would in
 * fact do the right thing, but "the database will probably fix it" is not a
 * migration strategy — emit them as bare numbers instead.
 */
const NUMERIC_COLUMNS = new Set<string>();

function key(table: string, column: string): string {
  return `${table}.${column}`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Refusing to emit non-finite number: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  // Everything else lands as a quoted string with '' escaping.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function toEpochSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms =
    value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Could not parse timestamp: ${String(value)}`);
  }
  return Math.floor(ms / 1000);
}

function convert(table: string, column: string, value: unknown): unknown {
  const k = key(table, column);

  if (TIMESTAMP_COLUMNS.has(k)) return toEpochSeconds(value);

  if (BOOLEAN_COLUMNS.has(k)) {
    if (value === null || value === undefined) return null;
    return value ? 1 : 0;
  }

  if (ARRAY_COLUMNS.has(k)) {
    // pg returns arrays as JS arrays through postgres-js; JSON.stringify is
    // the whole conversion. `?? []` covers a NULL array on a NOT NULL column
    // with an ARRAY[] default.
    return JSON.stringify(value ?? []);
  }

  if (JSON_COLUMNS.has(k)) {
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  if (NUMERIC_COLUMNS.has(k)) {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(`Column ${k} is not numeric: ${String(value)}`);
    }
    return n;
  }

  return value;
}

/**
 * Emit one `migration_adjustment` ledger row per user whose cached balance
 * disagrees with `SUM(shard_events.delta)`.
 *
 * The Neon data drifted: the only user's `shard_balances.shards` read 52
 * while their ledger summed to -110. The ledger had no `welcome_grant` row at
 * all, and a past collection reset deleted `pack_rips` audit rows while
 * leaving the matching `rip` debits behind.
 *
 * That drift was harmless under the old code, which incremented the cache
 * (`shards + N`) and never consulted the ledger. It is not harmless now:
 * `grantShards` rebuilds the cache from `SUM(delta)`, so the very next grant
 * would have snapped the balance from 52 to about -110 — a user visibly
 * losing their currency to a refactor.
 *
 * The fix is to make the ledger tell the truth rather than to trust it
 * blindly or to paper over it in the cache. One explicit, labelled event for
 * the difference: the balance the user sees is preserved, the ledger
 * reconstructs it exactly, and the discrepancy stays legible in the history
 * instead of being quietly absorbed.
 */
function reconcileShardBalances(dump: Dump): Array<string> {
  const out: Array<string> = [
    `-- Ledger reconciliation (see scripts/migrate-neon-to-d1.ts).`,
  ];

  const events = dump.tables.shard_events ?? [];
  const balances = dump.tables.shard_balances ?? [];

  const ledgerByUser = new Map<string, number>();
  for (const e of events) {
    const uid = String(e.user_id);
    ledgerByUser.set(uid, (ledgerByUser.get(uid) ?? 0) + Number(e.delta));
  }

  let emitted = 0;
  const at = toEpochSeconds(dump.exportedAt);

  for (const b of balances) {
    const uid = String(b.user_id);
    const cached = Number(b.shards);
    const ledger = ledgerByUser.get(uid) ?? 0;
    const delta = cached - ledger;
    if (delta === 0) {
      out.push(`-- user ${uid}: ledger already agrees (${cached})`);
      continue;
    }
    out.push(
      `-- user ${uid}: cached ${cached}, ledger ${ledger} -> adjusting by ${delta}`,
    );
    out.push(
      `INSERT INTO "shard_events" ("id", "user_id", "delta", "reason", ` +
        `"ref_book_id", "ref_pack_id", "ref_rip_id", "created_at") VALUES (` +
        `${sqlLiteral(crypto.randomUUID())}, ${sqlLiteral(uid)}, ${delta}, ` +
        `'migration_adjustment', NULL, NULL, NULL, ${at});`,
    );
    emitted++;
    console.log(
      `[migrate] reconcile user ${uid}: cached=${cached} ledger=${ledger} adjustment=${delta > 0 ? "+" : ""}${delta}`,
    );
  }

  if (emitted === 0) {
    console.log("[migrate] no shard-balance drift to reconcile");
  }
  out.push(``);
  return out;
}

function main(): void {
  const dump = JSON.parse(readFileSync(DUMP, "utf8")) as Dump;

  // Build the conversion sets from the exported information_schema rather
  // than a hand-written list, so a column added to Neon after this script was
  // written can't be silently mis-typed.
  for (const c of dump.columns) {
    const k = key(c.table_name, c.column_name);
    if (c.data_type === "timestamp with time zone") TIMESTAMP_COLUMNS.add(k);
    else if (c.data_type === "boolean") BOOLEAN_COLUMNS.add(k);
    else if (c.data_type === "ARRAY" || c.udt_name.startsWith("_"))
      ARRAY_COLUMNS.add(k);
    else if (c.data_type === "jsonb" || c.data_type === "json")
      JSON_COLUMNS.add(k);
    else if (
      [
        "bigint",
        "integer",
        "smallint",
        "numeric",
        "real",
        "double precision",
      ].includes(c.data_type)
    )
      NUMERIC_COLUMNS.add(k);
  }

  // Every table in the dump must be in TABLE_ORDER, or we would silently skip
  // it. Fail loudly instead.
  const dumped = Object.keys(dump.tables);
  const missing = dumped.filter(
    (t) => !(TABLE_ORDER as ReadonlyArray<string>).includes(t),
  );
  if (missing.length > 0) {
    throw new Error(
      `Dump contains tables absent from TABLE_ORDER: ${missing.join(", ")}. ` +
        `Add them (in FK-safe position) rather than letting them be skipped.`,
    );
  }

  const lines: Array<string> = [
    `-- Generated by scripts/migrate-neon-to-d1.ts`,
    `-- Source dump exported ${dump.exportedAt}`,
    `-- Timestamps are epoch SECONDS; booleans are 0/1; arrays and jsonb are JSON text.`,
    ``,
  ];

  const counts: Array<[string, number]> = [];

  for (const table of TABLE_ORDER) {
    const rows = dump.tables[table] ?? [];
    counts.push([table, rows.length]);
    if (rows.length === 0) {
      lines.push(`-- ${table}: 0 rows`);
      continue;
    }

    lines.push(`-- ${table}: ${rows.length} rows`);

    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map((c) => convert(table, c, row[c]));

      // books gains `authors_text`, which has no Postgres counterpart: it is
      // derived here exactly as src/db/authors.ts derives it at runtime, so
      // migrated rows are searchable on day one rather than only after their
      // next write.
      if (table === "books") {
        const authors = (row.authors ?? []) as Array<string>;
        columns.push("authors_text");
        values.push(toAuthorsText(authors));
      }

      const cols = columns.map((c) => `"${c}"`).join(", ");
      const vals = values.map(sqlLiteral).join(", ");
      lines.push(`INSERT INTO "${table}" (${cols}) VALUES (${vals});`);
    }
    lines.push(``);
  }

  lines.push(...reconcileShardBalances(dump));

  writeFileSync(OUT, lines.join("\n"));

  const total = counts.reduce((n, [, c]) => n + c, 0);
  console.log(`[migrate] wrote ${OUT}`);
  for (const [table, n] of counts) {
    console.log(`[migrate]   ${table.padEnd(18)} ${String(n).padStart(4)}`);
  }
  console.log(`[migrate]   ${"TOTAL".padEnd(18)} ${String(total).padStart(4)}`);
}

main();
