import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

import { CoverImage } from "@/components/CoverImage";
import {
  LOCAL_SPARSE_THRESHOLD,
  searchBooksForBuilderFn,
  searchHardcoverForBuilderFn,
  type BuilderHardcoverHit,
} from "@/server/user-packs";
import type { Rarity } from "@/lib/packs/composition";

/**
 * Shared "add books" search panel used by both the user-pack builder
 * (`/packs/$id/edit`) and the admin editorial-pack editor
 * (`/admin/packs/$slug`).
 *
 * Two-phase search behavior:
 *   1. Local catalog hit via `searchBooksForBuilderFn` (debounced 250ms).
 *   2. If local came back with fewer than `LOCAL_SPARSE_THRESHOLD` rows,
 *      we follow up with `searchHardcoverForBuilderFn` to surface books
 *      that aren't ingested yet. Hits already in our catalog are dropped
 *      (the local search already covered them); the section auto-expands
 *      only when local was empty, otherwise stays collapsed behind a
 *      caret toggle.
 *
 * The component is purposefully *adoption-shaped* — it doesn't know
 * whether it's adding to a user draft or an editorial pack. The two
 * write-side callbacks (`onAddLocal` / `onAddHardcover`) wire each route
 * to its own server fn:
 *
 *   - User builder: `addBookToPackDraftFn` /
 *     `ingestHardcoverBookForBuilderFn`.
 *   - Admin editor: `addBookToPackFn` /
 *     `ingestHardcoverBookForAdminPackFn`.
 *
 * `excludeBookIds` controls the "In pack" badge on local hits. The user
 * builder passes `excludePackIdInSearch` so the server filters its own
 * pack out of results (the badge is then redundant; the empty set is
 * fine). The admin editor passes the current member set instead, so we
 * keep the badge visible for context but don't filter server-side.
 *
 * `searching`/`adding` state is local. After a successful add the parent
 * is responsible for refreshing pack contents — the panel removes the
 * just-added entry from its local list optimistically so the user sees
 * immediate feedback without waiting for the round-trip.
 */
export interface BookSearchPanelProps {
  /** Stable pack identifier; included in queries to keep effects scoped. */
  packId: string;
  /**
   * When provided, the local search excludes this pack's current members
   * server-side. User-builder uses this; admin doesn't (admin shows an
   * "In pack" badge instead of hiding members).
   */
  excludePackIdInSearch?: string;
  /**
   * Book ids that should be shown with an "In pack" badge instead of an
   * Add button. Admin pass the current `memberIds`; user-builder may
   * pass an empty set since `excludePackIdInSearch` already removes them.
   */
  excludeBookIds: ReadonlySet<string>;
  /** Add an already-ingested catalog book to the pack. */
  onAddLocal: (bookId: string) => Promise<void>;
  /** Ingest a Hardcover hit and add it to the pack. */
  onAddHardcover: (hardcoverId: number) => Promise<void>;
}

interface BookHit {
  id: string;
  title: string;
  authors: ReadonlyArray<string>;
  coverUrl: string | null;
  genre: string;
  rarity: Rarity;
}

/**
 * Render a compact, cap-width author byline. Hardcover hits sometimes
 * list every contributor (translators, editors, illustrators, …) which
 * produces a string long enough to blow past `truncate`'s effective
 * width on narrow flex items — the full string still counts toward the
 * row's min-content size even if visually clipped, and on mobile that
 * pushed the Add button past the viewport edge. Showing at most one
 * name plus a "+N more" tail keeps the line short enough that
 * truncation on the *title* is the only thing the layout has to handle.
 */
function formatAuthors(authors: ReadonlyArray<string>): string {
  if (authors.length === 0) return "Unknown author";
  if (authors.length === 1) return authors[0]!;
  return `${authors[0]} +${authors.length - 1} more`;
}

