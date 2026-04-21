import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { X } from "lucide-react";

import { AdminForbidden } from "@/components/AdminForbidden";
import { checkAdminFn } from "@/server/admin";
import {
  listBooksFn,
  listPacksFn,
  setBookPacksFn,
  updateBookCurationFn,
  type AdminBookRow,
  type AdminPackSummary,
} from "@/server/catalog";

/**
 * Admin catalog browser.
 *
 * Layout is a wide table: cover, title+authors, genre, rarity, ratings,
 * pack memberships (as chips), assign button. Genre and mood tags are
 * editable in-place and persist on blur — no explicit save button, which
 * matches the low-friction curation feel. Rarity is display-only (owned
 * by `pnpm db:rebucket`).
 *
 * Pack assignment is deliberately modal-per-row rather than inline — a
 * book can belong to many packs, and a typeahead+checklist UI doesn't
 * fit cleanly inside a table row without breaking the scan.
 *
 * Search is server-side (title + authors), debounced 300ms. We don't
 * client-filter because the catalog grows beyond a reasonable in-memory
 * shipment as ingest continues; the server fn caps results at 200/page.
 */
export const Route = createFileRoute("/admin/books")({
  loader: async () => {
    const status = await checkAdminFn();
    if (!status.signedIn) {
      throw redirect({ to: "/sign-in" });
    }
    return { status };
  },
  component: AdminBooksPage,
});

function AdminBooksPage() {
  const { status } = Route.useLoaderData();
  if (!status.isAdmin) return <AdminForbidden email={status.email} />;
  return <BooksWorkspace />;
}

interface LoadState {
  kind: "idle" | "loading" | "error";
  message?: string;
}

