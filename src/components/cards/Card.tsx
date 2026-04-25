import { useState } from "react";
import { motion } from "motion/react";
import { BookOpen, ArrowUpRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { CardData } from "@/lib/cards/types";
import { RARITY_STYLES, formatGenre } from "@/lib/cards/style";

export interface CardProps {
  card: CardData;
  /** Defaults to false (front shown). Click flips. */
  startFlipped?: boolean;
  /**
   * When provided, a "Details" link is rendered on the back face that
   * navigates to this route. Omitted for the PackRip reveal sequence
   * where the card isn't yet associated with a navigable detail page.
   */
  detailHref?: string;
  /**
   * Controls the cover's `loading` attribute. Defaults to `eager`
   * because most use sites (rip reveal, book detail) render a single
   * card and want it visible immediately. Large grids (e.g. the
   * collection page) opt into `lazy` for off-screen cards so we
   * only eagerly fetch the above-the-fold tiles.
   */
  coverLoading?: "eager" | "lazy";
}

/**
 * A book card. Sized fluidly: full-width up to 320 px on mobile, capped at
 * 280 px on desktop, with a locked 2:3 aspect ratio (the classic TCG ratio).
 * The front is a full-bleed cover — no title/author footer, because every
 * cover already carries that text and the strip cost ~1/5 of the visible
 * area for no information gain. Rarity speaks through the border, never
 * an overlay chip. All detail (synopsis, tags, stats, rarity label) lives
 * on the back face.
 *
 * Structure: the root is a plain `<div>` so we can legally nest a real
 * `<a>` (the Details link on the back). A full-bleed overlay `<button>`
 * handles the flip click. When `detailHref` is set, the link sits
 * above the button on the back face with a higher z-index + its own
 * click handler that stops propagation so navigating doesn't also flip.
 */
export function Card({ card, startFlipped = false, detailHref, coverLoading = "eager" }: CardProps) {
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
    <div className="group relative aspect-[2/3] w-full max-w-[320px] rounded-2xl [perspective:1200px] sm:max-w-[280px]">
      <motion.div
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        className="relative h-full w-full [transform-style:preserve-3d]"
        style={{ boxShadow: glowShadow }}
      >
        {/* Front — cover-only. Title and author used to live in a
            ~19% footer strip below the cover, but every book cover
            already shows both — the strip was redundant trim that
            cost ~1/5 of the card's visible area. Going full-bleed
            lets the artwork (the actual collectible surface) breathe
            and matches how physical TCG cards read. Metadata still
            lives on the back face and on the book detail page. */}
        <div
          className={`absolute inset-0 overflow-hidden rounded-2xl bg-[var(--foam)] [backface-visibility:hidden] ${rarity.ring}`}
        >
          <div className="relative h-full w-full overflow-hidden bg-[var(--sand)]">
            <img
              src={card.coverUrl}
              alt=""
              loading={coverLoading}
              decoding="async"
              fetchPriority={coverLoading === "eager" ? "high" : "low"}
              // Hardcover's CDN serves cover images with hotlink
              // protection that 403s when a Referer header is sent.
              // Stripping the referrer is what lets covers actually
              // load in production.
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
            {card.rarity === "foil" && (
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-cyan-200/0 via-fuchsia-200/25 to-amber-200/0 mix-blend-overlay" />
            )}
            {card.rarity === "legendary" && (
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-violet-900/15" />
            )}
          </div>
        </div>

        {/* Back — all the detail lives here */}
        <div
          className={`absolute inset-0 flex flex-col gap-3 overflow-hidden rounded-2xl bg-[var(--foam)] p-5 [backface-visibility:hidden] [transform:rotateY(180deg)] ${rarity.ring}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="island-kicker">{rarity.label}</p>
              <h3 className="display-title text-lg font-bold leading-tight text-[var(--sea-ink)]">
                {card.title}
              </h3>
              <p className="text-xs text-[var(--sea-ink-soft)]">{card.authors.join(", ")}</p>
            </div>
            {/* When a detail route is available, we replace the
                decorative BookOpen icon with a real link — the link's
                actual markup lives in the z-index-20 overlay below so
                it can capture clicks above the flip button. Render
                BookOpen only when no link is provided so the back
                doesn't look naked. */}
            {!detailHref && (
              <BookOpen className="h-5 w-5 shrink-0 text-[var(--sea-ink-soft)]" />
            )}
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

      {/* Flip surface — full-bleed invisible button covering the card.
          Sits below the Details link (z-index-wise) so clicks on the
          link land on the anchor, not the button. Only reachable when
          the card is mounted; keyboard users can focus it directly to
          toggle. */}
      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        aria-label={`${card.title} by ${card.authors.join(", ")}. ${rarity.label} ${genreLabel} card. Click to flip.`}
        className="absolute inset-0 z-10 cursor-pointer rounded-2xl bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lagoon)]"
      />

      {/* Details link — only rendered on the back face. `[backface-
          visibility:hidden]` on a rotated wrapper hides it when the
          card is showing the front, so users can't accidentally
          navigate before seeing the back. Higher z-index than the
          flip button so it captures clicks first; stopPropagation
          belt-and-suspenders against bubbling into the flip. */}
      {detailHref && (
        <div
          className="pointer-events-none absolute inset-0 z-20 [transform-style:preserve-3d]"
          aria-hidden={!flipped}
        >
          <motion.div
            animate={{ rotateY: flipped ? 180 : 0 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="relative h-full w-full [transform-style:preserve-3d]"
          >
            <div className="absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)]">
              <Link
                to={detailHref}
                onClick={(e) => e.stopPropagation()}
                tabIndex={flipped ? 0 : -1}
                aria-label="Open book details"
                title="Open book details"
                className="pointer-events-auto absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface)] text-[var(--sea-ink)] shadow-sm transition hover:bg-[var(--foam)]"
              >
                <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
              </Link>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
