import { type ReactNode, useEffect, useState } from "react";
import { AnimatePresence, motion, type PanInfo } from "motion/react";
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
          <motion.div
            initial={{ rotate: -2, y: 0 }}
            animate={{ rotate: [-2, 2, -2], y: [0, -4, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            className="card-fit relative overflow-hidden rounded-2xl shadow-2xl"
            style={{
              background:
                "linear-gradient(135deg, var(--lagoon-deep) 0%, var(--lagoon) 55%, var(--palm) 100%)",
              boxShadow:
                "0 0 60px -10px color-mix(in oklab, var(--lagoon) 55%, transparent), 0 30px 60px -20px rgba(0, 0, 0, 0.55)",
            }}
          >
            <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_30%_20%,white,transparent_45%),radial-gradient(circle_at_70%_80%,white,transparent_45%)]" />
            <div className="relative flex h-full flex-col items-center justify-between p-6 text-center text-[var(--on-accent)]">
              <span className="island-kicker text-[var(--on-accent)]/80">Tome Pack</span>
              <div>
                <h2 className="display-title text-2xl font-bold leading-tight">{packName}</h2>
                <p className="mt-2 text-xs uppercase tracking-[0.18em] text-[var(--on-accent)]/70">
                  5 books · sealed
                </p>
              </div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--on-accent)]/60">
                tap below to rip
              </div>
            </div>
          </motion.div>
        </div>
        <button
          type="button"
          onClick={startRip}
          className="btn-primary w-full max-w-[320px] rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em] sm:w-auto"
        >
          Rip pack
        </button>
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
