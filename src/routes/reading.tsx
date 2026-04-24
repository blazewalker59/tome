import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy /reading entry point. The reading log moved under /library
 * as the "Log" tab. A plain redirect is enough here — the log page
 * didn't carry URL-bound search params prior to the move, so no
 * preservation logic is required.
 */
export const Route = createFileRoute("/reading")({
  loader: () => {
    throw redirect({ to: "/library/reading" });
  },
});
