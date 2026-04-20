import { Link } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import { signOut, useAuth } from "@/lib/supabase/auth";

/**
 * Top app bar — Tome wordmark + theme toggle + auth state.
 * On mobile this is the only chrome at the top; primary navigation lives
 * in the bottom tab bar (see `BottomTabs`). On desktop (≥sm) the top bar
 * also carries the inline nav links.
 *
 * Auth: while the session is still loading we render nothing in the auth
 * slot so we don't flash a "Sign in" link to a logged-in user. Once known,
 * we either show a user pill (avatar + sign-out) or a "Sign in" link.
 */
export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 pt-[env(safe-area-inset-top)] backdrop-blur-lg">
      <nav className="page-wrap flex items-center gap-3 py-3 sm:py-4">
        <Link
          to="/"
          className="inline-flex h-11 items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 text-sm font-semibold text-[var(--sea-ink)] no-underline"
        >
          <span className="h-2 w-2 rounded-full bg-[linear-gradient(90deg,var(--lagoon),var(--palm))]" />
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

  // Authenticated — pull a friendly label off the user.
  const label =
    (user?.user_metadata?.full_name as string | undefined) ??
    (user?.user_metadata?.name as string | undefined) ??
    user?.email ??
    "Signed in";
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="hidden h-9 items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 pr-3 text-xs font-semibold text-[var(--sea-ink)] sm:inline-flex"
        title={label}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-6 w-6 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--lagoon)] text-[10px] font-bold text-[var(--on-accent)]">
            {initial}
          </span>
        )}
        <span className="max-w-[120px] truncate">{label}</span>
      </span>

      {/* Mobile-only avatar button */}
      <span
        className="grid h-9 w-9 place-items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] sm:hidden"
        aria-label={label}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-7 w-7 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--lagoon)] text-xs font-bold text-[var(--on-accent)]">
            {initial}
          </span>
        )}
      </span>

      <button
        type="button"
        onClick={() => void signOut()}
        className="grid h-9 w-9 place-items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}
