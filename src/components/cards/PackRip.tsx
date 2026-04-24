import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo } from "motion/react";
import type { CardData } from "@/lib/cards/types";
import { Card } from "./Card";

export interface PackRipProps {
  cards: ReadonlyArray<CardData>;
  packName: string;
  /** Called once every card has been revealed. */
  onComplete?: () => void;
  /** Called when the user taps "Rip another" on the done screen. */
  onRipAnother?: () => void;
  /** Optional summary node rendered on the done screen (new/dupe/shards). */
  summary?: ReactNode;
}

type Phase = "idle" | "opening" | "revealing" | "done";

// Swipe threshold: trigger advance when the user drags past 100 px
// horizontally OR releases with enough velocity to imply a flick.
const SWIPE_DISTANCE = 100;
const SWIPE_VELOCITY = 500;

/**
 * The pack-rip experience. Designed to live inside a `.viewport-stage` so
 * the page never scrolls: the component fills its parent column, devotes
 * every spare pixel to the card stage, and uses container queries to fit
 * the 2:3 card to whichever axis constrains first.
 *
 * During the reveal phase the card accepts BOTH:
 *   - tap → flips the card (Card's own onClick), and
 *   - horizontal swipe → advances to the next card.
 * Motion's drag-vs-tap heuristic handles the distinction natively: small
 * pointer movements pass through as clicks, larger ones become drags.
 */
