import { Link, createFileRoute } from "@tanstack/react-router";
import { BookOpen, Sparkles, Layers } from "lucide-react";
import { getCollectionFn, getEditorialPackFn } from "@/server/collection";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import { rarityCounts } from "@/lib/cards/filter";
import { RARITY_STYLES } from "@/lib/cards/style";
import type { Rarity } from "@/lib/cards/types";
import { RarityGemRow } from "@/components/RarityGemRow";

/**
 * Home route.
 *
 * The loader runs on the server during SSR and on the client thereafter.
 * Both `getEditorialPackFn` and `getCollectionFn` are tolerant of
 * anonymous callers — the pack is public, and the collection fn returns
 * `null` rather than redirecting so the home page still renders for
 * signed-out visitors. The extra content (stats card, featured pack)
 * exists primarily so the page has real vertical height: on a phone,
 * the standalone-PWA safe-area inset for the bottom nav doesn't
 * "settle" until the viewport has something to scroll. Giving home
 * genuine content sidesteps that browser quirk entirely and, bonus,
 * gives repeat visitors something to land on.
 */
export const Route = createFileRoute("/")({
  loader: async () => {
    const [pack, collection] = await Promise.all([
      getEditorialPackFn(),
      getCollectionFn(),
    ]);
    return { pack, collection };
  },
  component: Home,
});

function Home() {
  const { pack, collection } = Route.useLoaderData();

  const packCards = pack.books.map(bookRowToCardData);
  const totalBooks = packCards.length;

  return (
    <main className="page-wrap space-y-6 px-4 pb-8 pt-6 sm:space-y-8 sm:pt-14">
      {/* Hero — unchanged copy, the anchor of the page. */}
      <section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-5 py-8 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--lagoon)_45%,transparent),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--clay)_35%,transparent),transparent_66%)]" />
        <p className="island-kicker mb-3">Tome</p>
        <h1 className="display-title mb-4 max-w-3xl text-3xl leading-[1.05] font-bold tracking-tight text-[var(--sea-ink)] sm:mb-5 sm:text-6xl sm:leading-[1.02]">
          Rip packs. Collect books. Build decks.
        </h1>
        <p className="mb-6 max-w-2xl text-sm text-[var(--sea-ink-soft)] sm:mb-8 sm:text-lg">
          Tome turns your reading life into a trading-card collection. Open curated packs, discover
          books across every genre, and shape decks worth sharing.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Link to="/rip" className="btn-primary rounded-full px-5 text-sm">
            Rip a pack
          </Link>
          <Link to="/collection" className="btn-secondary rounded-full px-5 text-sm">
            View collection
          </Link>
        </div>
      </section>

      {/* Signed-in: stats card. Hidden for anonymous users since the
          numbers would all be zero and the "View collection" CTA above
          already covers re-entry. */}
      {collection && <LibraryGlanceCard collection={collection} packCards={packCards} />}

      {/* Featured pack — always rendered. Gives anonymous users a
          preview of what they're signing up for and returning users a
          quick summary of the current rotation. */}
      <FeaturedPackCard
        name={pack.name}
        description={pack.description}
        bookCount={totalBooks}
        rarityBreakdown={rarityCounts(packCards)}
      />

      {/* Evergreen 3-step explainer. Keeps the page tall even on a
          small phone and reinforces the core loop for newcomers. */}
      <HowItWorksCard />
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Library glance (signed-in only)
// ─────────────────────────────────────────────────────────────────────────────

function LibraryGlanceCard({
  collection,
  packCards,
}: {
  collection: NonNullable<Awaited<ReturnType<typeof getCollectionFn>>>;
  packCards: ReadonlyArray<{ id: string; title: string; rarity: Rarity }>;
}) {
  const ownedSet = new Set(collection.ownedBookIds);
  const ownedCards = packCards.filter((c) => ownedSet.has(c.id));
  const owned = ownedCards.length;
  const total = packCards.length;
  const pct = total === 0 ? 0 : Math.round((owned / total) * 100);

  // "Rarest pull" = the highest-tier card the user currently owns. Gives
  // the card a dash of personalisation without needing a new query.
  const RARITY_RANK: Record<Rarity, number> = {
    legendary: 4,
    foil: 3,
    rare: 2,
    uncommon: 1,
    common: 0,
  };
  const rarest = ownedCards.reduce<{ title: string; rarity: Rarity } | null>(
    (best, c) =>
      !best || RARITY_RANK[c.rarity] > RARITY_RANK[best.rarity] ? { title: c.title, rarity: c.rarity } : best,
    null,
  );

  return (
    <section className="island-shell rise-in rounded-[1.5rem] px-5 py-6 sm:px-8 sm:py-8">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <p className="island-kicker">Your library</p>
          <h2 className="display-title mt-1 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
            At a glance
          </h2>
        </div>
        <Link
          to="/collection"
          className="shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] underline-offset-4 hover:text-[var(--sea-ink)] hover:underline"
        >
          Open →
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Books" value={`${owned}`} hint={`of ${total}`} />
        <Stat label="Shards" value={`${collection.shardBalance}`} />
        <Stat
          label="Rarest"
          value={rarest ? RARITY_STYLES[rarest.rarity].label : "—"}
          hint={rarest?.title}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      {/* Completion bar — a single glance at pack progress. Uses the
          same token as the collection page so the visual language is
          consistent. */}
      <div className="mt-5">
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
          <span>Completion</span>
          <span className="text-[var(--sea-ink)]">{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--track-bg)]">
          <div className="h-full bg-[var(--lagoon)]" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Recent rips — horizontal scroll row of the last 5 unique
          books. Sits inside the glance card (rather than its own
          section) so signed-in users get a single cohesive "your
          library" block on the home page. Hidden entirely when the
          user hasn't pulled anything yet — an empty row would look
          broken next to the completion bar. */}
      {collection.recentPulls.length > 0 && (
        <RecentPulls pulls={collection.recentPulls} />
      )}
    </section>
  );
}

