import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useMotionValue, animate } from "motion/react";
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { ChevronLeft, Gem, Info, X } from "lucide-react";
import { PackRip } from "@/components/cards/PackRip";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import { applyRip, pullPack, type PoolEntry, type RipOutcome } from "@/lib/cards/pull";
import { getCollectionFn, getPackBySlugFn, recordRipFn } from "@/server/collection";
import { RARITY_STYLES } from "@/lib/cards/style";
import type { BookRow } from "@/lib/cards/book-to-card";
import type { CardData, Rarity } from "@/lib/cards/types";

/**
 * /rip/$slug — the tear-open experience for a specific pack.
 *
 * The picker lives at /rip and navigates here once the user selects a
 * pack. We split the flow in two routes (picker list vs. open flow) so
 * each URL is shareable and so the open flow doesn't have to carry the
 * picker's carousel state. Auth is enforced only at this level: anons
 * can browse the picker but have to sign in to actually commit a rip,
 * which matches the "collection is the value" product framing.
 */
export const Route = createFileRoute("/rip/$slug")({
  loader: async ({ params }) => {
    const [pack, collection] = await Promise.all([
      getPackBySlugFn({ data: { slug: params.slug } }),
      getCollectionFn(),
    ]);
    if (!collection) {
      // Stash the pack slug on the sign-in URL so we can bounce back
      // after auth. (sign-in's redirect handling can wire this up
      // later; for now a plain redirect preserves the product flow.)
      throw redirect({ to: "/sign-in" });
    }
    return { pack, collection };
  },
  component: RipPackPage,
});

interface RipState {
  pulledCards: CardData[];
  outcome: RipOutcome;
}

/** Roll a fresh 5-card pull using the pack's rarity-weighted pool. */
function rollRip(
  pool: ReadonlyArray<PoolEntry>,
  cardById: ReadonlyMap<string, CardData>,
  ownedBookIds: ReadonlySet<string>,
): RipState {
  const pulls = pullPack({ pool });
  const outcome = applyRip({ pulls, ownedBookIds });
  const pulledCards = pulls.map((p) => {
    const card = cardById.get(p.bookId);
    if (!card) throw new Error(`rollRip: missing card data for ${p.bookId}`);
    return card;
  });
  return { pulledCards, outcome };
}

