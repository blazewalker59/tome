import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * /rip layout route.
 *
 * Exists solely to host the `<Outlet />` that renders the picker
 * (/rip/) or a specific pack (/rip/$slug). Without a layout route
 * TanStack Router's file-based convention treats `rip.tsx` as the
 * parent of `rip.$slug.tsx` and won't render the child unless this
 * parent yields an outlet — which was why tapping "Open pack"
 * updated the URL but never swapped the view.
 *
 * No shared chrome here (header/footer live in the root); this is a
 * pure passthrough. If the rip surface ever grows a shared sub-nav
 * or breadcrumb, this is where it'd go.
 */
export const Route = createFileRoute("/rip")({
  component: RipLayout,
});

function RipLayout() {
  return <Outlet />;
}
