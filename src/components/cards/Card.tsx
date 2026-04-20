import { useState } from "react";
import { motion } from "motion/react";
import { BookOpen } from "lucide-react";
import type { CardData } from "@/lib/cards/types";
import { RARITY_STYLES, formatGenre } from "@/lib/cards/style";

export interface CardProps {
  card: CardData;
  /** Defaults to false (front shown). Click flips. */
  startFlipped?: boolean;
}

/**
 * A book card. Sized fluidly: full-width up to 320 px on mobile, capped at
 * 280 px on desktop, with a locked 2:3 aspect ratio (the classic TCG ratio).
 * The cover dominates the front; the footer holds title + author. Rarity
 * speaks through the border, never an overlay chip.
 */
export function Card({ card, startFlipped = false }: CardProps) {
  const [flipped, setFlipped] = useState(startFlipped);
  const rarity = RARITY_STYLES[card.rarity];
  const genreLabel = formatGenre(card.genre);

  const glowShadow =
    rarity.glow >= 3
      ? "0 0 40px -8px color-mix(in oklab, var(--rarity-legendary) 60%, transparent), 0 30px 60px -20px rgba(0, 0, 0, 0.45)"
      : rarity.glow >= 2
        ? "0 0 28px -10px color-mix(in oklab, var(--rarity-rare) 55%, transparent), 0 26px 50px -22px rgba(0, 0, 0, 0.4)"
        : rarity.glow >= 1
          ? "0 0 18px -10px color-mix(in oklab, var(--rarity-uncommon) 55%, transparent), 0 22px 44px -22px rgba(0, 0, 0, 0.35)"
          : "0 22px 44px -22px rgba(0, 0, 0, 0.3)";

  return (
    <button
      type="button"
      onClick={() => setFlipped((f) => !f)}
      aria-label={`${card.title} by ${card.authors.join(", ")}. ${rarity.label} ${genreLabel} card. Click to flip.`}
      className="group relative aspect-[2/3] w-full max-w-[320px] cursor-pointer rounded-2xl bg-transparent p-0 [perspective:1200px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lagoon)] sm:max-w-[280px]"
    >
      <motion.div
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        className="relative h-full w-full [transform-style:preserve-3d]"
        style={{ boxShadow: glowShadow }}
      >
        {/* Front — cover-dominant; rarity speaks through the border */}
        <div
          className={`absolute inset-0 flex flex-col overflow-hidden rounded-2xl bg-[var(--foam)] [backface-visibility:hidden] ${rarity.ring}`}
        >
          <div className="relative flex-1 overflow-hidden bg-[var(--sand)]">
            <img
              src={card.coverUrl}
              alt=""
              loading="eager"
              decoding="async"
              fetchPriority="high"
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
            {card.rarity === "foil" && (
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-cyan-200/0 via-fuchsia-200/25 to-amber-200/0 mix-blend-overlay" />
            )}
            {card.rarity === "legendary" && (
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-violet-900/15" />
            )}
          </div>

          <div className="flex h-[19%] min-h-[68px] flex-col justify-center gap-0.5 px-4">
            <h3
              className="display-title line-clamp-1 text-base font-bold leading-tight text-[var(--sea-ink)]"
              title={card.title}
            >
              {card.title}
            </h3>
            <p className="line-clamp-1 text-xs text-[var(--sea-ink-soft)]">
              {card.authors.join(", ")}
            </p>
          </div>
        </div>

        {/* Back — all the detail lives here */}
        <div
          className={`absolute inset-0 flex flex-col gap-3 overflow-hidden rounded-2xl bg-[var(--foam)] p-5 [backface-visibility:hidden] [transform:rotateY(180deg)] ${rarity.ring}`}
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="island-kicker">{rarity.label}</p>
              <h3 className="display-title text-lg font-bold leading-tight text-[var(--sea-ink)]">
                {card.title}
              </h3>
              <p className="text-xs text-[var(--sea-ink-soft)]">{card.authors.join(", ")}</p>
            </div>
            <BookOpen className="h-5 w-5 text-[var(--sea-ink-soft)]" />
          </div>

          <p className="line-clamp-4 text-sm leading-relaxed text-[var(--sea-ink)]/90">
            {card.description}
          </p>

          <div className="flex flex-wrap gap-1.5">
            {card.moodTags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--sea-ink-soft)]"
              >
                {tag}
              </span>
            ))}
          </div>

          <div className="mt-auto space-y-1 text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
            <div className="flex justify-between">
              <span>Pages</span>
              <span className="text-[var(--sea-ink)]">{card.pageCount}</span>
            </div>
            <div className="flex justify-between">
              <span>Published</span>
              <span className="text-[var(--sea-ink)]">{card.publishedYear}</span>
            </div>
            <div className="flex justify-between">
              <span>Genre</span>
              <span className="text-[var(--sea-ink)]">{genreLabel}</span>
            </div>
          </div>
        </div>
      </motion.div>
    </button>
  );
}
