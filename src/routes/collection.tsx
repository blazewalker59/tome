import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { SlidersHorizontal, X } from "lucide-react";
import { Card } from "@/components/cards/Card";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import {
  filterCards,
  groupByGenre,
  rarityCounts,
  sortCards,
  uniqueGenres,
  uniqueMoods,
  type SortMode,
} from "@/lib/cards/filter";
import { RARITY_STYLES, formatGenre } from "@/lib/cards/style";
import type { CardData, Genre, Rarity } from "@/lib/cards/types";
import { getCollectionFn, getEditorialPackFn } from "@/server/collection";

/**
 * Collection route.
 *
 * Loader fetches the user's collection + the default pack (needed so the
 * rarity-progress bars can show "owned X / total Y"). Unauth'd users are
 * redirected to sign-in because a collection requires an account.
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
    const m = new Map<string, { packName: string; acquiredAt: number }>();
    for (const a of collection.acquisitions) {
      m.set(a.bookId, { packName: a.packName, acquiredAt: a.acquiredAt });
    }
    return m;
  }, [collection.acquisitions]);

  const [genreFilter, setGenreFilter] = useState<Set<Genre>>(new Set());
  const [rarityFilter, setRarityFilter] = useState<Set<Rarity>>(new Set());
  const [moodFilter, setMoodFilter] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [grouped, setGrouped] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filtered = useMemo(
    () =>
      filterCards(ownedCards, {
        genres: genreFilter,
        rarities: rarityFilter,
        moods: moodFilter,
        search,
      }),
    [ownedCards, genreFilter, rarityFilter, moodFilter, search],
  );

  const acquiredAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, info] of acquisitionMap) m.set(id, info.acquiredAt);
    return m;
  }, [acquisitionMap]);

  const sorted = useMemo(
    () => sortCards(filtered, sortMode, { acquiredAt }),
    [filtered, sortMode, acquiredAt],
  );

  const ownedRarityCounts = useMemo(() => rarityCounts(ownedCards), [ownedCards]);
  const totalRarityCounts = useMemo(() => rarityCounts(totalCards), [totalCards]);
  const genreOptions = useMemo(() => uniqueGenres(ownedCards), [ownedCards]);
  const moodOptions = useMemo(() => uniqueMoods(ownedCards), [ownedCards]);

  const activeFilterCount = genreFilter.size + rarityFilter.size + moodFilter.size;

  if (ownedCards.length === 0) {
    return <EmptyState />;
  }

  const filterBody = (
    <FiltersBody
      genreOptions={genreOptions}
      moodOptions={moodOptions}
      genreFilter={genreFilter}
      rarityFilter={rarityFilter}
      moodFilter={moodFilter}
      onGenreToggle={(v) => setGenreFilter(toggle(genreFilter, v))}
      onRarityToggle={(v) => setRarityFilter(toggle(rarityFilter, v))}
      onMoodToggle={(v) => setMoodFilter(toggle(moodFilter, v))}
      onClearAll={() => {
        setGenreFilter(new Set());
        setRarityFilter(new Set());
        setMoodFilter(new Set());
      }}
      activeCount={activeFilterCount}
    />
  );

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

      {/* Toolbar — search + sort + (mobile) filters button. Sticky on mobile so
          the user always has it within thumb reach while scrolling. */}
      <div className="sticky top-[64px] z-30 -mx-4 mt-6 mb-4 border-y border-[var(--line)] bg-[var(--header-bg)] px-4 py-3 backdrop-blur sm:relative sm:top-auto sm:mx-0 sm:rounded-2xl sm:border sm:border-[var(--line)] sm:bg-[var(--surface)] sm:px-4 sm:py-4">
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title or author"
            className="input-field min-h-[44px] flex-1 rounded-full px-4 text-sm"
          />
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="btn-secondary relative shrink-0 rounded-full px-4 text-sm sm:hidden"
            aria-label="Open filters"
          >
            <SlidersHorizontal aria-hidden className="h-4 w-4" />
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span className="ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-[var(--lagoon)] px-1.5 text-[10px] font-bold text-[var(--on-accent)]">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 sm:mt-4">
          <label className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
            Sort
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="input-field min-h-[36px] rounded-full px-3 text-xs font-semibold"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => setGrouped(e.target.checked)}
              className="h-4 w-4 accent-[var(--lagoon)]"
            />
            Group by genre
          </label>
        </div>

        {/* Desktop: filters render inline below the toolbar row. */}
        <div className="mt-4 hidden sm:block">{filterBody}</div>
      </div>

      {sorted.length === 0 ? (
        <p className="py-16 text-center text-sm text-[var(--sea-ink-soft)]">
          No cards match your filters.
        </p>
      ) : grouped ? (
        <div className="space-y-10">
          {groupByGenre(sorted).map((g) => (
            <section key={g.genre}>
              <h2 className="island-kicker mb-4">
                {formatGenre(g.genre)} · {g.cards.length}
              </h2>
              <CardGrid cards={g.cards} cardById={cardById} acquisitions={acquisitionMap} />
            </section>
          ))}
        </div>
      ) : (
        <CardGrid cards={sorted} cardById={cardById} acquisitions={acquisitionMap} />
      )}

      <BottomSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filters"
        footer={
          <button
            type="button"
            onClick={() => setFiltersOpen(false)}
            className="btn-primary w-full rounded-full px-6 text-sm uppercase tracking-[0.16em]"
          >
            Show {sorted.length} {sorted.length === 1 ? "book" : "books"}
          </button>
        }
      >
        {filterBody}
      </BottomSheet>
    </main>
  );
}

