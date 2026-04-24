import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { AdminForbidden } from "@/components/AdminForbidden";
import { checkAdminFn } from "@/server/admin";
import { createPackFn, listPacksFn, type AdminPackSummary } from "@/server/catalog";

/**
 * Admin packs index: list existing packs + inline create form.
 *
 * The create form auto-derives a slug from the name as the operator types
 * (standard kebab-case transform); the slug field is still editable if
 * they want to override. Submitting POSTs to `createPackFn` which also
 * enforces kebab-case and uniqueness on the server.
 *
 * Clicking a pack row navigates to `/admin/packs/$slug` for membership
 * editing.
 */
export const Route = createFileRoute("/admin/packs/")({
  loader: async () => {
    const status = await checkAdminFn();
    if (!status.signedIn) {
      throw redirect({ to: "/sign-in" });
    }
    return { status };
  },
  component: AdminPacksPage,
});

function AdminPacksPage() {
  const { status } = Route.useLoaderData();
  if (!status.isAdmin) return <AdminForbidden email={status.email} />;
  return <PacksWorkspace />;
}

/** Kebab-cases a name: "Booker Shortlist 2024" → "booker-shortlist-2024". */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function PacksWorkspace() {
  const [packs, setPacks] = useState<AdminPackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listPacksFn();
      setPacks([...rows]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8">
        <p className="island-kicker">
          <Link to="/admin" className="hover:text-[var(--sea-ink)]">
            Admin
          </Link>{" "}
          · packs
        </p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          Editorial packs
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          Packs group books for release drops. New packs are created as{" "}
          <code className="rounded bg-[var(--surface-muted)] px-1 py-0.5 text-xs">
            editorial
          </code>{" "}
          kind; deck-derived packs are produced by the deck flow.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section>
          <h2 className="island-kicker mb-3">Packs · {packs.length}</h2>

          {error && (
            <p
              role="alert"
              className="mb-3 rounded-xl border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-2 text-xs text-[color:var(--rarity-legendary)]"
            >
              {error}
            </p>
          )}

          {loading ? (
            <p className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
              Loading…
            </p>
          ) : packs.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
              No packs yet. Create one on the right.
            </p>
          ) : (
            <ul className="space-y-2">
              {packs.map((p) => (
                <li key={p.id}>
                  <Link
                    to="/admin/packs/$slug"
                    params={{ slug: p.slug }}
                    className="flex items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3 no-underline hover:border-[var(--lagoon)]"
                  >
                    {p.coverImageUrl ? (
                      <img
                        src={p.coverImageUrl}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-xl object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="h-14 w-14 shrink-0 rounded-xl bg-[linear-gradient(135deg,var(--lagoon),var(--palm))]" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                        {p.name}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">
                        {p.slug} · {p.bookCount} books · {p.creatorId === null ? "editorial" : "user"}
                      </p>
                      {p.description && (
                        <p className="mt-1 line-clamp-1 text-xs text-[var(--sea-ink-soft)]">
                          {p.description}
                        </p>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <CreatePackForm onCreated={reload} />
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create form
// ─────────────────────────────────────────────────────────────────────────────

function CreatePackForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  /** Track whether the operator has hand-edited the slug; once they do, we
   * stop auto-deriving it from the name so we don't overwrite their value. */
  const [slugDirty, setSlugDirty] = useState(false);
  const [description, setDescription] = useState("");
  const [coverImageUrl, setCoverImageUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onNameChange = (v: string) => {
    setName(v);
    if (!slugDirty) setSlug(slugify(v));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await createPackFn({
        data: {
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim() || undefined,
          coverImageUrl: coverImageUrl.trim() || undefined,
        },
      });
      await onCreated();
      setName("");
      setSlug("");
      setSlugDirty(false);
      setDescription("");
      setCoverImageUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section>
      <h2 className="island-kicker mb-3">New pack</h2>
      <form
        onSubmit={onSubmit}
        className="island-shell space-y-4 rounded-3xl p-5"
      >
        <Field label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            required
            maxLength={120}
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
            placeholder="Booker Shortlist 2024"
          />
        </Field>
        <Field label="Slug" hint="Auto-derived from name. Kebab-case.">
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugDirty(true);
            }}
            required
            pattern="[a-z0-9][a-z0-9-]*"
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
            placeholder="booker-shortlist-2024"
          />
        </Field>
        <Field label="Description" hint="Optional.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="input-field w-full rounded-2xl px-4 py-3 text-sm"
            placeholder="Six novels shortlisted for the 2024 Booker Prize."
          />
        </Field>
        <Field label="Cover image URL" hint="Optional.">
          <input
            type="url"
            value={coverImageUrl}
            onChange={(e) => setCoverImageUrl(e.target.value)}
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
            placeholder="https://…"
          />
        </Field>

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
          disabled={submitting || !name.trim() || !slug.trim()}
          className="btn-primary w-full rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Creating…" : "Create pack"}
        </button>
      </form>
    </section>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
        {label}
        {required && <span className="ml-1 text-[color:var(--rarity-legendary)]">*</span>}
      </span>
      {children}
      {hint && (
        <span className="mt-1.5 block text-[11px] text-[var(--sea-ink-soft)]">
          {hint}
        </span>
      )}
    </label>
  );
}
