import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import {
  getPublicProfileFn,
  type PublicProfilePayload,
} from "@/server/user-packs";

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
 */
export const Route = createFileRoute("/u/$username/")({
  loader: async ({ params }) => {
    try {
      const profile = await getPublicProfileFn({
        data: { username: params.username },
      });
      return { profile };
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
  const { profile } = Route.useLoaderData() as { profile: PublicProfilePayload };
  const { user, packs } = profile;

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 flex items-center gap-4 sm:mb-8">
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
        <div>
          <p className="island-kicker">@{user.username}</p>
          <h1 className="display-title mt-1 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
            {user.displayName ?? user.username}
          </h1>
        </div>
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
