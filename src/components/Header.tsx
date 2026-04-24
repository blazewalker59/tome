import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { LogIn, LogOut, ShieldCheck, Sparkles, User, BookOpen } from "lucide-react";
import ThemeToggle, { ThemeSegmented } from "./ThemeToggle";
import { signOut, useAuth, useIsAdmin } from "@/lib/auth/hooks";
import { getShardBalanceFn } from "@/server/collection";

/**
 * Top app bar.
 *
 * Mobile (< sm): collapsed to essentials — the Tome wordmark on the
 * left and an account/profile button on the right. Everything else
 * (theme selector, sign-in link, sign-out, admin shortcut) lives
 * inside the dropdown. Primary navigation lives in the bottom tab bar
 * (see `BottomTabs`) so the top bar is intentionally spare.
 *
 * Desktop (≥ sm): the top bar also carries the inline nav links and
 * the stand-alone theme-mode pill.
 *
 * Auth: while the session is still loading we render a neutral
 * placeholder so we don't flash a "Sign in" UI to a logged-in user.
 * Once resolved the button either shows the user's avatar (authed)
 * or a generic silhouette (anonymous) — both open the same dropdown
 * shell, just with different items inside.
 */
export default function Header() {
  // Publish the header's rendered height to CSS as `--header-h` so
  // sticky elements below (e.g. the collection toolbar) can pin flush
  // to the header's bottom edge without hardcoding a pixel value.
  // The header's height varies with safe-area insets and viewport size
  // (mobile py-2 vs desktop py-4), so a static `top-[64px]` on child
  // stickies leaves a visible sliver where scrolling cards show
  // through. ResizeObserver keeps it accurate across rotations and
  // breakpoint changes.
  const headerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const sync = () => {
      document.documentElement.style.setProperty(
        "--header-h",
        `${el.offsetHeight}px`,
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 pt-[env(safe-area-inset-top)] backdrop-blur-lg"
    >
      <nav className="page-wrap flex items-center gap-3 py-2 sm:py-4">
        <Link
          to="/"
          aria-label="Tome — home"
          className="inline-flex items-center gap-2 rounded-full text-sm font-semibold text-[var(--sea-ink)] no-underline sm:h-11 sm:border sm:border-[var(--chip-line)] sm:bg-[var(--chip-bg)] sm:px-4"
        >
          <BookOpen aria-hidden className="h-7 w-7 text-[var(--lagoon)] sm:h-5 sm:w-5" />
          <span className="hidden sm:inline">Tome</span>
        </Link>

        {/* Desktop-only inline nav */}
        <div className="ml-4 hidden items-center gap-x-5 text-sm font-semibold sm:flex">
          <Link to="/" className="nav-link" activeProps={{ className: "nav-link is-active" }}>
            Home
          </Link>
          <Link to="/rip" className="nav-link" activeProps={{ className: "nav-link is-active" }}>
            Rip
          </Link>
          <Link
            to="/collection"
            className="nav-link"
            activeProps={{ className: "nav-link is-active" }}
          >
            Collection
          </Link>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <AccountSlot />
          {/* Desktop-only standalone theme pill. On mobile the theme
              control is inside the account dropdown instead. */}
          <div className="hidden sm:block">
            <ThemeToggle />
          </div>
        </div>
      </nav>
    </header>
  );
}

function AccountSlot() {
  const { status, user } = useAuth();
  const isAdmin = useIsAdmin();

  if (status === "loading") {
    // Reserve the circular footprint of the final button so the layout
    // doesn't jump when auth resolves.
    return <span className="h-9 w-9" aria-hidden />;
  }

  if (status === "anonymous") {
    return <AccountMenu isAdmin={false} />;
  }

  const label =
    user?.displayName ??
    user?.name ??
    user?.email ??
    "Signed in";
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  const avatarUrl = user?.avatarUrl ?? user?.image ?? undefined;

  return (
    <AccountMenu
      label={label}
      email={user?.email ?? null}
      initial={initial}
      avatarUrl={avatarUrl}
      isAdmin={isAdmin === true}
    />
  );
}

/**
 * Single account dropdown used for both anonymous and authenticated
 * states so the header has exactly one trailing control regardless of
 * auth. Contents differ:
 *
 *   - Anonymous: theme selector + "Sign in" link.
 *   - Authenticated: profile header block, (optional) Admin shortcut,
 *     theme selector, Sign out.
 *
 * Keyboard / a11y:
 *   - Button has `aria-haspopup="menu"` and `aria-expanded`.
 *   - Escape closes and returns focus to the button.
 *   - Outside clicks close.
 */
function AccountMenu({
  label,
  email,
  initial,
  avatarUrl,
  isAdmin,
}: {
  label?: string;
  email?: string | null;
  initial?: string;
  avatarUrl?: string | undefined;
  isAdmin: boolean;
}) {
  const authed = Boolean(label);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Shards are fetched lazily the first time the menu opens for an
  // authed user — they aren't header chrome so there's no reason to
  // pay for the query on every page load. `null` means "not fetched
  // yet" so we can distinguish from "fetched and is zero". Cached
  // across subsequent opens in the same session; a rip will usually
  // navigate or trigger a re-render that remounts this anyway.
  const [shards, setShards] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !authed || shards !== null) return;
    let cancelled = false;
    void getShardBalanceFn().then((res) => {
      if (cancelled) return;
      setShards(res?.shards ?? 0);
    });
    return () => {
      cancelled = true;
    };
  }, [open, authed, shards]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const buttonLabel = authed ? `Account menu for ${label}` : "Account menu";

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        title={authed ? label : "Account"}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--sea-ink)] hover:bg-[var(--link-bg-hover)]"
      >
        {authed && avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-7 w-7 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : authed ? (
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--lagoon)] text-[10px] font-bold text-[var(--on-accent)]">
            {initial}
          </span>
        ) : (
          <User aria-hidden className="h-4 w-4" />
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          // Solid --bg-base rather than the translucent --header-bg
          // because the dropdown extends past the sticky header's box
          // and so can't inherit its backdrop blur. Mobile Safari in
          // particular drops backdrop-filter on descendants that escape
          // the filtered ancestor's bounds, so any alpha here would
          // show the page scrolling through.
          className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg-base)] shadow-lg"
        >
          {authed && (
            <div className="border-b border-[var(--line)] px-4 py-3">
              <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">{label}</p>
              {email && email !== label && (
                <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">{email}</p>
              )}
              {/* Shards live in the profile block: they're a per-user
                  stat, not navigation, and the block already has the
                  right visual weight for a compact stat line. The
                  number fades in once the lazy fetch resolves — a
                  dash placeholder avoids the "0 → real value" flash
                  for users with any balance. */}
              <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--sea-ink-soft)]">
                <Sparkles aria-hidden className="h-3.5 w-3.5 text-[var(--lagoon)]" />
                <span className="tabular-nums text-[var(--sea-ink)]">
                  {shards === null ? "—" : shards}
                </span>
                <span>shards</span>
              </p>
            </div>
          )}

          {authed && isAdmin && (
            <Link
              to="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3 text-sm font-semibold text-[var(--sea-ink)] no-underline hover:bg-[var(--link-bg-hover)]"
            >
              <ShieldCheck aria-hidden className="h-4 w-4 text-[var(--lagoon)]" />
              <span>Admin</span>
            </Link>
          )}

          <div className="border-b border-[var(--line)] px-4 py-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
              Theme
            </p>
            <ThemeSegmented />
          </div>

          {authed ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-[var(--sea-ink-soft)] hover:bg-[var(--link-bg-hover)] hover:text-[var(--sea-ink)]"
            >
              <LogOut aria-hidden className="h-4 w-4" />
              <span>Sign out</span>
            </button>
          ) : (
            <Link
              to="/sign-in"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-[var(--sea-ink)] no-underline hover:bg-[var(--link-bg-hover)]"
            >
              <LogIn aria-hidden className="h-4 w-4 text-[var(--lagoon)]" />
              <span>Sign in</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
