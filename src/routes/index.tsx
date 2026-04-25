import { Link, createFileRoute } from "@tanstack/react-router";
import { BookOpen, Layers, Library, Sparkles } from "lucide-react";
import { CoverImage } from "@/components/CoverImage";
import {
  getCollectionFn,
  getRipPacksFn,
  type PackSummary,
} from "@/server/collection";
import {
  listReadingEntriesFn,
  type ReadingEntry,
} from "@/server/reading";
import { RARITY_STYLES } from "@/lib/cards/style";
import type { Rarity } from "@/lib/cards/types";
import { packGradient } from "@/lib/packs/gradient";

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
    const [packs, collection, readingEntries] = await Promise.all([
      getRipPacksFn(),
      getCollectionFn(),
      // Swallow the auth error for anonymous callers — the glance
      // card won't render without `collection`, so a null here is
      // harmless. Keeping the fetch in Promise.all (rather than a
      // post-collection branch) avoids a serial round-trip on the
      // fast path where the user is signed in.
      listReadingEntriesFn().catch(() => null),
    ]);
    return { packs, collection, readingEntries };
  },
  component: Home,
});

/**
 * Slugs we recognize as "Modern <Genre> Starter" packs. Filter is
 * conservative (prefix AND suffix) so any future editorial pack that
 * just happens to start with "modern-" doesn't accidentally land in
 * the featured strip — it has to be a starter too. Keeps the home
 * strip pinned to the curated five until we decide otherwise.
 */
const STARTER_PACK_SLUG_PREFIX = "modern-";
const STARTER_PACK_SLUG_SUFFIX = "-starter";

function isStarterPack(pack: PackSummary): boolean {
  return (
    pack.slug.startsWith(STARTER_PACK_SLUG_PREFIX) &&
    pack.slug.endsWith(STARTER_PACK_SLUG_SUFFIX)
  );
}

