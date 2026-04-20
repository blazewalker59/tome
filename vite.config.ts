import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

// Pick the Nitro preset at build time. Set `NITRO_PRESET=cloudflare-module`
// (or use the `build:cf` script) to produce a Workers bundle; otherwise we
// fall back to the default Node preset which is what `pnpm dev` expects.
const nitroPreset = process.env.NITRO_PRESET;

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    nitro({
      ...(nitroPreset
        ? {
            preset: nitroPreset,
            cloudflare: {
              // Everything under `wrangler` is merged into the generated
              // `.output/server/wrangler.json`. Pinning name + date here
              // so the Worker always deploys as `tome` and we control the
              // runtime compat date (2025-03-15 gives us nodejs_compat v2
              // semantics, which postgres-js needs for TCP sockets).
              wrangler: {
                name: "tome",
                compatibility_date: "2025-03-15",
                observability: { enabled: true },
              },
            },
          }
        : {}),
      rollupConfig: { external: [/^@sentry\//] },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