function RecentPulls({
  pulls,
}: {
  pulls: NonNullable<Awaited<ReturnType<typeof getCollectionFn>>>["recentPulls"];
}) {
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          Recent rips
        </p>
      </div>
      {/* Scroll-snap keeps each cover aligned on mobile swipes.
          `-mx-5 px-5` / `-mx-8 px-8` bleed the scroll area to the
          card edges so the row looks continuous while content
          stays aligned to the padded gutter. Vertical `py-1` gives
          rarity rings (up to 4px outside the tile) room to render
          without being clipped by the scroll container. */}
      <div className="-mx-5 overflow-x-auto px-5 py-1 sm:-mx-8 sm:px-8">
        <ul className="flex gap-3 snap-x snap-mandatory">
          {pulls.map((p) => {
            const style = RARITY_STYLES[p.rarity as Rarity];
            return (
              <li key={p.bookId} className="shrink-0 snap-start">
                <Link
                  to="/book/$id"
                  params={{ id: p.bookId }}
                  className={`block w-20 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-1.5 transition hover:-translate-y-0.5 hover:shadow-md ${style?.ring ?? ""}`}
                >
                  {p.coverUrl ? (
                    <img
                      src={p.coverUrl}
                      alt=""
                      loading="lazy"
                      className="h-24 w-full rounded-sm border border-[var(--line)] object-cover"
                    />
                  ) : (
                    // No cover → keep the footprint so the row stays
                    // aligned. A muted initial is quieter than an
                    // empty box and hints at the title.
                    <div className="flex h-24 w-full items-center justify-center rounded-sm border border-[var(--line)] bg-[var(--track-bg)] text-sm font-bold text-[var(--sea-ink-soft)]">
                      {p.title.slice(0, 1)}
                    </div>
                  )}
                  <p
                    className="mt-1 line-clamp-2 text-[10px] font-medium leading-tight text-[var(--sea-ink)]"
                    title={p.title}
                  >
                    {p.title}
                  </p>
                </Link>
              </li>
            );
          })}
          {/* Tail CTA — same dimensions as the cover tiles so the row
              has a clean end cap rather than trailing off. */}
          <li className="shrink-0 snap-start">
            <Link
              to="/collection"
              className="flex h-full w-20 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] p-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
            >
              View all →
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  className = "",
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 ${className}`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
        {label}
      </p>
      <p className="mt-1 text-lg font-bold text-[var(--sea-ink)]">{value}</p>
      {hint && (
        <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Featured pack
// ─────────────────────────────────────────────────────────────────────────────

function FeaturedPackCard({
  name,
  description,
  bookCount,
  rarityBreakdown,
}: {
  name: string;
  description: string | null;
  bookCount: number;
  rarityBreakdown: Record<Rarity, number>;
}) {
  return (
    <section className="island-shell rise-in rounded-[1.5rem] px-5 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="island-kicker">Featured pack</p>
          <h2 className="display-title mt-1 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
            {name}
          </h2>
          {description && (
            <p className="mt-2 max-w-xl text-sm text-[var(--sea-ink-soft)]">{description}</p>
          )}
          <p className="mt-3 text-xs uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
            {bookCount} books in the set
          </p>
        </div>
        <Link
          to="/rip"
          className="btn-primary shrink-0 self-start rounded-full px-5 text-sm"
        >
          <Sparkles aria-hidden className="h-4 w-4" />
          <span>Rip a pack</span>
        </Link>
      </div>

      {/* Rarity spread — shared RarityGemRow component in `count`
          mode. Matches the visual language on /collection (same
          tinted gems, same tap-to-open popovers) but swaps the
          progress ring for a soft tint since the pack has no
          owned-of-total dimension. */}
      <div className="mt-5">
        <RarityGemRow
          mode="count"
          counts={rarityBreakdown}
          scopeLabel="in this pack"
        />
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// How it works
// ─────────────────────────────────────────────────────────────────────────────

function HowItWorksCard() {
  const steps = [
    {
      icon: <Sparkles aria-hidden className="h-5 w-5" />,
      title: "Rip",
      body: "Open a curated pack. Each pull rolls for rarity — from common to legendary.",
    },
    {
      icon: <BookOpen aria-hidden className="h-5 w-5" />,
      title: "Collect",
      body: "Books land in your library. Duplicates convert to shards you can spend later.",
    },
    {
      icon: <Layers aria-hidden className="h-5 w-5" />,
      title: "Build",
      body: "Group your library by pack, author, or rarity. Deck-building arrives soon.",
    },
  ];

  return (
    <section className="island-shell rise-in rounded-[1.5rem] px-5 py-6 sm:px-8 sm:py-8">
      <p className="island-kicker">How Tome works</p>
      <h2 className="display-title mt-1 mb-5 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
        Three steps, endlessly replayable
      </h2>
      <ol className="grid gap-3 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4"
          >
            <div className="mb-2 flex items-center gap-2 text-[var(--lagoon)]">
              {s.icon}
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
                Step {i + 1}
              </span>
            </div>
            <h3 className="display-title text-base font-bold text-[var(--sea-ink)]">
              {s.title}
            </h3>
            <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
