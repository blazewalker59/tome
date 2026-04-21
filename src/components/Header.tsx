import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BookOpen, LogOut, ShieldCheck } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import { signOut, useAuth, useIsAdmin } from "@/lib/auth/hooks";

/**
 * Top app bar — Tome wordmark + theme toggle + auth state.
 * On mobile this is the only chrome at the top; primary navigation lives
 * in the bottom tab bar (see `BottomTabs`). On desktop (≥sm) the top bar
 * also carries the inline nav links.
 *
 * Auth: while the session is still loading we render nothing in the auth
 * slot so we don't flash a "Sign in" link to a logged-in user. Once known,
 * we either show a profile button (opens a dropdown with admin shortcut +
 * sign-out) or a "Sign in" link.
 */
export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 pt-[env(safe-area-inset-top)] backdrop-blur-lg">
      <nav className="page-wrap flex items-center gap-3 py-3 sm:py-4">
        <Link
          to="/"
          className="inline-flex h-11 items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 text-sm font-semibold text-[var(--sea-ink)] no-underline"
        >
          <BookOpen aria-hidden className="h-5 w-5 text-[var(--lagoon)]" />
          Tome
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
          <AuthSlot />
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}

function AuthSlot() {
  const { status, user } = useAuth();
  const isAdmin = useIsAdmin();

  if (status === "loading") {
    // Reserve the same horizontal footprint as a "Sign in" link so the
    // layout doesn't jump when auth resolves.
    return <span className="h-9 w-[72px]" aria-hidden />;
  }

  if (status === "anonymous") {
    return (
      <Link
        to="/sign-in"
        className="inline-flex h-9 items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink)] no-underline hover:bg-[var(--link-bg-hover)]"
      >
        Sign in
      </Link>
    );
  }

  // Authenticated — pull a friendly label off the user. Better Auth
  // populates `name` from the Google profile; we also fill `displayName`
  // in the `user.create.before` hook. Prefer the human-entered display
  // name, fall back to Google's `name`, then email, then a generic label.
  const label =
    user?.displayName ??
    user?.name ??
    user?.email ??
    "Signed in";
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  const avatarUrl = user?.avatarUrl ?? user?.image ?? undefined;

  return (
    <ProfileMenu
      label={label}
      email={user?.email ?? null}
      initial={initial}
      avatarUrl={avatarUrl}
      isAdmin={isAdmin === true}
    />
  );
}

/**
 * Profile button that toggles a dropdown with account info, an Admin
 * shortcut (only when `isAdmin`), and Sign out.
 *
 * Keyboard / a11y:
 *   - Button has `aria-haspopup="menu"` and `aria-expanded`.
 *   - Escape closes and returns focus to the button.
 *   - Outside clicks close.
 *   - Menu items are plain anchors/buttons for simplicity; we don't
 *     implement full roving-tabindex arrow-key nav because the list is
 *     short (≤ 3 items) and tab order through anchors is already sensible.
 */
function ProfileMenu({
  label,
  email,
  initial,
  avatarUrl,
  isAdmin,
}: {
  label: string;
  email: string | null;
  initial: string;
  avatarUrl: string | undefined;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${label}`}
        title={label}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-1 pr-1 text-xs font-semibold text-[var(--sea-ink)] hover:bg-[var(--link-bg-hover)] sm:pr-3"
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-7 w-7 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--lagoon)] text-[10px] font-bold text-[var(--on-accent)]">
            {initial}
          </span>
        )}
        <span className="hidden max-w-[120px] truncate sm:inline">{label}</span>
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
          <div className="border-b border-[var(--line)] px-4 py-3">
            <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">{label}</p>
            {email && email !== label && (
              <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">{email}</p>
            )}
          </div>

          {isAdmin && (
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
        </div>
      )}
    </div>
  );
}
