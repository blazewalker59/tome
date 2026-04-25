import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { AdminForbidden } from "@/components/AdminForbidden";
import { BookSearchPanel } from "@/components/builder/BookSearchPanel";
import type { Rarity } from "@/lib/cards/rarity";
import { checkAdminFn } from "@/server/admin";
import {
  addBookToPackFn,
  getPackFn,
  ingestHardcoverBookForAdminPackFn,
  removeBookFromPackFn,
  updateBookRarityFn,
  updatePackFn,
  type AdminPackDetail,
} from "@/server/catalog";

// Mirror of `RARITY_VALUES` in src/server/catalog.ts. Kept as a local
// constant so the dropdown can render options without importing from
// the server module (server fns drag `node:*` deps into the bundle).
const RARITY_OPTIONS: ReadonlyArray<Rarity> = [
  "common",
  "uncommon",
  "rare",
  "foil",
  "legendary",
];

/**
 * Pack membership editor.
 *
 * Two-column layout:
 *   • Left: current members with a Remove button per row.
 *   • Right: search over the full catalog; results not already in the
 *     pack show an Add button. Results already in the pack are badged so
 *     the operator doesn't double-click.
 *
 * Each Add/Remove click fires a single server fn + optimistically updates
 * local state. On failure we reload the pack to rectify.
 */
export const Route = createFileRoute("/admin/packs/$slug")({
  loader: async ({ params }) => {
    const status = await checkAdminFn();
    if (!status.signedIn) {
      throw redirect({ to: "/sign-in" });
    }
    return { status, slug: params.slug };
  },
  component: AdminPackDetailPage,
});

function AdminPackDetailPage() {
  const { status, slug } = Route.useLoaderData();
  if (!status.isAdmin) return <AdminForbidden email={status.email} />;
  return <PackWorkspace slug={slug} />;
}

