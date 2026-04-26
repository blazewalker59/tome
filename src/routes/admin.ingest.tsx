import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CoverImage } from "@/components/CoverImage";
import { demoteReasonLabel } from "@/lib/hardcover/rank";
import {
  checkAdminFn,
  ingestBookFn,
  searchHardcoverFn,
  type IngestBookResult,
} from "@/server/ingest";
import type { HardcoverSearchHit, HardcoverSearchResult } from "@/server/hardcover";

/**
 * Admin-only Hardcover ingestion route.
 *
 * Two panes:
 *   1. **Search** — debounced (400ms, min 3 chars) queries to Hardcover's
 *      Typesense index. Results show cover, title, author, year, rating,
 *      and an "Add to queue" button. Books already in our catalog are
 *      tagged and un-queueable.
 *   2. **Staging queue + bulk ingest** — once queued, each entry gets
 *      per-row genre / mood / pack inputs. "Ingest all" runs them
 *      sequentially (Hardcover's rate limit is ~54 req/min shared
 *      across all calls, so parallel isn't safe anyway). Failures are
 *      reported per row and leave the entry in the queue for retry.
 *
 * Rarity is NOT recomputed here — ingest writes `common` on insert and
 * leaves existing values alone on update. Run `pnpm db:rebucket` after
 * a batch to redistribute globally.
 */
export const Route = createFileRoute("/admin/ingest")({
  loader: async () => {
    const status = await checkAdminFn();
    if (!status.signedIn) {
      throw redirect({ to: "/sign-in" });
    }
    return { status };
  },
  component: AdminIngestPage,
});

// ─────────────────────────────────────────────────────────────────────────────
// Page shell + auth gating
// ─────────────────────────────────────────────────────────────────────────────

function AdminIngestPage() {
  const { status } = Route.useLoaderData();

  if (!status.isAdmin) {
    return (
      <main className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-10 sm:py-16">
        <div className="island-shell w-full max-w-md rounded-3xl p-8 text-center">
          <p className="island-kicker">403 · not your shelf</p>
          <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)]">
            Admin access required
          </h1>
          <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
            Your account{status.email ? ` (${status.email})` : ""} isn&rsquo;t on the admin
            allowlist. If that&rsquo;s a mistake, ping the operator to add you to
            <code className="mx-1 rounded bg-[var(--surface-muted)] px-1 py-0.5 text-xs">
              ADMIN_EMAILS
            </code>
            .
          </p>
          <p className="mt-8 text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
            <Link to="/" className="hover:text-[var(--sea-ink)]">
              ← Back to home
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return <IngestWorkspace />;
}

// ─────────────────────────────────────────────────────────────────────────────
// State types
// ─────────────────────────────────────────────────────────────────────────────

