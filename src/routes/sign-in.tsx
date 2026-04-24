import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { signInWithGoogle, useAuth } from "@/lib/auth/hooks";

export const Route = createFileRoute("/sign-in")({
  component: SignInPage,
});

function SignInPage() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // If we land here already signed-in, bounce home.
  if (status === "authenticated") {
    void navigate({ to: "/" });
  }

  async function handleGoogle() {
    setError(null);
    setPending(true);
    try {
      await signInWithGoogle();
      // signInWithOAuth navigates away — we won't reach this line in practice.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setPending(false);
    }
  }

  return (
    <main className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-10 sm:py-16">
      <div className="island-shell w-full max-w-md rounded-3xl p-8 text-center">
        <p className="island-kicker">Welcome to Tome</p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)]">
          Sign in to start collecting
        </h1>
        <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
          Your collection, packs, and reading log live in your account so you can rip from any
          device.
        </p>

        <button
          type="button"
          onClick={handleGoogle}
          disabled={pending}
          className="btn-primary mt-8 w-full rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Redirecting…" : "Continue with Google"}
        </button>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-[color:var(--rarity-foil)]/40 bg-[color:var(--rarity-foil-soft)] px-3 py-2 text-xs text-[color:var(--rarity-foil)]"
          >
            {error}
          </p>
        )}

        <p className="mt-8 text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          <Link to="/" className="hover:text-[var(--sea-ink)]">
            ← Back to home
          </Link>
        </p>
      </div>
    </main>
  );
}
