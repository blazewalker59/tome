import { defineConfig } from "vitest/config";
import viteReact from "@vitejs/plugin-react";

/**
 * Vitest config, deliberately separate from vite.config.ts: that file loads
 * @cloudflare/vite-plugin, which sets `resolve.external` for the SSR
 * environment and breaks Vitest's module resolution. Keeping the two apart
 * avoids needing an `isTest` guard to conditionally drop the plugin.
 */
export default defineConfig({
  plugins: [viteReact()],
  resolve: {
    alias: {
      // `import.meta.dirname` rather than `__dirname`: Vite's native config
      // loader (soon the default) can't evaluate CJS globals.
      "@": new URL("./src", import.meta.url).pathname,
      "@test": new URL("./src/__tests__/_setup", import.meta.url).pathname,
      "#": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    // Default to node; component tests opt into jsdom via the
    // `// @vitest-environment jsdom` pragma at the top of the file.
    environment: "node",
    globals: false,
    setupFiles: ["./src/__tests__/_setup/setup.ts"],
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    // Integration tests need a real D1 binding and run under workerd via
    // vitest.integration.config.ts (`bun run test:integration`). They would
    // fail here, where there is no binding and no Worker runtime.
    exclude: ["src/__tests__/integration/**"],
    css: false,
  },
});
