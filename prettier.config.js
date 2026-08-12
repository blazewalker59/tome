// @ts-check

/**
 * Prettier defaults, chosen deliberately: the existing codebase is already
 * overwhelmingly double-quoted and semicolon-terminated (363 vs 41 import
 * quotes, 97 of 99 files semicolon-terminated), so the defaults produce the
 * smallest possible reformat diff.
 */
export default {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 80,
};
