import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { BookOpen, ChevronDown, Gem } from "lucide-react";
import { Card } from "@/components/cards/Card";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import {
  groupCards,
  rarityCounts,
  sortCards,
  type GroupBy,
  type SortMode,
} from "@/lib/cards/filter";
import { RARITY_STYLES } from "@/lib/cards/style";
import type { CardData, Rarity } from "@/lib/cards/types";
import { getCollectionFn, getEditorialPackFn } from "@/server/collection";

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
    return { collection, pack };
  },
  component: CollectionPage,
});

const ALL_RARITIES: Rarity[] = ["common", "uncommon", "rare", "foil", "legendary"];

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
  const { collection, pack } = Route.useLoaderData();
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
  const { ownedCards, totalCards, cardById } = useMemo(() => {
    const allCards = pack.books.map(bookRowToCardData);
    const byId = new Map(allCards.map((c) => [c.id, c]));
    const ownedSet = new Set(collection.ownedBookIds);
    return {
      ownedCards: allCards.filter((c) => ownedSet.has(c.id)),
      totalCards: allCards,
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

  const ownedRarityCounts = useMemo(() => rarityCounts(ownedCards), [ownedCards]);
  const totalRarityCounts = useMemo(() => rarityCounts(totalCards), [totalCards]);

  if (ownedCards.length === 0) {
    return <EmptyState />;
  }

  return (
    <main className="page-wrap pb-6 pt-4 sm:py-12">
      <header className="mb-4 flex items-end justify-between gap-4 sm:mb-8">
        <div className="min-w-0">
          {/* Single-line header — no eyebrow kicker, since "Your
              library" above "Collection" repeated the same idea. */}
          <h1 className="display-title text-2xl font-bold text-[var(--sea-ink)] sm:text-4xl">
            Collection
          </h1>
        </div>
        {/* Stats: only books-owned now. Shards moved to the profile
            dropdown in the header — they're a per-user wallet, not a
            collection-page metric, and the header is the natural
            place for account chrome.
            Visual weight: the icon's stroke is beefed up (2.5) and
            sized slightly larger than the numerator so it reads at
            the same weight as the bold count. The denominator sits
            at a step smaller so the owned count is the primary
            figure and `/12` reads as a quiet reference. */}
        <dl className="flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] sm:gap-2.5 sm:text-xs sm:tracking-[0.16em]">
          <dt className="sr-only">Books owned</dt>
          <BookOpen
            aria-hidden
            className="h-5 w-5 text-[var(--sea-ink)] sm:h-6 sm:w-6"
          />
          <dd className="flex items-baseline tabular-nums leading-none">
            <span className="text-xs font-semibold text-[var(--sea-ink-soft)] sm:text-sm">
              {ownedCards.length}/
            </span>
            <span className="text-xl font-semibold text-[var(--sea-ink)] sm:text-2xl">
              {totalCards.length}
            </span>
          </dd>
        </dl>
      </header>

      <RarityProgress owned={ownedRarityCounts} total={totalRarityCounts} />

      {/* View switcher — the top-level pivot. Sits directly under the
          progress strip and above the toolbar so it reads as a primary
          navigation control, not a filter option. */}
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
        <GroupedView groups={groups} view={view} cardById={cardById} />
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
}: {
  groups: ReadonlyArray<{ key: string; label: string; cards: ReadonlyArray<CardData> }>;
  view: GroupBy;
  cardById: ReadonlyMap<string, CardData>;
}) {
  // Auto-collapse when there are many groups. Tracked per view+group-key
  // so switching views resets cleanly (each view has its own identity
  // map of expanded groups).
  const initiallyCollapsed = groups.length > AUTO_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
      {groups.map((g) => (
        <CollapsibleGroup
          key={g.key}
          group={g}
          expanded={isExpanded(g.key)}
          onToggle={() => toggle(g.key)}
          cardById={cardById}
        />
      ))}
    </div>
  );
}

function CollapsibleGroup({
  group,
  expanded,
  onToggle,
  cardById,
}: {
  group: { key: string; label: string; cards: ReadonlyArray<CardData> };
  expanded: boolean;
  onToggle: () => void;
  cardById: ReadonlyMap<string, CardData>;
}) {
  // Preview strip — a handful of cover thumbnails shown in the collapsed
  // header so the user has visual recognition without expanding. Capped
  // at 5 so it fits on the narrowest viewport we support.
  const preview = group.cards.slice(0, 5);

  return (
    <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left sm:px-4"
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
          <div
            aria-hidden
            className="hidden shrink-0 items-center sm:flex"
          >
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

      {expanded && (
        <div className="border-t border-[var(--line)] px-3 pb-4 pt-4 sm:px-4">
          <CardGrid cards={group.cards} cardById={cardById} />
        </div>
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
  return (
    <div className="grid grid-cols-2 gap-4 justify-items-center sm:grid-cols-3 sm:gap-6 md:grid-cols-4 lg:grid-cols-5">
      {cards.map((c) => {
        const card = cardById.get(c.id);
        if (!card) return null;
        return (
          <div key={c.id} className="flex w-full flex-col items-center gap-2">
            <Card card={card} detailHref={`/book/${c.id}`} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Short descriptors used in the per-rarity popover. Kept here (rather
 * than alongside RARITY_STYLES) because the phrasing is route-specific
 * flavour text — the style module should stay purely visual.
 */
const RARITY_BLURBS: Record<Rarity, string> = {
  common: "Everyday pulls. The backbone of every library.",
  uncommon: "A cut above — showing up in most packs but not every one.",
  rare: "Scarce. Expect a handful across a full set.",
  foil: "Iridescent finishes on standout titles. Always a moment.",
  legendary: "Vanishingly rare. The marquee pulls of the set.",
};

/**
 * Condensed rarity row. Each rarity is a tinted gem icon whose outer
 * ring fills to show owned/total progress. Tapping a gem opens a
 * small popover anchored below it with the exact stats plus a short
 * blurb explaining the rarity tier. Only one popover is open at a
 * time; clicking outside or hitting Escape closes it.
 */
function RarityProgress({
  owned,
  total,
}: {
  owned: Record<Rarity, number>;
  total: Record<Rarity, number>;
}) {
  const [openRarity, setOpenRarity] = useState<Rarity | null>(null);
  const containerRef = useRef<HTMLUListElement>(null);

  // Close on outside click / Escape. The listener is only attached
  // while a popover is open so we're not paying for it on every
  // render, and it's removed on cleanup to avoid leaks.
  useEffect(() => {
    if (openRarity === null) return;

    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpenRarity(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenRarity(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [openRarity]);

  return (
    <ul
      ref={containerRef}
      className="flex items-start justify-between gap-2 sm:justify-start sm:gap-4"
    >
      {ALL_RARITIES.map((r) => {
        const o = owned[r];
        const t = total[r];
        const style = RARITY_STYLES[r];
        const hasAny = o > 0;
        // Percentage completion drives the conic-gradient sweep. Guard
        // against divide-by-zero (possible if a rarity has no books in
        // the set — unlikely but cheaper to guard than to debug later).
        const pct = t === 0 ? 0 : Math.round((o / t) * 100);
        const open = openRarity === r;
        return (
          <li
            key={r}
            className="relative flex flex-1 flex-col items-center gap-1 sm:flex-none"
          >
            <button
              type="button"
              onClick={() => setOpenRarity((cur) => (cur === r ? null : r))}
              aria-expanded={open}
              aria-haspopup="dialog"
              aria-label={`${style.label}: ${o} of ${t} owned. Tap for details.`}
              className="flex flex-col items-center gap-1 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lagoon)]"
            >
              {/* Conic-gradient ring doubles as the progress indicator:
                  the filled arc sweeps from the top clockwise in the
                  rarity's color, and the remainder falls back to the
                  neutral track color. A nested element with the
                  surface bg masks the center so only a 3px ring shows. */}
              <span
                className="relative flex h-10 w-10 items-center justify-center rounded-full"
                style={{
                  background: `conic-gradient(var(--rarity-${r}) ${pct}%, var(--track-bg) ${pct}% 100%)`,
                  opacity: hasAny ? 1 : 0.4,
                }}
              >
                <span className="flex h-[calc(100%-6px)] w-[calc(100%-6px)] items-center justify-center rounded-full bg-[var(--surface)]">
                  <Gem
                    aria-hidden
                    className="h-5 w-5"
                    style={{ color: `var(--rarity-${r})` }}
                    strokeWidth={2}
                    fill={hasAny ? `var(--rarity-${r})` : "none"}
                    fillOpacity={hasAny ? 0.2 : 0}
                  />
                </span>
              </span>
              {/* Owned / total — full fraction. Numerator takes the ink
                  color when non-zero so it pops against the muted
                  denominator. */}
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sea-ink-soft)] tabular-nums">
                <span className={hasAny ? "text-[var(--sea-ink)]" : undefined}>{o}</span>
                <span aria-hidden>/</span>
                {t}
              </span>
            </button>

            {open && (
              <RarityPopover
                rarity={r}
                label={style.label}
                owned={o}
                total={t}
                pct={pct}
                blurb={RARITY_BLURBS[r]}
                // Pin the popover to the row edges for the outermost
                // gems so it doesn't clip off-screen on narrow
                // viewports. Middle three stay centered under their
                // gem. ALL_RARITIES index === column index.
                align={
                  ALL_RARITIES.indexOf(r) === 0
                    ? "start"
                    : ALL_RARITIES.indexOf(r) === ALL_RARITIES.length - 1
                      ? "end"
                      : "center"
                }
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Anchored popover for a single rarity. Positioned absolutely below
 * the gem button. The `align` prop shifts the popover horizontally so
 * end-of-row gems don't clip off the viewport on narrow screens —
 * `start` pins the popover's left edge under the gem, `end` pins the
 * right edge, `center` (default) centers it. The arrow notch moves
 * with the popover so it always points at the gem.
 */
function RarityPopover({
  rarity,
  label,
  owned,
  total,
  pct,
  blurb,
  align = "center",
}: {
  rarity: Rarity;
  label: string;
  owned: number;
  total: number;
  pct: number;
  blurb: string;
  align?: "start" | "center" | "end";
}) {
  // Popover position — translate the container so its chosen edge
  // sits under the gem's horizontal center. The arrow stays visually
  // anchored to the gem by using the inverse offset.
  const containerPos =
    align === "start"
      ? "left-1/2 -translate-x-3"
      : align === "end"
        ? "right-1/2 translate-x-3"
        : "left-1/2 -translate-x-1/2";
  const arrowPos =
    align === "start"
      ? "left-3"
      : align === "end"
        ? "right-3"
        : "left-1/2 -translate-x-1/2";

  return (
    <div
      role="dialog"
      aria-label={`${label} rarity details`}
      className={`absolute top-full z-40 mt-2 w-[14rem] rounded-xl border border-[var(--line)] bg-[var(--foam)] p-3 text-left shadow-lg ${containerPos}`}
    >
      {/* Arrow / notch pointing at the gem. Pure CSS triangle built
          from a rotated square so the border shows on two sides —
          matches the popover's border + background. */}
      <span
        aria-hidden
        className={`absolute -top-1.5 h-3 w-3 rotate-45 border-l border-t border-[var(--line)] bg-[var(--foam)] ${arrowPos}`}
      />
      <div className="flex items-center gap-2">
        <Gem
          aria-hidden
          className="h-4 w-4 shrink-0"
          style={{ color: `var(--rarity-${rarity})` }}
          strokeWidth={2}
          fill={`var(--rarity-${rarity})`}
          fillOpacity={0.25}
        />
        <p className="text-sm font-bold text-[var(--sea-ink)]">{label}</p>
        <p className="ml-auto text-[11px] font-semibold tabular-nums text-[var(--sea-ink-soft)]">
          {owned}/{total} · {pct}%
        </p>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[var(--sea-ink-soft)]">
        {blurb}
      </p>
    </div>
  );
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