function PackWorkspace({ slug }: { slug: string }) {
  const [pack, setPack] = useState<AdminPackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const p = await getPackFn({ data: { slug } });
      setPack(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    }
  }, [slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const memberIds = useMemo(
    () => new Set(pack?.books.map((b) => b.id) ?? []),
    [pack],
  );

  const handleRemove = useCallback(
    async (bookId: string) => {
      if (!pack) return;
      try {
        await removeBookFromPackFn({ data: { packId: pack.id, bookId } });
        // Optimistic removal so the row disappears instantly.
        setPack((prev) =>
          prev ? { ...prev, books: prev.books.filter((b) => b.id !== bookId) } : prev,
        );
      } catch (err) {
        // eslint-disable-next-line no-alert
        alert(err instanceof Error ? err.message : "Failed to remove");
        await reload();
      }
    },
    [pack, reload],
  );

  const handleRarityChange = useCallback(
    async (bookId: string, rarity: Rarity) => {
      if (!pack) return;
      // Snapshot the prior value so we can revert on failure without a
      // round-trip to the server. Optimistic updates keep the UI
      // responsive (the dropdown commits instantly) while still
      // surfacing genuine errors.
      const prior = pack.books.find((b) => b.id === bookId)?.rarity;
      setPack((prev) =>
        prev
          ? {
              ...prev,
              books: prev.books.map((b) =>
                b.id === bookId ? { ...b, rarity } : b,
              ),
            }
          : prev,
      );
      try {
        await updateBookRarityFn({ data: { bookId, rarity } });
      } catch (err) {
        // eslint-disable-next-line no-alert
        alert(err instanceof Error ? err.message : "Failed to update rarity");
        // Revert the optimistic patch.
        if (prior !== undefined) {
          setPack((prev) =>
            prev
              ? {
                  ...prev,
                  books: prev.books.map((b) =>
                    b.id === bookId ? { ...b, rarity: prior } : b,
                  ),
                }
              : prev,
          );
        }
      }
    },
    [pack],
  );

  if (!pack && !error) {
    return (
      <main className="page-wrap py-12">
        <p className="text-xs text-[var(--sea-ink-soft)]">Loading…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="page-wrap py-12">
        <p
          role="alert"
          className="rounded-xl border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-2 text-xs text-[color:var(--rarity-legendary)]"
        >
          {error}
        </p>
        <p className="mt-4 text-xs">
          <Link to="/admin/packs" className="underline">
            ← All packs
          </Link>
        </p>
      </main>
    );
  }

  if (!pack) return null;

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8">
        <p className="island-kicker">
          <Link to="/admin" className="hover:text-[var(--sea-ink)]">
            Admin
          </Link>{" "}
          ·{" "}
          <Link to="/admin/packs" className="hover:text-[var(--sea-ink)]">
            packs
          </Link>{" "}
          · {pack.slug}
        </p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          {pack.name}
        </h1>
        <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
          {pack.creatorId === null ? "editorial" : "user"} · {pack.books.length} books
          {pack.genreTags.length > 0 && <> · {pack.genreTags.join(", ")}</>}
        </p>
      </header>

      {/* Pack details editor — name, description, cover, genre tags.
          Slug is intentionally read-only (it's part of public URLs and
          rip-history attribution; renames would invalidate shared
          links). Sits above the books area because edits here are less
          frequent than the membership churn below, but when an editor
          DOES want to fix the name or palette they shouldn't have to
          scroll past the entire member list to do it. */}
      <PackDetailsForm
        pack={pack}
        onSaved={(next) =>
          setPack((prev) =>
            prev
              ? {
                  ...prev,
                  name: next.name,
                  description: next.description,
                  coverImageUrl: next.coverImageUrl,
                  genreTags: next.genreTags,
                }
              : prev,
          )
        }
      />

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <MembersColumn
          books={pack.books}
          onRemove={handleRemove}
          onRarityChange={handleRarityChange}
        />
        <BookSearchPanel
          packId={pack.id}
          // Admin path doesn't filter members server-side; we want the
          // "In pack" badge to show context for already-curated books
          // rather than hiding them entirely.
          excludeBookIds={memberIds}
          onAddLocal={async (bookId) => {
            await addBookToPackFn({ data: { packId: pack.id, bookId } });
            await reload();
          }}
          onAddHardcover={async (hardcoverId) => {
            await ingestHardcoverBookForAdminPackFn({
              data: { packId: pack.id, hardcoverId },
            });
            await reload();
          }}
        />
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pack details form (name / description / cover / genre tags)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inline edit form for the pack-level fields. Slug is shown read-only
 * (intentionally non-editable — see `updatePackFn` rationale).
 *
 * Save button stays disabled until at least one field has changed
 * relative to the current `pack` snapshot, so accidental clicks on a
 * pristine form are no-ops without round-tripping the server.
 */
function PackDetailsForm({
  pack,
  onSaved,
}: {
  pack: AdminPackDetail;
  onSaved: (next: {
    name: string;
    description: string | null;
    coverImageUrl: string | null;
    genreTags: ReadonlyArray<string>;
  }) => void;
}) {
  const [name, setName] = useState(pack.name);
  const [description, setDescription] = useState(pack.description ?? "");
  const [coverImageUrl, setCoverImageUrl] = useState(pack.coverImageUrl ?? "");
  // Render genre tags as a comma-separated string in the input — same
  // affordance the user-pack edit form uses (`packs.$id.edit.tsx`),
  // which keeps muscle memory consistent for editors who toggle
  // between editorial and user packs.
  const [genreTagsRaw, setGenreTagsRaw] = useState(pack.genreTags.join(", "));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Re-sync local state if the parent loads a fresh pack (e.g. after a
  // membership change triggers a full reload). Without this the form
  // would drift from the canonical row on background refetches.
  useEffect(() => {
    setName(pack.name);
    setDescription(pack.description ?? "");
    setCoverImageUrl(pack.coverImageUrl ?? "");
    setGenreTagsRaw(pack.genreTags.join(", "));
  }, [pack.id, pack.name, pack.description, pack.coverImageUrl, pack.genreTags]);

  // Parse the comma-separated tag input into a normalized array. We do
  // this on every render (cheap; ≤3 tags) so the dirty-check has the
  // same shape the server will see. Validation errors surface from the
  // server on submit rather than blocking the button.
  const parsedTags = useMemo(
    () =>
      genreTagsRaw
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0),
    [genreTagsRaw],
  );

  const tagsEqual = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  const dirty =
    name.trim() !== pack.name ||
    description.trim() !== (pack.description ?? "") ||
    coverImageUrl.trim() !== (pack.coverImageUrl ?? "") ||
    !tagsEqual(parsedTags, pack.genreTags);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !dirty) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await updatePackFn({
        data: {
          packId: pack.id,
          // Only send fields that actually changed — the server
          // distinguishes `undefined` (leave alone) from explicit
          // values, so a no-touch field shouldn't be in the payload.
          ...(name.trim() !== pack.name ? { name: name.trim() } : {}),
          ...(description.trim() !== (pack.description ?? "")
            ? { description: description.trim() }
            : {}),
          ...(coverImageUrl.trim() !== (pack.coverImageUrl ?? "")
            ? { coverImageUrl: coverImageUrl.trim() }
            : {}),
          ...(!tagsEqual(parsedTags, pack.genreTags)
            ? { genreTags: parsedTags }
            : {}),
        },
      });
      onSaved({
        name: result.name,
        description: result.description,
        coverImageUrl: result.coverImageUrl,
        genreTags: result.genreTags,
      });
      setSuccess(true);
      // Hide the success chip after a couple seconds — keeping it up
      // forever competes for attention against the next edit.
      window.setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section>
      <h2 className="island-kicker mb-3">Pack details</h2>
      <form
        onSubmit={onSubmit}
        className="island-shell grid gap-4 rounded-3xl p-5 lg:grid-cols-2"
      >
        <Field label="Slug" hint="Read-only. Slugs anchor public URLs and rip history.">
          <input
            type="text"
            value={pack.slug}
            readOnly
            disabled
            className="input-field min-h-[40px] w-full cursor-not-allowed rounded-full px-4 text-sm opacity-60"
          />
        </Field>
        <Field label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
          />
        </Field>
        <Field
          label="Genre tags"
          hint="Comma-separated, kebab-case, max 3. The first tag drives the rip wrapper gradient."
        >
          <input
            type="text"
            value={genreTagsRaw}
            onChange={(e) => setGenreTagsRaw(e.target.value)}
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
            placeholder="fantasy, starter"
          />
        </Field>
        <Field label="Cover image URL" hint="Optional. Empty clears it.">
          <input
            type="url"
            value={coverImageUrl}
            onChange={(e) => setCoverImageUrl(e.target.value)}
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
            placeholder="https://…"
          />
        </Field>
        <Field label="Description" hint="Optional. Empty clears it.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="input-field w-full rounded-2xl px-4 py-3 text-sm lg:col-span-2"
          />
        </Field>

        <div className="flex items-center gap-3 lg:col-span-2">
          <button
            type="submit"
            disabled={submitting || !dirty || !name.trim()}
            className="btn-primary rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Saving…" : "Save changes"}
          </button>
          {success && (
            <span className="rounded-full border border-[color:var(--rarity-rare)]/40 bg-[color:var(--rarity-rare-soft)] px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--rarity-rare)]">
              Saved
            </span>
          )}
          {error && (
            <span
              role="alert"
              className="rounded-xl border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-1 text-[10px] text-[color:var(--rarity-legendary)]"
            >
              {error}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Members column
// ─────────────────────────────────────────────────────────────────────────────

function MembersColumn({
  books,
  onRemove,
  onRarityChange,
}: {
  books: AdminPackDetail["books"];
  onRemove: (bookId: string) => void;
  onRarityChange: (bookId: string, rarity: Rarity) => void;
}) {
  return (
    <section>
      <h2 className="island-kicker mb-3">Current members · {books.length}</h2>
      {/* Rarity edits write to the global `books` row, not a per-pack
          override — surface that explicitly so editors don't think
          they're scoping the change to this pack only. */}
      <p className="mb-3 rounded-2xl border border-[color:var(--rarity-foil)]/40 bg-[color:var(--rarity-foil-soft)] px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-[color:var(--rarity-foil)]">
        Rarity changes apply globally to the book in every pack.
      </p>
      {books.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
          No books yet. Add from the right.
        </p>
      ) : (
        <ul className="space-y-2">
          {books.map((book) => (
            <li
              key={book.id}
              className="flex gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3"
            >
              {book.coverUrl ? (
                <img
                  src={book.coverUrl}
                  alt=""
                  className="h-16 w-11 shrink-0 rounded-md object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="h-16 w-11 shrink-0 rounded-md bg-[var(--surface-muted)]" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                  {book.title}
                </p>
                <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">
                  {book.authors.join(", ") || "Unknown"} · {book.genre}
                </p>
                <label className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                  Rarity
                  <select
                    value={book.rarity}
                    onChange={(e) =>
                      onRarityChange(book.id, e.target.value as Rarity)
                    }
                    className="input-field rounded-full px-2 py-1 text-[11px] normal-case tracking-normal"
                    aria-label={`Rarity for ${book.title}`}
                  >
                    {RARITY_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                type="button"
                onClick={() => onRemove(book.id)}
                className="shrink-0 self-start text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] hover:text-[color:var(--rarity-legendary)]"
                aria-label={`Remove ${book.title} from pack`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Field — small label/input wrapper used by the details form
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror of the `Field` helper in `admin.packs.index.tsx`. Inlined here
 * (rather than promoted to a shared module) because both copies are
 * tiny and the admin surface doesn't yet warrant a `components/admin/`
 * directory; if a third copy lands, lift it then.
 */
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
