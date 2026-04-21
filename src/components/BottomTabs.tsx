import { Link } from "@tanstack/react-router";
import { BookOpen, Home, Sparkles } from "lucide-react";

/**
 * Mobile-only bottom tab bar. Hidden on `sm` and up where the top header
 * carries the inline nav. Each tab is a 56-px (≥44 minimum + breathing
 * room) hit target, thumb-reachable. Sits above the iOS home-indicator
 * via env(safe-area-inset-bottom).
 *
 * Background is intentionally opaque (--bg-base) rather than the
 * translucent --header-bg the top chrome uses. On `.viewport-stage`
 * pages (home, rip) the body doesn't scroll, so there's nothing
 * interesting behind the tab bar to blur — translucent + backdrop-blur
 * just revealed seams between where the body's gradient ends and where
 * <html>'s fill begins, which read as a weird banded strip under the
 * tab bar on iOS PWAs. Solid fill sidesteps it entirely.
 */
export default function BottomTabs() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--line)] bg-[var(--bg-base)] pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-around">
        <Tab to="/" label="Home" icon={<Home aria-hidden className="h-5 w-5" />} />
        <Tab to="/rip" label="Rip" icon={<Sparkles aria-hidden className="h-5 w-5" />} />
        <Tab to="/collection" label="Library" icon={<BookOpen aria-hidden className="h-5 w-5" />} />
      </ul>
    </nav>
  );
}

function Tab({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  return (
    <li className="flex-1">
      <Link
        // @ts-expect-error — string `to` is fine; TanStack typed-routes can't
        // infer the union here without per-route typing.
        to={to}
        className="bottom-tab"
        activeProps={{ className: "bottom-tab is-active" }}
      >
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">{label}</span>
      </Link>
    </li>
  );
}
