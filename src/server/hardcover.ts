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
 * Search query against Hardcover's Typesense-backed `search` field.
 * The `results` field is `jsonb` — it contains the raw Typesense hit
 * envelope (`{ found, hits: [{ document: {...} }], ... }`). We project
 * it into our own `HardcoverSearchHit` shape in `parseSearchResults`.
 *
 * Default query_type is `book` so omitting it is safe; we pass it
 * explicitly for readability. `per_page: 20` is a conservative batch
 * size — the form UI can page through more if needed later.
 */
const SEARCH_BOOKS_QUERY = /* GraphQL */ `
  query SearchBooks($query: String!, $perPage: Int!, $page: Int!) {
    search(query: $query, query_type: "book", per_page: $perPage, page: $page) {
      results
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

  const json = await hardcoverRequest<{
    books_by_pk?: HardcoverBook | null;
  }>("GetBook", BOOK_BY_ID_QUERY, { id });
  return json.books_by_pk ?? null;
}

/**
 * One hit in a book-search result. Derived from Typesense's `document`
 * payload — fields we don't use (content_warnings, cover_color,
 * audio_seconds, …) are intentionally omitted. The two that matter
 * most for the ingest UI:
 *   - `id` is what gets passed to `fetchBookById` when the operator
 *     picks a book to ingest.
 *   - `image.url` (and fallback `cached_image`) is how we show covers
 *     in the search-results list so admins can eyeball the right edition.
 */
export interface HardcoverSearchHit {
  id: number;
  title: string | null;
  subtitle: string | null;
  authorNames: ReadonlyArray<string>;
  releaseYear: number | null;
  rating: number | null;
  ratingsCount: number | null;
  coverUrl: string | null;
  /** URL slug on hardcover.app, useful for "open source" links. */
  slug: string | null;
}

export interface HardcoverSearchResult {
  hits: ReadonlyArray<HardcoverSearchHit>;
  /** Total matches across all pages (Typesense `found`). */
  found: number;
  page: number;
  perPage: number;
}

/**
 * Search Hardcover's book index. Thin wrapper over the GraphQL `search`
 * field; returns a flat shape so the UI doesn't need to know about
 * Typesense's `{ hits: [{ document }] }` envelope.
 *
 * `query` is trimmed and required to be at least 2 chars — short
 * queries waste a rate-limit slot on results that'll be too broad to
 * be useful. The admin UI further enforces a 3-char minimum; the 2-char
 * floor here is the absolute backstop.
 */
export async function searchBooks(
  query: string,
  opts: { page?: number; perPage?: number } = {},
): Promise<HardcoverSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    throw new HardcoverError(`Search query must be at least 2 characters; got "${query}"`);
  }
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const perPage = Math.max(1, Math.min(50, Math.floor(opts.perPage ?? 20)));

  const json = await hardcoverRequest<{
    search?: { results?: unknown } | null;
  }>("SearchBooks", SEARCH_BOOKS_QUERY, { query: trimmed, perPage, page });

  return parseSearchResults(json.search?.results, page, perPage);
}

/**
 * Shape of the Typesense envelope Hardcover forwards via `search.results`.
 * Documented informally in their searching guide; we narrow defensively
 * because Typesense has evolved the shape historically.
 */
interface TypesenseEnvelope {
  found?: number;
  hits?: Array<{ document?: Record<string, unknown> }>;
}

/** Parse the opaque Typesense result into our `HardcoverSearchResult`. */
export function parseSearchResults(
  raw: unknown,
  page: number,
  perPage: number,
): HardcoverSearchResult {
  if (!raw || typeof raw !== "object") {
    return { hits: [], found: 0, page, perPage };
  }
  const env = raw as TypesenseEnvelope;
  const found = typeof env.found === "number" ? env.found : 0;
  const hits: HardcoverSearchHit[] = [];
  for (const h of env.hits ?? []) {
    const d = h.document ?? {};
    const idRaw = (d as { id?: unknown }).id;
    // Typesense ships ids as strings; Hardcover's `books_by_pk` wants an
    // Int. Convert here so the UI can pass the id straight to ingest.
    const id = typeof idRaw === "string" ? Number.parseInt(idRaw, 10) : Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) continue;

    const title = pickString(d, "title");
    if (!title) continue; // skip malformed / missing-title hits

    const authorNamesRaw = (d as { author_names?: unknown }).author_names;
    const authorNames = Array.isArray(authorNamesRaw)
      ? authorNamesRaw.filter((x): x is string => typeof x === "string")
      : [];

    // Image can appear under a few keys depending on index version:
    // `image.url`, `cached_image.url`, or a bare string. Prefer the most
    // structured shape first.
    const coverUrl =
      pickNestedUrl(d, "image") ?? pickNestedUrl(d, "cached_image") ?? null;

    hits.push({
      id,
      title,
      subtitle: pickString(d, "subtitle"),
      authorNames,
      releaseYear: pickInt(d, "release_year"),
      rating: pickNumber(d, "rating"),
      ratingsCount: pickInt(d, "ratings_count"),
      coverUrl,
      slug: pickString(d, "slug"),
    });
  }
  return { hits, found, page, perPage };
}

function pickString(d: Record<string, unknown>, key: string): string | null {
  const v = d[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function pickNumber(d: Record<string, unknown>, key: string): number | null {
  const v = d[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickInt(d: Record<string, unknown>, key: string): number | null {
  const n = pickNumber(d, key);
  return n === null ? null : Math.trunc(n);
}

function pickNestedUrl(d: Record<string, unknown>, key: string): string | null {
  const v = d[key];
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const url = (v as { url?: unknown }).url;
    return typeof url === "string" && url.length > 0 ? url : null;
  }
  return null;
}

/**
 * Internal: perform a rate-limited GraphQL request. Throws
 * `HardcoverError` on transport / auth / rate-limit / GraphQL failures;
 * returns the `data` payload on success. Operations return their own
 * slice of `data` (caller narrows).
 */
async function hardcoverRequest<T>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
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
      body: JSON.stringify({ operationName, query, variables }),
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
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      throw new HardcoverError(
        `Hardcover GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
        undefined,
        json.errors,
      );
    }
    if (!json.data) {
      throw new HardcoverError(`Hardcover response missing data for ${operationName}`);
    }
    return json.data;
  });
}