function FiltersBody({
  genreOptions,
  moodOptions,
  genreFilter,
  rarityFilter,
  moodFilter,
  onGenreToggle,
  onRarityToggle,
  onMoodToggle,
  onClearAll,
  activeCount,
}: {
  genreOptions: ReadonlyArray<Genre>;
  moodOptions: ReadonlyArray<string>;
  genreFilter: ReadonlySet<Genre>;
  rarityFilter: ReadonlySet<Rarity>;
  moodFilter: ReadonlySet<string>;
  onGenreToggle: (v: Genre) => void;
  onRarityToggle: (v: Rarity) => void;
  onMoodToggle: (v: string) => void;
  onClearAll: () => void;
  activeCount: number;
}) {
  return (
    <div className="space-y-4">
      {genreOptions.length > 0 && (
        <ChipGroup
          label="Genre"
          values={genreOptions}
          selected={genreFilter}
          onToggle={onGenreToggle}
          renderLabel={formatGenre}
        />
      )}

      <ChipGroup
        label="Rarity"
        values={ALL_RARITIES}
        selected={rarityFilter}
        onToggle={onRarityToggle}
        renderLabel={(r) => RARITY_STYLES[r].label}
      />

      {moodOptions.length > 0 && (
        <ChipGroup
          label="Mood"
          values={moodOptions}
          selected={moodFilter}
          onToggle={onMoodToggle}
          renderLabel={(m) => m}
        />
      )}

      {activeCount > 0 && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] underline-offset-4 hover:text-[var(--sea-ink)] hover:underline"
        >
          Clear all filters
        </button>
      )}
    </div>
  );
}

function CardGrid({
  cards,
  cardById,
  acquisitions,
}: {
  cards: ReadonlyArray<{ id: string }>;
  cardById: ReadonlyMap<string, CardData>;
  acquisitions: ReadonlyMap<string, { packName: string; acquiredAt: number }>;
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

function ChipGroup<T extends string>({
  label,
  values,
  selected,
  onToggle,
  renderLabel,
}: {
  label: string;
  values: ReadonlyArray<T>;
  selected: ReadonlySet<T>;
  onToggle: (v: T) => void;
  renderLabel: (v: T) => string;
}) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => {
          const active = selected.has(v);
          return (
            <button
              key={v}
              type="button"
              onClick={() => onToggle(v)}
              aria-pressed={active}
              className="chip rounded-full px-3.5 text-xs"
            >
              {renderLabel(v)}
            </button>
          );
        })}
      </div>
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

/**
 * Bottom sheet built on the native <dialog> element so we get backdrop +
 * focus trap + Esc-to-close for free. Slide-up animation via a CSS
 * transition on the inner panel triggered by an `is-open` class.
 */
function BottomSheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="bottom-sheet"
    >
      <div className="bottom-sheet-panel">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="display-title text-lg font-bold text-[var(--sea-ink)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="-m-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
          >
            <X aria-hidden className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto pb-2">{children}</div>
        {footer && <div className="mt-4 pt-2">{footer}</div>}
      </div>
    </dialog>
  );
}

function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
