import { Link, createFileRoute } from "@tanstack/react-router";
import { BookOpen, Layers, Library, Sparkles } from "lucide-react";
import { getCollectionFn, getEditorialPackFn } from "@/server/collection";
import {
  listReadingEntriesFn,
  type ReadingEntry,
} from "@/server/reading";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import { rarityCounts } from "@/lib/cards/filter";
import { RARITY_STYLES } from "@/lib/cards/style";
import type { Rarity } from "@/lib/cards/types";
import { RarityGemRow } from "@/components/RarityGemRow";

/**
 * Home route.
 *
 * The loader runs on the server during SSR and on the client thereafter.
 * `getEditorialPackFn` is public; `getCollectionFn` returns `null` for
 * anonymous callers rather than redirecting so the home page still
 * renders for signed-out visitors. `listReadingEntriesFn` requires a
 * session and throws otherwise, so we swallow the error to `null` —
 * the signed-in-only card only consults it when `collection` is also
 * non-null, so anonymous callers never see the broken-fetch fallback.
 *
 * The extra content (library glance, featured pack, explainer) exists
 * primarily so the page has real vertical height: on a phone, the
 * standalone-PWA safe-area inset for the bottom nav doesn't "settle"
 * until the viewport has something to scroll. Giving home genuine
 * content sidesteps that browser quirk entirely and, bonus, gives
 * repeat visitors something to land on.
 */
export const Route = createFileRoute("/")({
  loader: async () => {
    const [pack, collection, readingEntries] = await Promise.all([
      getEditorialPackFn(),
      getCollectionFn(),
      // Swallow the auth error for anonymous callers — the glance
      // card won't render without `collection`, so a null here is
      // harmless. Keeping the fetch in Promise.all (rather than a
      // post-collection branch) avoids a serial round-trip on the
      // fast path where the user is signed in.
      listReadingEntriesFn().catch(() => null),
    ]);
    return { pack, collection, readingEntries };
  },
  component: Home,
});

function Home() {
  const { pack, collection, readingEntries } = Route.useLoaderData();

  const packCards = pack.books.map(bookRowToCardData);
  const totalBooks = packCards.length;

  return (
    <main className="page-wrap space-y-6 px-4 pb-8 pt-6 sm:space-y-8 sm:pt-14">
      {/* Hero — three-beat headline mirrors the reading → ripping →
          building loop that drives the economy; the subhead spells
          the loop out for first-time visitors. */}
      <section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-5 py-8 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--lagoon)_45%,transparent),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--clay)_35%,transparent),transparent_66%)]" />
        <p className="island-kicker mb-3">Tome</p>
        <h1 className="display-title mb-4 max-w-3xl text-3xl leading-[1.05] font-bold tracking-tight text-[var(--sea-ink)] sm:mb-5 sm:text-6xl sm:leading-[1.02]">
          Read books. Rip packs. Build your own.
        </h1>
        <p className="mb-6 max-w-2xl text-sm text-[var(--sea-ink-soft)] sm:mb-8 sm:text-lg">
          Tome turns your reading life into a trading-card collection — log
          books to earn shards, rip packs to collect them, and build packs
          worth sharing.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Link to="/rip" className="btn-primary rounded-full px-5 text-sm">
            Rip a pack
          </Link>
          <Link to="/collection" className="btn-secondary rounded-full px-5 text-sm">
            View collection
          </Link>
          {/* Only surface the builder for signed-in users — anon
              visitors can't create a draft without an account, and the
              primary acquisition path is still "rip a pack first". */}
          {collection && (
            <Link to="/packs/new" className="btn-secondary rounded-full px-5 text-sm">
              Build a pack
            </Link>
          )}
          {/* Reading log also gated on sign-in: every entry lives on a
              user account, so an anon CTA would just bounce through
              sign-in. Placed next to Build a pack so the two creator
              actions sit together at the end of the hero row. */}
          {collection && (
            <Link to="/reading" className="btn-secondary rounded-full px-5 text-sm">
              Log a book
            </Link>
          )}
        </div>
      </section>

      {/* Signed-in: stats card. Hidden for anonymous users since the
          numbers would all be zero and the "View collection" CTA above
          already covers re-entry. */}
      {collection && (
        <LibraryGlanceCard
          collection={collection}
          readingEntries={readingEntries ?? []}
        />
      )}

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

/**
 * Three stacked rows — the shape of the loop at a glance:
 *
 *   1. "Now reading" — every entry currently in `reading` status.
 *   2. "Next up" — up to three TBR entries to seed the next session.
 *   3. "Recent rips" — last five unique pack pulls (data from the
 *      collection fn, unchanged).
 *
 * Each row is either a horizontal-scroll cover strip (when there's
 * something to show) or an empty-state CTA pointing at the route
 * that fixes it. No numeric stats (shards, completion, rarest) —
 * those live elsewhere and were mostly filler here.
 */
