import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // Use the native View Transitions API for every navigation. The
    // browser snapshots the outgoing DOM, we render the new route,
    // and the two states cross-fade (or slide — see `::view-transition-*`
    // rules in styles.css). Unlike a keyed React remount this is a
    // single paint swap, so it feels native and doesn't re-trigger
    // route effects or data loaders. Safari 18+, Chrome 111+, FF 134+.
    // Where unsupported the router falls through to an instant swap.
    defaultViewTransition: true,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
