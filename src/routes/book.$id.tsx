import { useEffect, useState, useTransition } from "react";
import {
  createFileRoute,
  Link,
  notFound,
  useRouter,
} from "@tanstack/react-router";
import { BookOpen, Check, Star, Trash2 } from "lucide-react";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import { Card } from "@/components/cards/Card";
import { useToast } from "@/components/Toast";
import { RARITY_STYLES, formatGenre } from "@/lib/cards/style";
import {
  getBookFn,
  type BookDetailPayload,
} from "@/server/collection";
import {
  deleteReadingEntryFn,
  getReadingEntryFn,
  upsertReadingEntryFn,
  type ReadingEntry,
  type ReadingStatus,
} from "@/server/reading";

/**
 * Book detail route: `/book/:id`.
 *
 * Public page. The book itself, its pack memberships, and metadata are
 * visible to anyone with the link (including signed-out visitors) —
 * books are not a secret, and shareable book pages are a natural
 * entry point from elsewhere on the web.
 *
 * Signed-in users see a Reading panel regardless of whether they own
 * the card. Reading-log state is independent of ownership (see the
 * `reading_entries` table in `src/db/schema.ts`). Owners additionally
 * see a "Your copy" block with acquisition details. Non-owners still
 * get a rip-to-unlock CTA further down.
 */
export const Route = createFileRoute("/book/$id")({
  loader: async ({ params }) => {
    const [data, readingEntry] = await Promise.all([
      getBookFn({ data: { bookId: params.id } }),
      // The reading-entry fetch throws for anonymous callers because
      // the server fn requires a session. That's fine: anonymous users
      // don't have entries to load, and we fall through to null.
      getReadingEntryFn({ data: { bookId: params.id } }).catch(() => null),
    ]);
    if (!data) throw notFound();
    return { data, readingEntry };
  },
  component: BookDetailPage,
});

function BookDetailPage() {
  const { data, readingEntry } = Route.useLoaderData();
  const card = bookRowToCardData(data.book);
  // The reading panel renders when the viewer is signed in — detected
  // via `ownership !== null`, which is the same flag we use elsewhere
  // to distinguish anonymous from authenticated callers. Ownership
  // status itself isn't the gate anymore (see file header).
  const signedIn = data.ownership !== null;

  return (
    <main className="page-wrap space-y-6 py-6 sm:space-y-8 sm:py-12">
      {/* Breadcrumb-ish back affordance — on a phone this is cheaper
          than the browser back chrome and more discoverable. */}
      <Link
        to="/library/collection"
        className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] underline-offset-4 hover:text-[var(--sea-ink)] hover:underline"
      >
        ← Back to collection
      </Link>

      <BookHero detail={data} />

      {signedIn ? (
        <ReadingPanel
          bookId={data.book.id}
          initialEntry={readingEntry}
        />
      ) : (
        <UnlockCta signedIn={false} />
      )}

      {signedIn && data.ownership?.owned && (
        <OwnerMetaPanel ownership={data.ownership} />
      )}

      {signedIn && !data.ownership?.owned && (
        <UnlockCta signedIn={true} />
      )}

      {/* Visual anchor — show the Card component itself so the detail
          page feels like an expanded version of what the user sees on
          the collection grid. */}
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
// Reading panel — status / rating / notes for the signed-in viewer
//
// Shown regardless of card ownership. When the user has no entry yet,
// a compact "Log this book" CTA row renders with the three status
// buttons as the primary action; picking one creates the entry. Once
// an entry exists, the full editor renders.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_OPTIONS: Array<{ value: ReadingStatus; label: string }> = [
  { value: "tbr", label: "Want to read" },
  { value: "reading", label: "Reading" },
  { value: "finished", label: "Finished" },
];