function LibraryGlanceCard({
  collection,
  readingEntries,
}: {
  collection: NonNullable<Awaited<ReturnType<typeof getCollectionFn>>>;
  readingEntries: ReadonlyArray<ReadingEntry>;
}) {
  // Server returns entries ordered by updated_at desc, so filtering
  // preserves recency. Reading can overflow the visible strip (horiz
  // scroll handles it); TBR caps at three to keep "next up" feeling
  // curated rather than an inbox.
  const reading = readingEntries.filter((e) => e.status === "reading");
  const nextUp = readingEntries.filter((e) => e.status === "tbr").slice(0, 3);

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

      <ReadingStrip
        label="Now reading"
        entries={reading}
        emptyCta={{
          href: "/reading",
          copy: "Nothing in progress. Start a book to earn 5 shards.",
          linkText: "Log a book →",
        }}
      />

      <ReadingStrip
        label="Next up"
        entries={nextUp}
        emptyCta={{
          href: "/reading",
          copy: "Shelf up to three books you want to read next.",
          linkText: "Add to TBR →",
        }}
      />

      {/* Recent rips — horizontal scroll row of the last 5 unique
          books. Hidden entirely when the user hasn't pulled anything
          yet so new accounts don't see a broken-looking empty row;
          the hero's "Rip a pack" CTA is the entry point for them. */}
      {collection.recentPulls.length > 0 && (
        <RecentPulls pulls={collection.recentPulls} />
      )}
    </section>
  );
}

/**
 * Horizontal-scroll strip of reading-entry covers. Shared between
 * "Now reading" and "Next up" — the only differences are the label,
 * the source list, and the empty-state copy, all passed in by the
 * caller. Covers link to the book detail page, not the reading list,
 * because tapping a specific cover signals "this one" rather than
 * "all of them".
 */
function ReadingStrip({
  label,
  entries,
  emptyCta,
}: {
  label: string;
  entries: ReadonlyArray<ReadingEntry>;
  emptyCta: { href: "/reading"; copy: string; linkText: string };
}) {
  return (
    <div className="mt-6 first:mt-0">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          {label}
        </p>
      </div>
      {entries.length === 0 ? (
        // Empty state sits inline rather than as a separate card so
        // the section rhythm stays consistent whether the user has
        // entries or not. Dashed border is the same "empty shelf"
        // affordance used on /packs and /collection.
        <div className="rounded-xl border border-dashed border-[var(--line)] p-4 text-xs text-[var(--sea-ink-soft)]">
          {emptyCta.copy}{" "}
          <Link
            to={emptyCta.href}
            className="font-semibold text-[var(--sea-ink)] underline-offset-4 hover:underline"
          >
            {emptyCta.linkText}
          </Link>
        </div>
      ) : (
        // Same scroll-bleed trick as RecentPulls — the row's overflow
        // container punches through the card's horizontal padding so
        // the strip reads as continuous while content stays aligned
        // to the padded gutter on both sides.
        <div className="-mx-5 overflow-x-auto px-5 py-1 sm:-mx-8 sm:px-8">
          <ul className="flex gap-3 snap-x snap-mandatory">
            {entries.map((e) => (
              <li key={e.bookId} className="shrink-0 snap-start">
                <Link
                  to="/book/$id"
                  params={{ id: e.bookId }}
                  className="block w-20 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-1.5 transition hover:-translate-y-0.5 hover:shadow-md"
                >
                  {e.book.coverUrl ? (
                    <img
                      src={e.book.coverUrl}
                      alt=""
                      loading="lazy"
                      className="h-24 w-full rounded-sm border border-[var(--line)] object-cover"
                    />
                  ) : (
                    <div className="flex h-24 w-full items-center justify-center rounded-sm border border-[var(--line)] bg-[var(--track-bg)] text-sm font-bold text-[var(--sea-ink-soft)]">
                      {e.book.title.slice(0, 1)}
                    </div>
                  )}
                  <p
                    className="mt-1 line-clamp-2 text-[10px] font-medium leading-tight text-[var(--sea-ink)]"
                    title={e.book.title}
                  >
                    {e.book.title}
                  </p>
                </Link>
              </li>
            ))}
            {/* Tail CTA mirrors RecentPulls so all three strips end
                with the same "see the whole list" affordance. */}
            <li className="shrink-0 snap-start">
              <Link
                to="/reading"
                className="flex h-full w-20 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] p-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
              >
                View all →
              </Link>
            </li>
          </ul>
        </div>
      )}
    </div>
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
  // Four beats to match the loop the hero names: reading mints the
  // currency, ripping spends it, the collection is the output, and
  // the builder feeds back in. Ordering matters — "Read" comes first
  // because it's the only one a signed-out visitor can do today
  // (shelf anything, no pack needed).
  const steps = [
    {
      icon: <BookOpen aria-hidden className="h-5 w-5" />,
      title: "Read",
      body: "Log what you're reading. Start a book for 5 shards, finish it for 100 — once per book, for any title in the catalog.",
    },
    {
      icon: <Sparkles aria-hidden className="h-5 w-5" />,
      title: "Rip",
      body: "Spend shards on curated packs. Each pull rolls for rarity — from common to legendary.",
    },
    {
      icon: <Library aria-hidden className="h-5 w-5" />,
      title: "Collect",
      body: "Books land in your library. Duplicates convert back to shards so no pull is wasted.",
    },
    {
      icon: <Layers aria-hidden className="h-5 w-5" />,
      title: "Build",
      body: "Curate your own packs from books you love and share them with other readers.",
    },
  ];

  return (
    <section className="island-shell rise-in rounded-[1.5rem] px-5 py-6 sm:px-8 sm:py-8">
      <p className="island-kicker">How Tome works</p>
      <h2 className="display-title mt-1 mb-5 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
        Four steps, endlessly replayable
      </h2>
      {/* 2x2 on phones so each card stays roomy, 4-across on desktop
          so the flow reads left-to-right. sm: threshold matches the
          rest of the page. */}
      <ol className="grid gap-3 grid-cols-2 sm:grid-cols-4">
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
