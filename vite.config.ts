import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * Build config for Cloudflare Workers.
 *
 * Replaces the previous Nitro `cloudflare-module` preset. The reason for the
 * swap is bindings: Nitro generated its own wrangler.json into `.output/` and
 * there was no clean way to declare a D1 binding on it, so `vite dev` ran the
 * Node preset with no database binding at all and D1 could only ever be
 * exercised under a separate `wrangler dev`. @cloudflare/vite-plugin runs the
 * dev server inside workerd against the real wrangler.jsonc, so `bun run dev`
 * gets a genuine local D1 (miniflare-backed, seeded by
 * `bun run db:migrate:local`) — dev and production hit the same binding.
 *
 * Vitest config deliberately lives in its own vitest.config.ts rather than a
 * `test` block here. The Cloudflare plugin sets `resolve.external` for the SSR
 * environment, which breaks Vitest's module resolution; keeping the two files
 * apart avoids needing an `isTest` guard to conditionally drop the plugin.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
