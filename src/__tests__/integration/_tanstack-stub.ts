/**
 * Stub for TanStack Start's virtual entry modules.
 *
 * Importing any `src/server/*.ts` module pulls in `createServerFn`, which
 * reaches for `#tanstack-router-entry` and friends — virtual specifiers the
 * dev/build pipeline provides and a test worker does not. The integration
 * tests only ever call the plain query functions those modules export, never
 * the server functions themselves, so an empty module is enough to let the
 * import graph resolve.
 */
export default {};
