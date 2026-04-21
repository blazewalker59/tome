import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { AdminForbidden } from "@/components/AdminForbidden";
import { checkAdminFn } from "@/server/admin";
import {
  addBookToPackFn,
  getPackFn,
  listBooksFn,
  removeBookFromPackFn,
  type AdminBookRow,
  type AdminPackDetail,
} from "@/server/catalog";

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

  const handleAdd = useCallback(
    async (bookId: string) => {
      if (!pack) return;
      try {
        await addBookToPackFn({ data: { packId: pack.id, bookId } });
        await reload();
      } catch (err) {
        // eslint-disable-next-line no-alert
        alert(err instanceof Error ? err.message : "Failed to add");
      }
    },
    [pack, reload],
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
        {pack.description && (
          <p className="mt-2 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
            {pack.description}
          </p>
        )}
        <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
          {pack.kind} · {pack.books.length} books
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <MembersColumn books={pack.books} onRemove={handleRemove} />
        <AddColumn memberIds={memberIds} onAdd={handleAdd} />
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Members column
// ─────────────────────────────────────────────────────────────────────────────

function MembersColumn({
  books,
  onRemove,
}: {
  books: AdminPackDetail["books"];
  onRemove: (bookId: string) => void;
}) {
  return (
    <section>
      <h2 className="island-kicker mb-3">Current members · {books.length}</h2>
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
                  {book.authors.join(", ") || "Unknown"} · {book.genre} · {book.rarity}
                </p>
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
// Add column (catalog search)
// ─────────────────────────────────────────────────────────────────────────────

function AddColumn({
  memberIds,
  onAdd,
}: {
  memberIds: Set<string>;
  onAdd: (bookId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<AdminBookRow[]>([]);
  const [loading, setLoading] = useState(false);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    const q = search.trim();
    const mySeq = ++reqSeqRef.current;
    // We only search with at least 2 chars — an empty-string browse would
    // load the full catalog into this panel, which isn't useful vs. the
    // dedicated /admin/books view.
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      setLoading(true);
      listBooksFn({ data: { search: q, limit: 50 } })
        .then((res) => {
          if (mySeq !== reqSeqRef.current) return;
          setResults([...res.items]);
          setLoading(false);
        })
        .catch(() => {
          if (mySeq !== reqSeqRef.current) return;
          setLoading(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <section>
      <h2 className="island-kicker mb-3">Add books</h2>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search title or author (2+ chars)"
        className="input-field mb-3 min-h-[40px] w-full rounded-full px-4 text-sm"
        aria-label="Search catalog"
      />
      {loading ? (
        <p className="text-xs text-[var(--sea-ink-soft)]">Searching…</p>
      ) : search.trim().length < 2 ? (
        <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
          Type at least 2 characters to search the catalog.
        </p>
      ) : results.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
          No matches.
        </p>
      ) : (
        <ul className="space-y-2">
          {results.map((book) => {
            const isMember = memberIds.has(book.id);
            return (
              <li
                key={book.id}
                className="flex gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3"
              >
                {book.coverUrl ? (
                  <img
                    src={book.coverUrl}
                    alt=""
                    className="h-14 w-10 shrink-0 rounded-md object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="h-14 w-10 shrink-0 rounded-md bg-[var(--surface-muted)]" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                    {book.title}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">
                    {book.authors.join(", ") || "Unknown"} · {book.genre}
                  </p>
                </div>
                <div className="shrink-0 self-center">
                  {isMember ? (
                    <span className="rounded-full border border-[color:var(--rarity-rare)]/40 bg-[color:var(--rarity-rare-soft)] px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--rarity-rare)]">
                      In pack
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onAdd(book.id)}
                      className="btn-secondary rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.14em]"
                    >
                      + Add
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
