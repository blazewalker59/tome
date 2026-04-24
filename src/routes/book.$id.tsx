import { useEffect, useState, useTransition } from "react";
import {
  createFileRoute,
  Link,
  notFound,
  useRouter,
} from "@tanstack/react-router";
import { BookOpen, Check, Star } from "lucide-react";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import { Card } from "@/components/cards/Card";
import { RARITY_STYLES, formatGenre } from "@/lib/cards/style";
import {
  getBookFn,
  updateCollectionCardFn,
  type BookDetailPayload,
  type ReadStatus,
} from "@/server/collection";

/**
 * Book detail route: `/book/:id`.
 *
 * Public page. The book itself, its pack memberships, and metadata are
 * visible to anyone with the link (including signed-out visitors) —
 * books are not a secret, and shareable book pages are a natural
 * entry point from elsewhere on the web. The per-user overlay
 * (reading status / rating / note) only renders when the caller is
 * signed in and owns the book. Non-owners see a "rip to unlock" CTA.
 *
 * The loader short-circuits with `notFound()` if the id doesn't match
 * any book — TanStack Router's 404 handler takes over. Auth failures
 * never happen here since the fn itself tolerates anonymous callers.
 */
export const Route = createFileRoute("/book/$id")({
  loader: async ({ params }) => {
    const data = await getBookFn({ data: { bookId: params.id } });
    if (!data) throw notFound();
    return { data };
  },
  component: BookDetailPage,
});

