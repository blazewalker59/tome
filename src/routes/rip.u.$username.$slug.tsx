import { createFileRoute, redirect } from "@tanstack/react-router";
import { RipPackShell } from "@/components/rip/RipPackShell";
import { getCollectionFn, getUserPackFn } from "@/server/collection";
import { getPublicEconomyFn } from "@/server/economy";

/**
 * /rip/u/$username/$slug — tear-open flow for a user-authored pack.
 *
 * Mirrors `/rip/$slug` but resolves the pack through `getUserPackFn`
 * so the slug lookup is scoped to the creator's namespace (two users
 * can publish different packs with the same slug). The rip payload
 * shape and commit path are identical — `recordRipFn` takes a
 * `packId`, not a slug, so crediting works the same regardless of
 * whether the pack is editorial or user-authored.
 *
 * Auth gate matches the editorial route: anons get bounced to
 * sign-in. The public pack page at `/u/$username/$slug` shows a
 * "sign in to rip" CTA for anons, so they shouldn't land here
 * unauthenticated in normal navigation; the guard is defensive for
 * deep links.
 */
export const Route = createFileRoute("/rip/u/$username/$slug")({
  loader: async ({ params }) => {
    const [pack, collection, economy] = await Promise.all([
      getUserPackFn({
        data: { username: params.username, slug: params.slug },
      }),
      getCollectionFn(),
      getPublicEconomyFn(),
    ]);
    if (!collection) throw redirect({ to: "/sign-in" });
    return { pack, collection, economy, username: params.username, slug: params.slug };
  },
  component: RipUserPackRoute,
});

function RipUserPackRoute() {
  const { pack, collection, economy, username, slug } = Route.useLoaderData();
  // Back target is the public pack page rather than the editorial
  // picker — user-pack discovery doesn't route through /rip (yet), so
  // bouncing there would drop the user somewhere unrelated.
  return (
    <RipPackShell
      pack={pack}
      collection={collection}
      economy={economy}
      backTo={`/u/${username}/${slug}`}
      backLabel="Back to pack"
    />
  );
}
