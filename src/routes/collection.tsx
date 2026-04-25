import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy /collection entry point. The Collection surface moved under
 * /library as a tab sibling to the reading Log. The redirect
 * preserves search params (view / sort / q) so old bookmarks keep
 * landing in the right grouped/filtered state — TanStack's redirect
 * drops the incoming search by default, which would strip a user's
 * carefully-chosen view=pack pin.
 */
export const Route = createFileRoute("/collection")({
  loader: ({ location }) => {
    throw redirect({ to: "/library/collection", search: location.search });
  },
});
