/**
 * Hardcover GraphQL client — server-side only.
 *
 * Hardcover's API is a public Hasura instance at
 * `https://api.hardcover.app/v1/graphql` requiring a Bearer token (see
 * `.env.example` → `HARDCOVER_API_TOKEN`). The endpoint enforces:
 *
 *   - 60 requests / minute (hard limit).
 *   - Max query depth of 3 (so `book { contributions { author { name } } }`
 *     is fine but going one level deeper would be rejected).
 *   - 30-second query timeout.
 *
 * Design constraints this module lives by:
 *
 *   1. **One request at a time, rate-limited.** We spin requests through
 *      a per-process FIFO queue with a minimum 1100ms gap between calls.
 *      That's 54 req/min worst-case — below the limit with a safety margin.
 *      We don't need parallelism: ingestion is an admin action performed a
 *      book at a time from a form, not a bulk pipeline.
 *   2. **Never called from the browser.** The API spec forbids it
 *      (CORS-locked + token is a full-account credential). This module
 *      imports `getEnv` which reads Worker secrets; calling it from a
 *      client bundle would fail at build time.
 *   3. **Narrow query surface.** Only what `bookResponseToRow` needs.
 *      Adding fields here means extending `HardcoverBook` in
 *      `src/lib/cards/hardcover.ts` in lockstep.
 */

import { getEnv } from "@/lib/env";
import type { HardcoverBook } from "@/lib/cards/hardcover";

const HARDCOVER_GRAPHQL = "https://api.hardcover.app/v1/graphql";

/** 60 req/min allowed; 1100ms gap gives ~54 req/min with headroom. */
const MIN_REQUEST_SPACING_MS = 1100;

/**
 * The single ingestion query. Named `GetBook` so the MSW handler can
 * match it by operation name. Kept flat to stay within the max depth
 * of 3 the API enforces.
 */
const BOOK_BY_ID_QUERY = /* GraphQL */ `
  query GetBook($id: Int!) {
    books_by_pk(id: $id) {
      id
      title
      subtitle
      description
      pages
      release_year
      rating
      ratings_count
      cached_image
      image {
        url
      }
      contributions {
        contribution
        author {
          name
        }
      }
    }
  }
`;

/**
 * FIFO queue of pending requests. Each enqueued function returns a
 * promise; we chain them so the next only runs `MIN_REQUEST_SPACING_MS`
 * after the previous *started*. Module-level state — intentional. The
 * queue is per-process, which on Cloudflare Workers means per-isolate.
 * An admin clicking the ingest button a few times per minute won't ever
 * produce cross-isolate concurrency worth worrying about.
 */
let lastRequestStartedAt = 0;

async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const waitFor = lastRequestStartedAt + MIN_REQUEST_SPACING_MS - now;
  if (waitFor > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitFor));
  }
  lastRequestStartedAt = Date.now();
  return fn();
}

/**
 * Reset the rate-limit clock. Exported for tests — our test harness
 * runs many requests back-to-back and we don't want each test to wait
 * 1.1 seconds. NEVER call this from application code.
 */
export function __resetRateLimitForTests(): void {
  lastRequestStartedAt = 0;
}

export class HardcoverError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HardcoverError";
  }
}

/**
 * Fetch a single book by its Hardcover id. Returns `null` if the book
 * doesn't exist (Hasura `_by_pk` returns `null` for unknown ids).
 * Throws `HardcoverError` on transport / auth / rate-limit failures so
 * callers can distinguish "not found" from "API unreachable".
 */
export async function fetchBookById(id: number): Promise<HardcoverBook | null> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new HardcoverError(`Invalid Hardcover book id: ${id}`);
  }

  const token = await getEnv("HARDCOVER_API_TOKEN");
  if (!token) {
    throw new HardcoverError(
      "Missing HARDCOVER_API_TOKEN. On Cloudflare Workers set it with " +
        "`wrangler secret put HARDCOVER_API_TOKEN --name tome`. Locally " +
        "put it in .env.local.",
    );
  }

  return withRateLimit(async () => {
    const res = await fetch(HARDCOVER_GRAPHQL, {
      method: "POST",
      headers: {
        // Hardcover accepts raw tokens OR `Bearer <token>` — we use the
        // canonical Bearer prefix. Some tokens in their docs show no
        // prefix; if adoption breaks, revisit.
        authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
        "content-type": "application/json",
        // API docs request identifiable UAs; keep it short and grep-able.
        "user-agent": "tome-ingest (+https://tome.blazewalker59.workers.dev)",
      },
      body: JSON.stringify({
        operationName: "GetBook",
        query: BOOK_BY_ID_QUERY,
        variables: { id },
      }),
    });

    if (res.status === 429) {
      throw new HardcoverError("Hardcover rate limit hit (429)", 429);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HardcoverError(
        `Hardcover API returned ${res.status}`,
        res.status,
        body,
      );
    }

    const json = (await res.json()) as {
      data?: { books_by_pk?: HardcoverBook | null };
      errors?: Array<{ message: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      throw new HardcoverError(
        `Hardcover GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
        undefined,
        json.errors,
      );
    }

    return json.data?.books_by_pk ?? null;
  });
}