function ReadingPanel({
  bookId,
  initialEntry,
}: {
  bookId: string;
  initialEntry: ReadingEntry | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const toast = useToast();

  // Entry state mirrors the server response. A null entry means the
  // user hasn't logged this book; the first status click creates it.
  const [entry, setEntry] = useState<ReadingEntry | null>(initialEntry);
  const [note, setNote] = useState(initialEntry?.note ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep local state in sync when the loader invalidates (e.g. after
  // editing in another tab). Derived fields like `note` also reset.
  useEffect(() => {
    setEntry(initialEntry);
    setNote(initialEntry?.note ?? "");
  }, [initialEntry]);

  const save = async (patch: {
    status?: ReadingStatus;
    rating?: number | null;
    note?: string | null;
  }) => {
    setError(null);
    try {
      const res = await upsertReadingEntryFn({
        data: { bookId, ...patch },
      });
      setEntry(res.entry);
      setSavedAt(Date.now());

      for (const g of res.grants) {
        if (g.reason === "start_reading") {
          toast.push({
            title: "Started reading",
            description: "Finish the book for a bigger payout.",
            tone: "shard",
            amount: g.amount,
          });
        } else if (g.reason === "finish_reading") {
          toast.push({
            title: "Book finished",
            description: "Nice work — enough to rip a fresh pack.",
            tone: "shard",
            amount: g.amount,
          });
        }
      }

      // When the finish grant was withheld by the 1-hour guard, tell
      // the user rather than silently skipping — otherwise they'll
      // wonder why no toast fired.
      if (res.finishGuardSuppressed) {
        toast.push({
          title: "No shards this time",
          description:
            "Finish a book at least an hour after starting to earn shards.",
          tone: "neutral",
        });
      }

      startTransition(() => {
        void router.invalidate();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  };

  const onRemove = async () => {
    try {
      await deleteReadingEntryFn({ data: { bookId } });
      setEntry(null);
      setNote("");
      startTransition(() => {
        void router.invalidate();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    }
  };

  // ── Unlogged state ─────────────────────────────────────────────
  if (!entry) {
    return (
      <section className="island-shell rounded-[1.5rem] p-6 sm:p-8">
        <p className="island-kicker">Reading log</p>
        <h2 className="display-title mt-1 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
          Log this book
        </h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--sea-ink-soft)]">
          Track your reading and earn shards — 5 when you start,
          100 when you finish.
        </p>
        <div role="radiogroup" aria-label="Reading status" className="mt-4 flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={false}
              onClick={() => void save({ status: o.value })}
              className="view-tab"
            >
              {o.label}
            </button>
          ))}
        </div>
        {error && (
          <p className="mt-3 text-xs text-[color:var(--rarity-legendary)]">{error}</p>
        )}
      </section>
    );
  }

  // ── Logged state ───────────────────────────────────────────────
  const rating = entry.rating;
  return (
    <section className="island-shell rounded-[1.5rem] p-6 sm:p-8">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <div>
          <p className="island-kicker">Reading log</p>
          <h2 className="display-title mt-1 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
            Your progress
          </h2>
        </div>
        <SaveIndicator savedAt={savedAt} error={error} />
      </div>

      {/* Status — three-state segmented control. */}
      <div className="mb-6">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          Status
        </p>
        <div role="radiogroup" aria-label="Reading status" className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((o) => {
            const active = entry.status === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => void save({ status: o.value })}
                className={`view-tab ${active ? "is-active" : ""}`}
              >
                {active && <Check aria-hidden className="h-3.5 w-3.5" />}
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Rating — 5 star buttons; click the active max to clear. */}
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
                  const next = rating === n ? null : n;
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
              onClick={() => void save({ rating: null })}
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
            const prev = entry.note ?? null;
            if (next !== prev) void save({ note: next });
          }}
          placeholder="Thoughts, quotes, or where you left off…"
          className="input-field w-full rounded-xl px-3 py-2 text-sm"
          maxLength={2000}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
          {entry.startedAt && (
            <>Started {new Date(entry.startedAt).toLocaleDateString()}</>
          )}
          {entry.startedAt && entry.finishedAt && " · "}
          {entry.finishedAt && (
            <>Finished {new Date(entry.finishedAt).toLocaleDateString()}</>
          )}
        </div>
        <button
          type="button"
          onClick={() => void onRemove()}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
        >
          <Trash2 aria-hidden className="h-3 w-3" />
          Remove from log
        </button>
      </div>
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
// Owner meta — ownership/acquisition details for users who own the card
// ─────────────────────────────────────────────────────────────────────────────

function OwnerMetaPanel({
  ownership,
}: {
  ownership: NonNullable<BookDetailPayload["ownership"]>;
}) {
  if (!ownership.owned || !ownership.firstAcquiredAt) return null;
  return (
    <section className="island-shell rounded-[1.5rem] px-6 py-4 sm:px-8">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
        Your copy · Added{" "}
        {new Date(ownership.firstAcquiredAt).toLocaleDateString()}
        {ownership.quantity > 1 && ` · ${ownership.quantity} copies`}
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Unlock CTA — shown to non-owners (incl. anonymous)
// ─────────────────────────────────────────────────────────────────────────────

function UnlockCta({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="island-shell rounded-[1.5rem] p-6 sm:p-8">
      <p className="island-kicker">Not a card in your collection</p>
      <h2 className="display-title mt-1 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
        Rip a pack to add it
      </h2>
      <p className="mt-2 max-w-xl text-sm text-[var(--sea-ink-soft)]">
        {signedIn
          ? "Logging the book above doesn't require owning the card. Rip a pack to add this book as a card in your collection."
          : "Sign in to start tracking your reading and building your card collection."}
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
