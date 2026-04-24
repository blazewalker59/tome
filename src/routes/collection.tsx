import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Info } from "lucide-react";
import { Card } from "@/components/cards/Card";
import { PackContentsSheet } from "@/components/PackContentsSheet";
import { RarityGemRow } from "@/components/RarityGemRow";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import {
  groupCards,
  rarityCounts,
  sortCards,
  type GroupBy,
  type SortMode,
} from "@/lib/cards/filter";
import type { CardData } from "@/lib/cards/types";
import {
  getCollectionFn,
  getEditorialPackFn,
  getPackBooksByIdsFn,
  type PackManifestEntry,
} from "@/server/collection";

/**
 * Collection route.
 *
 * Loader fetches the user's collection + the default pack (needed so the
 * rarity-progress bars can show "owned X / total Y"). Unauth'd users are
 * redirected to sign-in because a collection requires an account.
 *
 * The page is organised around a single top-level pivot — "view" — that
 * switches between a flat grid and four grouped modes (pack / author /
 * rarity / genre). Filters used to live alongside search but proved
 * redundant once grouping moved to top-level: users either want "all"
 * or "just one bucket", and search covers the long-tail case. Keeping
 * the toolbar to three controls (search, sort, view) also matches the
 * available horizontal real estate on a phone without a second row.
 *
 * State persistence: `view`, `q` (search), and `sort` are all mirrored
 * to the URL via TanStack Router's `validateSearch`. None are required
 * — defaults stay out of the URL so a plain `/collection` link looks
 * clean. This makes "grouped by rarity" and similar views shareable
 * (copy the URL) and browser-history friendly (back arrow restores the
 * prior view).
 */

// Accepted values, declared once so `validateSearch` and the UI stay
// aligned. The `as const` lets us derive the union type directly.
const VIEW_VALUES = ["all", "pack", "author", "rarity", "genre"] as const;
const SORT_VALUES = ["newest", "rarity", "title", "author"] as const;

interface CollectionSearch {
  /** Grouping pivot. Defaults to `all` and is omitted from the URL
   *  when at default so `/collection` stays clean. */
  view?: GroupBy;
  /** Sort mode. Defaults to `newest`; omitted when at default. */
  sort?: SortMode;
  /** Case-insensitive search query. Omitted when empty. We use `q`
   *  (not `search`) to keep URLs compact and match convention. */
  q?: string;
}

/**
 * Parse + coerce the raw `?...` params into a typed search object.
 *
 * Accepts anything, returns only valid values. Unknown strings (e.g. a
 * stale link pointing at a view we removed) silently degrade to
 * undefined → the component falls back to its default. This is
 * intentionally forgiving: strict parsing would turn a shared URL into
 * a route error if we ever rename an enum value.
 */
function parseCollectionSearch(raw: Record<string, unknown>): CollectionSearch {
  const out: CollectionSearch = {};

  const view = raw.view;
  if (typeof view === "string" && (VIEW_VALUES as readonly string[]).includes(view)) {
    out.view = view as GroupBy;
  }

  const sort = raw.sort;
  if (typeof sort === "string" && (SORT_VALUES as readonly string[]).includes(sort)) {
    out.sort = sort as SortMode;
  }

  const q = raw.q;
  if (typeof q === "string" && q.trim().length > 0) {
    // Cap the length — search params round-trip through SSR and we
    // don't want an attacker to stuff a 100kB string into a URL that
    // then ends up in server logs.
    out.q = q.slice(0, 200);
  }

  return out;
}

export const Route = createFileRoute("/collection")({
  validateSearch: parseCollectionSearch,
  loader: async () => {
    const [collection, pack] = await Promise.all([getCollectionFn(), getEditorialPackFn()]);
    if (!collection) {
      throw redirect({ to: "/sign-in" });
    }
    // Second phase — once we know which packs the user has rolled
    // from, batch-fetch their manifests so the per-pack "contents"
    // sheet can show the full book list (owned + unowned) just like
    // /rip does. Kept as a separate request because the first phase
    // already roundtripped and we don't know the IDs until it lands;
    // one additional query at page load is an acceptable cost for
    // the feature and scales linearly with packs-rolled-from rather
    // than books-owned.
    const packIds = Array.from(
      new Set(
        collection.acquisitions
          .map((a) => a.packId)
          .filter((id): id is string => typeof id === "string"),
      ),
    );
    const packManifests = packIds.length
      ? await getPackBooksByIdsFn({ data: { packIds } }).catch(() => ({}))
      : {};
    return { collection, pack, packManifests };
  },
  component: CollectionPage,
});

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "rarity", label: "Rarity" },
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
];

