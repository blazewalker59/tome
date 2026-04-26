import { useLayoutEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { BookOpen, Home, Rss, Sparkles } from "lucide-react";

/**
 * Mobile-only bottom tab bar. Hidden on `sm` and up where the top header
 * carries the inline nav. Each tab is a 56-px (≥44 minimum + breathing
 * room) hit target, thumb-reachable. Sits above the iOS home-indicator
 * via env(safe-area-inset-bottom).
 *
 * Background is intentionally opaque (--bg-base) rather than the
 * translucent --header-bg the top chrome uses. On pages without enough
 * scrollable content to pass under the bar (home, rip), the translucent
 * fill made the safe-area-inset-bottom padding zone below the icons
 * read as empty space — the nav's full 56px+inset height was there, but
 * only the icon row looked "filled", so the inset zone appeared as a
 * floating gap beneath the bar. Solid fill makes the whole bar height
 * (including the home-indicator-hugging inset zone) read as one piece.
 *
 * Chrome-height contract: we measure the nav's rendered outer height
 * (content + safe-area padding) and publish it as `--chrome-bottom` on
 * <html>. Two things depend on that value:
 *   • `body { padding-bottom: var(--chrome-bottom) }` reserves space so
 *     scrollable pages don't end under the bar.
 *   • `.viewport-stage` uses it to compute its own height on pages that
 *     don't scroll.
 *
 * We MUST measure instead of hardcoding because of an iOS Safari /
 * standalone-PWA quirk: `env(safe-area-inset-bottom)` can resolve to 0
 * at first paint and only resolve to the real home-indicator height
 * after the layout viewport recomputes (e.g. after a scroll). On
 * fixed-height routes (home, rip) that recompute may never happen, so
 * any CSS math that assumes the inset resolves correctly at mount
 * leaves a visible gap between the nav and the device edge. The
 * ResizeObserver catches whatever value the browser eventually settles
 * on, as well as rotation/font-scaling changes.
 */
export default function BottomTabs() {
  const navRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    // Skip on desktop where the nav is display:none'd via `sm:hidden`.
    // Desktop CSS already zeroes out `--chrome-bottom`; we don't want to
    // stomp that with a bogus measurement.
    const root = document.documentElement;

    const publish = () => {
      const h = el.getBoundingClientRect().height;
      if (h <= 0) {
        // Hidden (desktop) — clear so the CSS @media default wins.
        root.style.removeProperty("--chrome-bottom");
        return;
      }
      root.style.setProperty("--chrome-bottom", `${Math.ceil(h)}px`);
    };

    publish();

    const ro = new ResizeObserver(publish);
    ro.observe(el);

    // Also listen for viewport-level changes that don't resize the nav
    // itself but do change the safe-area inset (rotation, virtual
    // keyboard, PWA chrome transitions).
    window.addEventListener("resize", publish);
    window.addEventListener("orientationchange", publish);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", publish);
      window.removeEventListener("orientationchange", publish);
      root.style.removeProperty("--chrome-bottom");
    };
  }, []);

  return (
    <nav
      ref={navRef}
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--line)] bg-[var(--bg-base)] pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-around">
        <Tab to="/" label="Home" icon={<Home aria-hidden className="h-5 w-5" />} />
        <Tab to="/rip" label="Rip" icon={<Sparkles aria-hidden className="h-5 w-5" />} />
        {/* Feed is fourth so the rip CTA stays visually centered in
            a 3-icon mental model — Home + Rip + Library remain the
            primary loop, with Feed an adjacent surface. Order tested
            against thumb reachability: Feed at the right edge keeps
            the chord on the dominant hand for right-handed users
            (the majority) without crowding the rip tap target. */}
        <Tab to="/feed" label="Feed" icon={<Rss aria-hidden className="h-5 w-5" />} />
        <Tab to="/library/collection" label="Library" icon={<BookOpen aria-hidden className="h-5 w-5" />} />
      </ul>
    </nav>
  );
}

function Tab({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  return (
    <li className="flex-1">
      <Link
        // String `to` is fine here; TanStack typed-routes can't infer the
        // union without per-route typing, so we cast through `any` rather
        // than leave a `@ts-expect-error` that flickers between TS releases.
        to={to as never}
        className="bottom-tab"
        activeProps={{ className: "bottom-tab is-active" }}
      >
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">{label}</span>
      </Link>
    </li>
  );
}
