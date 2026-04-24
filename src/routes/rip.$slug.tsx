import { createFileRoute, redirect } from "@tanstack/react-router";
import { RipPackShell } from "@/components/rip/RipPackShell";
import { getCollectionFn, getPackBySlugFn } from "@/server/collection";
import { getPublicEconomyFn } from "@/server/economy";

/**
 * /rip/$slug — the tear-open experience for an editorial pack.
 *
 * The picker lives at /rip and navigates here once the user selects a
 * pack. We split the flow in two routes (picker list vs. open flow) so
 * each URL is shareable and so the open flow doesn't have to carry the
 * picker's carousel state. Auth is enforced only at this level: anons
 * can browse the picker but have to sign in to actually commit a rip,
 * which matches the "collection is the value" product framing.
 *
 * User-authored packs use `/rip/u/$username/$slug` and render the same
 * shell with a different back target; see `rip.u.$username.$slug.tsx`.
 */
export const Route = createFileRoute("/rip/$slug")({
  loader: async ({ params }) => {
    const [pack, collection, economy] = await Promise.all([
      getPackBySlugFn({ data: { slug: params.slug } }),
      getCollectionFn(),
      getPublicEconomyFn(),
    ]);
    if (!collection) {
      // Stash the pack slug on the sign-in URL so we can bounce back
      // after auth. (sign-in's redirect handling can wire this up
      // later; for now a plain redirect preserves the product flow.)
      throw redirect({ to: "/sign-in" });
    }
    return { pack, collection, economy };
  },
  component: RipEditorialPackRoute,
});

function RipEditorialPackRoute() {
  const { pack, collection, economy } = Route.useLoaderData();
  return (
    <RipPackShell
      pack={pack}
      collection={collection}
      economy={economy}
      backTo="/rip"
      backLabel="All packs"
    />
  );
}
