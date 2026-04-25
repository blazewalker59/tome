import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Bare /library sends the user to the Collection tab. The tab row
 * would otherwise render without an active child, which is visually
 * correct (both tabs unselected) but not what a landing visit is
 * asking for — "take me to my library" nearly always means the
 * card surface. The redirect happens at loader time so the tab bar
 * flicker for an empty outlet is avoided.
 */
export const Route = createFileRoute("/library/")({
  loader: () => {
    throw redirect({ to: "/library/collection" });
  },
});
