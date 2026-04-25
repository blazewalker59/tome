import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { CoverImage } from "@/components/CoverImage";
import { getMeFn } from "@/server/admin";
import {
  getPublicPackFn,
  type PublicPackPayload,
} from "@/server/user-packs";

interface MeView {
  id: string;
  username: string | null;
}

/**
 * Public pack page — `/u/$username/$slug`.
 *
 * Renders for anyone, signed-in or not:
 *   • Signed in → "Rip this pack" CTA links to `/rip/u/$username/$slug`,
 *     which reuses the editorial rip shell scoped to the creator's
 *     slug namespace.
 *   • Anonymous → "Sign in to rip" CTA that redirects to the auth
 *     flow. Kept as a plain anchor rather than a router Link because
 *     the sign-in flow is a full page transition, not a client
 *     navigation.
 *
 * The loader also reads `getMeFn` so we can vary the CTA copy and
 * avoid a flash of the wrong button state. If loading the pack fails
 * we throw the TanStack Router `notFound()` helper — the server fn
 * throws for private drafts and missing rows alike, which is what we
 * want (don't leak existence).
 */
export const Route = createFileRoute("/u/$username/$slug")({
  loader: async ({ params }) => {
    const [me, pack] = await Promise.all([
      getMeFn(),
      getPublicPackFn({
        data: { username: params.username, slug: params.slug },
      }).catch(() => null),
    ]);
    if (!pack) throw notFound();
    return { me, pack, username: params.username, slug: params.slug };
  },
  component: PublicPackPage,
});

function PublicPackPage() {
  const { me, pack, username, slug } = Route.useLoaderData() as {
    me: MeView | null;
    pack: PublicPackPayload;
    username: string;
    slug: string;
  };
  const creator = pack.creator;

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8">
        {creator && (
          <Link
            to="/u/$username"
            params={{ username: creator.username }}
            className="island-kicker text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
          >
            @{creator.username}
          </Link>
        )}
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          {pack.name}
        </h1>
        {pack.description && (
          <p className="mt-2 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
            {pack.description}
          </p>
        )}
        {pack.genreTags.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-1.5 text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
            {pack.genreTags.map((t) => (
              <span
                key={t}
                className="rounded-full border border-[var(--line)] px-2 py-0.5"
              >
                {t}
              </span>
            ))}
          </p>
        )}
      </header>

      <section className="island-shell rounded-3xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[var(--sea-ink)]">
            {pack.books.length} books · shuffle one into your collection.
          </p>
          <RipCta me={me} username={username} slug={slug} />
        </div>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pack.books.map((b) => (
            <li
              key={b.id}
              className="flex items-start gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3"
            >
              <CoverImage
                src={b.coverUrl}
                alt=""
                className="h-20 w-14 shrink-0 rounded-md object-cover"
                fallback={
                  <div className="h-20 w-14 shrink-0 rounded-md bg-[var(--surface-muted)]" />
                }
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                  {b.title}
                </p>
                <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                  {b.authors.join(", ")}
                </p>
                <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                  {b.rarity}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function RipCta({
  me,
  username,
  slug,
}: {
  me: MeView | null;
  username: string;
  slug: string;
}) {
  if (!me) {
    // Anonymous: full page nav to sign-in. The rip route itself
    // enforces auth server-side so we don't need to round-trip.
    return (
      <a
        href="/sign-in"
        className="btn-primary rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em]"
      >
        Sign in to rip
      </a>
    );
  }
  // Signed in: route into the shared rip shell under the user-pack
  // namespace. `recordRipFn` takes a packId, not a slug, so the
  // commit path is identical to the editorial flow.
  return (
    <Link
      to="/rip/u/$username/$slug"
      params={{ username, slug }}
      className="btn-primary rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em]"
    >
      Rip this pack
    </Link>
  );
}
