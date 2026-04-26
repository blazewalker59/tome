/**
 * /feed — two-tab feed surface.
 *
 * Tab `social` (default): chronological list of events from people the
 * viewer follows — packs they publish + legendary cards they pull. The
 * empty state surfaces suggested *creators* (with inline Follow buttons)
 * and trending public packs so a brand-new user can populate their feed
 * in one tap each, instead of being told to "go find people."
 *
 * Tab `you`: the viewer's own rip history — every pack they've opened,
 * one card per rip, with the rarest card highlighted and an expandable
 * view of every pulled book. Gives the page intrinsic value before the
 * social graph fills in: even with zero follows, you have a personal
 * artifact log to scroll through.
 *
 * Tab is bound to a `?tab=` search param so the choice survives
 * reload + back-button + share. When a signed-in viewer with no social
 * activity lands on the default tab (`social`), the loader auto-redirects
 * to `?tab=you` so the page is never empty for them; this is preferable
 * to flashing the dead state on first paint.
 */

import { useState } from "react";
import {
  createFileRoute,
  Link,
  useNavigate,
  redirect,
} from "@tanstack/react-router";

import {
  getFollowFeedFn,
  getMyRipsFn,
  getSuggestedCreatorsFn,
  type FollowFeedEvent,
  type FollowFeedPayload,
  type LegendaryPullEvent,
  type MyRipEvent,
  type MyRipsPayload,
  type MyRipCard,
  type PackPublishedEvent,
  type SuggestedCreator,
  type SuggestedCreatorsPayload,
} from "@/server/social";
import { CoverImage } from "@/components/CoverImage";
import { FollowButton } from "@/components/FollowButton";
import { packGradient } from "@/lib/packs/gradient";
import { RARITY_STYLES } from "@/lib/cards/style";

// Accepted tab values. Declared once so the search validator + UI keep
// in sync; the `as const` lets us derive the union cleanly.
const TAB_VALUES = ["social", "you"] as const;
type FeedTab = (typeof TAB_VALUES)[number];

interface FeedSearch {
  /** Active tab. Omitted from URL when at default ("social") so a
   *  plain `/feed` link stays clean. */
  tab?: FeedTab;
}

function parseFeedSearch(raw: Record<string, unknown>): FeedSearch {
  const out: FeedSearch = {};
  const tab = raw.tab;
  if (typeof tab === "string" && (TAB_VALUES as readonly string[]).includes(tab)) {
    out.tab = tab as FeedTab;
  }
  return out;
}

export const Route = createFileRoute("/feed")({
  validateSearch: parseFeedSearch,
  // Re-run the loader when the tab changes so each tab fetches its own
  // payload server-side. Cheap — the inactive tab's data isn't fetched
  // (the loader branches on `tab`), so the cost is one query per
  // navigation.
  loaderDeps: ({ search }) => ({ tab: search.tab ?? "social" }),
  loader: async ({ deps }) => {
    if (deps.tab === "you") {
      const myRips = await getMyRipsFn();
      return { tab: "you" as const, myRips };
    }

    // Social tab: fetch the feed + suggested creators in parallel.
    // The two are unrelated queries and both are needed for either
    // the populated path (feed) or the empty-state path (creators).
    const [feed, suggested] = await Promise.all([
      getFollowFeedFn(),
      getSuggestedCreatorsFn(),
    ]);

    // Auto-switch heuristic: signed-in viewer with an empty social
    // feed → bounce to the You tab IF they have any rip history,
    // since that surface is more valuable to them than the empty
    // social state. Brand-new users (no follows AND no rips) stay on
    // social so the suggested creators carry the page.
    //
    // The peek is a cheap `limit: 1` MyRips fetch — one indexed query
    // against `pack_rips_user_idx`. Only runs on the empty-feed path.
    if (feed.signedIn && feed.events.length === 0) {
      const peek = await getMyRipsFn({ data: { limit: 1 } });
      if (peek.events.length > 0) {
        throw redirect({ to: "/feed", search: { tab: "you" } });
      }
    }

    return { tab: "social" as const, feed, suggested };
  },
  component: FeedPage,
});

function FeedPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const activeTab: FeedTab = search.tab ?? "social";

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-5 sm:mb-8">
        <h1 className="display-title text-2xl font-bold text-[var(--sea-ink)] sm:text-3xl">
          Your feed
        </h1>
        <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
          {activeTab === "social"
            ? "Packs and pulls from creators you follow."
            : "Every pack you've opened."}
        </p>
      </header>

      <FeedTabs active={activeTab} />

      <div className="mt-5 sm:mt-6">
        {data.tab === "social" ? (
          <SocialTab feed={data.feed} suggested={data.suggested} />
        ) : (
          <YouTab myRips={data.myRips} />
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Tab strip

function FeedTabs({ active }: { active: FeedTab }) {
  // Two pill links — same `view-tabs` / `view-tab` utility classes
  // used elsewhere (library/collection, library/reading) so the tab
  // chrome looks identical across the app.
  const tabs: ReadonlyArray<{ key: FeedTab; label: string }> = [
    { key: "social", label: "Social" },
    { key: "you", label: "You" },
  ];
  return (
    <div role="tablist" aria-label="Feed view" className="view-tabs flex gap-2">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            to="/feed"
            // Default tab omitted from URL for cleanliness — matches
            // the `parseFeedSearch` contract (unknown / missing →
            // social). Only the non-default tab gets the param.
            search={t.key === "social" ? {} : { tab: t.key }}
            role="tab"
            aria-selected={isActive}
            className={`view-tab ${isActive ? "is-active" : ""}`}
            // Avoid a full router transition when already on the tab.
            // TanStack handles this correctly by default; the explicit
            // class swap above is what matters for ARIA.
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Social tab

function SocialTab({
  feed,
  suggested,
}: {
  feed: FollowFeedPayload;
  suggested: SuggestedCreatorsPayload;
}) {
  // Local pagination state seeded from the loader. "Load older"
  // appends to the array rather than refetching the head — same
  // pattern as before the tabs refactor.
  const [events, setEvents] = useState<ReadonlyArray<FollowFeedEvent>>(
    feed.events,
  );
  const [cursor, setCursor] = useState<number | null>(feed.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadOlder = async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await getFollowFeedFn({ data: { before: cursor } });
      setEvents((prev) => [...prev, ...next.events]);
      setCursor(next.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  if (!feed.signedIn) {
    return (
      <section className="flex min-h-[40vh] flex-col items-center justify-center text-center">
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Sign in to see packs and pulls from creators you follow.
        </p>
        <Link
          to="/sign-in"
          className="btn-primary mt-5 inline-flex items-center justify-center rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em]"
        >
          Sign in
        </Link>
        {/* Even signed-out viewers get suggestions below — the
            sign-in CTA is the primary action, but seeing real
            creators makes the value proposition concrete. */}
        <div className="mt-10 w-full">
          <SuggestedCreatorsSection creators={suggested.creators} />
        </div>
      </section>
    );
  }

  if (events.length === 0) {
    return (
      <div className="space-y-8">
        <p className="rounded-2xl border border-dashed border-[var(--line)] p-5 text-center text-xs text-[var(--sea-ink-soft)]">
          {feed.followingCount === 0
            ? "You're not following anyone yet. Follow a few creators below to fill your feed."
            : "The people you follow have been quiet. Discover more creators below."}
        </p>
        <SuggestedCreatorsSection creators={suggested.creators} />
        <TrendingPacksSection packs={feed.suggestions} />
      </div>
    );
  }

  return (
    <>
      <ul className="space-y-4">
        {events.map((event) =>
          event.type === "pack_published" ? (
            <li key={event.id}>
              <PackPublishedCard event={event} />
            </li>
          ) : (
            <li key={event.id}>
              <LegendaryPullCard event={event} />
            </li>
          ),
        )}
      </ul>

      {cursor !== null && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => {
              void loadOlder();
            }}
            disabled={loadingMore}
            className="btn-secondary inline-flex items-center justify-center rounded-full px-5 py-2 text-xs uppercase tracking-[0.16em] disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load older"}
          </button>
        </div>
      )}

      {/* Footer suggestions: even when the feed is populated, surface a
          few creators / packs to keep the social graph growing. Smaller
          headings here than the empty-state version. */}
      <div className="mt-12 space-y-8">
        <SuggestedCreatorsSection creators={suggested.creators} variant="footer" />
      </div>
    </>
  );
}

function SuggestedCreatorsSection({
  creators,
  variant = "primary",
}: {
  creators: ReadonlyArray<SuggestedCreator>;
  variant?: "primary" | "footer";
}) {
  if (creators.length === 0) return null;
  return (
    <section aria-labelledby="feed-creators-heading">
      <h2
        id="feed-creators-heading"
        className={
          variant === "primary"
            ? "island-kicker mb-3"
            : "island-kicker mb-3 opacity-80"
        }
      >
        {variant === "primary" ? "Creators to follow" : "More creators"}
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {creators.map((c) => (
          <li key={c.id}>
            <SuggestedCreatorCard creator={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SuggestedCreatorCard({ creator }: { creator: SuggestedCreator }) {
  // Activity blurb: prefer the larger of the two signals to lead
  // (e.g. "12 packs published" beats "3 legendaries pulled" if both
  // are truthy). Falls back to "active recently" if score is zero —
  // shouldn't happen given the SQL filter, but defensive.
  const activity =
    creator.packsPublished >= creator.legendariesPulled
      ? creator.packsPublished > 0
        ? `${creator.packsPublished} pack${creator.packsPublished === 1 ? "" : "s"} this month`
        : "Active recently"
      : `${creator.legendariesPulled} legendar${creator.legendariesPulled === 1 ? "y" : "ies"} this month`;

  return (
    <article className="island-shell flex items-center gap-3 rounded-3xl p-4">
      <Link
        to="/u/$username"
        params={{ username: creator.username }}
        className="flex flex-1 items-center gap-3 no-underline"
      >
        {creator.avatarUrl ? (
          <img
            src={creator.avatarUrl}
            alt=""
            className="h-12 w-12 flex-shrink-0 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="h-12 w-12 flex-shrink-0 rounded-full bg-[linear-gradient(135deg,var(--lagoon),var(--palm))]" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
            {creator.displayName ?? creator.username}
          </p>
          <p className="truncate text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
            @{creator.username} · {activity}
          </p>
        </div>
      </Link>
      {/* Inline Follow button — the whole point of these cards. The
          button reverts on error and pushes a toast; we don't react
          to the onChange callback here because there's no count
          display on the card to update (kept the card minimal). */}
      <FollowButton username={creator.username} initialFollowing={false} />
    </article>
  );
}

function TrendingPacksSection({
  packs,
}: {
  packs: ReadonlyArray<FollowFeedPayload["suggestions"][number]>;
}) {
  if (packs.length === 0) return null;
  return (
    <section aria-labelledby="feed-trending-heading">
      <h2 id="feed-trending-heading" className="island-kicker mb-3">
        Trending packs
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {packs.map((s) => (
          <li key={s.id}>
            <Link
              to="/u/$username/$slug"
              params={{ username: s.creatorUsername, slug: s.slug }}
              className="island-shell flex h-full flex-col gap-2 rounded-3xl p-4 no-underline hover:border-[var(--lagoon)]"
            >
              {s.coverImageUrl ? (
                <img
                  src={s.coverImageUrl}
                  alt=""
                  className="aspect-[2/1] w-full rounded-2xl object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div
                  className="aspect-[2/1] w-full rounded-2xl"
                  style={{
                    background: packGradient(s.slug, s.genreTags).background,
                  }}
                />
              )}
              <p className="text-sm font-semibold text-[var(--sea-ink)]">
                {s.name}
              </p>
              <p className="text-xs text-[var(--sea-ink-soft)]">
                by @{s.creatorUsername}
              </p>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-center text-xs text-[var(--sea-ink-soft)]">
        Browse more in{" "}
        <Link
          to="/rip"
          className="font-medium text-[var(--sea-ink)] underline decoration-dotted underline-offset-2"
        >
          the rip hub
        </Link>
        .
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// You tab

function YouTab({ myRips }: { myRips: MyRipsPayload }) {
  const navigate = useNavigate();
  const [events, setEvents] = useState<ReadonlyArray<MyRipEvent>>(myRips.events);
  const [cursor, setCursor] = useState<number | null>(myRips.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadOlder = async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await getMyRipsFn({ data: { before: cursor } });
      setEvents((prev) => [...prev, ...next.events]);
      setCursor(next.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  if (events.length === 0) {
    return (
      <section className="flex min-h-[40vh] flex-col items-center justify-center text-center">
        <p className="text-sm text-[var(--sea-ink-soft)]">
          You haven't ripped any packs yet. Open one to start your collection.
        </p>
        <button
          type="button"
          onClick={() => {
            void navigate({ to: "/rip" });
          }}
          className="btn-primary mt-5 inline-flex items-center justify-center rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em]"
        >
          Browse packs
        </button>
      </section>
    );
  }

  return (
    <>
      <ul className="space-y-4">
        {events.map((event) => (
          <li key={event.id}>
            <RipHistoryCard event={event} />
          </li>
        ))}
      </ul>

      {cursor !== null && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => {
              void loadOlder();
            }}
            disabled={loadingMore}
            className="btn-secondary inline-flex items-center justify-center rounded-full px-5 py-2 text-xs uppercase tracking-[0.16em] disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load older"}
          </button>
        </div>
      )}
    </>
  );
}

function RipHistoryCard({ event }: { event: MyRipEvent }) {
  const [expanded, setExpanded] = useState(false);
  const { highlight, cards, pack } = event;
  const remaining = cards.length - 1;
  const highlightStyle = RARITY_STYLES[highlight.rarity];

  // Pack link target: editorial vs user pack. Branched <Link> rather
  // than a computed `to` string so the typed router stays happy —
  // same pattern used in the social-tab cards.
  const packLink = pack.creatorUsername ? (
    <Link
      to="/u/$username/$slug"
      params={{ username: pack.creatorUsername, slug: pack.slug }}
      className="font-medium text-[var(--sea-ink)] underline decoration-dotted underline-offset-2"
    >
      {pack.name}
    </Link>
  ) : (
    <Link
      to="/rip/$slug"
      params={{ slug: pack.slug }}
      className="font-medium text-[var(--sea-ink)] underline decoration-dotted underline-offset-2"
    >
      {pack.name}
    </Link>
  );

  return (
    <article className="island-shell flex flex-col gap-3 rounded-3xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[var(--sea-ink-soft)]">
            Ripped {packLink}
          </p>
          <p className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
            {formatRelative(event.timestamp)}
            {event.duplicateCount > 0 && (
              <>
                {" · "}
                {event.duplicateCount} dupe
                {event.duplicateCount === 1 ? "" : "s"}
              </>
            )}
            {event.shardsAwarded > 0 && (
              <> · +{event.shardsAwarded} shards</>
            )}
          </p>
        </div>
      </div>

      {/* Highlight + thumbstrip layout. The highlight card sits left
          (or stacked on mobile) with full ring + label; the rest
          appear as small thumbnails on the right with rarity-tinted
          borders. Tapping any thumb expands the full grid below. */}
      <div className="flex gap-3">
        <Link
          to="/book/$id"
          params={{ id: highlight.bookId }}
          className="flex-shrink-0 no-underline"
        >
          <div
            className={`aspect-[2/3] w-24 overflow-hidden rounded-xl sm:w-28 ${highlightStyle.ring}`}
          >
            <CoverImage
              src={highlight.coverUrl}
              alt={highlight.title}
              className="h-full w-full object-cover"
            />
          </div>
          <p
            className={`mt-1 inline-block rounded-full px-2 py-[2px] text-[9px] font-semibold uppercase tracking-[0.14em] ${highlightStyle.gemBg} ${highlightStyle.gemText}`}
          >
            {highlightStyle.label}
          </p>
        </Link>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-semibold text-[var(--sea-ink)]">
            {highlight.title}
          </p>
          {highlight.authors.length > 0 && (
            <p className="text-xs text-[var(--sea-ink-soft)]">
              {highlight.authors[0]}
              {highlight.authors.length > 1 ? " et al." : ""}
            </p>
          )}
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-3 inline-flex items-center gap-1 text-[11px] uppercase tracking-[0.14em] text-[var(--lagoon)] hover:underline"
            >
              {expanded
                ? "Hide"
                : `+ ${remaining} more card${remaining === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>

      {expanded && remaining > 0 && (
        <ul className="grid grid-cols-3 gap-2 pt-1 sm:grid-cols-4">
          {cards.slice(1).map((c) => (
            <li key={c.bookId}>
              <ExpandedRipCard card={c} />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ExpandedRipCard({ card }: { card: MyRipCard }) {
  const style = RARITY_STYLES[card.rarity];
  return (
    <Link
      to="/book/$id"
      params={{ id: card.bookId }}
      className="flex flex-col gap-1 no-underline"
    >
      <div
        className={`aspect-[2/3] w-full overflow-hidden rounded-lg ${style.ring}`}
      >
        <CoverImage
          src={card.coverUrl}
          alt={card.title}
          className="h-full w-full object-cover"
        />
      </div>
      <p className="line-clamp-2 text-[10px] font-medium text-[var(--sea-ink)]">
        {card.title}
      </p>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Social-tab event cards (unchanged from the pre-tabs version)

function ActorRow({ event }: { event: FollowFeedEvent }) {
  const { actor, timestamp } = event;
  return (
    <div className="flex items-center gap-3">
      {actor.avatarUrl ? (
        <img
          src={actor.avatarUrl}
          alt=""
          className="h-9 w-9 rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="h-9 w-9 rounded-full bg-[linear-gradient(135deg,var(--lagoon),var(--palm))]" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
          <Link
            to="/u/$username"
            params={{ username: actor.username }}
            className="no-underline hover:underline decoration-dotted underline-offset-2"
          >
            {actor.displayName ?? actor.username}
          </Link>
        </p>
        <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
          @{actor.username} · {formatRelative(timestamp)}
        </p>
      </div>
    </div>
  );
}

function PackPublishedCard({ event }: { event: PackPublishedEvent }) {
  const { pack, actor } = event;
  const gradient = packGradient(pack.slug, pack.genreTags);
  return (
    <article className="island-shell flex flex-col gap-3 rounded-3xl p-4">
      <ActorRow event={event} />
      <p className="text-xs text-[var(--sea-ink-soft)]">
        Published a new pack
      </p>
      <Link
        to="/u/$username/$slug"
        params={{ username: actor.username, slug: pack.slug }}
        className="flex gap-3 no-underline"
      >
        {pack.coverImageUrl ? (
          <img
            src={pack.coverImageUrl}
            alt=""
            className="h-24 w-16 flex-shrink-0 rounded-xl object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div
            className="h-24 w-16 flex-shrink-0 rounded-xl"
            style={{ background: gradient.background }}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-[var(--sea-ink)]">
            {pack.name}
          </p>
          {pack.description && (
            <p className="mt-1 line-clamp-2 text-xs text-[var(--sea-ink-soft)]">
              {pack.description}
            </p>
          )}
          <p className="mt-2 text-[10px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
            {pack.bookCount} books
            {pack.genreTags.length > 0 && <> · {pack.genreTags.join(", ")}</>}
          </p>
        </div>
      </Link>
    </article>
  );
}

function LegendaryPullCard({ event }: { event: LegendaryPullEvent }) {
  const { pack, cards } = event;
  const multiple = cards.length > 1;
  const packLink = pack.creatorUsername ? (
    <Link
      to="/u/$username/$slug"
      params={{ username: pack.creatorUsername, slug: pack.slug }}
      className="font-medium text-[var(--sea-ink)] underline decoration-dotted underline-offset-2"
    >
      {pack.name}
    </Link>
  ) : (
    <Link
      to="/rip/$slug"
      params={{ slug: pack.slug }}
      className="font-medium text-[var(--sea-ink)] underline decoration-dotted underline-offset-2"
    >
      {pack.name}
    </Link>
  );
  return (
    <article className="island-shell flex flex-col gap-3 rounded-3xl p-4">
      <ActorRow event={event} />
      <p className="text-xs text-[var(--sea-ink-soft)]">
        Pulled {multiple ? `${cards.length} legendaries` : "a legendary"} from{" "}
        {packLink}
      </p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <li key={c.bookId}>
            <Link
              to="/book/$id"
              params={{ id: c.bookId }}
              className="flex flex-col gap-1 no-underline"
            >
              <div className="aspect-[2/3] w-full overflow-hidden rounded-xl ring-2 ring-[color:var(--rarity-legendary)]">
                <CoverImage
                  src={c.coverUrl}
                  alt={c.title}
                  className="h-full w-full object-cover"
                />
              </div>
              <p className="line-clamp-2 text-xs font-medium text-[var(--sea-ink)]">
                {c.title}
              </p>
              {c.authors.length > 0 && (
                <p className="text-[10px] text-[var(--sea-ink-soft)]">
                  {c.authors[0]}
                  {c.authors.length > 1 ? " et al." : ""}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * Coarse relative-time formatter. The feed cares about "minutes",
 * "hours", "days" — exact timestamps would clutter the cards. Avoids
 * pulling in `date-fns` for one helper.
 */
function formatRelative(epochMs: number): string {
  const now = Date.now();
  const diff = now - epochMs;
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(epochMs).toLocaleDateString();
}