export function PackRip({ cards, packName, onComplete, onRipAnother, summary }: PackRipProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [revealedCount, setRevealedCount] = useState(0);
  // Direction the current card should fly off-screen: -1 left, 1 right, 0 up.
  const [exitDir, setExitDir] = useState<-1 | 0 | 1>(0);

  // Warm the browser cache with every cover the moment the pack mounts so the
  // user never sees an image fade in mid-reveal.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const preloaded: HTMLImageElement[] = [];
    for (const card of cards) {
      const img = new Image();
      img.decoding = "async";
      img.src = card.coverUrl;
      preloaded.push(img);
    }
    return () => {
      preloaded.length = 0;
    };
  }, [cards]);

  function startRip() {
    setPhase("opening");
    setRevealedCount(0);
    setTimeout(() => setPhase("revealing"), 700);
  }

  function revealNext(direction: -1 | 0 | 1 = 0) {
    setExitDir(direction);
    const next = revealedCount + 1;
    setRevealedCount(next);
    if (next >= cards.length) {
      setPhase("done");
      onComplete?.();
    }
  }

  function handleDragEnd(_: unknown, info: PanInfo) {
    const passedDistance = Math.abs(info.offset.x) > SWIPE_DISTANCE;
    const passedVelocity = Math.abs(info.velocity.x) > SWIPE_VELOCITY;
    if (passedDistance || passedVelocity) {
      revealNext(info.offset.x < 0 ? -1 : 1);
    }
  }

  function reset() {
    onRipAnother?.();
    setPhase("idle");
    setRevealedCount(0);
    setExitDir(0);
  }

  if (phase === "idle") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center gap-4 px-4 pb-4">
        <div className="card-stage">
          <PackSealDrag packName={packName} onRip={startRip} />
        </div>
        <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--sea-ink-soft)]">
          Drag across the perforation to rip
        </p>
      </div>
    );
  }

  if (phase === "opening") {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
        <div className="card-stage">
          <motion.div
            initial={{ scale: 1, opacity: 1 }}
            animate={{ scale: 1.4, opacity: 0 }}
            transition={{ duration: 0.7, ease: "easeIn" }}
            className="card-fit rounded-2xl"
            style={{
              background:
                "linear-gradient(135deg, var(--lagoon-deep) 0%, var(--lagoon) 55%, var(--palm) 100%)",
              boxShadow: "0 0 100px 0 color-mix(in oklab, var(--lagoon) 70%, transparent)",
            }}
          />
        </div>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
        <div className="text-center">
          <p className="display-title text-lg font-bold text-[var(--sea-ink)]">Pack opened</p>
          {summary && <div className="mt-2">{summary}</div>}
        </div>
        {/* Internal scroll keeps the page itself locked. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 justify-items-center gap-3 pb-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {cards.map((card, idx) => (
              <Card key={`${card.id}-${idx}`} card={card} />
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={reset}
          className="btn-primary mx-auto w-full max-w-[320px] rounded-full px-6 py-2.5 text-sm sm:w-auto"
        >
          Rip another
        </button>
      </div>
    );
  }

  // Revealing
  const currentCard = cards[revealedCount];
  const isFinalCard = revealedCount === cards.length - 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-3 px-4 pb-4">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
        Card {Math.min(revealedCount + 1, cards.length)} of {cards.length}
      </div>

      <div className="card-stage">
        <AnimatePresence mode="wait" custom={exitDir}>
          {currentCard && (
            <motion.div
              key={currentCard.id}
              custom={exitDir}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.4}
              onDragEnd={handleDragEnd}
              initial={{ opacity: 0, y: 30, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={(dir: -1 | 0 | 1) => ({
                opacity: 0,
                x: dir === 0 ? 0 : dir * 320,
                y: dir === 0 ? -30 : 0,
                scale: 0.96,
                transition: { duration: 0.28, ease: [0.4, 0, 0.2, 1] },
              })}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className="card-fit cursor-grab active:cursor-grabbing"
            >
              <Card card={currentCard} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <button
        type="button"
        onClick={() => revealNext(0)}
        className="btn-secondary w-full max-w-[320px] rounded-full px-6 py-2.5 text-sm sm:w-auto"
      >
        {isFinalCard ? "See your pull" : "Next card"}
      </button>
      <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
        Tap to flip · swipe to advance
      </p>
    </div>
  );
}

// --- Drag-to-rip pack seal --------------------------------------------------

// The tear-strip band sits this far down from the top of the pack. 14%
// matches where the perforation is printed on real foil booster packs;
// more importantly it leaves enough room above for the top strip to
// visibly peel off on commit without overlapping the pack title.
const TEAR_STRIP_TOP_PCT = 0.14;
// Vertical tolerance around the strip (as a fraction of pack height).
// Finger must stay within TEAR_STRIP_TOP_PCT ± this for progress to
// advance. Forgiving enough that casual horizontal drags work, strict
// enough that a random mid-pack swipe is a no-op.
const TEAR_STRIP_BAND_PCT = 0.08;
// Fraction of the pack width the user must traverse to commit the rip.
// Below this, release springs back to 0. 0.85 (not 1.0) so a determined
// drag that slightly undershoots still feels successful.
const TEAR_COMMIT_THRESHOLD = 0.85;

interface PackSealDragProps {
  packName: string;
  onRip: () => void;
}

/**
 * Interactive pack seal. The user tears the pack open by dragging
 * horizontally across a perforation band near the top of the pack —
 * inspired by Pokémon TCG Pocket's pack-opening gesture, which uses a
 * position-gated drag (vs. a free swipe) for the "you're physically
 * opening this" feel.
 *
 * Mechanics:
 *   - A `tearProgress` motion value tracks 0 → 1 across the pack width.
 *   - Progress only advances while the pointer is vertically within the
 *     perforation band; a drag through the middle of the pack is a
 *     no-op, matching the physical metaphor.
 *   - The top strip's visible height shrinks with progress (clip-path),
 *     giving the illusion of the foil tearing away behind the finger.
 *   - On release: commit if past threshold (calls `onRip`), else spring
 *     the tear back to 0 so the user can try again.
 *   - Haptic pulses at the commit boundary on supporting devices.
 */
function PackSealDrag({ packName, onRip }: PackSealDragProps) {
  const packRef = useRef<HTMLDivElement | null>(null);
  // 0 = sealed, 1 = fully torn. Drives the visual via useTransform below
  // so we never re-render React during the drag — the tear updates
  // every frame on the GPU.
  const progress = useMotionValue(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  // Track whether we've already fired the commit haptic this drag so
  // we don't buzz on every frame past threshold.
  const committedBuzzRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);

  // Top-strip clip: as progress grows, the strip is torn away from the
  // user's starting edge. We use a polygon that shrinks horizontally.
  // Start edge is whichever side the user began dragging from (stored
  // at pointer-down); for simplicity we always tear left→right from
  // the *opposite* edge of wherever they first touched. A left-start
  // tear reveals from the left; a right-start from the right.
  const tearOriginRef = useRef<"left" | "right">("left");
  // Derived clip-path for the "torn" section (what gets hidden). We
  // animate via a CSS var on the pack element that the clip-path
  // references; using useTransform → motion template keeps it on the
  // compositor.
  const tornWidth = useTransform(progress, (p) => `${Math.min(p, 1) * 100}%`);

  function pctToStripWindow(yPct: number) {
    return Math.abs(yPct - TEAR_STRIP_TOP_PCT) <= TEAR_STRIP_BAND_PCT;
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (isCommitting) return;
    const rect = packRef.current?.getBoundingClientRect();
    if (!rect) return;
    const xPct = (e.clientX - rect.left) / rect.width;
    const yPct = (e.clientY - rect.top) / rect.height;
    // Only arm the drag if the initial touch lands inside the strip.
    // Lets the user tap the pack body without accidentally starting
    // a rip; matches the "grip the perforation" affordance.
    if (!pctToStripWindow(yPct)) return;
    pointerIdRef.current = e.pointerId;
    tearOriginRef.current = xPct < 0.5 ? "left" : "right";
    setIsDragging(true);
    committedBuzzRef.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    const rect = packRef.current?.getBoundingClientRect();
    if (!rect) return;
    const xPct = (e.clientX - rect.left) / rect.width;
    const yPct = (e.clientY - rect.top) / rect.height;
    // If the finger leaves the strip vertically we *freeze* progress
    // rather than resetting it — feels more forgiving than snapping
    // back mid-motion. Resume advancing when they return to the band.
    if (!pctToStripWindow(yPct)) return;
    const origin = tearOriginRef.current;
    // Distance traveled from the origin edge toward the opposite edge.
    // Clamped to [0, 1] so overshooting doesn't matter.
    const traveled = origin === "left" ? xPct : 1 - xPct;
    const clamped = Math.max(0, Math.min(1, traveled));
    // Progress only ever moves forward during a single drag; otherwise
    // wobbling the finger back and forth would replay the tear.
    if (clamped > progress.get()) {
      progress.set(clamped);
      if (!committedBuzzRef.current && clamped >= TEAR_COMMIT_THRESHOLD) {
        committedBuzzRef.current = true;
        if (typeof navigator !== "undefined" && "vibrate" in navigator) {
          navigator.vibrate?.(12);
        }
      }
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const p = progress.get();
    if (p >= TEAR_COMMIT_THRESHOLD) {
      // Animate the last bit to 1 for visual completeness, then hand
      // off to the opening phase. We pin the progress and toggle a
      // `isCommitting` flag so further pointer events don't retrigger.
      setIsCommitting(true);
      // Short delay lets the tear visually finish sealing the top off
      // before the opening flash kicks in (handled by parent).
      progress.set(1);
      setTimeout(onRip, 180);
    } else {
      // Spring back to sealed. We animate via a simple rAF loop rather
      // than `animate()` to keep this file framework-agnostic; a
      // 160ms ease-out feels tactile without blocking a retry.
      springBackToZero(progress);
    }
  }

  // Keyboard fallback: Enter or Space commits the rip for users who
  // can't or don't want to drag. Still gives pointer users the tactile
  // affordance while not locking anyone out.
  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRip();
    }
  }

  return (
    <motion.div
      ref={packRef}
      role="button"
      tabIndex={0}
      aria-label={`Rip ${packName}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKey}
      // Idle idle-state wobble; we pause it while the user is dragging
      // so the rotation doesn't fight the drag gesture.
      animate={
        isDragging || isCommitting
          ? { rotate: 0, y: 0 }
          : { rotate: [-2, 2, -2], y: [0, -4, 0] }
      }
      transition={
        isDragging || isCommitting
          ? { duration: 0.2 }
          : { duration: 4, repeat: Infinity, ease: "easeInOut" }
      }
      className="card-fit relative touch-none select-none overflow-hidden rounded-2xl shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--lagoon)]"
      style={{
        background:
          "linear-gradient(135deg, var(--lagoon-deep) 0%, var(--lagoon) 55%, var(--palm) 100%)",
        boxShadow:
          "0 0 60px -10px color-mix(in oklab, var(--lagoon) 55%, transparent), 0 30px 60px -20px rgba(0, 0, 0, 0.55)",
        // `touch-none` disables native scrolling so the pointer events
        // reach us cleanly on touch devices; `select-none` prevents
        // text-selection flicker on long drags.
      }}
    >
      {/* Dotted sparkle gradient — pure decoration, unchanged from
          the previous seal design. */}
      <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_30%_20%,white,transparent_45%),radial-gradient(circle_at_70%_80%,white,transparent_45%)]" />

      {/* Pack content (under the tear strip). Laid out the same way as
          the old static seal so the pack "feels" unchanged until the
          user interacts with the perforation. */}
      <div className="relative flex h-full flex-col items-center justify-center p-6 text-center text-[var(--on-accent)]">
        <div>
          <h2 className="display-title text-2xl font-bold leading-tight">{packName}</h2>
          <p className="mt-2 text-xs uppercase tracking-[0.18em] text-[var(--on-accent)]/70">
            5 books · sealed
          </p>
        </div>
        <div className="mt-6 text-[10px] uppercase tracking-[0.2em] text-[var(--on-accent)]/60">
          drag the seal to rip
        </div>
      </div>

      {/* Tear indicator. Hidden by default — the pack looks sealed
          until the user actually starts dragging. On pointer-down we
          flip `isDragging`, which fades the dashed line in; the line
          then extends from the origin edge behind the finger as
          progress grows. Driven by a CSS custom property so the whole
          update stays on the compositor.
          A single tiny notch stays visible pre-drag as a "something
          happens here" breadcrumb, without committing to a full
          perforation graphic. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 flex h-3 items-center"
        style={{
          top: `${TEAR_STRIP_TOP_PCT * 100}%`,
          transform: "translateY(-50%)",
        }}
      >
        {/* Minimal pre-drag hint: a small pill centered on the strip.
            Fades out once the user is dragging so it doesn't compete
            with the growing dashed line. */}
        <motion.div
          className="absolute left-1/2 -translate-x-1/2 h-1 w-8 rounded-full bg-[var(--on-accent)]/50"
          animate={{ opacity: isDragging || isCommitting ? 0 : 1 }}
          transition={{ duration: 0.15 }}
        />

        {/* The dashed line itself — a single growing segment anchored
            to whichever edge the user started dragging from. Width
            comes from the motion value via --torn-w, so it extends
            behind the finger in real time. Opacity is bound to
            `isDragging` so the line only exists while the gesture is
            active. */}
        <motion.div
          className="absolute inset-y-0 flex items-center"
          style={{
            width: "var(--torn-w)",
            [tearOriginRef.current === "left" ? "left" : "right"]: "0",
            ["--torn-w" as string]: tornWidth,
          }}
          animate={{ opacity: isDragging || isCommitting ? 1 : 0 }}
          transition={{ duration: 0.1 }}
        >
          <div
            className="h-px w-full"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, rgba(255,255,255,0.9) 0 6px, transparent 6px 12px)",
            }}
          />
        </motion.div>
      </div>
    </motion.div>
  );
}

/**
 * Spring a motion value back to 0 over ~160 ms with an ease-out curve.
 * Standalone so PackSealDrag doesn't need to pull in motion's `animate`
 * helper (we only need this one behavior). rAF loop is cheap and
 * avoids any dependency on motion's imperative animation runtime.
 */
function springBackToZero(mv: ReturnType<typeof useMotionValue<number>>) {
  const start = mv.get();
  const startTime = performance.now();
  const duration = 160;
  function tick(now: number) {
    const t = Math.min(1, (now - startTime) / duration);
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3);
    mv.set(start * (1 - eased));
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
