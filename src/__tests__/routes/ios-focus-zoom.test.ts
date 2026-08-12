import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the central fix for iOS focus zoom (issue #16).
 *
 * Mobile Safari zooms the layout viewport when a focused text-entry element
 * renders below 16px, and never zooms back out. `src/styles.css` fixes this
 * once for every input, textarea and select rather than per element.
 *
 * The fix rests on a cascade detail that is easy to break by accident:
 * the rule is UNLAYERED, while Tailwind v4 emits `text-sm` / `text-xs` /
 * `text-[10px]` into `@layer utilities`, and unlayered normal declarations
 * outrank layered ones regardless of specificity. Wrap the rule in a layer —
 * or move it into `@layer components` during a tidy-up — and it silently
 * stops working, with no test failing and no visible change on desktop.
 *
 * So these assert the mechanism, not merely the rule's presence.
 */

const STYLES = readFileSync("src/styles.css", "utf8");

/** The `@media (max-width: …)` block carrying the font-size rule. */
function zoomRuleBlock(): string {
  const start = STYLES.indexOf("@media (max-width: 39.99rem)");
  expect(
    start,
    "the mobile-scoped font-size rule is gone from src/styles.css",
  ).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = STYLES.indexOf("{", start); i < STYLES.length; i++) {
    if (STYLES[i] === "{") depth++;
    else if (STYLES[i] === "}") {
      depth--;
      if (depth === 0) return STYLES.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in the zoom rule block");
}

describe("iOS focus-zoom rule", () => {
  it("sets text-entry elements to 16px below the sm breakpoint", () => {
    const block = zoomRuleBlock();
    expect(block).toMatch(/\binput\b/);
    expect(block).toMatch(/\btextarea\b/);
    // <select> zooms too, and is the one people forget.
    expect(block).toMatch(/\bselect\b/);
    // 1rem === 16px, the threshold below which Safari zooms.
    expect(block).toMatch(/font-size:\s*1rem/);
  });

  it("is scoped to mobile so dense desktop sizing survives", () => {
    // An unscoped rule would flatten the deliberately small admin controls
    // (text-xs, text-[10px], text-[11px]) on desktop — a regression, not a fix.
    expect(STYLES).toMatch(/@media\s*\(max-width:\s*39\.99rem\)/);
  });

  it("excludes input types iOS never zooms for", () => {
    const block = zoomRuleBlock();
    // Forcing 16px on a checkbox changes its rendered size for no benefit,
    // and two checkboxes in admin.books.tsx sit right next to real inputs.
    for (const type of ["checkbox", "radio", "range"]) {
      expect(block, `input[type=${type}] should be excluded`).toContain(
        `[type="${type}"]`,
      );
    }
  });

  it("stays UNLAYERED, which is what lets it beat Tailwind's utilities", () => {
    // The load-bearing detail. Tailwind's text-* utilities live in
    // @layer utilities; an unlayered rule outranks them regardless of
    // specificity. Inside any layer, this rule would lose to `text-sm` and
    // the bug would come back silently.
    const idx = STYLES.indexOf("@media (max-width: 39.99rem)");
    const before = STYLES.slice(0, idx);
    // Count unclosed `@layer <name> {` blocks preceding the rule.
    let depth = 0;
    const layerStarts: Array<number> = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] === "{") depth++;
      else if (before[i] === "}") {
        depth--;
        while (
          layerStarts.length &&
          layerStarts[layerStarts.length - 1] > depth
        )
          layerStarts.pop();
      }
    }
    expect(
      depth,
      "the zoom rule is nested inside another block (a @layer?) — unlayered " +
        "is what makes it outrank Tailwind's layered text-* utilities",
    ).toBe(0);
  });
});

describe("viewport meta", () => {
  it("still permits pinch-zoom", () => {
    const root = readFileSync("src/routes/__root.tsx", "utf8");
    // Suppressing zoom this way is a WCAG 1.4.4 failure — the font-size fix
    // exists precisely so this stays unnecessary.
    expect(root).not.toMatch(/maximum-scale/);
    expect(root).not.toMatch(/user-scalable\s*=\s*no/);
    expect(root).toMatch(/width=device-width/);
  });
});

