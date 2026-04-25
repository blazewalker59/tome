/**
 * Per-pack gradient + accent-shadow helper.
 *
 * Editorial packs get bespoke, genre-coded palettes so the rip
 * carousel at /rip reads as a spectrum rather than five identical
 * teal wrappers. The mapping is keyed by the pack's primary genre
 * tag (the first entry in `packs.genre_tags`), which is admin-editable
 * via /admin/packs/$slug. This keeps the gradient tied to *what the
 * pack is about* rather than *what its slug happens to be*, so renaming
 * a starter pack doesn't lose its art and a user-built pack tagged
 * `fantasy` automatically inherits the dusk-magic palette.
 *
 * Slug-keyed palettes are kept as a back-compat fallback for the five
 * original starter packs — their genre tags already match the genre
 * map, but the slug map costs nothing and protects against a future
 * editor accidentally clearing the tags.
 *
 * Any pack whose tags + slug we don't recognize falls through to the
 * original lagoon→palm token blend so the on-brand default remains
 * the baseline for user-authored packs.
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
 * Per-genre palette overrides — the primary mapping. Keys match the
 * normalized kebab-case genre tags admins type into the pack form
 * (`normalizePackGenreTags` in src/server/catalog.ts). Any pack with
 * one of these as its first tag inherits the palette.
 *
 * Palettes:
 *   - fantasy      → deep plum → rose → warm magenta (dusk-magic)
 *   - sci-fi       → midnight indigo → cyan → pale aqua (night-sky + chrome)
 *   - nonfiction   → charcoal → slate → warm amber (print + lamp-light)
 *   - romance      → deep rose → coral → peach (warm candlelight)
 *   - literary     → forest sage → moss → ochre (earthbound, quiet)
 *
 * `literary` matches the seeded "Modern Realist Fiction Starter" tag
 * (see scripts/seed-editor-packs.ts:240). The slug-keyed fallback
 * below covers the case where someone clears that tag from the admin
 * form.
 */
const PACK_GRADIENTS_BY_GENRE: Readonly<Record<string, PackGradient>> = {
  fantasy: {
    background:
      "linear-gradient(135deg, #2b0b3f 0%, #8a2b6b 55%, #d94a8c 100%)",
    glowColor: "color-mix(in oklab, #8a2b6b 55%, transparent)",
  },
  "sci-fi": {
    background:
      "linear-gradient(135deg, #0a1a3f 0%, #1f6fb8 55%, #6ad3e0 100%)",
    glowColor: "color-mix(in oklab, #1f6fb8 55%, transparent)",
  },
  nonfiction: {
    background:
      "linear-gradient(135deg, #1d2430 0%, #4a5668 55%, #d6a45c 100%)",
    glowColor: "color-mix(in oklab, #4a5668 55%, transparent)",
  },
  romance: {
    background:
      "linear-gradient(135deg, #7a1f3d 0%, #c8436a 55%, #f7b29b 100%)",
    glowColor: "color-mix(in oklab, #c8436a 55%, transparent)",
  },
  literary: {
    background:
      "linear-gradient(135deg, #1f3b2d 0%, #5a7a4c 55%, #c89a4d 100%)",
    glowColor: "color-mix(in oklab, #5a7a4c 55%, transparent)",
  },
};

/**
 * Slug-keyed fallback for the five original starter packs. Kept so
 * that even if an editor empties the `genre_tags` array on one of
 * these flagship packs the wrapper still renders with its bespoke
 * palette. New editorial packs should rely on the genre map above
 * (just tag them; no code change needed).
 */
const PACK_GRADIENTS_BY_SLUG: Readonly<Record<string, PackGradient>> = {
  "modern-fantasy-starter": PACK_GRADIENTS_BY_GENRE.fantasy!,
  "modern-sci-fi-starter": PACK_GRADIENTS_BY_GENRE["sci-fi"]!,
  "modern-nonfiction-starter": PACK_GRADIENTS_BY_GENRE.nonfiction!,
  "modern-romance-starter": PACK_GRADIENTS_BY_GENRE.romance!,
  "modern-realist-fiction-starter": PACK_GRADIENTS_BY_GENRE.literary!,
};

/**
 * Resolve a pack's wrapper gradient. Always returns a valid
 * `PackGradient`. Lookup order:
 *
 *   1. `genreTags[0]` against the genre palette map
 *   2. `slug` against the back-compat slug map
 *   3. default lagoon→palm
 *
 * Both inputs are permissive (`null | undefined` allowed) so callers
 * can pass whatever they have without defensive branching.
 */
export function packGradient(
  slug: string | null | undefined,
  genreTags?: ReadonlyArray<string> | null,
): PackGradient {
  const primaryGenre = genreTags?.[0];
  if (primaryGenre && PACK_GRADIENTS_BY_GENRE[primaryGenre]) {
    return PACK_GRADIENTS_BY_GENRE[primaryGenre];
  }
  if (slug && PACK_GRADIENTS_BY_SLUG[slug]) {
    return PACK_GRADIENTS_BY_SLUG[slug];
  }
  return DEFAULT_PACK_GRADIENT;
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
