import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import { getMeFn } from "@/server/admin";
import { createPackDraftFn } from "@/server/user-packs";

/**
 * Pack-builder entry point.
 *
 * Minimum-viable draft form: name + optional description. Everything
 * else (books, genre tags, cover image) lives on the edit page because
 * it needs the draft id first. Submitting creates the draft and
 * redirects to `/packs/$id/edit`.
 *
 * Auth: server fn throws for anonymous callers, but the route also
 * redirects up-front so signed-out users land on `/sign-in` instead of
 * seeing a form that will fail.
 */
export const Route = createFileRoute("/packs/new")({
  loader: async () => {
    const user = await getMeFn();
    if (!user) throw redirect({ to: "/sign-in" });
    return { user };
  },
  component: NewPackPage,
});

function NewPackPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await createPackDraftFn({
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
        },
      });
      // Navigate to the edit screen — the builder flow's real surface.
      await router.navigate({ to: "/packs/$id/edit", params: { id: result.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create draft");
      setSubmitting(false);
    }
  };

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8">
        <p className="island-kicker">New pack</p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          Build a pack
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          Start a draft with a name and optional description. You can
          add books, genre tags, and a cover on the next screen. Drafts
          are private until you publish them.
        </p>
      </header>

      <form onSubmit={onSubmit} className="island-shell max-w-xl space-y-5 rounded-3xl p-5">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
            Name <span className="text-[color:var(--rarity-legendary)]">*</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
            placeholder="Sci-fi starter shelf"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
            className="input-field w-full rounded-2xl px-4 py-3 text-sm"
            placeholder="A short pitch for your pack — what ties these books together."
          />
        </label>

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-2 text-xs text-[color:var(--rarity-legendary)]"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="btn-primary w-full rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Creating…" : "Create draft"}
        </button>
      </form>
    </main>
  );
}
