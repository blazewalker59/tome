/**
 * Shared error-logging wrapper for server functions.
 *
 * TanStack Start's serializer drops `.cause` chains on the way to the
 * client, so without this wrapper postgres/drizzle errors show up as
 * generic "Failed query" strings in Worker tail. Wrapping every
 * server-fn handler gives us the real SQLSTATE / message server-side
 * while still surfacing the original error to the client.
 *
 * Lives here (not in any one *server.ts* file) so every server module
 * can pull it in without creating import cycles. Exact shape mirrors
 * the original inline version in `src/server/collection.ts`.
 */
export function withErrorLogging<Args extends unknown[], R>(
  label: string,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      // eslint-disable-next-line no-console
      console.error(
        `[${label}]`,
        err instanceof Error ? err.message : err,
        cause instanceof Error
          ? `\n  cause: ${cause.message}`
          : cause
            ? `\n  cause: ${JSON.stringify(cause)}`
            : "",
        err instanceof Error && err.stack ? `\n${err.stack}` : "",
      );
      throw err;
    }
  };
}
