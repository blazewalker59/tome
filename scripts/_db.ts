/**
 * Drizzle client for Node-side scripts (seeds, backfills, one-off admin jobs).
 *
 * Scripts cannot use `src/db/client.ts`. That module reads the D1 *binding*
 * off the Cloudflare env, and a binding is a live object handed to a Worker's
 * fetch invocation — it does not exist in a `tsx` process. Under Neon this
 * distinction didn't arise: a connection string works from anywhere, which is
 * why every script used to just import the app's client.
 *
 * The way in from outside the Worker is D1's HTTP API. `drizzle-orm/sqlite-proxy`
 * exists for exactly this: you hand it a function that ships SQL somewhere and
 * returns rows, and it gives you the ordinary Drizzle query builder on top. So
 * scripts get the same `db.select().from(books)` API as the app, against the
 * same schema, over HTTP instead of a binding.
 *
 * Required env (in `.env.local`):
 *   CLOUDFLARE_ACCOUNT_ID   — the account that owns the database
 *   CLOUDFLARE_DATABASE_ID  — tome-db's uuid (see wrangler.jsonc)
 *   CLOUDFLARE_D1_TOKEN     — an API token with D1 edit permission
 *
 * NOTE: this talks to the REMOTE database. There is no local-miniflare path
 * here; for local work use `wrangler d1 execute tome-db --local`.
 */

import { config as loadEnv } from "dotenv";

import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "../src/db/schema";

// Load `.env.local` first (gitignored), then `.env`. First-set wins.
loadEnv({ path: ".env.local" });
loadEnv();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[tome/scripts] Missing ${name}. Scripts reach D1 over the HTTP API and ` +
        `need CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID and ` +
        `CLOUDFLARE_D1_TOKEN in .env.local — see .env.example.`,
    );
  }
  return value;
}

interface D1ApiResult {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: Array<{ results?: Array<unknown>; success?: boolean }>;
}

/**
 * Execute one statement against D1's HTTP API and return rows as arrays of
 * column values, which is the shape sqlite-proxy expects.
 */
async function d1Query(
  sql: string,
  params: Array<unknown>,
  method: "run" | "all" | "values" | "get",
): Promise<{ rows: Array<Array<unknown>> }> {
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const databaseId = requireEnv("CLOUDFLARE_DATABASE_ID");
  const token = requireEnv("CLOUDFLARE_D1_TOKEN");

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/raw`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );

  const body = (await res.json()) as D1ApiResult;
  if (!res.ok || !body.success) {
    const detail =
      body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ??
      `HTTP ${res.status}`;
    throw new Error(`[tome/scripts] D1 query failed — ${detail}\nSQL: ${sql}`);
  }

  // The `/raw` endpoint returns { results: { columns, rows } } per statement,
  // where `rows` is already an array of column-value arrays.
  const first = body.result?.[0] as
    | { results?: { columns?: Array<string>; rows?: Array<Array<unknown>> } }
    | undefined;
  const rows = first?.results?.rows ?? [];

  // `get` wants a single row rather than a list.
  return { rows: method === "get" ? rows.slice(0, 1) : rows };
}

export const db = drizzle(d1Query, { schema });
export { schema };