export function BookSearchPanel({
  packId,
  excludePackIdInSearch,
  excludeBookIds,
  onAddLocal,
  onAddHardcover,
}: BookSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BookHit[]>([]);
  const [hardcoverHits, setHardcoverHits] = useState<BuilderHardcoverHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchingHardcover, setSearchingHardcover] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hardcoverError, setHardcoverError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [ingestingId, setIngestingId] = useState<number | null>(null);
  // When local results exist, Hardcover hits are usually noise — they
  // mostly duplicate what we already have plus a long tail of foreign
  // editions and translations. Hide them behind a toggle so the primary
  // list stays calm; auto-expand only when local came back empty, since
  // that's the case where the user actually needs the fallback.
  const [hardcoverExpanded, setHardcoverExpanded] = useState(false);

  // Two-phase search: local first, then Hardcover fallback if local is
  // sparse. Sequential (not parallel) so the rate-limited Hardcover
  // call only fires when the local results don't cover the user's
  // intent. UI feels like "results appear fast; a 'From Hardcover'
  // section fades in a moment later when needed."
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setHardcoverHits([]);
      setError(null);
      setHardcoverError(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const rows = await searchBooksForBuilderFn({
          data: { query: trimmed, excludePackId: excludePackIdInSearch },
        });
        if (cancelled) return;
        setResults([...rows]);
        setError(null);

        if (rows.length < LOCAL_SPARSE_THRESHOLD) {
          setSearchingHardcover(true);
          setHardcoverError(null);
          try {
            const hcRows = await searchHardcoverForBuilderFn({
              data: { query: trimmed },
            });
            if (cancelled) return;
            // The server already tags hits whose `hardcover_id` is in
            // our catalog via `alreadyInCatalogBookId`. Drop those so
            // the fallback list stays focused on books the user can't
            // find locally — the whole point of the section.
            setHardcoverHits(
              hcRows.filter((h) => h.alreadyInCatalogBookId === null),
            );
            // Auto-expand only when local had nothing to show. Any
            // local hit means the query was satisfied; the user can
            // still opt in via the toggle.
            setHardcoverExpanded(rows.length === 0);
          } catch (err) {
            if (!cancelled) {
              setHardcoverError(
                err instanceof Error ? err.message : "Hardcover search failed",
              );
              setHardcoverHits([]);
            }
          } finally {
            if (!cancelled) setSearchingHardcover(false);
          }
        } else {
          setHardcoverHits([]);
          setHardcoverError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, packId, excludePackIdInSearch]);

  const handleAddLocal = async (bookId: string) => {
    setAddingId(bookId);
    try {
      await onAddLocal(bookId);
      // Optimistic prune — refresh from the parent will reconcile any
      // discrepancy. Keeps the list from showing a still-addable row
      // for the same book until the next debounced re-search.
      setResults((prev) => prev.filter((b) => b.id !== bookId));
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAddingId(null);
    }
  };

  const handleAddHardcover = async (hardcoverId: number) => {
    setIngestingId(hardcoverId);
    try {
      await onAddHardcover(hardcoverId);
      setHardcoverHits((prev) => prev.filter((h) => h.hardcoverId !== hardcoverId));
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : "Failed to add from Hardcover");
    } finally {
      setIngestingId(null);
    }
  };

  return (
    // `min-w-0` on the panel root: when this section is a grid or
    // flex item in its parent layout, default `min-width: auto` lets
    // it grow to fit intrinsic content (the row `truncate` lines do
    // exactly that). Pinning it to 0 here makes the panel a good
    // citizen regardless of how the parent lays it out.
    <section className="island-shell min-w-0 rounded-3xl p-5">
      <h2 className="island-kicker mb-3">Add books</h2>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
        placeholder="Search by title or author…"
      />
      {error && (
        <p className="mt-3 text-xs text-[color:var(--rarity-legendary)]">{error}</p>
      )}
      {searching && <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">Searching…</p>}
      {results.length > 0 && (
        <ul className="mt-4 space-y-2">
          {results.map((b) => {
            const isMember = excludeBookIds.has(b.id);
            return (
              <li
                key={b.id}
                // `flex-wrap` lets the trailing action chip drop to its
                // own line on narrow viewports instead of forcing the
                // title row to overflow. Same fix used in the library
                // shelf search (`library.reading.tsx:495`); the
                // image+text column keeps `min-w-0 flex-1` so titles
                // ellipsize when the row is intact.
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
                    {formatAuthors(b.authors)} · {b.rarity}
                  </p>
                </div>
                {isMember ? (
                  <span className="shrink-0 rounded-full border border-[color:var(--rarity-rare)]/40 bg-[color:var(--rarity-rare-soft)] px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--rarity-rare)]">
                    In pack
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={addingId === b.id}
                    onClick={() => void handleAddLocal(b.id)}
                    className="btn-primary shrink-0 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] disabled:opacity-50"
                  >
                    {addingId === b.id ? "Adding…" : "Add"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/* Hardcover fallback section. Only rendered when local was sparse
          and we actually have hits to show (or are loading / errored).
          When local produced matches, the list stays collapsed behind a
          caret toggle — see hardcoverExpanded. */}
      {(searchingHardcover || hardcoverHits.length > 0 || hardcoverError) && (
        <div className="mt-5">
          <button
            type="button"
            onClick={() => setHardcoverExpanded((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left"
            aria-expanded={hardcoverExpanded}
          >
            <h3 className="island-kicker text-[11px]">
              From Hardcover
              {hardcoverHits.length > 0 && (
                <span className="ml-1 text-[var(--sea-ink-soft)] normal-case tracking-normal">
                  · {hardcoverHits.length}
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
                <p className="text-xs text-[var(--sea-ink-soft)]">Searching Hardcover…</p>
              )}
              {hardcoverError && (
                <p className="text-xs text-[color:var(--rarity-legendary)]">
                  {hardcoverError}
                </p>
              )}
              {hardcoverHits.length > 0 && (
                <ul className="space-y-2">
                  {hardcoverHits.map((h) => (
                    <li
                      key={h.hardcoverId}
                      // See note on the local-row <li>: flex-wrap is
                      // load-bearing on mobile so the Add button drops
                      // to a new line rather than overflowing the row.
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
                        </p>
                        <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                          {formatAuthors(h.authors)}
                          {h.releaseYear ? ` · ${h.releaseYear}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={ingestingId === h.hardcoverId}
                        onClick={() => void handleAddHardcover(h.hardcoverId)}
                        className="btn-primary shrink-0 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] disabled:opacity-50"
                      >
                        {ingestingId === h.hardcoverId ? "Adding…" : "Add"}
                      </button>
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
