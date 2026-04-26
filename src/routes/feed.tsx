import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import {
  getFollowFeedFn,
  type FollowFeedEvent,
  type FollowFeedPayload,
  type LegendaryPullEvent,
  type PackPublishedEvent,
} from "@/server/social";
import { CoverImage } from "@/components/CoverImage";
import { packGradient } from "@/lib/packs/gradient";

/**
 * /feed — follow feed.
 *
 * Chronological list of events from people the viewer follows: new
 * packs they publish + legendary cards they pull. Loader-driven SSR
 * so the first render is server-rendered for signed-in users; the
 * "Load older" pagination is client-side via a refetch with the
 * `before` cursor.
 *
 * Surface decisions:
 *   • Anonymous viewers see a sign-in CTA, not an empty state. The
 *     feed is fundamentally personal — there's no useful "browse
 *     anonymously" mode.
 *   • Empty state for signed-in viewers (zero follows or quiet
 *     followees) recycles the trending public packs from the
 *     server response so discovery is one tap away. Same payload
 *     `listPublicPacksFn` produces; the server merges it into the
 *     feed response so this page only needs one round-trip.
 *
 * Pagination: append-only. Newer items don't get fetched on mount
 * (the loader already has them). "Load older" mutates local state
 * with the next page's events. This is intentional — auto-refresh
 * on a feed is a UX rabbit hole and is deferred until we have a
 * real reason to add it.
 */
export const Route = createFileRoute("/feed")({
  loader: async () => {
    const feed = await getFollowFeedFn();
    return { feed };
  },
  component: FeedPage,
});

function FeedPage() {
  const { feed: initialFeed } = Route.useLoaderData() as {
    feed: FollowFeedPayload;
  };
  const [events, setEvents] = useState<ReadonlyArray<FollowFeedEvent>>(
    initialFeed.events,
  );
  const [cursor, setCursor] = useState<number | null>(initialFeed.nextCursor);
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

  if (!initialFeed.signedIn) {
    return (
      <main className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-10 sm:py-16">
        <div className="text-center">
          <h1 className="display-title text-2xl font-bold text-[var(--sea-ink)] sm:text-3xl">
            Your feed
          </h1>
          <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
            Sign in to see packs and pulls from creators you follow.
          </p>
          <Link
            to="/sign-in"
            className="btn-primary mt-6 inline-flex items-center justify-center rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em]"
          >
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  // Empty state: zero events. We don't distinguish "you follow no one"
  // from "your followees have been quiet" in the UI because the
  // remedy is the same — go follow more creators. The trending
  // suggestions surface real public packs so the page is still
  // valuable.
  if (events.length === 0) {
    return (
      <main className="page-wrap py-6 sm:py-12">
        <header className="mb-6 sm:mb-8">
          <h1 className="display-title text-2xl font-bold text-[var(--sea-ink)] sm:text-3xl">
            Your feed
          </h1>
          <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
            {initialFeed.followingCount === 0
              ? "Follow creators to see their packs and pulls here."
              : "The people you follow have been quiet. Discover more creators below."}
          </p>
        </header>

        {initialFeed.suggestions.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
            No public packs yet — check back soon.
          </p>
        ) : (
          <section aria-labelledby="feed-suggestions-heading">
            <h2 id="feed-suggestions-heading" className="island-kicker mb-3">
              Trending creators
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {initialFeed.suggestions.map((s) => (
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
        )}
      </main>
    );
  }

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8">
        <h1 className="display-title text-2xl font-bold text-[var(--sea-ink)] sm:text-3xl">
          Your feed
        </h1>
        <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
          From {initialFeed.followingCount}{" "}
          {initialFeed.followingCount === 1 ? "creator" : "creators"} you follow.
        </p>
      </header>

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
    </main>
  );
}

// ---------------------------------------------------------------------------
// Cards

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
  // Pack link target depends on whether this is an editorial or user
  // pack. Editorial packs have no `creatorUsername`; their public URL
  // is `/rip/$slug`. User packs live under the creator's profile.
  // Rendered as separate <Link>s rather than a computed string so the
  // typed router is happy — TanStack's typed `to` prop rejects
  // arbitrary string templates without a `@ts-expect-error` cast,
  // and a branched render is easier to read than the cast anyway.
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
              {/* Rarity-tinted ring — same lagoon-gold treatment used
                  on the rip reveal. Inlined here rather than reused
                  from RARITY_STYLES to keep the feed card light;
                  importing the full style table just for one ring is
                  overkill. */}
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
 * "hours", "days" — exact timestamps would clutter the cards. The
 * `Intl.RelativeTimeFormat` API is already in browser globals so no
 * dependency is needed.
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
  // Past a month, fall back to a date string. Locale-default matches
  // the rest of the app (we don't override Intl anywhere).
  return new Date(epochMs).toLocaleDateString();
}