function RipPackPage() {
  const { pack, collection } = Route.useLoaderData();
  const router = useRouter();

  // Memoise pool + lookup map derived from server data so re-rolls don't
  // re-compute them on every "Rip another" click.
  const { pool, cardById } = useMemo(() => {
    const cards = pack.books.map(bookRowToCardData);
    return {
      pool: cards.map<PoolEntry>((c) => ({ bookId: c.id, rarity: c.rarity })),
      cardById: new Map(cards.map((c) => [c.id, c])),
    };
  }, [pack.books]);

  const ownedBookIds = useMemo(() => new Set(collection.ownedBookIds), [collection.ownedBookIds]);

  const [ripState, setRipState] = useState<RipState>(() => rollRip(pool, cardById, ownedBookIds));
  const [ripKey, setRipKey] = useState(0);
  const [committedKey, setCommittedKey] = useState<number | null>(null);
  const [savingError, setSavingError] = useState<string | null>(null);
  const [contentsOpen, setContentsOpen] = useState(false);

  async function handleRipComplete() {
    // Guard against StrictMode double-invokes and animation re-triggers.
    if (committedKey === ripKey) return;
    setCommittedKey(ripKey);
    setSavingError(null);
    try {
      await recordRipFn({
        data: {
          packId: pack.packId,
          pulledBookIds: ripState.outcome.pulls.map((p) => p.bookId),
        },
      });
      // Refresh the loader so the next render sees the new collection.
      await router.invalidate();
    } catch (err) {
      // Surface failures but don't block the animation — the user has
      // already seen the cards. Retry is implicit on "Rip another".
      console.error("[rip] recordRip failed:", err);
      setSavingError(
        err instanceof Error ? err.message : "We couldn't save that rip. Try again.",
      );
    }
  }

  function handleRipAnother() {
    setRipState(rollRip(pool, cardById, ownedBookIds));
    setRipKey((k) => k + 1);
  }

  const { outcome } = ripState;

  return (
    <main className="viewport-stage">
      <header className="relative px-4 pt-3 pb-2 text-center sm:pt-5 sm:pb-3">
        {/* Back link to the picker. Absolutely positioned so the
            pack name below remains visually centered regardless of
            the link's width; on mobile it sits as a pure icon to
            claim minimal space. The route is `/rip` (the layout
            index) so we're always popping out to the carousel, not
            relying on history which might not contain it (e.g. a
            deep link straight to /rip/$slug). */}
        <Link
          to="/rip"
          aria-label="Back to all packs"
          className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] no-underline hover:text-[var(--sea-ink)] sm:left-4 sm:px-3 sm:py-1.5"
        >
          <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">All packs</span>
        </Link>

        {/* Info chip — mirrors the back-link chip on the opposite
            edge. Opens a bottom sheet showing every book in the pack
            grouped by rarity, so the user can see what they're
            rolling into before committing a rip. */}
        <button
          type="button"
          onClick={() => setContentsOpen(true)}
          aria-label="See what's in this pack"
          className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] sm:right-4 sm:px-3 sm:py-1.5"
        >
          <Info aria-hidden className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Contents</span>
        </button>

        <p className="island-kicker">{pack.name}</p>
        <div className="mt-1 flex items-center justify-center gap-3 text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          <span>
            Owned <span className="text-[var(--sea-ink)]">{collection.ownedBookIds.length}</span>
          </span>
          <span aria-hidden>·</span>
          <span>
            Shards <span className="text-[var(--sea-ink)]">{collection.shardBalance}</span>
          </span>
        </div>
      </header>

      <PackRip
        key={ripKey}
        cards={ripState.pulledCards}
        packName={pack.name}
        onComplete={handleRipComplete}
        onRipAnother={handleRipAnother}
        summary={
          <RipSummary
            shardsEarned={outcome.shardsEarned}
            newCount={outcome.newCards.length}
            duplicateCount={outcome.duplicates.length}
            error={savingError}
          />
        }
      />

      <PackContentsSheet
        open={contentsOpen}
        onClose={() => setContentsOpen(false)}
        packName={pack.name}
        books={pack.books}
      />
    </main>
  );
}