const VIEW_OPTIONS: Array<{ value: GroupBy; label: string }> = [
  { value: "all", label: "All" },
  { value: "pack", label: "Pack" },
  { value: "author", label: "Author" },
  { value: "rarity", label: "Rarity" },
  { value: "genre", label: "Genre" },
];

// When switching into a grouped view with more than this many groups, we
// default every group to collapsed so the user sees a navigable index
// rather than an endless scroll. Below the threshold the UX is better
// with groups pre-expanded since there isn't much to collapse anyway.
const AUTO_COLLAPSE_THRESHOLD = 4;

function CollectionPage() {
  const { collection, pack, packManifests } = Route.useLoaderData();
  const searchParams = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // Resolve defaults locally so the render path never has to branch on
  // "is the param present?". The URL stays minimal because we only
  // write non-default values back via `updateSearch`.
  const view: GroupBy = searchParams.view ?? "all";
  const sortMode: SortMode = searchParams.sort ?? "newest";
  const search = searchParams.q ?? "";

  /**
   * Patch the URL search params. Keys set to `undefined` are removed
   * (TanStack Router's convention). `replace: true` avoids polluting
   * browser history with every keystroke; the back button should step
   * between meaningful states, not typed characters. Use `push` only
   * for the view/sort changes below where a history entry makes sense.
   */
  const updateSearch = (
    patch: Partial<CollectionSearch>,
    options: { replace?: boolean } = {},
  ) => {
    void navigate({
      search: (prev) => {
        const next = { ...prev, ...patch };
        // Strip keys that are at their default value so clean URLs
        // stay clean. Without this, picking "Newest" and "All" still
        // leaves ?view=all&sort=newest hanging in the bar.
        if (next.view === "all") delete next.view;
        if (next.sort === "newest") delete next.sort;
        if (!next.q) delete next.q;
        return next;
      },
      replace: options.replace ?? false,
    });
  };

  // Local state for the search input so typing feels instant. We only
  // push to the URL on blur / explicit submit — otherwise every
  // keystroke would land in history and (on slow networks) trigger a
  // re-render through the router update cycle.
  const [searchDraft, setSearchDraft] = useState(search);

  // Map the pack's books into CardData once per pack payload, then split into
  // the subset the user owns. We derive from the pack (not the collection's
  // raw ids) because we need full card data for rendering — until we have a
  // dedicated "cards I own" server function that joins through to `books`.
  const { ownedCards, cardById } = useMemo(() => {
    const allCards = pack.books.map(bookRowToCardData);
    const byId = new Map(allCards.map((c) => [c.id, c]));
    const ownedSet = new Set(collection.ownedBookIds);
    return {
      ownedCards: allCards.filter((c) => ownedSet.has(c.id)),
      cardById: byId,
    };
  }, [pack.books, collection.ownedBookIds]);

  const acquisitionMap = useMemo(() => {
    const m = new Map<
      string,
      { packId: string | null; packName: string; acquiredAt: number }
    >();
    for (const a of collection.acquisitions) {
      m.set(a.bookId, {
        packId: a.packId,
        packName: a.packName,
        acquiredAt: a.acquiredAt,
      });
    }
    return m;
  }, [collection.acquisitions]);

  // Use the URL-synced value (not the draft) for the actual filter so
  // the displayed grid reflects what the URL says. This keeps paste-a-
  // URL behaviour correct: the incoming `?q=gaiman` filters immediately.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ownedCards;
    return ownedCards.filter((c) =>
      `${c.title} ${c.authors.join(" ")}`.toLowerCase().includes(q),
    );
  }, [ownedCards, search]);

  const acquiredAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, info] of acquisitionMap) m.set(id, info.acquiredAt);
    return m;
  }, [acquisitionMap]);

  const sorted = useMemo(
    () => sortCards(searched, sortMode, { acquiredAt }),
    [searched, sortMode, acquiredAt],
  );

  // Group ctx: pack grouping needs the (packId, packName) per-book map.
  const groupCtx = useMemo(
    () => ({
      acquisitions: new Map(
        [...acquisitionMap.entries()].map(([id, info]) => [
          id,
          { packId: info.packId, packName: info.packName },
        ]),
      ),
    }),
    [acquisitionMap],
  );

  const groups = useMemo(
    () => groupCards(sorted, view, groupCtx),
    [sorted, view, groupCtx],
  );

  if (ownedCards.length === 0) {
    return <EmptyState />;
  }

  return (
    <main className="page-wrap pb-6 pt-4 sm:py-12">
      <header className="mb-4 sm:mb-8">
        {/* Single-line header — no eyebrow kicker, since "Your
            library" above "Collection" repeated the same idea. The
            owned/total stat chip that used to sit on the right was
            removed: once the page groups by pack with its own
            "contents" sheet, a single global `N/T` number stops
            being a meaningful figure — it's really just the owned
            count of the editorial pack, which misrepresents "your
            library" as more packs come online. */}
        <h1 className="display-title text-2xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          Collection
        </h1>
      </header>

      {/* View switcher — the top-level pivot. Sits directly under the
          page header and above the toolbar so it reads as a primary
          navigation control, not a filter option. The per-pack rarity
          breakdown used to live here as a top-level strip, but now
          nests into each pack group when sorted by pack — a single
          global row stops carrying useful information once the user
          owns books from more than one pack. */}
      <ViewTabs value={view} onChange={(v) => updateSearch({ view: v })} />

      {/* Toolbar — search + sort. Sticky on mobile so the user always has
          it within thumb reach while scrolling. Filters are gone: search
          + view covers the use cases that used to need chips. */}
      <div className="sticky top-[var(--header-h,64px)] z-30 -mx-4 mt-4 mb-4 border-y border-[var(--line)] bg-[var(--header-bg)] px-4 py-3 backdrop-blur sm:relative sm:top-auto sm:mx-0 sm:rounded-2xl sm:border sm:border-[var(--line)] sm:bg-[var(--surface)] sm:px-4 sm:py-3">
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            // Commit to URL on blur (tab-away / tap elsewhere) and on
            // Enter. Both are natural "I'm done typing" signals and
            // avoid writing to the URL on every keystroke.
            onBlur={() =>
              searchDraft !== search &&
              updateSearch({ q: searchDraft || undefined }, { replace: true })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            placeholder="Search title or author"
            className="input-field min-h-[44px] flex-1 rounded-full px-4 text-sm"
          />
          <label className="flex shrink-0 items-center gap-2 text-xs uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
            <span className="hidden sm:inline">Sort</span>
            <select
              value={sortMode}
              onChange={(e) => updateSearch({ sort: e.target.value as SortMode })}
              className="input-field min-h-[44px] rounded-full px-3 text-xs font-semibold"
              aria-label="Sort"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="py-16 text-center text-sm text-[var(--sea-ink-soft)]">
          No books match your search.
        </p>
      ) : view === "all" ? (
        <CardGrid cards={sorted} cardById={cardById} />
      ) : (
        <GroupedView
          groups={groups}
          view={view}
          cardById={cardById}
          packManifests={packManifests}
          ownedBookIds={collection.ownedBookIds}
        />
      )}
    </main>
  );
}

