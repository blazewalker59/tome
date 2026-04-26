import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createFileRoute,
  Link,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { getMeFn } from "@/server/admin";
import {
  ingestHardcoverForReadingLogFn,
  listReadingEntriesFn,
  LOCAL_SPARSE_THRESHOLD,
  searchForReadingLogFn,
  searchHardcoverForReadingLogFn,
  upsertReadingEntryFn,
  type LocalSearchHit,
  type ReadingEntry,
  type ReadingHardcoverHit,
  type ReadingStatus,
} from "@/server/reading";
import { useToast } from "@/components/Toast";
import { CoverImage } from "@/components/CoverImage";
import { demoteReasonLabel } from "@/lib/hardcover/rank";

/**
 * Reading list route: `/reading`.
 *
 * The signed-in user's reading log, grouped into three tabs matching
 * the `reading_status` enum (TBR / Reading / Finished). Logging is
 * independent of pack ownership — any Hardcover book can be shelved,
 * with ingest happening on-demand through the same 10/hr user throttle
 * the pack builder uses.
 *
 * Auth: loader redirects anonymous users to sign-in. The server fns
 * enforce auth separately so a URL guess against the endpoints still
 * fails closed.
 *
 * Search is the pattern lifted from the pack builder
 * (`packs.$id.edit.tsx`): local catalog first, Hardcover fallback only
 * when local is sparse, collapsed behind a caret toggle unless local
 * came back empty. Intentional duplication over a shared component —
 * the two surfaces have different "add" semantics (add-to-pack vs
 * set-reading-status) and different result-filter rules.
 */
export const Route = createFileRoute("/library/reading")({
  loader: async () => {
    const user = await getMeFn();
    if (!user) throw redirect({ to: "/sign-in" });
    const entries = await listReadingEntriesFn();
    return { user, entries };
  },
  component: ReadingListPage,
});

// URL-bound tab key. Kept to three values so validateSearch can be
// strict; any other value falls back to "reading" (the middle tab).
type TabKey = ReadingStatus;
const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "reading", label: "Reading" },
  { key: "tbr", label: "TBR" },
  { key: "finished", label: "Finished" },
];

