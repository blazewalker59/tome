import { defineConfig } from "vitest/config";
import viteReact from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [viteReact()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@test": resolve(__dirname, "./src/__tests__/_setup"),
      "#": resolve(__dirname, "./src"),
    },
  },
  test: {
    // Default to node; component tests opt into jsdom via the
    // `// @vitest-environment jsdom` pragma at the top of the file.
    environment: "node",
    globals: false,
    setupFiles: ["./src/__tests__/_setup/setup.ts"],
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    css: false,
  },
});
