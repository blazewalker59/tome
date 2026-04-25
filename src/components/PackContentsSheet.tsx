import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useMotionValue, animate } from "motion/react";
import { Check, Gem, X } from "lucide-react";
import { RARITY_STYLES } from "@/lib/cards/style";
import type { BookRow } from "@/lib/cards/book-to-card";
import type { Rarity } from "@/lib/cards/types";

/**
 * Shared "contents of this pack" bottom sheet. Originally lived inside
 * `RipPackShell.tsx`; extracted here so the collection page can open
 * the same sheet from each pack group card. Both entry points benefit
 * from an identical grouped-by-rarity reading of the pack so the user
 * builds a consistent mental model — "this is the pack's manifest" —
 * rather than learning a different list on each screen.
 *
 * Built on the native `<dialog>` element + the `.bottom-sheet` styles
 * already defined in styles.css (slide-up animation, dim backdrop,
 * safe-area-aware bottom padding). Native dialog gives us focus
 * trapping, Escape-to-close, and backdrop dismissal without
 * re-implementing any of it; the only thing we have to manage is
 * calling `showModal()`/`close()` when the `open` prop flips.
 *
 * Rendered through a portal to `document.body` because some callers
 * wrap this in `<main class="viewport-stage">` which is
 * `overflow: hidden` and sits inside a route-transition stack that
 * applies transforms to pseudo-elements during navigation. Even
 * though a modal `<dialog>` is supposed to escape to the browser's
 * top layer, those ancestor conditions can break top-layer promotion
 * on iOS Safari — the observable symptom is a blurred backdrop but a
 * zero-size / un-tappable panel. Portaling the dialog to `<body>`
 * sidesteps the whole class of ancestor-containment issues.
 *
 * The panel is a motion.div with `drag="y"` so the user can swipe
 * down to dismiss. Drag is constrained to the downward direction
 * only; releasing past a velocity or distance threshold closes the
 * sheet, shorter drags spring back. The list content lives inside
 * an inner scrollable element so vertical scrolling still works —
 * drag and scroll are on separate elements, so they never fight.
 *
 * When `ownedIds` is provided (collection use case), rows render
 * with an "owned" check affordance and unowned rows dim slightly so
 * the sheet reads as "here's what's in the set, and here's what
 * you're still missing." Without it (rip use case), every row gets
 * the same default treatment.
 */
export interface PackContentsSheetProps {
  open: boolean;
  onClose: () => void;
  packName: string;
  books: ReadonlyArray<BookRow>;
  /** Optional set of book IDs the viewer already owns from this
   *  pack. When present, owned rows gain a check affordance and
   *  unowned rows dim so missing books are obvious at a glance.
   *  Omit on surfaces where ownership isn't a useful axis (e.g.
   *  the pre-rip preview, where the whole point is what you could
   *  pull). */
  ownedIds?: ReadonlySet<string>;
  /** Optional copy shown under the pack name. Defaults to a simple
   *  "N book(s)" line on /collection; /rip passes a variant that
   *  also reminds the user each rip draws 5. */
  subheadSuffix?: string;
}

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

export function PackContentsSheet({
  open,
  onClose,
  packName,
  books,
  ownedIds,
  subheadSuffix,
}: PackContentsSheetProps) {
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

  // Default subhead derives from total count. Callers override when
  // they want extra context (e.g. "· Each rip draws 5" on /rip).
  const resolvedSubhead = useMemo(() => {
    const base = `${books.length} book${books.length === 1 ? "" : "s"}`;
    return subheadSuffix ? `${base} · ${subheadSuffix}` : base;
  }, [books.length, subheadSuffix]);

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
            <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">{resolvedSubhead}</p>
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
            // Owned-count header only makes sense when the caller
            // passed an owned set. Keeps the /rip preview (where
            // everyone starts at zero) uncluttered.
            const ownedCount = ownedIds
              ? entries.reduce((n, b) => (ownedIds.has(b.id) ? n + 1 : n), 0)
              : null;
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
                    {ownedCount !== null ? `${ownedCount}/${entries.length}` : entries.length}
                  </span>
                </header>
                <ul className="space-y-1.5">
                  {entries.map((b) => (
                    <BookRowItem
                      key={b.id}
                      book={b}
                      owned={ownedIds ? ownedIds.has(b.id) : null}
                    />
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
 *
 * `owned` is `null` when the caller isn't tracking ownership (rip
 * preview), `true`/`false` otherwise. Unowned rows dim their body
 * text slightly so the owned ones read as the "present" state and
 * the missing ones as "still to find" — we avoid hiding unowned
 * titles entirely because the whole point of the sheet on /collection
 * is to see what you're missing.
 */
function BookRowItem({
  book,
  owned,
}: {
  book: BookRow;
  owned: boolean | null;
}) {
  const author = book.authors[0] ?? "Unknown";
  const dim = owned === false;
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2 ${
        dim ? "opacity-60" : ""
      }`}
    >
      <div className="h-12 w-9 shrink-0 overflow-hidden rounded-md bg-[var(--track-bg)]">
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt=""
            className={`h-full w-full object-cover ${dim ? "grayscale" : ""}`}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-tight text-[var(--sea-ink)]">
          {book.title}
        </p>
        <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">{author}</p>
      </div>
      {owned === true && (
        <span
          aria-label="Owned"
          title="Owned"
          className="shrink-0 rounded-full bg-[var(--chip-bg)] p-1 text-[var(--sea-ink-soft)]"
        >
          <Check aria-hidden className="h-3.5 w-3.5" />
        </span>
      )}
    </li>
  );
}
