/**
 * Follow / Unfollow button for `/u/$username`.
 *
 * Behavior:
 *   • Hidden when the viewer is anonymous — instead the parent should
 *     render a "Sign in to follow" link. We don't render that prompt
 *     here because the surrounding layout differs by surface (header
 *     vs sidebar vs feed callout); the parent decides.
 *   • Hidden when the viewer is the profile owner (no self-follow).
 *   • Optimistic toggle: clicking flips the local state immediately
 *     so the UI feels instant, then reconciles to the server result.
 *     On error we revert and surface a toast — the parent's count
 *     stays in sync via `onChange` which receives the authoritative
 *     count returned by the server.
 *   • Concurrent clicks are coalesced via a `pending` flag — taps
 *     during an in-flight request are ignored. Simpler than a queue
 *     and avoids the "click follow then unfollow rapidly → desynced
 *     state" failure mode.
 */

import { useState, useTransition } from "react";

import { followUserFn, unfollowUserFn } from "@/server/social";
import { useToast } from "@/components/Toast";

interface FollowButtonProps {
  /** Target username (URL slug; what the server fns key off). */
  username: string;
  /** Initial state from the loader. We use this as both the first
   *  paint AND as the fallback we revert to on failure. */
  initialFollowing: boolean;
  /**
   * Fired with the authoritative state after each successful toggle.
   * Parent uses this to bump its follower-count display without a
   * separate refetch. Kept as a callback (not router.invalidate) so
   * the count animates locally without re-fetching the whole profile.
   */
  onChange?: (next: { following: boolean; followerCount: number }) => void;
}

export function FollowButton({
  username,
  initialFollowing,
  onChange,
}: FollowButtonProps) {
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const onClick = () => {
    if (pending) return;

    // Optimistic flip — captured before the await so we can revert on
    // error. The server result is authoritative for the count, but
    // the boolean state is something we already know.
    const previous = following;
    const next = !previous;
    setFollowing(next);

    startTransition(async () => {
      try {
        const result = next
          ? await followUserFn({ data: { username } })
          : await unfollowUserFn({ data: { username } });
        onChange?.({
          following: result.following,
          followerCount: result.followerCount,
        });
      } catch (err) {
        // Revert the optimistic flip and tell the user. The server
        // fn throws structured-prefix errors (SELF_FOLLOW:,
        // FOLLOW_TARGET_NOT_FOUND:) but they're unreachable from a
        // rendered profile page (we hide the button on self, and the
        // profile loader 404s on missing users), so we surface a
        // generic message rather than branching.
        setFollowing(previous);
        toast.push({
          title: next ? "Couldn't follow" : "Couldn't unfollow",
          description:
            err instanceof Error ? err.message : "Try again in a moment.",
          tone: "neutral",
        });
      }
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      // Same visual vocabulary as the existing primary/secondary
      // pair: filled lagoon for the affirmative state ("Follow"),
      // outline-on-surface for the engaged state ("Following") so a
      // glance reads both as "primary action available" and "you're
      // already in the relationship."
      className={
        following
          ? "btn-secondary inline-flex items-center justify-center rounded-full px-5 py-2 text-xs uppercase tracking-[0.16em] disabled:opacity-60"
          : "btn-primary inline-flex items-center justify-center rounded-full px-5 py-2 text-xs uppercase tracking-[0.16em] disabled:opacity-60"
      }
      aria-pressed={following}
    >
      {following ? "Following" : "Follow"}
    </button>
  );
}