function BookDetailPage() {
  const { data } = Route.useLoaderData();
  const card = bookRowToCardData(data.book);

  return (
    <main className="page-wrap space-y-6 py-6 sm:space-y-8 sm:py-12">
      {/* Breadcrumb-ish back affordance — on a phone this is cheaper
          than the browser back chrome and more discoverable. */}
      <Link
        to="/collection"
        className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] underline-offset-4 hover:text-[var(--sea-ink)] hover:underline"
      >
        ← Back to collection
      </Link>

      <BookHero detail={data} />

      {/* Editable overlay — only owners see it. Anonymous users and
          non-owners get a CTA further down instead. */}
      {data.ownership?.owned ? (
        <OwnerPanel detail={data} />
      ) : (
        <UnlockCta signedIn={data.ownership !== null} />
      )}

      {/* Visual anchor — show the Card component itself so the detail
          page feels like an expanded version of what the user sees on
          the collection grid. Flip interaction stays because the back
          of the card has mood tags that the prose area below doesn't
          duplicate. */}
      <section className="rounded-[1.5rem] border border-[var(--line)] bg-[var(--surface)] p-6">
        <p className="island-kicker mb-4">The card</p>
        <div className="flex justify-center">
          <div className="w-full max-w-[320px]">
            <Card card={card} />
          </div>
        </div>
      </section>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero: cover + title + metadata + description
// ─────────────────────────────────────────────────────────────────────────────

function BookHero({ detail }: { detail: BookDetailPayload }) {
  const { book, packs } = detail;
  const rarity = RARITY_STYLES[book.rarity];
  const genreLabel = formatGenre(book.genre);

  return (
    <section className="island-shell rise-in overflow-hidden rounded-[2rem] p-6 sm:p-10">
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-10">
        <div className="mx-auto w-full max-w-[220px] shrink-0 sm:mx-0 sm:w-56">
          <div
            className={`relative aspect-[2/3] overflow-hidden rounded-2xl border bg-[var(--sand)] ${rarity.ring}`}
          >
            {book.coverUrl ? (
              <img
                src={book.coverUrl}
                alt=""
                className="h-full w-full object-cover"
                loading="eager"
                decoding="async"
                fetchPriority="high"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[var(--sea-ink-soft)]">
                <BookOpen aria-hidden className="h-10 w-10" />
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p className="island-kicker">{rarity.label}</p>
          <h1 className="display-title mt-2 text-3xl font-bold leading-tight text-[var(--sea-ink)] sm:text-4xl">
            {book.title}
          </h1>
          <p className="mt-2 text-sm text-[var(--sea-ink-soft)] sm:text-base">
            {book.authors.join(", ")}
          </p>

          {book.description && (
            <p className="mt-5 max-w-prose text-sm leading-relaxed text-[var(--sea-ink)]/90 sm:text-base">
              {book.description}
            </p>
          )}

          {/* Stat strip — compact, uppercase tracked to match the rest
              of the chrome. Hide fields that are zero/empty so we
              don't render "0 pages" when the DB just doesn't know. */}
          <dl className="mt-6 grid grid-cols-2 gap-3 text-xs uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] sm:grid-cols-4">
            <Meta label="Genre" value={genreLabel} />
            {book.pageCount ? <Meta label="Pages" value={`${book.pageCount}`} /> : null}
            {book.publishedYear ? (
              <Meta label="Year" value={`${book.publishedYear}`} />
            ) : null}
            <Meta label="Rarity" value={rarity.label} />
          </dl>

          {book.moodTags.length > 0 && (
            <ul className="mt-5 flex flex-wrap gap-2">
              {book.moodTags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--sea-ink-soft)]"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}

          {packs.length > 0 && (
            <p className="mt-6 text-xs uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
              Found in:{" "}
              {packs.map((p, i) => (
                <span key={p.id}>
                  <span className="text-[var(--sea-ink)]">{p.name}</span>
                  {i < packs.length - 1 && " · "}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold">{label}</dt>
      <dd className="mt-0.5 text-sm font-bold normal-case tracking-normal text-[var(--sea-ink)]">
        {value}
      </dd>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner panel — status / rating / notes
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_OPTIONS: Array<{ value: ReadStatus; label: string }> = [
  { value: "unread", label: "Unread" },
  { value: "reading", label: "Reading" },
  { value: "read", label: "Finished" },
];

/**
 * Editable panel for the signed-in owner. Optimistic-UI light: we show
 * the new value immediately and only fall back if the server rejects.
 * All three fields (status / rating / note) auto-save — no explicit
 * save button, which matches the inline feel of the rest of the app.
 * Status + rating commit on change; note commits on blur (so typing
 * doesn't fire a request per keystroke).
 */
function OwnerPanel({ detail }: { detail: BookDetailPayload }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const own = detail.ownership!;

  const [status, setStatus] = useState<ReadStatus>(own.status);
  const [rating, setRating] = useState<number | null>(own.rating);
  const [note, setNote] = useState(own.note ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // If the loader refreshes (e.g. after another tab edited) reset the
  // local state to the server truth. A stale local value otherwise
  // survives invalidation and leads to "why did my edit disappear?".
  useEffect(() => {
    setStatus(own.status);
    setRating(own.rating);
    setNote(own.note ?? "");
  }, [own.status, own.rating, own.note]);

  const save = async (
    patch: Parameters<typeof updateCollectionCardFn>[0] extends undefined
      ? never
      : { status?: ReadStatus; rating?: number | null; note?: string | null },
  ) => {
    setError(null);
    try {
      await updateCollectionCardFn({
        data: { bookId: detail.book.id, ...patch },
      });
      setSavedAt(Date.now());
      // Re-run the loader so any SSR cache + other tabs stay in sync.
      // Wrapped in startTransition so the save indicator doesn't
      // flicker when React suspends on the refetch.
      startTransition(() => {
        void router.invalidate();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  };

  return (
    <section className="island-shell rounded-[1.5rem] p-6 sm:p-8">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <div>
          <p className="island-kicker">Your copy</p>
          <h2 className="display-title mt-1 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
            Reading log
          </h2>
        </div>
        <SaveIndicator savedAt={savedAt} error={error} />
      </div>

      {/* Status — a three-state segmented control. Touch target 44px. */}
      <div className="mb-6">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          Status
        </p>
        <div role="radiogroup" aria-label="Reading status" className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((o) => {
            const active = status === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setStatus(o.value);
                  void save({ status: o.value });
                }}
                className={`view-tab ${active ? "is-active" : ""}`}
              >
                {active && <Check aria-hidden className="h-3.5 w-3.5" />}
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Rating — 5 star buttons. Click an already-selected star to
          clear it (common pattern; avoids dedicating a separate "no
          rating" button). */}
      <div className="mb-6">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          Rating
        </p>
        <div role="radiogroup" aria-label="Rating" className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = rating !== null && n <= rating;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={`${n} star${n === 1 ? "" : "s"}`}
                onClick={() => {
                  // Toggle off when clicking the currently-active max.
                  const next = rating === n ? null : n;
                  setRating(next);
                  void save({ rating: next });
                }}
                className="p-1 text-[var(--sea-ink-soft)] transition-colors hover:text-[var(--sea-ink)]"
              >
                <Star
                  aria-hidden
                  className={`h-6 w-6 ${filled ? "fill-[var(--lagoon)] text-[var(--lagoon)]" : ""}`}
                />
              </button>
            );
          })}
          {rating !== null && (
            <button
              type="button"
              onClick={() => {
                setRating(null);
                void save({ rating: null });
              }}
              className="ml-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] underline-offset-4 hover:text-[var(--sea-ink)] hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Note — small textarea, saves on blur. */}
      <div>
        <label
          htmlFor="book-note"
          className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]"
        >
          Notes
        </label>
        <textarea
          id="book-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            const next = note.trim() === "" ? null : note;
            const prev = own.note ?? null;
            if (next !== prev) void save({ note: next });
          }}
          placeholder="Thoughts, quotes, or where you left off…"
          className="input-field w-full rounded-xl px-3 py-2 text-sm"
          maxLength={2000}
        />
      </div>

      {own.firstAcquiredAt && (
        <p className="mt-5 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
          Added {new Date(own.firstAcquiredAt).toLocaleDateString()}
          {own.quantity > 1 && ` · ${own.quantity} copies`}
        </p>
      )}
    </section>
  );
}

function SaveIndicator({
  savedAt,
  error,
}: {
  savedAt: number | null;
  error: string | null;
}) {
  // Show "Saved" for a few seconds after a successful write; after
  // that, the field itself is the truth and a trailing indicator just
  // becomes visual noise.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1800);
    return () => clearTimeout(t);
  }, [savedAt]);

  if (error) {
    return (
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--rarity-legendary)]">
        {error}
      </span>
    );
  }
  if (!visible) return null;
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
      Saved
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Unlock CTA — shown to non-owners (incl. anonymous)
// ─────────────────────────────────────────────────────────────────────────────

function UnlockCta({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="island-shell rounded-[1.5rem] p-6 sm:p-8">
      <p className="island-kicker">Not in your library yet</p>
      <h2 className="display-title mt-1 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
        Rip a pack to add it
      </h2>
      <p className="mt-2 max-w-xl text-sm text-[var(--sea-ink-soft)]">
        {signedIn
          ? "This book will appear in your collection the first time a pack rolls it."
          : "Sign in to start building your library. Each rip rolls for rarity — legendaries are vanishingly rare."}
      </p>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <Link to="/rip" className="btn-primary rounded-full px-5 text-sm">
          Rip a pack
        </Link>
        {!signedIn && (
          <Link to="/sign-in" className="btn-secondary rounded-full px-5 text-sm">
            Sign in
          </Link>
        )}
      </div>
    </section>
  );
}