function BooksWorkspace() {
  const [books, setBooks] = useState<AdminBookRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "idle" });
  const [searchInput, setSearchInput] = useState("");
  const [allPacks, setAllPacks] = useState<AdminPackSummary[]>([]);
  const [assignTarget, setAssignTarget] = useState<AdminBookRow | null>(null);

  // Debounced search — same cadence as Hardcover ingest's search.
  const reqSeqRef = useRef(0);
  useEffect(() => {
    const q = searchInput.trim();
    const mySeq = ++reqSeqRef.current;
    const timer = setTimeout(() => {
      setLoadState({ kind: "loading" });
      listBooksFn({ data: { search: q || undefined, limit: 200 } })
        .then((result) => {
          if (mySeq !== reqSeqRef.current) return;
          setBooks([...result.items]);
          setTotal(result.total);
          setLoadState({ kind: "idle" });
        })
        .catch((err: unknown) => {
          if (mySeq !== reqSeqRef.current) return;
          setLoadState({
            kind: "error",
            message: err instanceof Error ? err.message : "Load failed",
          });
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Packs list: load once at mount. We refetch only if the modal opens
  // after a new pack was created elsewhere in this session (rare — admin
  // workflows tend to not interleave these tabs).
  useEffect(() => {
    listPacksFn()
      .then((rows) => setAllPacks([...rows]))
      .catch(() => {
        /* non-fatal; assign modal will show an empty state */
      });
  }, []);

  const handleCurationUpdate = useCallback(
    async (
      bookId: string,
      patch: { genre?: string; moodTags?: string[] },
    ): Promise<void> => {
      // Optimistic: we already updated local state before this was called.
      // On failure, reload the row from the server to rectify.
      try {
        const result = await updateBookCurationFn({ data: { bookId, ...patch } });
        setBooks((prev) =>
          prev.map((b) =>
            b.id === bookId
              ? { ...b, genre: result.genre, moodTags: result.moodTags }
              : b,
          ),
        );
      } catch (err) {
        // Error is surfaced via alert because inline row error UI would
        // require a per-row error slot. Admin-tier UX — a toast would be
        // nicer later.
        // eslint-disable-next-line no-alert
        alert(
          `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [],
  );

  const handleAssignSubmit = useCallback(
    async (bookId: string, packIds: string[]) => {
      try {
        await setBookPacksFn({ data: { bookId, packIds } });
        // Sync local row's `packs` display.
        const packsById = new Map(allPacks.map((p) => [p.id, p]));
        const nextPacks = packIds
          .map((id) => packsById.get(id))
          .filter((p): p is AdminPackSummary => Boolean(p))
          .map((p) => ({ id: p.id, slug: p.slug, name: p.name }));
        setBooks((prev) =>
          prev.map((b) => (b.id === bookId ? { ...b, packs: nextPacks } : b)),
        );
        setAssignTarget(null);
      } catch (err) {
        // eslint-disable-next-line no-alert
        alert(
          `Failed to save pack assignments: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    [allPacks],
  );

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="island-kicker">
            <Link to="/admin" className="hover:text-[var(--sea-ink)]">
              Admin
            </Link>{" "}
            · books
          </p>
          <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
            Browse catalog
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
            Edit genre + mood tags in place (saves on blur). Click a row&rsquo;s
            <em> Packs</em> to manage memberships. Rarity is owned by{" "}
            <code className="rounded bg-[var(--surface-muted)] px-1 py-0.5 text-xs">
              pnpm db:rebucket
            </code>
            .
          </p>
        </div>
        <div className="w-full sm:w-72">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search title or author"
            className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
            aria-label="Search catalog"
          />
          <p className="mt-2 text-[11px] text-[var(--sea-ink-soft)]">
            {loadState.kind === "loading"
              ? "Loading…"
              : `${books.length} shown · ${total} total`}
          </p>
        </div>
      </header>

      {loadState.kind === "error" && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-2 text-xs text-[color:var(--rarity-legendary)]"
        >
          {loadState.message}
        </p>
      )}

      <div className="island-shell overflow-hidden rounded-3xl">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--line)] text-left text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
              <tr>
                <th className="w-[40%] px-4 py-3">Book</th>
                <th className="px-3 py-3">Genre</th>
                <th className="px-3 py-3">Mood tags</th>
                <th className="px-3 py-3">Rarity</th>
                <th className="px-3 py-3">Packs</th>
              </tr>
            </thead>
            <tbody>
              {books.length === 0 && loadState.kind !== "loading" ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-10 text-center text-xs text-[var(--sea-ink-soft)]"
                  >
                    No books match.
                  </td>
                </tr>
              ) : (
                books.map((book) => (
                  <BookRow
                    key={book.id}
                    book={book}
                    onUpdate={handleCurationUpdate}
                    onAssignClick={() => setAssignTarget(book)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {assignTarget && (
        <AssignPacksModal
          book={assignTarget}
          allPacks={allPacks}
          onClose={() => setAssignTarget(null)}
          onSubmit={(packIds) => handleAssignSubmit(assignTarget.id, packIds)}
        />
      )}
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Row with inline genre/moodTags editing
// ─────────────────────────────────────────────────────────────────────────────

function BookRow({
  book,
  onUpdate,
  onAssignClick,
}: {
  book: AdminBookRow;
  onUpdate: (
    bookId: string,
    patch: { genre?: string; moodTags?: string[] },
  ) => Promise<void>;
  onAssignClick: () => void;
}) {
  // Local drafts so typing doesn't trigger a save per keystroke. Commit
  // happens on blur, iff the normalized value actually changed.
  const [genreDraft, setGenreDraft] = useState(book.genre);
  const [moodDraft, setMoodDraft] = useState(book.moodTags.join(", "));

  // Sync drafts when the row is reloaded from the server (e.g. after a
  // search refresh that picks up another admin's edits).
  useEffect(() => {
    setGenreDraft(book.genre);
  }, [book.genre]);
  useEffect(() => {
    setMoodDraft(book.moodTags.join(", "));
  }, [book.moodTags]);

  const commitGenre = () => {
    const next = genreDraft.trim().toLowerCase();
    if (next === book.genre) return;
    void onUpdate(book.id, { genre: next });
  };
  const commitMood = () => {
    const next = moodDraft
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const prevJoined = book.moodTags.join(",");
    if (next.join(",") === prevJoined) return;
    void onUpdate(book.id, { moodTags: next });
  };

  return (
    <tr className="border-b border-[var(--line)] last:border-0 align-top">
      <td className="px-4 py-3">
        <div className="flex gap-3">
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
          <div className="min-w-0">
            <p className="truncate font-semibold text-[var(--sea-ink)]">
              {book.title}
              {book.publishedYear && (
                <span className="ml-1 text-xs font-normal text-[var(--sea-ink-soft)]">
                  ({book.publishedYear})
                </span>
              )}
            </p>
            <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">
              {book.authors.join(", ") || "Unknown author"}
            </p>
            <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
              hc#{book.hardcoverId}
              {book.averageRating != null &&
                ` · ★ ${Number(book.averageRating).toFixed(2)}`}
              {book.ratingsCount > 0 &&
                ` · ${book.ratingsCount.toLocaleString()} ratings`}
            </p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        <input
          type="text"
          value={genreDraft}
          onChange={(e) => setGenreDraft(e.target.value)}
          onBlur={commitGenre}
          pattern="[a-z0-9][a-z0-9-]*"
          className="input-field min-h-[32px] w-32 rounded-md px-2 text-xs"
          placeholder="literary-fiction"
          aria-label={`Genre for ${book.title}`}
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="text"
          value={moodDraft}
          onChange={(e) => setMoodDraft(e.target.value)}
          onBlur={commitMood}
          className="input-field min-h-[32px] w-48 rounded-md px-2 text-xs"
          placeholder="atmospheric, slow-burn"
          aria-label={`Mood tags for ${book.title}`}
        />
      </td>
      <td className="px-3 py-3">
        <RarityBadge rarity={book.rarity} />
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {book.packs.length === 0 ? (
            <span className="text-xs text-[var(--sea-ink-soft)]">—</span>
          ) : (
            book.packs.map((p) => (
              <span
                key={p.id}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--sea-ink)]"
                title={p.slug}
              >
                {p.name}
              </span>
            ))
          )}
          <button
            type="button"
            onClick={onAssignClick}
            className="btn-secondary rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.14em]"
          >
            Edit
          </button>
        </div>
      </td>
    </tr>
  );
}

function RarityBadge({ rarity }: { rarity: string }) {
  // Colour tokens follow the rarity palette defined in the theme CSS.
  const map: Record<string, string> = {
    common:
      "border border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)]",
    uncommon:
      "border border-[color:var(--rarity-uncommon)]/40 bg-[color:var(--rarity-uncommon-soft)] text-[color:var(--rarity-uncommon)]",
    rare: "border border-[color:var(--rarity-rare)]/40 bg-[color:var(--rarity-rare-soft)] text-[color:var(--rarity-rare)]",
    foil: "border border-[color:var(--rarity-foil)]/40 bg-[color:var(--rarity-foil-soft)] text-[color:var(--rarity-foil)]",
    legendary:
      "border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] text-[color:var(--rarity-legendary)]",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${
        map[rarity] ?? map.common
      }`}
    >
      {rarity}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Assign-packs modal
// ─────────────────────────────────────────────────────────────────────────────

function AssignPacksModal({
  book,
  allPacks,
  onClose,
  onSubmit,
}: {
  book: AdminBookRow;
  allPacks: AdminPackSummary[];
  onClose: () => void;
  onSubmit: (packIds: string[]) => void;
}) {
  const initialSelected = useMemo(
    () => new Set(book.packs.map((p) => p.id)),
    [book.packs],
  );
  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allPacks;
    return allPacks.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
    );
  }, [allPacks, filter]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-packs-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="island-shell w-full max-w-lg rounded-3xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="island-kicker">Assign packs</p>
            <h2
              id="assign-packs-title"
              className="display-title mt-1 text-lg font-bold text-[var(--sea-ink)]"
            >
              {book.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-[var(--sea-ink-soft)] hover:bg-[var(--link-bg-hover)] hover:text-[var(--sea-ink)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter packs"
          className="input-field mb-3 min-h-[36px] w-full rounded-full px-4 text-xs"
          aria-label="Filter packs"
        />

        <ul className="max-h-72 overflow-y-auto rounded-2xl border border-[var(--line)]">
          {filtered.length === 0 ? (
            <li className="p-4 text-center text-xs text-[var(--sea-ink-soft)]">
              {allPacks.length === 0 ? (
                <>
                  No packs yet.{" "}
                  <Link to="/admin/packs" className="underline">
                    Create one
                  </Link>
                  .
                </>
              ) : (
                "No matches."
              )}
            </li>
          ) : (
            filtered.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-2 last:border-0"
              >
                <input
                  id={`pack-${p.id}`}
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="h-4 w-4"
                />
                <label
                  htmlFor={`pack-${p.id}`}
                  className="flex-1 cursor-pointer text-sm text-[var(--sea-ink)]"
                >
                  <span className="font-semibold">{p.name}</span>
                  <span className="ml-2 text-[11px] text-[var(--sea-ink-soft)]">
                    {p.slug} · {p.bookCount} books
                  </span>
                </label>
              </li>
            ))
          )}
        </ul>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary rounded-full px-4 py-2 text-xs uppercase tracking-[0.14em]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit([...selected])}
            className="btn-primary rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em]"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