function Home() {
  const { packs, collection, readingEntries } = Route.useLoaderData();

  // Server sorts by createdAt DESC. We want a stable, human-readable
  // left-to-right ordering for the starter strip so the genres don't
  // shuffle whenever a pack is re-saved; alpha-by-slug gives that.
  const starterPacks = packs
    .filter(isStarterPack)
    .slice()
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

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
          <Link to="/library/collection" className="btn-secondary rounded-full px-5 text-sm">
            View collection
          </Link>
          {/* Reading log is gated on sign-in: every entry lives on a
              user account, so an anon CTA would just bounce through
              sign-in. The pack builder CTA used to sit here too but
              was removed from the hero — creating packs is a deeper
              power-user flow that shouldn't compete with the primary
              Rip / Collect loop on the landing surface. The builder
              is still reachable via the main nav and /packs routes
              for users who go looking for it. */}
          {collection && (
            <Link to="/library/reading" className="btn-secondary rounded-full px-5 text-sm">
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

      {/* Featured starters — always rendered. Gives anonymous users
          a preview of the curated rotation and returning users a
          fast lane into any of the five starter packs. Falls back
          gracefully to nothing when the catalog hasn't been seeded
          yet (local-dev first boot, smoke envs, etc.) — the page
          still has the hero + how-it-works strip to fill space. */}
      {starterPacks.length > 0 && <StarterPacksCard packs={starterPacks} />}

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
          to="/library/collection"
          className="shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] underline-offset-4 hover:text-[var(--sea-ink)] hover:underline"
        >
          Open →
        </Link>
      </div>

      <ReadingStrip
        label="Now reading"
        entries={reading}
        emptyCta={{
          href: "/library/reading",
          copy: "Nothing in progress. Start a book to earn 5 shards.",
          linkText: "Log a book →",
        }}
      />

      <ReadingStrip
        label="Next up"
        entries={nextUp}
        emptyCta={{
          href: "/library/reading",
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
  emptyCta: { href: "/library/reading"; copy: string; linkText: string };
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
          <ul className="flex items-stretch gap-3 snap-x snap-mandatory">
            {entries.map((e) => (
              <li key={e.bookId} className="shrink-0 snap-start">
                <Link
                  to="/book/$id"
                  params={{ id: e.bookId }}
                  aria-label={e.book.title}
                  title={e.book.title}
                  className="flex h-full w-20 flex-col rounded-lg border border-[var(--line)] bg-[var(--surface)] p-1.5 transition hover:-translate-y-0.5 hover:shadow-md"
                >
                  <CoverImage
                    src={e.book.coverUrl}
                    alt=""
                    loading="lazy"
                    className="h-24 w-full rounded-sm border border-[var(--line)] object-cover"
                    fallback={
                      // Covers the "no cover art" case. The title
                      // initial keeps the tile from reading as broken
                      // now that the explicit title bar is gone; the
                      // full title is still available via the link's
                      // title/aria-label for hover + assistive tech.
                      <div className="flex h-24 w-full items-center justify-center rounded-sm border border-[var(--line)] bg-[var(--track-bg)] text-sm font-bold text-[var(--sea-ink-soft)]">
                        {e.book.title.slice(0, 1)}
                      </div>
                    }
                  />
                </Link>
              </li>
            ))}
            {/* Tail CTA mirrors RecentPulls so all three strips end
                with the same "see the whole list" affordance. */}
            <li className="shrink-0 snap-start">
              <Link
                to="/library/reading"
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
        <ul className="flex items-stretch gap-3 snap-x snap-mandatory">
          {pulls.map((p) => {
            const style = RARITY_STYLES[p.rarity as Rarity];
            return (
              <li key={p.bookId} className="shrink-0 snap-start">
                <Link
                  to="/book/$id"
                  params={{ id: p.bookId }}
                  aria-label={p.title}
                  title={p.title}
                  className={`flex h-full w-20 flex-col rounded-lg border border-[var(--line)] bg-[var(--surface)] p-1.5 transition hover:-translate-y-0.5 hover:shadow-md ${style?.ring ?? ""}`}
                >
                  <CoverImage
                    src={p.coverUrl}
                    alt=""
                    loading="lazy"
                    className="h-24 w-full rounded-sm border border-[var(--line)] object-cover"
                    fallback={
                      // No cover → keep the footprint so the row stays
                      // aligned. A muted initial is quieter than an
                      // empty box and hints at the title; the full
                      // title is still available via hover + a11y
                      // label on the link itself.
                      <div className="flex h-24 w-full items-center justify-center rounded-sm border border-[var(--line)] bg-[var(--track-bg)] text-sm font-bold text-[var(--sea-ink-soft)]">
                        {p.title.slice(0, 1)}
                      </div>
                    }
                  />
                </Link>
              </li>
            );
          })}
          {/* Tail CTA — same dimensions as the cover tiles so the row
              has a clean end cap rather than trailing off. */}
          <li className="shrink-0 snap-start">
            <Link
              to="/library/collection"
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
// Starter packs strip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Row of mini pack tiles — one per "Modern <Genre> Starter" pack.
 * Each tile paints with its pack's bespoke gradient (see
 * `src/lib/packs/gradient.ts`) so the row reads as a spectrum, and
 * tapping anywhere on a tile deep-links into `/rip/$slug` for the
 * tear-open flow.
 *
 * Layout:
 *   - Horizontal scroll on phones so all five tiles stay legible
 *     without cramping each to < 60px wide. `snap-x` makes the swipe
 *     feel committed.
 *   - Five-across grid from the `sm:` breakpoint up, where there's
 *     room to show every tile at a readable size without scrolling.
 */
function StarterPacksCard({ packs }: { packs: ReadonlyArray<PackSummary> }) {
  return (
    <section className="island-shell rise-in rounded-[1.5rem] px-5 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="island-kicker">Starter packs</p>
          <h2 className="display-title mt-1 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
            Start your shelf
          </h2>
          <p className="mt-2 max-w-xl text-sm text-[var(--sea-ink-soft)]">
            Five hand-picked packs across the biggest modern genres —
            {" "}20 well-loved books each.
          </p>
        </div>
        <Link
          to="/rip"
          className="btn-secondary shrink-0 self-start rounded-full px-4 text-sm sm:self-end"
        >
          <Sparkles aria-hidden className="h-4 w-4" />
          <span>See all packs</span>
        </Link>
      </div>

      {/* 5-up grid on sm+, horizontal snap-scroll on narrow screens.
          The scroll area stays inside the card's padding — bleeding
          to the card edges made the tiles look unpadded against
          the island border. A touch of extra end-padding on the
          scroller preserves the "there's more" affordance on phones
          without sacrificing the inset. */}
      <div className="mt-5">
        <ul className="flex gap-3 overflow-x-auto pb-1 snap-x snap-mandatory sm:grid sm:grid-cols-5 sm:gap-4 sm:overflow-visible">
          {packs.map((pack) => (
            <li key={pack.id} className="snap-start shrink-0 w-[44%] sm:w-auto">
              <StarterPackTile pack={pack} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * One mini pack tile. 2:3 aspect matches the full-size pack seal on
 * /rip so tapping the tile is visually continuous with landing on
 * the rip surface (same gradient, same typography). Pack name prints
 * in the foil color over the gradient; book count sits under it as
 * a kicker.
 */
function StarterPackTile({ pack }: { pack: PackSummary }) {
  const gradient = packGradient(pack.slug, pack.genreTags);
  // When the pack has bespoke cover art, that art owns the tile —
  // the genre gradient is a fallback for un-art-directed packs, not
  // a frame to overlay on top of someone's cover. We still print the
  // pack name on top, so we lay a dark scrim under the label to keep
  // the type readable on any cover.
  const hasCover = Boolean(pack.coverImageUrl);
  // Every starter gradient is saturated/dark enough that the label
  // needs light parchment text — NOT the theme-reactive --on-accent,
  // which flips to a dark sea-ink on the light theme and turns the
  // pack name invisible against the plum/indigo/forest gradients.
  // Using the dark-theme on-accent hex directly pins readability.
  // Cover-art tiles use the same light text so the look stays
  // consistent across the row.
  const labelColor = "#f8f2e2";
  const labelColorSoft = "color-mix(in oklab, #f8f2e2 70%, transparent)";
  return (
    <Link
      to="/rip/$slug"
      params={{ slug: pack.slug }}
      className="group relative block aspect-[2/3] w-full overflow-hidden rounded-2xl shadow-lg outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--lagoon)]"
      style={{
        // Cover art replaces the gradient entirely; the gradient is
        // only laid down when there's no cover so user/editor packs
        // without art still get a genre-coded backdrop.
        background: hasCover ? undefined : gradient.background,
        color: labelColor,
        // Subtle glow that echoes the larger pack seals. Softer than
        // the rip carousel's so the home page doesn't look busy.
        // Reuse the genre glow even with cover art so the tile still
        // has a tinted halo on the page.
        boxShadow: `0 0 40px -16px ${gradient.glowColor}, 0 18px 32px -22px rgba(0, 0, 0, 0.45)`,
      }}
      aria-label={`Rip ${pack.name}`}
    >
      {hasCover && (
        <img
          src={pack.coverImageUrl ?? undefined}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          referrerPolicy="no-referrer"
        />
      )}
      <div className="relative flex h-full flex-col justify-between p-3">
        {/* Sparkle overlay — same dotted gradient as the full seal
            but lower opacity so the mini doesn't fight with its
            neighbours in a row of five. Skipped on cover-art tiles
            so the photograph isn't speckled. */}
        {!hasCover && (
          <div className="pointer-events-none absolute inset-0 opacity-15 [background-image:radial-gradient(circle_at_30%_20%,white,transparent_45%),radial-gradient(circle_at_70%_80%,white,transparent_45%)]" />
        )}
        {/* Bottom-up scrim under the label, only over cover art —
            keeps the kicker + title readable against any photo
            without dimming the whole image. */}
        {hasCover && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-[linear-gradient(to_top,rgba(0,0,0,0.7),transparent)]" />
        )}
        <div
          className="relative text-[9px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: labelColorSoft }}
        >
          Starter
        </div>
        <div className="relative">
          <h3 className="display-title text-sm font-bold leading-tight sm:text-base">
            {pack.name}
          </h3>
          <p
            className="mt-1 text-[10px] uppercase tracking-[0.14em]"
            style={{ color: labelColorSoft }}
          >
            {pack.bookCount} books
          </p>
        </div>
      </div>
    </Link>
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