// Exported for tests — the parser is the whole URL→state contract and
// deserves targeted coverage independent of the rest of the route.
export { parseCollectionSearch };
export type { CollectionSearch };

// ─────────────────────────────────────────────────────────────────────────────
// View switcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Segmented pill control for the top-level view pivot. Horizontally
 * scrollable on mobile (so longer option lists don't wrap), stationary
 * on larger screens.
 */
function ViewTabs({
  value,
  onChange,
}: {
  value: GroupBy;
  onChange: (v: GroupBy) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Collection view"
      className="view-tabs mt-3 mb-1 flex gap-2 overflow-x-auto sm:mt-5 sm:mb-2"
    >
      {VIEW_OPTIONS.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`view-tab ${active ? "is-active" : ""}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouped view + collapsible group
// ─────────────────────────────────────────────────────────────────────────────

function GroupedView({
  groups,
  view,
  cardById,
  packManifests,
  ownedBookIds,
}: {
  groups: ReadonlyArray<{ key: string; label: string; cards: ReadonlyArray<CardData> }>;
  view: GroupBy;
  cardById: ReadonlyMap<string, CardData>;
  packManifests: Record<string, PackManifestEntry>;
  ownedBookIds: ReadonlyArray<string>;
}) {
  // Auto-collapse when there are many groups. Tracked per view+group-key
  // so switching views resets cleanly (each view has its own identity
  // map of expanded groups).
  const initiallyCollapsed = groups.length > AUTO_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Set of book IDs the user owns, built once and reused across the
  // pack group cards so each sheet can mark its own rows in O(1).
  // Declared here (not inside CollapsibleGroup) so it isn't rebuilt
  // per-group on every render — the set is identical across all
  // groups.
  const ownedIdSet = useMemo(() => new Set(ownedBookIds), [ownedBookIds]);

  // The map above is keyed by `${view}:${groupKey}` so it stays
  // meaningful after the user toggles views. Resetting on view change
  // would also be reasonable, but keeping prior expansions has been the
  // less-surprising behaviour when the user bounces between views.
  const isExpanded = (key: string) => {
    const explicit = expanded[`${view}:${key}`];
    return explicit ?? !initiallyCollapsed;
  };
  const toggle = (key: string) =>
    setExpanded((prev) => ({
      ...prev,
      [`${view}:${key}`]: !isExpanded(key),
    }));

  return (
    <div className="space-y-4 sm:space-y-6">
      {groups.map((g) => {
        // For pack groups, pull the manifest so the Info chip can
        // open the full-contents sheet. Group keys come out of
        // `groupCards` prefixed (`pack:${packId}`) — strip the prefix
        // to look up the raw ID. Non-pack views pass undefined and
        // the group card hides its Info affordance.
        const packId =
          view === "pack" && g.key.startsWith("pack:") ? g.key.slice("pack:".length) : null;
        const manifest = packId ? packManifests[packId] : undefined;
        return (
          <CollapsibleGroup
            key={g.key}
            group={g}
            view={view}
            expanded={isExpanded(g.key)}
            onToggle={() => toggle(g.key)}
            cardById={cardById}
            packManifest={manifest}
            ownedIdSet={ownedIdSet}
          />
        );
      })}
    </div>
  );
}

function CollapsibleGroup({
  group,
  view,
  expanded,
  onToggle,
  cardById,
  packManifest,
  ownedIdSet,
}: {
  group: { key: string; label: string; cards: ReadonlyArray<CardData> };
  view: GroupBy;
  expanded: boolean;
  onToggle: () => void;
  cardById: ReadonlyMap<string, CardData>;
  packManifest: PackManifestEntry | undefined;
  ownedIdSet: ReadonlySet<string>;
}) {
  // Preview strip — a handful of cover thumbnails shown in the collapsed
  // header so the user has visual recognition without expanding. Capped
  // at 5 so it fits on the narrowest viewport we support.
  const preview = group.cards.slice(0, 5);

  // Per-pack rarity breakdown — only shown inside the pack view. We use
  // `count` mode (not `progress`) because the page only has full
  // manifests for the editorial pack; showing raw owned counts works
  // uniformly across every pack without needing to fetch N pack
  // manifests. Computed from the group's resolved cards so it always
  // matches whatever is currently in view (search / sort aware).
  const showRarityRow = view === "pack";
  const rarityCountsForGroup = useMemo(() => {
    const resolved = group.cards
      .map((c) => cardById.get(c.id))
      .filter((c): c is CardData => !!c);
    return rarityCounts(resolved);
  }, [group.cards, cardById]);

  // "Contents" bottom sheet. Only available in pack view and only
  // when we successfully loaded the pack's manifest — otherwise the
  // sheet has nothing useful to show beyond what's already on screen.
  const [contentsOpen, setContentsOpen] = useState(false);
  const showContentsChip = view === "pack" && !!packManifest;

  return (
    <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
      {/* Header row — split into the toggle button (flex-1, covers
          most of the row) and the contents Info chip (sibling, not
          nested, so we don't break HTML by putting a button inside
          a button). The chip only shows in pack view and hides when
          we couldn't load a manifest for this pack. */}
      <div className="flex items-center gap-2 pr-2 sm:pr-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-3 text-left sm:px-4"
        >
          <ChevronDown
            aria-hidden
            className={`h-4 w-4 shrink-0 text-[var(--sea-ink-soft)] transition-transform ${
              expanded ? "rotate-0" : "-rotate-90"
            }`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h2 className="truncate text-sm font-semibold text-[var(--sea-ink)] sm:text-base">
                {group.label}
              </h2>
              <span className="shrink-0 text-xs uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                {group.cards.length}
              </span>
            </div>
          </div>
          {!expanded && preview.length > 0 && (
            <div aria-hidden className="hidden shrink-0 items-center sm:flex">
              {preview.map((c, i) => (
                <img
                  key={c.id}
                  src={c.coverUrl}
                  alt=""
                  loading="lazy"
                  className="h-10 w-7 rounded-sm border border-[var(--line)] object-cover shadow-sm"
                  style={{
                    marginLeft: i === 0 ? 0 : "-0.5rem",
                    zIndex: preview.length - i,
                  }}
                />
              ))}
            </div>
          )}
        </button>

        {showContentsChip && (
          <button
            type="button"
            onClick={() => setContentsOpen(true)}
            aria-label={`See what's in ${packManifest!.name}`}
            className="shrink-0 inline-flex items-center gap-1 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] sm:px-3 sm:py-1.5"
          >
            <Info aria-hidden className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Contents</span>
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-[var(--line)] px-3 pb-4 pt-4 sm:px-4">
          {showRarityRow && (
            <div className="mb-4">
              <RarityGemRow
                mode="count"
                counts={rarityCountsForGroup}
                scopeLabel="in this pack"
              />
            </div>
          )}
          <CardGrid cards={group.cards} cardById={cardById} />
        </div>
      )}

      {showContentsChip && packManifest && (
        <PackContentsSheet
          open={contentsOpen}
          onClose={() => setContentsOpen(false)}
          packName={packManifest.name}
          books={packManifest.books}
          ownedIds={ownedIdSet}
        />
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Grid + progress + empty state
// ─────────────────────────────────────────────────────────────────────────────

function CardGrid({
  cards,
  cardById,
}: {
  cards: ReadonlyArray<{ id: string }>;
  cardById: ReadonlyMap<string, CardData>;
}) {
  // Gate the grid behind a skeleton until the above-the-fold covers
  // have loaded. The largest grid (desktop lg) shows 5 columns × ~2
  // rows initially, so preloading 10 covers the visible area on every
  // breakpoint without over-fetching. Images past the tenth stay lazy
  // so long collections don't hammer the network up-front.
  const ABOVE_THE_FOLD = 10;
  const preloadUrls = useMemo(() => {
    const urls: string[] = [];
    for (const c of cards) {
      if (urls.length >= ABOVE_THE_FOLD) break;
      const card = cardById.get(c.id);
      if (card?.coverUrl) urls.push(card.coverUrl);
    }
    return urls;
  }, [cards, cardById]);
  // 5s ceiling per the design decision — a single slow/broken CDN
  // link should never keep the user staring at skeletons indefinitely.
  // After the timeout we reveal regardless and let the `<img>` tags
  // fall back to their natural broken-image behavior (Card already
  // renders a neutral tile when coverUrl is null).
  const ready = useImagesReady(preloadUrls, 5000);
  return (
    <div className="grid grid-cols-2 gap-4 justify-items-center sm:grid-cols-3 sm:gap-6 md:grid-cols-4 lg:grid-cols-5">
      {cards.map((c, i) => {
        const card = cardById.get(c.id);
        if (!card) return null;
        // While gating, render a skeleton for every cell so the
        // layout doesn't reflow on reveal. Swap to the real card
        // in one commit once images are ready (or the timeout
        // fires). Beyond the above-the-fold window, images lazy-
        // load as the user scrolls; no skeleton needed there.
        if (!ready) {
          return <CardSkeleton key={c.id} />;
        }
        return (
          <div key={c.id} className="flex w-full flex-col items-center gap-2">
            <Card
              card={card}
              detailHref={`/book/${c.id}`}
              // Pass lazy to off-fold cards so we only eagerly load
              // the first ten. `i` maps to grid position because the
              // parent sorted the list.
              coverLoading={i < ABOVE_THE_FOLD ? "eager" : "lazy"}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Placeholder tile that mirrors a `<Card>`'s outer dimensions and
 * 2:3 aspect ratio so the grid doesn't reflow when real cards
 * mount in. Uses the page's existing skeleton background token so
 * it reads as "loading" rather than "empty content". A soft
 * animated shimmer comes from the `.skeleton` utility in
 * styles.css — keeps the loading cue consistent across surfaces.
 */
function CardSkeleton() {
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <div
        aria-hidden
        className="skeleton aspect-[2/3] w-full max-w-[320px] rounded-2xl sm:max-w-[280px]"
      />
    </div>
  );
}

/**
 * Resolve to `true` once every URL in `urls` has either loaded or
 * errored, or after `timeoutMs` — whichever comes first. An empty
 * input set resolves immediately so an empty-grid render path
 * (filtered-to-nothing search) doesn't get stuck on a skeleton.
 *
 * Implementation uses raw `Image` objects rather than `<img>` tags
 * with `onLoad` handlers because we want to start the network
 * fetch *before* the grid actually renders — the skeleton's whole
 * job is to occupy the layout while the browser is hitting the
 * wire. Relying on render-time <img> elements would defer the
 * fetch until we've decided to show them, undoing the point.
 *
 * Each Image listener is cleaned up on unmount so an effect-
 * restart (cards prop changes mid-flight) doesn't leak or
 * race with stale resolutions from the prior URL set.
 */
function useImagesReady(urls: ReadonlyArray<string>, timeoutMs: number): boolean {
  const [ready, setReady] = useState(urls.length === 0);
  // Stabilise the dependency — a new array identity each render
  // would restart the effect every time even when the URLs are
  // unchanged. Joining gives a cheap structural key; the set is
  // small (≤10) so the string concat cost is negligible.
  const key = urls.join("|");
  useEffect(() => {
    if (urls.length === 0) {
      setReady(true);
      return;
    }
    setReady(false);
    let remaining = urls.length;
    let cancelled = false;
    const imgs: HTMLImageElement[] = [];
    const done = () => {
      if (cancelled) return;
      remaining -= 1;
      if (remaining <= 0) setReady(true);
    };
    for (const u of urls) {
      const img = new Image();
      // Both paths count toward "resolved" — an error shouldn't
      // leave us counting down forever. The user still gets the
      // neutral tile fallback on the real render.
      img.onload = done;
      img.onerror = done;
      img.src = u;
      imgs.push(img);
    }
    const t = window.setTimeout(() => {
      if (!cancelled) setReady(true);
    }, timeoutMs);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      // Detach handlers; browsers will keep the in-flight fetch
      // warm in cache so subsequent <img> uses are instant, but
      // we don't want stale `done` calls flipping state on a
      // swapped-out URL set.
      for (const img of imgs) {
        img.onload = null;
        img.onerror = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: stabilised via `key`
  }, [key, timeoutMs]);
  return ready;
}

function EmptyState() {
  return (
    <main className="page-wrap py-16 sm:py-24">
      <div className="mx-auto max-w-md text-center">
        <p className="island-kicker">Empty shelf</p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)]">
          Your collection is empty
        </h1>
        <p className="mt-4 text-sm text-[var(--sea-ink-soft)]">
          Rip your first pack to start building a library. Common books fill the shelf; legendaries
          are vanishingly rare.
        </p>
        <Link
          to="/rip"
          className="btn-primary mt-8 inline-flex rounded-full px-6 text-sm uppercase tracking-[0.16em]"
        >
          Open a pack
        </Link>
      </div>
    </main>
  );
}
