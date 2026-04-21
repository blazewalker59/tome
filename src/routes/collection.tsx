import { useMemo, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
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
 */
export const Route = createFileRoute("/collection")({
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

  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [view, setView] = useState<GroupBy>("all");

  // Search filter — simple case-insensitive match on title + authors.
  // We do it inline rather than go through `filterCards` since the chip
  // filters are gone; keeping it inline avoids re-introducing the whole
  // CollectionFilter surface for a one-field check.
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
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8">
        <p className="island-kicker">Your library</p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          Collection
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          <span>
            <span className="text-[var(--sea-ink)]">{ownedCards.length}</span> /{" "}
            {totalCards.length} books
          </span>
          <span aria-hidden>·</span>
          <span>
            Shards <span className="text-[var(--sea-ink)]">{collection.shardBalance}</span>
          </span>
        </div>
      </header>

      <RarityProgress owned={ownedRarityCounts} total={totalRarityCounts} />

      {/* View switcher — the top-level pivot. Sits directly under the
          progress strip and above the toolbar so it reads as a primary
          navigation control, not a filter option. */}
      <ViewTabs value={view} onChange={setView} />

      {/* Toolbar — search + sort. Sticky on mobile so the user always has
          it within thumb reach while scrolling. Filters are gone: search
          + view covers the use cases that used to need chips. */}
      <div className="sticky top-[64px] z-30 -mx-4 mt-4 mb-4 border-y border-[var(--line)] bg-[var(--header-bg)] px-4 py-3 backdrop-blur sm:relative sm:top-auto sm:mx-0 sm:rounded-2xl sm:border sm:border-[var(--line)] sm:bg-[var(--surface)] sm:px-4 sm:py-3">
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title or author"
            className="input-field min-h-[44px] flex-1 rounded-full px-4 text-sm"
          />
          <label className="flex shrink-0 items-center gap-2 text-xs uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
            <span className="hidden sm:inline">Sort</span>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
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
        <CardGrid
          cards={sorted}
          cardById={cardById}
          acquisitions={acquisitionMap}
        />
      ) : (
        <GroupedView
          groups={groups}
          view={view}
          cardById={cardById}
          acquisitions={acquisitionMap}
        />
      )}
    </main>
  );
}

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
      className="view-tabs mt-5 mb-2 flex gap-2 overflow-x-auto"
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
  acquisitions,
}: {
  groups: ReadonlyArray<{ key: string; label: string; cards: ReadonlyArray<CardData> }>;
  view: GroupBy;
  cardById: ReadonlyMap<string, CardData>;
  acquisitions: ReadonlyMap<
    string,
    { packId: string | null; packName: string; acquiredAt: number }
  >;
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
          acquisitions={acquisitions}
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
  acquisitions,
}: {
  group: { key: string; label: string; cards: ReadonlyArray<CardData> };
  expanded: boolean;
  onToggle: () => void;
  cardById: ReadonlyMap<string, CardData>;
  acquisitions: ReadonlyMap<
    string,
    { packId: string | null; packName: string; acquiredAt: number }
  >;
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
          <CardGrid cards={group.cards} cardById={cardById} acquisitions={acquisitions} />
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
  acquisitions,
}: {
  cards: ReadonlyArray<{ id: string }>;
  cardById: ReadonlyMap<string, CardData>;
  acquisitions: ReadonlyMap<
    string,
    { packId: string | null; packName: string; acquiredAt: number }
  >;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 justify-items-center sm:grid-cols-3 sm:gap-6 md:grid-cols-4 lg:grid-cols-5">
      {cards.map((c) => {
        const card = cardById.get(c.id);
        if (!card) return null;
        const meta = acquisitions.get(c.id);
        return (
          <div key={c.id} className="flex w-full flex-col items-center gap-2">
            <Card card={card} />
            {meta && (
              <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                {meta.packName}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RarityProgress({
  owned,
  total,
}: {
  owned: Record<Rarity, number>;
  total: Record<Rarity, number>;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {ALL_RARITIES.map((r) => {
        const o = owned[r];
        const t = total[r];
        const pct = t === 0 ? 0 : Math.round((o / t) * 100);
        const style = RARITY_STYLES[r];
        return (
          <div
            key={r}
            className={`rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 backdrop-blur ${style.ring}`}
          >
            <p className="island-kicker">{style.label}</p>
            <p className="mt-1 text-lg font-bold text-[var(--sea-ink)]">
              {o}
              <span className="text-sm font-normal text-[var(--sea-ink-soft)]">
                {" / "}
                {t}
              </span>
            </p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--track-bg)]">
              <div className="h-full bg-[var(--lagoon)]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
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
