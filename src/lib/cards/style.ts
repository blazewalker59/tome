import type { Rarity } from "./types";

export interface RarityStyle {
  /** Tailwind classes for the outer ring on the card. */
  ring: string;
  gemBg: string;
  gemText: string;
  /** Label shown on the card (capitalized). */
  label: string;
  /** Sparkle/glow intensity (0–4) used by the rip animation. */
  glow: number;
}

/**
 * Rarity progression follows the botanical-journal palette:
 * lichen → fern → ochre → terracotta → garnet. Border thickness scales
 * with rarity; color intensity does too. All colors live as CSS variables
 * in styles.css so they shift correctly with the theme.
 */
export const RARITY_STYLES: Record<Rarity, RarityStyle> = {
  common: {
    ring: "ring-1 ring-[color:var(--rarity-common)]",
    gemBg: "bg-[color:var(--rarity-common-soft)]",
    gemText: "text-[color:var(--rarity-common)]",
    label: "Common",
    glow: 0,
  },
  uncommon: {
    ring: "ring-2 ring-[color:var(--rarity-uncommon)]",
    gemBg: "bg-[color:var(--rarity-uncommon-soft)]",
    gemText: "text-[color:var(--rarity-uncommon)]",
    label: "Uncommon",
    glow: 1,
  },
  rare: {
    ring: "ring-[3px] ring-[color:var(--rarity-rare)]",
    gemBg: "bg-[color:var(--rarity-rare-soft)]",
    gemText: "text-[color:var(--rarity-rare)]",
    label: "Rare",
    glow: 2,
  },
  foil: {
    ring: "ring-[3px] ring-[color:var(--rarity-foil)]",
    gemBg:
      "bg-[linear-gradient(110deg,var(--rarity-foil-soft),var(--rarity-rare-soft),var(--rarity-uncommon-soft))]",
    gemText: "text-[color:var(--rarity-foil)]",
    label: "Foil",
    glow: 3,
  },
  legendary: {
    ring: "ring-4 ring-[color:var(--rarity-legendary)]",
    gemBg:
      "bg-[linear-gradient(110deg,var(--rarity-legendary),var(--rarity-foil))] text-[color:var(--sea-ink)]",
    gemText: "text-[color:var(--sea-ink)]",
    label: "Legendary",
    glow: 4,
  },
};

/**
 * Title-case a kebab-case genre slug for display.
 * `science-fiction` -> `Science Fiction`, `ya` -> `YA`.
 */
const ALL_CAPS = new Set(["ya", "sf", "lgbtq"]);

export function formatGenre(genre: string): string {
  if (!genre) return "";
  return genre
    .split("-")
    .map((word) => {
      if (ALL_CAPS.has(word.toLowerCase())) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}
