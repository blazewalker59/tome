import { Gem } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RARITY_STYLES } from "@/lib/cards/style";
import type { Rarity } from "@/lib/cards/types";

/**
 * Canonical display order for rarity rows, ascending from most common
 * to rarest. Centralised here so every screen that shows a gem row
 * reads left-to-right the same way.
 */
const ALL_RARITIES: ReadonlyArray<Rarity> = [
  "common",
  "uncommon",
  "rare",
  "foil",
  "legendary",
];

/**
 * Short descriptors shown in the per-rarity popover. Kept with the
 * component (rather than in RARITY_STYLES) because the phrasing is
 * presentation-layer flavour text — the style module stays purely
 * visual.
 */
const RARITY_BLURBS: Record<Rarity, string> = {
  common: "Everyday pulls. The backbone of every library.",
  uncommon: "A cut above — showing up in most packs but not every one.",
  rare: "Scarce. Expect a handful across a full set.",
  foil: "Iridescent finishes on standout titles. Always a moment.",
  legendary: "Vanishingly rare. The marquee pulls of the set.",
};

/**
 * Two presentation modes. They share the same tinted-gem language and
 * tap-to-reveal popover; they differ in what number lives under each
 * gem and what the outer ring communicates.
 *
 * - `progress`: owned-of-total across the user's collection. The gem
 *   sits inside a conic-gradient ring that fills clockwise to show
 *   completion. Label under the gem is an `N/T` fraction. Popover
 *   shows `owned/total · pct%` plus the rarity blurb.
 *
 * - `count`: how many books of this rarity exist in some scope (a
 *   pack, a set, etc.). No progress dimension, so the ring collapses
 *   to a soft inset tint. Label under the gem is the raw count.
 *   Popover shows `N <rarity>` plus the blurb.
 */
export type RarityGemRowProps =
  | {
      mode: "progress";
      owned: Record<Rarity, number>;
      total: Record<Rarity, number>;
    }
  | {
      mode: "count";
      counts: Record<Rarity, number>;
      /** Short noun used in the popover (e.g. "in this pack"). */
      scopeLabel?: string;
    };

/**
 * Shared rarity gem row used on /collection (progress mode) and on
 * the featured-pack card on home (count mode). Each gem is a tap
 * target that opens an anchored popover with the rarity label and a
 * short blurb; tapping outside or pressing Escape closes it. Only one
 * popover is open at a time.
 */
