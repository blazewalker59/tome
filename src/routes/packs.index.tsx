import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { getMeFn } from "@/server/admin";
import {
  listMyPacksFn,
  type MyPackSummary,
} from "@/server/user-packs";

/**
 * "My packs" — the signed-in creator's hub for their own packs.
 *
 * Shows drafts and published packs together, grouped by status so the
 * UI can nudge drafts with "Continue building" and link published packs
 * to their public `/u/$username/$slug` page. This is the one place a
 * creator can see work-in-progress drafts; the public profile page
 * (`/u/$username`) deliberately hides them.
 *
 * Auth: anonymous callers are redirected to `/sign-in`. The server fn
 * also enforces auth so a direct fetch against `listMyPacksFn` without
 * a session throws.
 */
export const Route = createFileRoute("/packs/")({
  loader: async () => {
    const user = await getMeFn();
    if (!user) throw redirect({ to: "/sign-in" });
    const packs = await listMyPacksFn();
    return { user, packs };
  },
  component: MyPacksPage,
});

function MyPacksPage() {
  const { user, packs } = Route.useLoaderData();

  // Split once up front; the two lists are rendered as separate
  // sections with different CTAs so doing this inline in JSX would
  // read worse than named locals.
  const drafts = packs.filter((p) => !p.isPublic);
  const published = packs.filter((p) => p.isPublic);

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 sm:mb-8">
        <div>
          <p className="island-kicker">Your shelf</p>
          <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
            My packs
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
            Drafts stay private; only you can see them here. Publish a
            pack to make it show up on your profile and available for
            anyone to rip.
          </p>
        </div>
        <Link
          to="/packs/new"
          className="btn-primary rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em]"
        >
          Build a new pack
        </Link>
      </header>

      <section className="mb-8">
        <h2 className="island-kicker mb-3">
          Drafts · {drafts.length}
        </h2>
        {drafts.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
            No drafts in progress. Start one and it&rsquo;ll live here
            until you publish.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {drafts.map((p) => (
              <PackCard key={p.id} pack={p} kind="draft" />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="island-kicker mb-3">
          Published · {published.length}
        </h2>
        {published.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
            Nothing published yet. Your drafts move here once they meet
            the composition rules and you hit publish.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {published.map((p) => (
              <PackCard
                key={p.id}
                pack={p}
                kind="published"
                username={user.username ?? ""}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * Single tile for the grid. Drafts link to the builder; published packs
 * link to their public page. Both surface a small "Edit" link on
 * published tiles so metadata (name, description, tags) can still be
 * touched up post-publish — contents are frozen but the wrapper isn't.
 */
function PackCard({
  pack,
  kind,
  username,
}: {
  pack: MyPackSummary;
  kind: "draft" | "published";
  username?: string;
}) {
  if (kind === "draft") {
    return (
      <li>
        <Link
          to="/packs/$id/edit"
          params={{ id: pack.id }}
          className="island-shell flex h-full flex-col gap-2 rounded-3xl p-4 no-underline hover:border-[var(--lagoon)]"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-[var(--sea-ink)]">
              {pack.name}
            </p>
            <span className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
              Draft
            </span>
          </div>
          <p className="text-xs text-[var(--sea-ink-soft)]">
            {pack.bookCount} {pack.bookCount === 1 ? "book" : "books"} · Continue
            building →
          </p>
        </Link>
      </li>
    );
  }

  // Published. The outer card navigates to the public page; the
  // "Edit" pill is a nested Link. Nested interactive elements need
  // stopPropagation so the parent card doesn't also fire.
  return (
    <li>
      <div className="island-shell relative flex h-full flex-col gap-2 rounded-3xl p-4 hover:border-[var(--lagoon)]">
        <Link
          to="/u/$username/$slug"
          params={{ username: username ?? "", slug: pack.slug }}
          className="absolute inset-0 rounded-3xl"
          aria-label={`View ${pack.name}`}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-[var(--sea-ink)]">
            {pack.name}
          </p>
          <Link
            to="/packs/$id/edit"
            params={{ id: pack.id }}
            onClick={(e) => e.stopPropagation()}
            // `relative` lifts this above the full-card overlay Link so
            // clicking "Edit" goes to the builder, not the public view.
            className="relative z-10 rounded-full border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink)] no-underline hover:bg-[var(--link-bg-hover)]"
          >
            Edit
          </Link>
        </div>
        <p className="text-xs text-[var(--sea-ink-soft)]">
          {pack.bookCount} {pack.bookCount === 1 ? "book" : "books"}
          {pack.publishedAt && (
            <> · Published {new Date(pack.publishedAt).toLocaleDateString()}</>
          )}
        </p>
      </div>
    </li>
  );
}
