import { Link } from "@tanstack/react-router";

/**
 * Shared 403 panel for admin routes.
 *
 * Every `/admin/*` route calls `checkAdminFn` in its loader; signed-in
 * non-admins get this island rendered instead of the gated content. The
 * loader-level check avoids a flash of admin UI for unauthorized users
 * and keeps the server fn call off the client path for anonymous users
 * (they're redirected to sign-in before the component ever mounts).
 */
export function AdminForbidden({ email }: { email: string | null }) {
  return (
    <main className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-10 sm:py-16">
      <div className="island-shell w-full max-w-md rounded-3xl p-8 text-center">
        <p className="island-kicker">403 · not your shelf</p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)]">
          Admin access required
        </h1>
        <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
          Your account{email ? ` (${email})` : ""} isn&rsquo;t on the admin
          allowlist. If that&rsquo;s a mistake, ping the operator to add you to
          <code className="mx-1 rounded bg-[var(--surface-muted)] px-1 py-0.5 text-xs">
            ADMIN_EMAILS
          </code>
          .
        </p>
        <p className="mt-8 text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          <Link to="/" className="hover:text-[var(--sea-ink)]">
            ← Back to home
          </Link>
        </p>
      </div>
    </main>
  );
}
