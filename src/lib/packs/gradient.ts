/**
 * Per-pack gradient + accent-shadow helper.
 *
 * Editorial packs get bespoke, genre-coded palettes so the rip
 * carousel at /rip reads as a spectrum rather than five identical
 * teal wrappers. The mapping is keyed by pack slug — the same slug
 * is stable across seed runs, is what the router uses, and is what
 * the admin already types into the pack builder.
 *
 * Any slug we don't know about (user-authored packs, future editorial
 * packs the code doesn't yet mention) falls through to the original
 * lagoon→palm token blend so the on-brand default remains the baseline.
 *
 * Shape:
 *   - `background` — the full CSS `linear-gradient(...)` string.
 *   - `glowColor`  — a single color used by the pack's outer box-shadow
 *                    glow, tinted to match the gradient so the ambient
 *                    halo doesn't clash with the surface.
 *
 * The gradient angle (135°) and stop positions (0% / 55% / 100%) are
 * fixed across every pack so the animation work (shimmer sweep, tear
 * fade) tuned against the baseline keeps reading correctly — only the
 * colors vary.
 */

export interface PackGradient {
  /** Full CSS value for `style={{ background }}`. */
  readonly background: string;
  /** Single color used inside the outer `boxShadow` glow. */
  readonly glowColor: string;
}

/**
 * Default palette — the original lagoon→palm wrapper. Used for every
 * user-authored pack and any editorial pack this helper hasn't learned
 * about yet.
 */
const DEFAULT_PACK_GRADIENT: PackGradient = {
  background:
    "linear-gradient(135deg, var(--lagoon-deep) 0%, var(--lagoon) 55%, var(--palm) 100%)",
  glowColor: "color-mix(in oklab, var(--lagoon) 55%, transparent)",
};

/**
 * Per-slug palette overrides for the five "Modern <Genre> Starter"
 * editorial packs. Palettes picked so each pack reads as its genre
 * at a glance:
 *
 *   - fantasy          → deep plum → rose → warm magenta (dusk-magic)
 *   - sci-fi           → midnight indigo → cyan → pale aqua (night-sky + chrome)
 *   - nonfiction       → charcoal → slate → warm amber (print + lamp-light)
 *   - romance          → deep rose → coral → peach (warm candlelight)
 *   - realist fiction  → forest sage → moss → ochre (earthbound, quiet)
 *
 * Stops match the default (0/55/100%) and 135° so downstream animations
 * need no per-pack tuning. Colors are literal hex (not tokens) because
 * these palettes aren't meant to theme-shift — they're editorial art.
 * The white foil text we print on top clears AA contrast against the
 * middle stop of every gradient (verified against #ffffff).
 */
const PACK_GRADIENTS_BY_SLUG: Readonly<Record<string, PackGradient>> = {
  "modern-fantasy-starter": {
    background:
      "linear-gradient(135deg, #2b0b3f 0%, #8a2b6b 55%, #d94a8c 100%)",
    glowColor: "color-mix(in oklab, #8a2b6b 55%, transparent)",
  },
  "modern-sci-fi-starter": {
    background:
      "linear-gradient(135deg, #0a1a3f 0%, #1f6fb8 55%, #6ad3e0 100%)",
    glowColor: "color-mix(in oklab, #1f6fb8 55%, transparent)",
  },
  "modern-nonfiction-starter": {
    background:
      "linear-gradient(135deg, #1d2430 0%, #4a5668 55%, #d6a45c 100%)",
    glowColor: "color-mix(in oklab, #4a5668 55%, transparent)",
  },
  "modern-romance-starter": {
    background:
      "linear-gradient(135deg, #7a1f3d 0%, #c8436a 55%, #f7b29b 100%)",
    glowColor: "color-mix(in oklab, #c8436a 55%, transparent)",
  },
  "modern-realist-fiction-starter": {
    background:
      "linear-gradient(135deg, #1f3b2d 0%, #5a7a4c 55%, #c89a4d 100%)",
    glowColor: "color-mix(in oklab, #5a7a4c 55%, transparent)",
  },
};

/**
 * Resolve a pack's wrapper gradient. Always returns a valid
 * `PackGradient`: known slugs get their bespoke palette; everything
 * else gets the default lagoon→palm.
 *
 * `slug` is permissive (`string | null | undefined`) so callers can
 * pass whatever they have without defensively branching; nullish
 * values return the default.
 */
export function packGradient(slug: string | null | undefined): PackGradient {
  if (!slug) return DEFAULT_PACK_GRADIENT;
  return PACK_GRADIENTS_BY_SLUG[slug] ?? DEFAULT_PACK_GRADIENT;
}

/**
 * Compose the full `boxShadow` value for a pack seal. The outer
 * drop-shadow is constant across packs (holds the card off the page);
 * only the tinted glow changes with the palette.
 */
export function packBoxShadow(gradient: PackGradient): string {
  return `0 0 60px -10px ${gradient.glowColor}, 0 30px 60px -20px rgba(0, 0, 0, 0.55)`;
}

/** Same idea, brighter glow used by the /rip carousel hero card. */
export function packHeroBoxShadow(gradient: PackGradient): string {
  return `0 0 100px 0 ${gradient.glowColor}`;
}