/** An entry in the staging list with its editable curation fields. */
interface QueueEntry {
  /** Stable per-session key; we use the hardcover id. */
  hardcoverId: number;
  hit: HardcoverSearchHit;
  genre: string;
  moodTagsRaw: string;
  packSlug: string;
  /** Per-row status during / after a bulk submit. */
  state:
    | { kind: "idle" }
    | { kind: "pending" }
    | { kind: "done"; result: IngestBookResult }
    | { kind: "error"; message: string };
}

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ready";
      query: string;
      result: HardcoverSearchResult & { existingByHardcoverId: Record<number, string> };
    }
  | { kind: "error"; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// Main workspace
// ─────────────────────────────────────────────────────────────────────────────

function IngestWorkspace() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState<SearchState>({ kind: "idle" });
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);

  // Shared defaults the operator can pre-fill once and propagate to
  // newly-added queue entries. Saves retyping genre for themed batches.
  const [defaultGenre, setDefaultGenre] = useState("");
  const [defaultPackSlug, setDefaultPackSlug] = useState("");

  // Debounced search: 400ms after the last keystroke, and only when the
  // trimmed query is >= 3 chars. Aborts in-flight stale requests so we
  // don't flash an earlier result after typing more.
  const reqSeqRef = useRef(0);
  useEffect(() => {
    const q = searchInput.trim();
    if (q.length < 3) {
      setSearch({ kind: "idle" });
      return;
    }
    const mySeq = ++reqSeqRef.current;
    const timer = setTimeout(() => {
      setSearch((prev) => (prev.kind === "ready" && prev.query === q ? prev : { kind: "loading" }));
      searchHardcoverFn({ data: { query: q, perPage: 20 } })
        .then((result) => {
          if (mySeq !== reqSeqRef.current) return; // stale
          setSearch({ kind: "ready", query: q, result });
        })
        .catch((err: unknown) => {
          if (mySeq !== reqSeqRef.current) return;
          setSearch({
            kind: "error",
            message: err instanceof Error ? err.message : "Search failed",
          });
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const addToQueue = useCallback(
    (hit: HardcoverSearchHit) => {
      setQueue((q) => {
        if (q.some((e) => e.hardcoverId === hit.id)) return q;
        return [
          ...q,
          {
            hardcoverId: hit.id,
            hit,
            genre: defaultGenre,
            moodTagsRaw: "",
            packSlug: defaultPackSlug,
            state: { kind: "idle" },
          },
        ];
      });
    },
    [defaultGenre, defaultPackSlug],
  );

  const removeFromQueue = useCallback((hardcoverId: number) => {
    setQueue((q) => q.filter((e) => e.hardcoverId !== hardcoverId));
  }, []);

  const updateEntry = useCallback(
    (hardcoverId: number, patch: Partial<Omit<QueueEntry, "hardcoverId" | "hit">>) => {
      setQueue((q) => q.map((e) => (e.hardcoverId === hardcoverId ? { ...e, ...patch } : e)));
    },
    [],
  );

  /**
   * Bulk-ingest runs entries sequentially. The rate limiter in the
   * Hardcover client enforces the ~1.1s spacing server-side, so firing
   * in parallel wouldn't actually speed anything up — it would just
   * pile promises into the server's queue. Sequential also lets us
   * update UI state per-row as we go, which is the feedback the
   * operator cares about.
   */
  const runBulk = useCallback(async () => {
    if (bulkRunning) return;
    const pending = queue.filter(
      (e) => e.state.kind === "idle" || e.state.kind === "error",
    );
    if (pending.length === 0) return;
    setBulkRunning(true);
    for (const entry of pending) {
      // Client-side pre-flight: genre is the only non-optional field
      // beyond the hardcover id. Skip (mark error) rather than hit the
      // network just to get the same rejection back.
      if (entry.genre.trim().length === 0) {
        setQueue((q) =>
          q.map((e) =>
            e.hardcoverId === entry.hardcoverId
              ? { ...e, state: { kind: "error", message: "Genre is required" } }
              : e,
          ),
        );
        continue;
      }

      setQueue((q) =>
        q.map((e) =>
          e.hardcoverId === entry.hardcoverId ? { ...e, state: { kind: "pending" } } : e,
        ),
      );
      try {
        const moodTags = entry.moodTagsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const result = await ingestBookFn({
          data: {
            hardcoverId: entry.hardcoverId,
            genre: entry.genre.trim(),
            moodTags,
            packSlug: entry.packSlug.trim() || undefined,
          },
        });
        setQueue((q) =>
          q.map((e) =>
            e.hardcoverId === entry.hardcoverId ? { ...e, state: { kind: "done", result } } : e,
          ),
        );
      } catch (err) {
        setQueue((q) =>
          q.map((e) =>
            e.hardcoverId === entry.hardcoverId
              ? {
                  ...e,
                  state: {
                    kind: "error",
                    message: err instanceof Error ? err.message : "Ingest failed",
                  },
                }
              : e,
          ),
        );
      }
    }
    setBulkRunning(false);
  }, [bulkRunning, queue]);

  const clearDone = useCallback(() => {
    setQueue((q) => q.filter((e) => e.state.kind !== "done"));
  }, []);

  const pendingCount = queue.filter(
    (e) => e.state.kind === "idle" || e.state.kind === "error",
  ).length;
  const doneCount = queue.filter((e) => e.state.kind === "done").length;

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8">
        <p className="island-kicker">Admin · catalog</p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          Ingest from Hardcover
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          Search Hardcover, queue books, then bulk-ingest. Re-ingesting a book updates editorial
          fields (genre, moods) and refreshes metadata; rarity is untouched. Run{" "}
          <code className="rounded bg-[var(--surface-muted)] px-1 py-0.5 text-xs">
            pnpm db:rebucket
          </code>{" "}
          after a batch to redistribute rarities.
        </p>
      </header>

      {/* Shared defaults — applied to entries added to the queue AFTER
          the defaults were set. Existing entries aren't retroactively
          rewritten because the operator may have hand-tuned them. */}
      <section className="island-shell mb-6 grid gap-4 rounded-3xl p-5 sm:grid-cols-2">
        <Field label="Default genre" hint="Auto-filled on new queue entries.">
          <input
            type="text"
            value={defaultGenre}
            onChange={(e) => setDefaultGenre(e.target.value)}
            pattern="[a-z0-9][a-z0-9-]*"
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
            placeholder="literary-fiction"
          />
        </Field>
        <Field label="Default pack slug" hint="Optional. Applied to new queue entries.">
          <input
            type="text"
            value={defaultPackSlug}
            onChange={(e) => setDefaultPackSlug(e.target.value)}
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
            placeholder="editorial-launch"
          />
        </Field>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SearchPane
          value={searchInput}
          onChange={setSearchInput}
          state={search}
          queuedIds={new Set(queue.map((e) => e.hardcoverId))}
          onAdd={addToQueue}
        />

        <QueuePane
          queue={queue}
          bulkRunning={bulkRunning}
          pendingCount={pendingCount}
          doneCount={doneCount}
          onUpdate={updateEntry}
          onRemove={removeFromQueue}
          onRunBulk={runBulk}
          onClearDone={clearDone}
        />
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Search pane
// ─────────────────────────────────────────────────────────────────────────────

function SearchPane({
  value,
  onChange,
  state,
  queuedIds,
  onAdd,
}: {
  value: string;
  onChange: (v: string) => void;
  state: SearchState;
  queuedIds: ReadonlySet<number>;
  onAdd: (hit: HardcoverSearchHit) => void;
}) {
  return (
    <section>
      <h2 className="island-kicker mb-3">Search Hardcover</h2>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Title, author, or ISBN"
        className="input-field min-h-[44px] w-full rounded-full px-4 text-sm"
        aria-label="Search Hardcover"
      />
      <p className="mt-2 text-[11px] text-[var(--sea-ink-soft)]">
        3+ characters; debounced 400ms. Each search consumes a Hardcover rate-limit slot.
      </p>

      <div className="mt-4">
        {state.kind === "idle" && (
          <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
            Start typing to search.
          </p>
        )}
        {state.kind === "loading" && (
          <p className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
            Searching…
          </p>
        )}
        {state.kind === "error" && (
          <p
            role="alert"
            className="rounded-xl border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-2 text-xs text-[color:var(--rarity-legendary)]"
          >
            {state.message}
          </p>
        )}
        {state.kind === "ready" && state.result.hits.length === 0 && (
          <p className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
            No results.
          </p>
        )}
        {state.kind === "ready" && state.result.hits.length > 0 && (
          <ul className="space-y-2">
            {state.result.hits.map((hit) => {
              const existingId = state.result.existingByHardcoverId[hit.id];
              const alreadyIngested = Boolean(existingId);
              const inQueue = queuedIds.has(hit.id);
              return (
                <li
                  key={hit.id}
                  className="flex gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3"
                >
                  <CoverImage
                    src={hit.coverUrl}
                    alt=""
                    className="h-20 w-14 shrink-0 rounded-md object-cover"
                    fallback={
                      <div className="h-20 w-14 shrink-0 rounded-md bg-[var(--surface-muted)]" />
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                      {hit.title}
                      {hit.releaseYear && (
                        <span className="ml-1 text-xs font-normal text-[var(--sea-ink-soft)]">
                          ({hit.releaseYear})
                        </span>
                      )}
                      {hit.demoted && hit.demoteReason && (
                        // Admin sees the same badges as users — keeps
                        // the operator's mental model aligned with what
                        // the public UI surfaces, and warns them off
                        // ingesting summaries by accident.
                        <span className="ml-2 inline-block rounded-sm bg-[var(--surface-muted)] px-1.5 py-0.5 align-middle text-[9px] font-medium uppercase tracking-[0.06em] text-[var(--sea-ink-soft)]">
                          {demoteReasonLabel(hit.demoteReason)}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">
                      {hit.authorNames.join(", ") || "Unknown author"}
                    </p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                      {hit.rating != null ? `★ ${hit.rating.toFixed(2)}` : "—"}
                      {hit.ratingsCount != null && ` · ${hit.ratingsCount.toLocaleString()} ratings`}
                      {" · hc#"}
                      {hit.id}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    {alreadyIngested ? (
                      <span className="rounded-full border border-[color:var(--rarity-rare)]/40 bg-[color:var(--rarity-rare-soft)] px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--rarity-rare)]">
                        In catalog
                      </span>
                    ) : inQueue ? (
                      <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                        Queued
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onAdd(hit)}
                        className="btn-secondary rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.14em]"
                      >
                        + Queue
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue pane
// ─────────────────────────────────────────────────────────────────────────────

function QueuePane({
  queue,
  bulkRunning,
  pendingCount,
  doneCount,
  onUpdate,
  onRemove,
  onRunBulk,
  onClearDone,
}: {
  queue: QueueEntry[];
  bulkRunning: boolean;
  pendingCount: number;
  doneCount: number;
  onUpdate: (
    id: number,
    patch: Partial<Omit<QueueEntry, "hardcoverId" | "hit">>,
  ) => void;
  onRemove: (id: number) => void;
  onRunBulk: () => void;
  onClearDone: () => void;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="island-kicker">Queue · {queue.length}</h2>
        <div className="flex items-center gap-2">
          {doneCount > 0 && (
            <button
              type="button"
              onClick={onClearDone}
              className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
            >
              Clear {doneCount} done
            </button>
          )}
          <button
            type="button"
            onClick={onRunBulk}
            disabled={bulkRunning || pendingCount === 0}
            className="btn-primary rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {bulkRunning ? "Ingesting…" : `Ingest ${pendingCount || "all"}`}
          </button>
        </div>
      </div>

      {queue.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
          Add books from search to build a batch.
        </p>
      ) : (
        <ul className="space-y-3">
          {queue.map((entry) => (
            <QueueRow
              key={entry.hardcoverId}
              entry={entry}
              bulkRunning={bulkRunning}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function QueueRow({
  entry,
  bulkRunning,
  onUpdate,
  onRemove,
}: {
  entry: QueueEntry;
  bulkRunning: boolean;
  onUpdate: (
    id: number,
    patch: Partial<Omit<QueueEntry, "hardcoverId" | "hit">>,
  ) => void;
  onRemove: (id: number) => void;
}) {
  const disabled = bulkRunning || entry.state.kind === "pending" || entry.state.kind === "done";

  return (
    <li className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
      <div className="flex items-start gap-3">
        <CoverImage
          src={entry.hit.coverUrl}
          alt=""
          className="h-16 w-11 shrink-0 rounded-md object-cover"
          fallback={
            <div className="h-16 w-11 shrink-0 rounded-md bg-[var(--surface-muted)]" />
          }
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
            {entry.hit.title}
          </p>
          <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">
            {entry.hit.authorNames.join(", ") || "Unknown author"} · hc#{entry.hardcoverId}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge state={entry.state} />
          <button
            type="button"
            onClick={() => onRemove(entry.hardcoverId)}
            disabled={bulkRunning && entry.state.kind === "pending"}
            className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Remove ${entry.hit.title} from queue`}
          >
            Remove
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Genre" compact>
          <input
            type="text"
            value={entry.genre}
            onChange={(e) => onUpdate(entry.hardcoverId, { genre: e.target.value })}
            disabled={disabled}
            pattern="[a-z0-9][a-z0-9-]*"
            className="input-field min-h-[36px] w-full rounded-full px-3 text-xs"
            placeholder="literary-fiction"
          />
        </Field>
        <Field label="Mood tags" compact>
          <input
            type="text"
            value={entry.moodTagsRaw}
            onChange={(e) => onUpdate(entry.hardcoverId, { moodTagsRaw: e.target.value })}
            disabled={disabled}
            className="input-field min-h-[36px] w-full rounded-full px-3 text-xs"
            placeholder="atmospheric, slow-burn"
          />
        </Field>
        <Field label="Pack slug" compact>
          <input
            type="text"
            value={entry.packSlug}
            onChange={(e) => onUpdate(entry.hardcoverId, { packSlug: e.target.value })}
            disabled={disabled}
            className="input-field min-h-[36px] w-full rounded-full px-3 text-xs"
            placeholder="optional"
          />
        </Field>
      </div>

      {entry.state.kind === "error" && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-2 text-xs text-[color:var(--rarity-legendary)]"
        >
          {entry.state.message}
        </p>
      )}
      {entry.state.kind === "done" && entry.state.result.linkedToPackId && (
        <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
          Linked to pack
        </p>
      )}
    </li>
  );
}

function StatusBadge({ state }: { state: QueueEntry["state"] }) {
  if (state.kind === "pending") {
    return (
      <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
        Pending
      </span>
    );
  }
  if (state.kind === "done") {
    return (
      <span
        className={
          "rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] " +
          (state.result.created
            ? "border border-[color:var(--rarity-uncommon)]/40 bg-[color:var(--rarity-uncommon-soft)] text-[color:var(--rarity-uncommon)]"
            : "border border-[color:var(--rarity-rare)]/40 bg-[color:var(--rarity-rare-soft)] text-[color:var(--rarity-rare)]")
        }
      >
        {state.result.created ? "Added" : "Re-curated"}
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className="rounded-full border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--rarity-legendary)]">
        Failed
      </span>
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared form primitives
// ─────────────────────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  compact = false,
  children,
}: {
  label: string;
  hint?: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span
        className={
          (compact ? "mb-1" : "mb-1.5") +
          " block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]"
        }
      >
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] text-[var(--sea-ink-soft)]">{hint}</span>}
    </label>
  );
}