function ReadingListPage() {
  const { entries: initialEntries } = Route.useLoaderData();
  const router = useRouter();
  const [entries, setEntries] = useState<ReadonlyArray<ReadingEntry>>(
    () => initialEntries,
  );
  const [activeTab, setActiveTab] = useState<TabKey>("reading");

  // Reload from the server; used after logging a new book from search
  // or after a child panel updates an entry. `invalidate()` alone would
  // require the route to re-mount; calling the server fn directly keeps
  // the tab state and scroll position.
  const reload = useCallback(async () => {
    try {
      const rows = await listReadingEntriesFn();
      setEntries(rows);
    } catch {
      // Network blips are non-fatal — the stale list stays visible and
      // the next router.invalidate() will retry. Surfacing an alert
      // here would be noisier than helpful.
    }
  }, []);

  const grouped = useMemo(() => {
    const by = new Map<TabKey, ReadingEntry[]>();
    for (const t of TABS) by.set(t.key, []);
    for (const e of entries) by.get(e.status as TabKey)?.push(e);
    return by;
  }, [entries]);

  const currentList = grouped.get(activeTab) ?? [];

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* The page-level "Reading list" title used to live here but
          now sits in the /library parent layout as part of the
          shared "Library" heading + tabs. Only the subhead blurb
          remains so the user still gets context about what the
          log does — pack ownership not required, shards on
          start/finish. */}
      <header>
        <p className="max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          Shelf any book here to earn shards when you start and finish
          it — pack ownership not required. Search pulls in your
          catalog first, then Hardcover.
        </p>
      </header>

      <LogSearchPanel
        entries={entries}
        onLogged={async (status) => {
          await reload();
          router.invalidate();
          // Auto-switch the active tab to wherever the freshly-
          // logged book landed. Without this the entry disappears
          // from the user's view on log (search results reset,
          // active tab stays wherever it was) — previous UX read
          // as "nothing happened" when logging e.g. a Finished
          // book while viewing the Reading tab. Staying on the
          // current tab is fine when it already matches.
          setActiveTab(status);
        }}
      />

      {/* Tabs. Pill-shaped segmented control matching the pattern on
          /collection and /book/:id — the shared `.view-tab` utility
          gives consistent height, rounded pills, and graceful mobile
          overflow (horizontal scroll with snap) instead of wrapping
          mid-row. Client-side re-filter beats a round-trip per tab
          switch since the three lists already rode in on the loader. */}
      <div
        role="tablist"
        aria-label="Reading log"
        className="view-tabs flex gap-2 overflow-x-auto"
      >
        {TABS.map((t) => {
          const active = activeTab === t.key;
          const count = grouped.get(t.key)?.length ?? 0;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(t.key)}
              className={`view-tab ${active ? "is-active" : ""}`}
            >
              <span>{t.label}</span>
              {/* Count is secondary information — smaller, lower
                  contrast, and tucked to the right of the label so
                  it never dominates the pill. Hidden at zero to keep
                  empty tabs visually quiet. */}
              {count > 0 && (
                <span
                  aria-hidden
                  className={`ml-1.5 text-[10px] font-semibold ${
                    active ? "opacity-80" : "opacity-60"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {currentList.length === 0 ? (
        <EmptyState tab={activeTab} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {currentList.map((e) => (
            <EntryRow key={e.bookId} entry={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty states
// ─────────────────────────────────────────────────────────────────────────────

function EmptyState({ tab }: { tab: TabKey }) {
  const copy =
    tab === "reading"
      ? "No active reads yet. Search above and tap Reading to start earning shards."
      : tab === "tbr"
        ? "Nothing shelved yet. Search above and tap Want to read to save a book for later."
        : "Nothing finished yet. Finish a book to earn 100 shards (once per book).";
  return (
    <p className="rounded-2xl border border-dashed border-[var(--line)] p-8 text-center text-sm text-[var(--sea-ink-soft)]">
      {copy}
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry row
// ─────────────────────────────────────────────────────────────────────────────

function EntryRow({ entry }: { entry: ReadingEntry }) {
  return (
    <li className="island-shell rounded-3xl p-4">
      <Link
        to="/book/$id"
        params={{ id: entry.bookId }}
        className="flex min-w-0 items-center gap-3"
      >
        <CoverImage
          src={entry.book.coverUrl}
          alt=""
          className="h-16 w-12 shrink-0 rounded-md object-cover"
          fallback={
            <div className="h-16 w-12 shrink-0 rounded-md bg-[var(--surface-muted)]" />
          }
        />
        <div className="min-w-0 flex-1">
          <p
            title={entry.book.title}
            className="line-clamp-2 text-sm font-semibold text-[var(--sea-ink)]"
          >
            {entry.book.title}
          </p>
          <p className="mt-1 truncate text-xs text-[var(--sea-ink-soft)]">
            {formatAuthors(entry.book.authors)}
          </p>
          {/* Surface the most recent timestamp we know about. Finished
              wins over started wins over neither — matches the mental
              model of "what changed most recently for this book". */}
          {entry.finishedAt ? (
            <p className="mt-1 text-[11px] text-[var(--sea-ink-soft)]">
              Finished {formatDate(entry.finishedAt)}
            </p>
          ) : entry.startedAt ? (
            <p className="mt-1 text-[11px] text-[var(--sea-ink-soft)]">
              Started {formatDate(entry.startedAt)}
            </p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Search + log panel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two-phase search: local catalog first, Hardcover fallback only when
 * local is sparse. Mirrors `BookSearchPanel` in `packs.$id.edit.tsx`
 * but the per-row action is "set status" rather than "add to pack",
 * and Hardcover hits flow through a dedicated ingest path that stamps
 * the user's provenance and bumps the 10/hr throttle.
 *
 * `entries` is threaded in so rows the user already logged can be
 * labelled as such rather than duplicating them in the result list.
 */
function LogSearchPanel({
  entries,
  onLogged,
}: {
  entries: ReadonlyArray<ReadingEntry>;
  // Callback receives the status the book was logged with so the
  // parent can jump to the matching tab. Async so the parent can
  // await a reload before the UI settles.
  onLogged: (status: ReadingStatus) => Promise<void>;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState<LocalSearchHit[]>([]);
  const [hardcover, setHardcover] = useState<ReadingHardcoverHit[]>([]);
  const [searchingLocal, setSearchingLocal] = useState(false);
  const [searchingHardcover, setSearchingHardcover] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [hardcoverError, setHardcoverError] = useState<string | null>(null);
  const [busyBookId, setBusyBookId] = useState<string | null>(null);
  const [busyHardcoverId, setBusyHardcoverId] = useState<number | null>(null);
  // Collapsed by default when local found anything; auto-expanded
  // when local was empty — the one case the user needs the fallback.
  const [hardcoverExpanded, setHardcoverExpanded] = useState(false);

  // Map of bookIds already in the user's log so a fresh local search
  // can correctly label rows without a second server fn call. Derived
  // here (not in search) because `entries` updates after every log.
  const loggedIds = useMemo(
    () => new Set(entries.map((e) => e.bookId)),
    [entries],
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setLocal([]);
      setHardcover([]);
      setLocalError(null);
      setHardcoverError(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearchingLocal(true);
      try {
        const rows = await searchForReadingLogFn({ data: { query: trimmed } });
        if (cancelled) return;
        setLocal([...rows]);
        setLocalError(null);

        if (rows.length < LOCAL_SPARSE_THRESHOLD) {
          setSearchingHardcover(true);
          setHardcoverError(null);
          try {
            const hcRows = await searchHardcoverForReadingLogFn({
              data: { query: trimmed },
            });
            if (cancelled) return;
            // Filter out hits that already exist in the local catalog
            // — those are better served by the local row (which knows
            // the user's log status). The server tags them for us.
            setHardcover(
              hcRows.filter((h) => h.alreadyInCatalogBookId === null),
            );
            setHardcoverExpanded(rows.length === 0);
          } catch (err) {
            if (!cancelled) {
              setHardcoverError(
                err instanceof Error
                  ? err.message
                  : "Hardcover search failed",
              );
              setHardcover([]);
            }
          } finally {
            if (!cancelled) setSearchingHardcover(false);
          }
        } else {
          setHardcover([]);
          setHardcoverError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setLocalError(err instanceof Error ? err.message : "Search failed");
        }
      } finally {
        if (!cancelled) setSearchingLocal(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  const logLocal = async (bookId: string, status: ReadingStatus) => {
    setBusyBookId(bookId);
    try {
      const res = await upsertReadingEntryFn({
        data: { bookId, status },
      });
      for (const g of res.grants) {
        if (g.amount > 0) {
          toast.push({
            title: `+${g.amount} shards`,
            description:
              g.reason === "start_reading"
                ? "Started reading"
                : "Finished reading",
            tone: "shard",
          });
        }
      }
      if (res.finishGuardSuppressed) {
        // Two paths lead here: the hourly anti-farm guard, and the
        // retroactive-log case (no prior start_reading event at all).
        // Separating the copy keeps each honest — the farm guard
        // wants to explain the hour window; the retroactive path
        // wants to reassure the user their log was saved even though
        // no shards minted. We distinguish by checking whether any
        // `start_reading` event ever existed for this book — the
        // server already encoded that decision via `shouldGrantFinish`
        // returning false for both, but the client doesn't see that
        // reason, so we infer from `res.entry.startedAt`: a true
        // farm bounce would have stamped startedAt earlier, while a
        // retroactive log still has startedAt === null.
        const retroactive = res.entry.startedAt === null;
        toast.push({
          title: retroactive ? "Logged as finished" : "No shards this time",
          description: retroactive
            ? "Already read it? Shelved with no shards — you only earn them for books you start in the app."
            : "Finish a book at least an hour after starting to earn shards.",
          tone: "neutral",
        });
      }
      await onLogged(status);
    } catch (err) {
      toast.push({
        title: "Couldn't log book",
        description: err instanceof Error ? err.message : "Unknown error",
        tone: "neutral",
      });
    } finally {
      setBusyBookId(null);
    }
  };

  const logHardcover = async (
    hardcoverId: number,
    status: ReadingStatus,
  ) => {
    setBusyHardcoverId(hardcoverId);
    try {
      // Two-step: ingest to get a local bookId, then upsert the
      // reading entry with the chosen status. Ingest alone is free
      // (shelving costs nothing); only the status choice potentially
      // mints shards.
      const { bookId } = await ingestHardcoverForReadingLogFn({
        data: { hardcoverId },
      });
      const res = await upsertReadingEntryFn({ data: { bookId, status } });
      for (const g of res.grants) {
        if (g.amount > 0) {
          toast.push({
            title: `+${g.amount} shards`,
            description:
              g.reason === "start_reading"
                ? "Started reading"
                : "Finished reading",
            tone: "shard",
          });
        }
      }
      // Same suppressed-grant feedback as logLocal. Kept inline
      // (not extracted) because the two log-paths only share this
      // tail; factoring it out trades a small file for a one-use
      // helper that still has to carry `status` and the entry
      // shape through.
      if (res.finishGuardSuppressed) {
        const retroactive = res.entry.startedAt === null;
        toast.push({
          title: retroactive ? "Logged as finished" : "No shards this time",
          description: retroactive
            ? "Already read it? Shelved with no shards — you only earn them for books you start in the app."
            : "Finish a book at least an hour after starting to earn shards.",
          tone: "neutral",
        });
      }
      // Drop the hit so the list doesn't show a stale Add after the
      // caller reloads; the newly-ingested book will appear in the
      // local list on the next search.
      setHardcover((prev) => prev.filter((h) => h.hardcoverId !== hardcoverId));
      await onLogged(status);
    } catch (err) {
      toast.push({
        title: "Couldn't add from Hardcover",
        description: err instanceof Error ? err.message : "Unknown error",
        tone: "neutral",
      });
    } finally {
      setBusyHardcoverId(null);
    }
  };

  return (
    <section className="island-shell rounded-3xl p-5">
      <h2 className="island-kicker mb-3">Log a book</h2>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
        placeholder="Search by title or author…"
      />
      {localError && (
        <p className="mt-3 text-xs text-[color:var(--rarity-legendary)]">
          {localError}
        </p>
      )}
      {searchingLocal && (
        <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">Searching…</p>
      )}
      {local.length > 0 && (
        <ul className="mt-4 space-y-2">
          {local.map((b) => {
            const logged = loggedIds.has(b.id) || b.alreadyInLog;
            return (
              <li
                key={b.id}
                className="flex min-w-0 flex-wrap items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3"
              >
                <CoverImage
                  src={b.coverUrl}
                  alt=""
                  className="h-14 w-10 shrink-0 rounded-md object-cover"
                  fallback={
                    <div className="h-14 w-10 shrink-0 rounded-md bg-[var(--surface-muted)]" />
                  }
                />
                <div className="min-w-0 flex-1">
                  <p
                    title={b.title}
                    className="line-clamp-1 text-sm font-semibold text-[var(--sea-ink)] [overflow-wrap:anywhere]"
                  >
                    {b.title}
                  </p>
                  <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                    {formatAuthors(b.authors)}
                  </p>
                </div>
                {logged ? (
                  <Link
                    to="/book/$id"
                    params={{ id: b.id }}
                    className="shrink-0 rounded-full border border-[var(--line)] px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
                  >
                    In log
                  </Link>
                ) : (
                  <StatusPicker
                    disabled={busyBookId === b.id}
                    onPick={(s) => void logLocal(b.id, s)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(searchingHardcover ||
        hardcover.length > 0 ||
        hardcoverError) && (
        <div className="mt-5">
          <button
            type="button"
            onClick={() => setHardcoverExpanded((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left"
            aria-expanded={hardcoverExpanded}
          >
            <h3 className="island-kicker text-[11px]">
              From Hardcover
              {hardcover.length > 0 && (
                <span className="ml-1 text-[var(--sea-ink-soft)] normal-case tracking-normal">
                  · {hardcover.length}
                </span>
              )}
            </h3>
            <ChevronRight
              aria-hidden
              className={`h-4 w-4 text-[var(--sea-ink)] transition-transform ${hardcoverExpanded ? "rotate-90" : ""}`}
            />
          </button>
          {hardcoverExpanded && (
            <div className="mt-2">
              {searchingHardcover && (
                <p className="text-xs text-[var(--sea-ink-soft)]">
                  Searching Hardcover…
                </p>
              )}
              {hardcoverError && (
                <p className="text-xs text-[color:var(--rarity-legendary)]">
                  {hardcoverError}
                </p>
              )}
              {hardcover.length > 0 && (
                <ul className="space-y-2">
                  {hardcover.map((h) => (
                    <li
                      key={h.hardcoverId}
                      className="flex min-w-0 flex-wrap items-center gap-3 rounded-2xl border border-dashed border-[var(--line)] bg-[var(--surface)] p-3"
                    >
                      <CoverImage
                        src={h.coverUrl}
                        alt=""
                        className="h-14 w-10 shrink-0 rounded-md object-cover"
                        fallback={
                          <div className="h-14 w-10 shrink-0 rounded-md bg-[var(--surface-muted)]" />
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          title={h.title}
                          className="line-clamp-1 text-sm font-semibold text-[var(--sea-ink)] [overflow-wrap:anywhere]"
                        >
                          {h.title}
                          {h.demoted && h.demoteReason && (
                            // Demoted hits stay selectable but get a
                            // small inline tag so the user can see
                            // why the ranker pushed them down.
                            <span className="ml-2 inline-block rounded-sm bg-[var(--surface-muted)] px-1.5 py-0.5 align-middle text-[9px] font-medium uppercase tracking-[0.06em] text-[var(--sea-ink-soft)]">
                              {demoteReasonLabel(h.demoteReason)}
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                          {formatAuthors(h.authors)}
                          {h.releaseYear ? ` · ${h.releaseYear}` : ""}
                        </p>
                      </div>
                      <StatusPicker
                        disabled={busyHardcoverId === h.hardcoverId}
                        onPick={(s) => void logHardcover(h.hardcoverId, s)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Three-button status picker used in both local and Hardcover rows.
// Kept as a tiny subcomponent so the row markup stays readable and
// the button styling lives in one place.
function StatusPicker({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (status: ReadingStatus) => void;
}) {
  const choices: ReadonlyArray<{ key: ReadingStatus; label: string }> = [
    { key: "tbr", label: "TBR" },
    { key: "reading", label: "Reading" },
    { key: "finished", label: "Finished" },
  ];
  return (
    <div className="flex shrink-0 flex-wrap gap-1">
      {choices.map((c) => (
        <button
          key={c.key}
          type="button"
          disabled={disabled}
          onClick={() => onPick(c.key)}
          className="rounded-full border border-[var(--line)] px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--sea-ink)] hover:bg-[var(--surface-muted)] disabled:opacity-50"
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────────

// Matches the helper in packs.$id.edit.tsx. Duplicated rather than
// shared because the two routes touch it at different render depths;
// extracting to a tiny module can happen when a third caller shows up.
function formatAuthors(authors: ReadonlyArray<string>): string {
  if (authors.length === 0) return "Unknown author";
  if (authors.length === 1) return authors[0]!;
  return `${authors[0]!} +${authors.length - 1}`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
