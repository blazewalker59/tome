// @ts-check

import { tanstackConfig } from "@tanstack/eslint-config";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  ...tanstackConfig,

  {
    name: "tome/ignores",
    ignores: [
      "eslint.config.js",
      "prettier.config.js",
      "public/**/*.js",
      "drizzle/**",
      "dist/**",
      ".output/**",
      ".wrangler/**",
      "coverage/**",
      "scripts/migration-data/**",
      "src/routeTree.gen.ts",
    ],
  },

  {
    name: "tome/react-hooks",
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  {
    name: "tome/overrides",
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Optional chaining is used defensively across the server functions
      // (API payloads, Better Auth session shapes) even where TS believes the
      // value is non-nullable.
      "@typescript-eslint/no-unnecessary-condition": "off",

      // Async functions without an await are usually intentional here — the
      // server-fn handlers are uniformly async by contract.
      "@typescript-eslint/require-await": "warn",

      // Shadowing is intentional in the nested transaction/batch callbacks.
      "no-shadow": "warn",

      // `.json()` casts are load-bearing under tsc (it returns unknown); the
      // rule's type info disagrees and --fix strips them.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
];