function RipSummary({
  shardsEarned,
  newCount,
  duplicateCount,
  error,
}: {
  shardsEarned: number;
  newCount: number;
  duplicateCount: number;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] uppercase tracking-[0.16em]">
        <span className="rounded-full border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-1 text-[color:var(--rarity-legendary)]">
          Save failed — {error}
        </span>
      </div>
    );
  }
  if (newCount === 0 && duplicateCount === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] uppercase tracking-[0.16em]">
      <span className="rounded-full border border-[color:var(--rarity-uncommon)]/40 bg-[color:var(--rarity-uncommon-soft)] px-3 py-1 text-[color:var(--rarity-uncommon)]">
        {newCount} new
      </span>
      <span className="rounded-full border border-[color:var(--rarity-common)]/40 bg-[color:var(--rarity-common-soft)] px-3 py-1 text-[color:var(--rarity-common)]">
        {duplicateCount} dupe{duplicateCount === 1 ? "" : "s"}
      </span>
      {shardsEarned > 0 && (
        <span className="rounded-full border border-[color:var(--rarity-rare)]/40 bg-[color:var(--rarity-rare-soft)] px-3 py-1 text-[color:var(--rarity-rare)]">
          +{shardsEarned} shards
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pack contents sheet
// ─────────────────────────────────────────────────────────────────────────────

// Descending rarity so the "good stuff" reads first — people open
// this sheet mostly to see what legendaries are possible. Counts of
// each rarity are shown in the group header.
const RARITY_ORDER_DESCENDING: ReadonlyArray<Rarity> = [
  "legendary",
  "foil",
  "rare",
  "uncommon",
  "common",
];

/**
 * Bottom sheet listing every book in the pack, grouped by rarity.
 * Built on the native `<dialog>` element + the `.bottom-sheet` styles
 * already defined in styles.css (slide-up animation, dim backdrop,
 * safe-area-aware bottom padding). Native dialog gives us focus
 * trapping, Escape-to-close, and backdrop dismissal without
 * re-implementing any of it; the only thing we have to manage is
 * calling `showModal()`/`close()` when the `open` prop flips.
 *
 * Rendered through a portal to `document.body` because the route's
 * wrapping `<main class="viewport-stage">` is `overflow: hidden` and
 * sits inside a route-transition stack that applies transforms to
 * pseudo-elements during navigation. Even though a modal `<dialog>`
 * is supposed to escape to the browser's top layer, those ancestor
 * conditions can break top-layer promotion on iOS Safari — the
 * observable symptom is a blurred backdrop but a zero-size /
 * un-tappable panel. Portaling the dialog to `<body>` sidesteps the
 * whole class of ancestor-containment issues.
 *
 * The panel is a motion.div with `drag="y"` so the user can swipe
 * down to dismiss. Drag is constrained to the downward direction
 * only; releasing past a velocity or distance threshold closes the
 * sheet, shorter drags spring back. The list content lives inside
 * an inner scrollable element so vertical scrolling still works —
 * drag and scroll are on separate elements, so they never fight.
 */
function PackContentsSheet({
  open,
  onClose,
  packName,
  books,
}: {
  open: boolean;
  onClose: () => void;
  packName: string;
  books: ReadonlyArray<BookRow>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Offset y for the drag gesture. Lives outside React state so
  // dragging doesn't trigger re-renders; motion tracks it via the
  // motion value directly.
  const y = useMotionValue(0);
  // Guard against re-entrant close animations — without it, a fast
  // flick could trigger onDragEnd's dismiss path and the backdrop
  // click in close succession, animating twice and ending in a weird
  // state.
  const closingRef = useRef(false);

  // Animates the panel off-screen then calls onClose. Using the
  // panel's measured height (rather than a fixed pixel distance)
  // keeps the exit length proportional to content — short sheets
  // don't overshoot, tall sheets still fully clear. The +32 gives
  // a little headroom so the drop-shadow doesn't flash at the
  // bottom edge on the final frame.
  const dismiss = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const height = panelRef.current?.offsetHeight ?? 400;
    animate(y, height + 32, {
      type: "spring",
      stiffness: 300,
      damping: 32,
      velocity: 0,
      onComplete: () => {
        closingRef.current = false;
        onClose();
      },
    });
  };

  // Portal targets must only be read client-side. Computing
  // `document.body` during SSR would throw; a naive
  // `typeof document === "undefined"` branch would also cause a
  // hydration mismatch (server renders `null`, client renders a
  // <dialog>). Defer the portal until after mount by flipping this
  // flag in a useEffect — the first client render still matches the
  // server's `null`, and the dialog mounts on the following commit.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync open prop → imperative dialog API. Using showModal() gives
  // us the modal semantics (backdrop pseudo-element, focus trap,
  // inert background) that plain open= attribute doesn't. Also
  // resets the drag offset to 0 whenever the sheet opens — otherwise
  // the panel would re-appear mid-drag if the user opened it, swiped
  // partway, released below threshold, and reopened.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      y.set(0);
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open, mounted, y]);

  // Group books by rarity once per change. Within a group, order by
  // title so the list reads alphabetically — gives the set a stable
  // predictable feel rather than looking randomly sorted.
  const grouped = useMemo(() => {
    const buckets: Record<Rarity, BookRow[]> = {
      common: [],
      uncommon: [],
      rare: [],
      foil: [],
      legendary: [],
    };
    for (const b of books) buckets[b.rarity].push(b);
    for (const r of RARITY_ORDER_DESCENDING) {
      buckets[r].sort((a, b) => a.title.localeCompare(b.title));
    }
    return buckets;
  }, [books]);

  // SSR guard — server render returns null so markup matches
  // the initial client render; the `mounted` flag flips after
  // hydration completes, at which point the portal can safely
  // mount against document.body.
  if (!mounted) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      // Native dialog dispatches a `close` event whenever the user
      // Esc's out or backdrop-clicks; translate that back to our
      // controlled `open` prop.
      onClose={onClose}
      // Close on backdrop click. Native <dialog> dispatches clicks
      // on the dialog element itself (not a child) when the backdrop
      // pseudo-element is clicked — so `e.target === dialogRef` means
      // the click landed on the backdrop, not on anything inside the
      // panel.
      onClick={(e) => {
        if (e.target === dialogRef.current) dismiss();
      }}
      className="bottom-sheet"
      aria-label={`Contents of ${packName}`}
    >
      <motion.div
        ref={panelRef}
        className="bottom-sheet-panel"
        drag="y"
        // Upper bound locked to 0 (can't drag up past resting
        // position); downward drag is unconstrained in distance but
        // decays elastically past the threshold so it still feels
        // "weighted" if the user hauls on it.
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.5 }}
        style={{ y }}
        onDragEnd={(_, info) => {
          // Dismiss if the user either drags far enough or flicks
          // with enough downward velocity. The velocity path handles
          // quick flicks without a long drag distance — classic
          // iOS sheet behavior. Distance threshold is ~1/4 of a
          // typical panel height; velocity threshold is comfortable
          // for intentional flicks without triggering on small
          // wobbles.
          const DISTANCE = 120;
          const VELOCITY = 500;
          if (info.offset.y > DISTANCE || info.velocity.y > VELOCITY) {
            // Continue the gesture into a dismiss animation rather
            // than teleporting the sheet away — keeps the motion
            // continuous with the user's drag.
            if (closingRef.current) return;
            closingRef.current = true;
            const height = panelRef.current?.offsetHeight ?? 400;
            animate(y, height + 32, {
              type: "spring",
              stiffness: 300,
              damping: 32,
              // Carry the user's release velocity into the spring
              // so a hard flick feels appropriately snappy and a
              // gentle release is correspondingly soft.
              velocity: info.velocity.y,
              onComplete: () => {
                closingRef.current = false;
                onClose();
              },
            });
          } else {
            // Snap back with a spring so the return feels physical
            // rather than a linear tween.
            animate(y, 0, { type: "spring", stiffness: 400, damping: 40 });
          }
        }}
      >
        {/* Grabber handle — still decorative but now backed by a
            real dismiss gesture on the whole panel. */}
        <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--line)]" />

        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="island-kicker">In this pack</p>
            <h2 className="display-title mt-0.5 truncate text-lg font-bold text-[var(--sea-ink)]">
              {packName}
            </h2>
            <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
              {books.length} book{books.length === 1 ? "" : "s"} · Each rip draws 5
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            className="shrink-0 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] p-1.5 text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable list area. Isolating the scroll to a nested
            element (rather than the panel itself) keeps drag and
            scroll on separate elements so they don't steal gestures
            from each other — dragging always moves the sheet,
            scrolling always moves the list, no heuristics needed.
            The max-height accounts for the panel's padding + header
            roughly; 60vh leaves a comfortable peek of the underlying
            page and plenty of room for long book lists. */}
        <div className="-mx-5 max-h-[60vh] overflow-y-auto overscroll-contain px-5 space-y-5">
          {RARITY_ORDER_DESCENDING.map((r) => {
            const entries = grouped[r];
            if (entries.length === 0) return null;
            const style = RARITY_STYLES[r];
            return (
              <section key={r}>
                <header className="mb-2 flex items-center gap-2">
                  <Gem
                    aria-hidden
                    className="h-4 w-4 shrink-0"
                    style={{ color: `var(--rarity-${r})` }}
                    strokeWidth={2}
                    fill={`var(--rarity-${r})`}
                    fillOpacity={0.2}
                  />
                  <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--sea-ink)]">
                    {style.label}
                  </h3>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] tabular-nums">
                    {entries.length}
                  </span>
                </header>
                <ul className="space-y-1.5">
                  {entries.map((b) => (
                    <BookRowItem key={b.id} book={b} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </motion.div>
    </dialog>,
    document.body,
  );
}

/**
 * Single book row in the contents sheet. Cover thumbnail, title,
 * author — kept compact so the full list fits without a pile of
 * scrolling. The cover falls back to a neutral placeholder tile
 * when missing (legacy rows, manual imports) rather than rendering
 * a broken-image icon.
 */
function BookRowItem({ book }: { book: BookRow }) {
  const author = book.authors[0] ?? "Unknown";
  return (
    <li className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2">
      <div className="h-12 w-9 shrink-0 overflow-hidden rounded-md bg-[var(--track-bg)]">
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-tight text-[var(--sea-ink)]">
          {book.title}
        </p>
        <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">{author}</p>
      </div>
    </li>
  );
}
