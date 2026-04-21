/**
 * Regenerate raster favicon / PWA icons from `public/favicon.svg`.
 *
 * Produces:
 *   - public/logo192.png        (192×192, PWA icon + apple-touch-icon)
 *   - public/logo512.png        (512×512, PWA icon)
 *   - public/favicon.ico        (multi-res ICO: 16, 32, 48)
 *
 * Why this exists: the app ships a single SVG source of truth
 * (`public/favicon.svg`) but browsers, PWAs, and iOS home-screens still
 * need raster fallbacks. Re-run this whenever the SVG mark changes:
 *
 *   pnpm favicons
 *
 * Dependencies are pulled on demand via `pnpm dlx` in the npm script so
 * we don't add them to the runtime/devDependencies graph. If you run
 * this file directly with `tsx`, make sure `sharp` and `png-to-ico` are
 * installed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

async function main() {
  // Lazy-imported so `tsc --noEmit` doesn't demand these as deps.
  const sharp = (await import("sharp")).default;
  const pngToIco = (await import("png-to-ico")).default;

  const svgPath = path.join(publicDir, "favicon.svg");
  const svg = await readFile(svgPath);

  // PWA icons — straightforward PNG renders at the manifest's advertised
  // sizes. `density` is bumped so sharp rasterizes the SVG at a high
  // enough DPI that curves don't look chunky at 192×192.
  const sizes = [
    { name: "logo192.png", size: 192 },
    { name: "logo512.png", size: 512 },
  ];
  for (const { name, size } of sizes) {
    const out = path.join(publicDir, name);
    await sharp(svg, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out);
    console.log(`wrote ${out}`);
  }

  // Multi-resolution .ico. Windows / legacy browsers still request this
  // path; embedding 16/32/48 covers tab favicons and File Explorer.
  const icoSizes = [16, 32, 48];
  const icoPngs = await Promise.all(
    icoSizes.map((s) =>
      sharp(svg, { density: 384 })
        .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    ),
  );
  const ico = await pngToIco(icoPngs);
  const icoPath = path.join(publicDir, "favicon.ico");
  await writeFile(icoPath, ico);
  console.log(`wrote ${icoPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