export function RarityGemRow(props: RarityGemRowProps) {
  const [openRarity, setOpenRarity] = useState<Rarity | null>(null);
  const containerRef = useRef<HTMLUListElement>(null);
  // One button ref per rarity so the portaled popover can measure the
  // anchor and position itself in viewport coordinates. This is the
  // workaround for `.island-shell`'s `backdrop-filter` creating a
  // stacking context that traps absolutely-positioned children behind
  // subsequent sibling cards — rendering the popover through a portal
  // to document.body sidesteps the trap entirely.
  const buttonRefs = useRef<Partial<Record<Rarity, HTMLButtonElement | null>>>({});

  // Close on outside click / Escape. The listeners are only attached
  // while a popover is open so we're not paying for them on every
  // render, and they're removed on cleanup to avoid leaks. The
  // outside-click check accepts either the button or the portaled
  // popover as "inside" (popover carries `data-rarity-popover`).
  useEffect(() => {
    if (openRarity === null) return;

    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-rarity-popover]")) {
        return;
      }
      setOpenRarity(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenRarity(null);
    };
    // Close if the user scrolls or the viewport resizes — the
    // portaled popover's anchor position is captured at open time,
    // so it'd drift out of sync otherwise. Cheaper to dismiss than
    // to live-track.
    const onDismiss = () => setOpenRarity(null);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [openRarity]);

  return (
    <ul
      ref={containerRef}
      className="flex items-start justify-between gap-2 sm:justify-start sm:gap-4"
    >
      {ALL_RARITIES.map((r, idx) => {
        const style = RARITY_STYLES[r];
        const { value, total, hasAny, pct } = resolveCell(r, props);
        const open = openRarity === r;

        // Pin the popover to the row edges for the outermost gems so
        // it doesn't clip off-screen on narrow viewports. Middle
        // three stay centered under their gem.
        const align: "start" | "center" | "end" =
          idx === 0 ? "start" : idx === ALL_RARITIES.length - 1 ? "end" : "center";

        return (
          <li
            key={r}
            className="relative flex flex-1 flex-col items-center gap-1 sm:flex-none"
          >
            <button
              ref={(el) => {
                buttonRefs.current[r] = el;
              }}
              type="button"
              onClick={() => setOpenRarity((cur) => (cur === r ? null : r))}
              aria-expanded={open}
              aria-haspopup="dialog"
              aria-label={ariaLabel(style.label, props.mode, value, total)}
              className="flex flex-col items-center gap-1 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lagoon)]"
            >
              <GemBadge rarity={r} hasAny={hasAny} pct={pct} mode={props.mode} />
              <GemLabel rarity={r} mode={props.mode} value={value} total={total} hasAny={hasAny} />
            </button>

            {open && (
              <RarityPopover
                anchorEl={buttonRefs.current[r] ?? null}
                rarity={r}
                label={style.label}
                align={align}
                blurb={RARITY_BLURBS[r]}
                body={popoverBody(props, r)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

type Cell = {
  value: number;
  total: number | null;
  hasAny: boolean;
  /** Progress percent 0-100; 0 when not in progress mode. */
  pct: number;
};

/**
 * Normalise the two props shapes down to the handful of scalars the
 * row needs per cell. Keeping this out of the JSX keeps the render
 * path readable.
 */
function resolveCell(r: Rarity, props: RarityGemRowProps): Cell {
  if (props.mode === "progress") {
    const value = props.owned[r];
    const total = props.total[r];
    // Guard against divide-by-zero — a rarity with no books in the
    // set is unlikely but cheaper to guard than to debug later.
    const pct = total === 0 ? 0 : Math.round((value / total) * 100);
    return { value, total, hasAny: value > 0, pct };
  }
  const value = props.counts[r];
  return { value, total: null, hasAny: value > 0, pct: 0 };
}

/**
 * 10×10 gem medallion. In `progress` mode the outer ring is a
 * conic-gradient that fills clockwise with the rarity color. In
 * `count` mode the ring collapses to a soft inset tint so the row
 * still reads as the same family of controls without implying
 * progress the data can't support.
 */
function GemBadge({
  rarity,
  hasAny,
  pct,
  mode,
}: {
  rarity: Rarity;
  hasAny: boolean;
  pct: number;
  mode: RarityGemRowProps["mode"];
}) {
  if (mode === "progress") {
    return (
      <span
        className="relative flex h-10 w-10 items-center justify-center rounded-full"
        style={{
          background: `conic-gradient(var(--rarity-${rarity}) ${pct}%, var(--track-bg) ${pct}% 100%)`,
          opacity: hasAny ? 1 : 0.4,
        }}
      >
        <span className="flex h-[calc(100%-6px)] w-[calc(100%-6px)] items-center justify-center rounded-full bg-[var(--surface)]">
          <GemIcon rarity={rarity} hasAny={hasAny} />
        </span>
      </span>
    );
  }

  return (
    <span
      className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface)]"
      style={{
        boxShadow: hasAny
          ? `inset 0 0 0 1.5px color-mix(in oklab, var(--rarity-${rarity}) 60%, transparent)`
          : "inset 0 0 0 1.5px var(--line)",
        opacity: hasAny ? 1 : 0.4,
      }}
    >
      <GemIcon rarity={rarity} hasAny={hasAny} />
    </span>
  );
}

function GemIcon({ rarity, hasAny }: { rarity: Rarity; hasAny: boolean }) {
  return (
    <Gem
      aria-hidden
      className="h-5 w-5"
      style={{ color: `var(--rarity-${rarity})` }}
      strokeWidth={2}
      fill={hasAny ? `var(--rarity-${rarity})` : "none"}
      fillOpacity={hasAny ? 0.2 : 0}
    />
  );
}

/**
 * The small numeric caption sitting under each gem. `progress` shows
 * an owned/total fraction; `count` shows the single scope count.
 */
function GemLabel({
  rarity,
  mode,
  value,
  total,
  hasAny,
}: {
  rarity: Rarity;
  mode: RarityGemRowProps["mode"];
  value: number;
  total: number | null;
  hasAny: boolean;
}) {
  if (mode === "progress" && total !== null) {
    return (
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sea-ink-soft)] tabular-nums">
        <span className={hasAny ? "text-[var(--sea-ink)]" : undefined}>{value}</span>
        <span aria-hidden>/</span>
        {total}
      </span>
    );
  }
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sea-ink-soft)] tabular-nums">
      <span className={hasAny ? "text-[var(--sea-ink)]" : undefined}>{value}</span>
      <span className="sr-only"> {RARITY_STYLES[rarity].label}</span>
    </span>
  );
}

function ariaLabel(
  styleLabel: string,
  mode: RarityGemRowProps["mode"],
  value: number,
  total: number | null,
): string {
  if (mode === "progress" && total !== null) {
    return `${styleLabel}: ${value} of ${total} owned. Tap for details.`;
  }
  return `${styleLabel}: ${value}. Tap for details.`;
}

function popoverBody(props: RarityGemRowProps, r: Rarity): React.ReactNode {
  if (props.mode === "progress") {
    const owned = props.owned[r];
    const total = props.total[r];
    const pct = total === 0 ? 0 : Math.round((owned / total) * 100);
    return (
      <span className="tabular-nums">
        {owned}/{total} · {pct}%
      </span>
    );
  }
  const count = props.counts[r];
  const scope = props.scopeLabel ?? "";
  return (
    <span className="tabular-nums">
      {count}
      {scope ? ` ${scope}` : ""}
    </span>
  );
}

/**
 * Anchored popover for a single rarity. Rendered through a portal to
 * `document.body` so the `backdrop-filter` on parent `.island-shell`
 * cards (which creates a stacking context) doesn't trap the popover
 * behind subsequent sibling cards. Position is computed from the
 * anchor button's bounding rect at mount, in viewport coordinates,
 * using `position: fixed`. Row-edge clipping is avoided with the same
 * `align` logic as before — `start` pins the popover's left edge
 * under the gem, `end` pins the right edge, `center` centers it.
 * The arrow notch moves with the popover so it always points at the
 * gem.
 */
function RarityPopover({
  anchorEl,
  rarity,
  label,
  blurb,
  body,
  align = "center",
}: {
  anchorEl: HTMLElement | null;
  rarity: Rarity;
  label: string;
  blurb: string;
  body: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  // Popover width in px — must match the `w-[14rem]` Tailwind class
  // below so the alignment math lines up. Kept as a constant so the
  // two places that need it can't drift apart.
  const POPOVER_W = 14 * 16; // 14rem @ 16px base = 224px
  const GAP = 8; // mt-2 ≈ 8px between anchor and popover
  const ANCHOR_PAD = 12; // horizontal offset used by start/end alignment

  const [pos, setPos] = useState<{ top: number; left: number; arrowLeft: number } | null>(
    null,
  );

  // useLayoutEffect so the first paint already has the computed
  // position — otherwise the popover would flash at top:0,left:0 for
  // a frame before jumping into place.
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const anchorCenterX = rect.left + rect.width / 2;
    let left: number;
    let arrowLeft: number; // arrow's x inside the popover box
    if (align === "start") {
      left = anchorCenterX - ANCHOR_PAD;
      arrowLeft = ANCHOR_PAD;
    } else if (align === "end") {
      left = anchorCenterX + ANCHOR_PAD - POPOVER_W;
      arrowLeft = POPOVER_W - ANCHOR_PAD;
    } else {
      left = anchorCenterX - POPOVER_W / 2;
      arrowLeft = POPOVER_W / 2;
    }
    // Keep the popover on-screen with an 8px margin — belt-and-braces
    // for cases where the alignment math puts it off the viewport
    // (very narrow screens, tight edge gems).
    const margin = 8;
    const maxLeft = window.innerWidth - POPOVER_W - margin;
    const clampedLeft = Math.min(Math.max(left, margin), Math.max(margin, maxLeft));
    // When the popover is clamped, adjust the arrow so it still
    // points at the gem's center.
    arrowLeft += left - clampedLeft;
    const top = rect.bottom + GAP;
    setPos({ top, left: clampedLeft, arrowLeft });
  }, [anchorEl, align]);

  if (!pos) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-label={`${label} rarity details`}
      data-rarity-popover
      className="fixed z-50 w-[14rem] rounded-xl border border-[var(--line)] bg-[var(--foam)] p-3 text-left shadow-lg"
      style={{ top: pos.top, left: pos.left }}
    >
      {/* Arrow / notch pointing at the gem. Pure CSS triangle built
          from a rotated square so the border shows on two sides —
          matches the popover's border + background. */}
      <span
        aria-hidden
        className="absolute -top-1.5 h-3 w-3 rotate-45 border-l border-t border-[var(--line)] bg-[var(--foam)]"
        style={{ left: pos.arrowLeft - 6 }}
      />
      <div className="flex items-center gap-2">
        <Gem
          aria-hidden
          className="h-4 w-4 shrink-0"
          style={{ color: `var(--rarity-${rarity})` }}
          strokeWidth={2}
          fill={`var(--rarity-${rarity})`}
          fillOpacity={0.25}
        />
        <p className="text-sm font-bold text-[var(--sea-ink)]">{label}</p>
        <p className="ml-auto text-[11px] font-semibold text-[var(--sea-ink-soft)]">{body}</p>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[var(--sea-ink-soft)]">{blurb}</p>
    </div>,
    document.body,
  );
}
