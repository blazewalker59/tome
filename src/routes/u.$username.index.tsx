import { useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import {
  getPublicProfileFn,
  type PublicProfilePayload,
} from "@/server/user-packs";
import { getFollowStateFn, type FollowStatePayload } from "@/server/social";
import { getMeFn } from "@/server/admin";
import { FollowButton } from "@/components/FollowButton";

/**
 * Public creator profile.
 *
 * Anonymous-friendly — shows the creator's published packs and nothing
 * else (drafts stay private). Rendered via loader-driven SSR so the
 * profile is crawlable and shareable without a client round-trip.
 *
 * Username is the URL-param, not the user id, so links are human-
 * readable. The `users.username` column is `unique` so there's exactly
 * one profile per slug.
 *
 * Social: the loader fetches follow state in parallel with the
 * profile + viewer identity. The follow button renders only for
 * signed-in non-self viewers; anonymous viewers see a "Sign in to
 * follow" link instead, which preserves the action shape without
 * forcing them through auth before they've decided to engage.
 */
export const Route = createFileRoute("/u/$username/")({
  loader: async ({ params }) => {
    try {
      const [profile, followState, me] = await Promise.all([
        getPublicProfileFn({ data: { username: params.username } }),
        getFollowStateFn({ data: { username: params.username } }),
        getMeFn(),
      ]);
      return { profile, followState, me };
    } catch {
      // Any error → 404. The fn throws "User @x not found" for misses;
      // we don't distinguish that from transient failures at the route
      // boundary because either way the user should see a not-found UI.
      throw notFound();
    }
  },
  component: ProfilePage,
});

function ProfilePage() {
  const { profile, followState, me } = Route.useLoaderData() as {
    profile: PublicProfilePayload;
    followState: FollowStatePayload;
    me: { id: string; username: string | null } | null;
  };
  const { user, packs } = profile;

  // Local mirrors of the social counts so an optimistic toggle in
  // FollowButton can update the header without a route refetch. The
  // initial values come from the loader; subsequent server responses
  // overwrite via `onChange`.
  const [followerCount, setFollowerCount] = useState(followState.followerCount);
  const [followingNow, setFollowingNow] = useState(followState.viewerFollows);
  const followingCount = followState.followingCount;

  const isSelf = followState.isSelf;
  const showFollowButton = Boolean(me) && !isSelf;
  const showSignInPrompt = !me && !isSelf;

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 flex flex-wrap items-center gap-4 sm:mb-8">
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="h-16 w-16 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="h-16 w-16 rounded-full bg-[linear-gradient(135deg,var(--lagoon),var(--palm))]" />
        )}
        <div className="min-w-0 flex-1">
          <p className="island-kicker">@{user.username}</p>
          <h1 className="display-title mt-1 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
            {user.displayName ?? user.username}
          </h1>
          {/* Counts row. Plural-aware so "1 follower" / "2 followers"
              reads naturally. Tabular nums keeps the digits aligned
              when the counts tick during an optimistic follow. */}
          <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
            <span className="tabular-nums">{followerCount}</span>{" "}
            {followerCount === 1 ? "follower" : "followers"}
            <span className="mx-2 opacity-50">·</span>
            <span className="tabular-nums">{followingCount}</span> following
          </p>
        </div>
        {showFollowButton && (
          <FollowButton
            username={user.username}
            initialFollowing={followingNow}
            onChange={({ following, followerCount: nextCount }) => {
              setFollowingNow(following);
              setFollowerCount(nextCount);
            }}
          />
        )}
        {showSignInPrompt && (
          // Anonymous CTA. The sign-in route doesn't currently honor
          // a redirect param; once it does we can pass the profile
          // path through and land them back here. For now Google OAuth
          // bounces home and the user re-navigates manually — a small
          // friction we'll fix when the redirect param lands.
          <Link
            to="/sign-in"
            className="btn-primary inline-flex items-center justify-center rounded-full px-5 py-2 text-xs uppercase tracking-[0.16em]"
          >
            Sign in to follow
          </Link>
        )}
      </header>

      <section>
        <h2 className="island-kicker mb-3">
          Published packs · {packs.length}
        </h2>
        {packs.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
            No published packs yet.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {packs.map((p) => (
              <li key={p.id}>
                <Link
                  to="/u/$username/$slug"
                  params={{ username: user.username, slug: p.slug }}
                  className="island-shell flex h-full flex-col gap-2 rounded-3xl p-4 no-underline hover:border-[var(--lagoon)]"
                >
                  {p.coverImageUrl ? (
                    <img
                      src={p.coverImageUrl}
                      alt=""
                      className="aspect-[2/1] w-full rounded-2xl object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="aspect-[2/1] w-full rounded-2xl bg-[linear-gradient(135deg,var(--lagoon),var(--palm))]" />
                  )}
                  <p className="text-sm font-semibold text-[var(--sea-ink)]">
                    {p.name}
                  </p>
                  <p className="text-xs text-[var(--sea-ink-soft)]">
                    {p.bookCount} books
                    {p.genreTags.length > 0 && <> · {p.genreTags.join(", ")}</>}
                  </p>
                  {p.description && (
                    <p className="line-clamp-2 text-xs text-[var(--sea-ink-soft)]">
                      {p.description}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