describe("every text-entry element in the app is matched by the rule", () => {
  /**
   * The real regression guard.
   *
   * A per-element `text-sm` is harmless now — the central rule outranks it —
   * so asserting "no element carries a small text class" would flag 32
   * non-bugs. What actually breaks the fix is an element the SELECTOR does
   * not reach: a new `<input type="...">` excluded by the `:not(...)` list,
   * or a switch to a contenteditable div. So this walks the real elements and
   * checks each one against the selector as written.
   *
   * Narrow the selector back to `.input-field` and this fails, because three
   * elements never had that class.
   */
  function tsxFiles(dir: string): Array<string> {
    const out: Array<string> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsxFiles(p));
      else if (entry.name.endsWith(".tsx")) out.push(p);
    }
    return out;
  }

  /** Full opening tag from `<input` to its matching `>`, braces respected. */
  function openingTag(src: string, start: number): string {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) return src.slice(start, i + 1);
    }
    return src.slice(start, start + 500);
  }

  interface Element {
    where: string;
    tag: "input" | "textarea" | "select";
    type: string | null;
    markup: string;
  }

  function findElements(): Array<Element> {
    const found: Array<Element> = [];
    for (const file of tsxFiles("src")) {
      if (file.includes("__tests__")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<(input|textarea|select)[\s\n]/g)) {
        const markup = openingTag(src, m.index);
        // `<select>` also appears inside JSX prose comments; a real element
        // always carries at least one attribute.
        if (!/\w+=/.test(markup)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        const type = /type=["']([a-z-]+)["']/.exec(markup)?.[1] ?? null;
        found.push({
          where: `${file}:${line}`,
          tag: m[1] as Element["tag"],
          type,
          markup,
        });
      }
    }
    return found;
  }

  /** Input types the rule deliberately skips — iOS never zooms for these. */
  const NON_ZOOMING = new Set([
    "checkbox",
    "radio",
    "range",
    "color",
    "submit",
    "button",
    "reset",
    "file",
  ]);

  it("finds the elements at all (guards the parser itself)", () => {
    const els = findElements();
    // A parser that silently matched nothing would make every assertion
    // below vacuously true.
    expect(els.length).toBeGreaterThan(20);
    expect(els.some((e) => e.tag === "select")).toBe(true);
    expect(els.some((e) => e.tag === "textarea" || e.tag === "input")).toBe(
      true,
    );
  });

  it("leaves no zoom-capable element outside the selector", () => {
    const block = zoomRuleBlock();
    const missed = findElements()
      .filter((e) => !(e.type && NON_ZOOMING.has(e.type)))
      .filter((e) => !new RegExp(`\\b${e.tag}\\b`).test(block));

    expect(
      missed.map(
        (e) => `${e.where} <${e.tag}${e.type ? ` type=${e.type}` : ""}>`,
      ),
      "these elements can trigger iOS focus zoom but the rule in " +
        "src/styles.css does not select them",
    ).toEqual([]);
  });

  it("does not rely on a class three elements never had", () => {
    // admin.books.tsx has two checkboxes and a pill-styled rarity <select>
    // without `.input-field`. Keying the fix on that class would miss the
    // select — and would visually break the checkboxes if "fixed" by adding
    // the class to them.
    const withoutClass = findElements().filter(
      (e) => !e.markup.includes("input-field"),
    );
    expect(withoutClass.length).toBeGreaterThan(0);
    const zoomable = withoutClass.filter(
      (e) => !(e.type && NON_ZOOMING.has(e.type)),
    );
    const block = zoomRuleBlock();
    for (const e of zoomable) {
      expect(
        new RegExp(`\\b${e.tag}\\b`).test(block),
        `${e.where} has no .input-field and must be covered by element selector`,
      ).toBe(true);
    }
  });
});
