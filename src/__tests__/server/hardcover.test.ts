import { graphql, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "@test/msw/server";
import {
  __resetRateLimitForTests,
  fetchBookById,
  HardcoverError,
  parseSearchResults,
  searchBooks,
} from "@/server/hardcover";

const HARDCOVER_GRAPHQL = "https://api.hardcover.app/v1/graphql";

describe("fetchBookById", () => {
  beforeEach(() => {
    // The module reads HARDCOVER_API_TOKEN via `getEnv` which in Node
    // falls back to `process.env`. Set it once so the auth guard passes.
    process.env.HARDCOVER_API_TOKEN = "test-token-abc";
    // Clear the rate-limit clock so tests don't each pay 1.1s.
    __resetRateLimitForTests();
  });

  afterEach(() => {
    delete process.env.HARDCOVER_API_TOKEN;
  });

  it("returns the book when the fixture id matches", async () => {
    const book = await fetchBookById(12345);
    expect(book).toMatchObject({
      id: 12345,
      title: "The Long Way to a Small, Angry Planet",
      rating: 4.32,
      ratings_count: 42000,
    });
    expect(book?.contributions?.[0]?.author?.name).toBe("Becky Chambers");
  });

  it("returns null when the book is not in the fixture (books_by_pk returns null)", async () => {
    const book = await fetchBookById(99999);
    expect(book).toBeNull();
  });

  it("rejects invalid ids without hitting the network", async () => {
    await expect(fetchBookById(0)).rejects.toThrow(HardcoverError);
    await expect(fetchBookById(-1)).rejects.toThrow(/Invalid/);
  });

  it("throws HardcoverError when the token is missing", async () => {
    delete process.env.HARDCOVER_API_TOKEN;
    await expect(fetchBookById(12345)).rejects.toThrow(/HARDCOVER_API_TOKEN/);
  });

  it("sends a Bearer Authorization header and an operationName", async () => {
    let capturedAuth: string | undefined;
    let capturedOperation: string | undefined;
    server.use(
      graphql.link(HARDCOVER_GRAPHQL).query("GetBook", async ({ request }) => {
        capturedAuth = request.headers.get("authorization") ?? undefined;
        const body = (await request.clone().json()) as unknown as { operationName?: string };
        capturedOperation = body.operationName;
        return HttpResponse.json({
          data: {
            books_by_pk: {
              id: 1,
              title: "Stub",
              contributions: [],
              cached_image: null,
              image: null,
            },
          },
        });
      }),
    );
    await fetchBookById(1);
    expect(capturedAuth).toBe("Bearer test-token-abc");
    expect(capturedOperation).toBe("GetBook");
  });

  it("does not double-prefix a token that already starts with 'Bearer '", async () => {
    process.env.HARDCOVER_API_TOKEN = "Bearer preprefixed";
    let captured: string | undefined;
    server.use(
      graphql.link(HARDCOVER_GRAPHQL).query("GetBook", ({ request }) => {
        captured = request.headers.get("authorization") ?? undefined;
        return HttpResponse.json({
          data: {
            books_by_pk: {
              id: 1,
              title: "Stub",
              contributions: [],
              cached_image: null,
              image: null,
            },
          },
        });
      }),
    );
    await fetchBookById(1);
    expect(captured).toBe("Bearer preprefixed");
  });

  it("surfaces GraphQL errors as HardcoverError with the upstream message", async () => {
    server.use(
      graphql.link(HARDCOVER_GRAPHQL).query("GetBook", () => {
        return HttpResponse.json({
          errors: [{ message: "field 'rating' disabled" }],
        });
      }),
    );
    await expect(fetchBookById(12345)).rejects.toThrow(/field 'rating' disabled/);
  });

  it("surfaces HTTP 429 distinctly so callers can back off", async () => {
    server.use(
      graphql.link(HARDCOVER_GRAPHQL).query("GetBook", () => {
        return new HttpResponse("Throttled", { status: 429 });
      }),
    );
    const err = await fetchBookById(12345).catch((e) => e);
    expect(err).toBeInstanceOf(HardcoverError);
    expect(err.status).toBe(429);
  });

  it("surfaces non-ok HTTP status with the status code", async () => {
    server.use(
      graphql.link(HARDCOVER_GRAPHQL).query("GetBook", () => {
        return new HttpResponse("Bad Gateway", { status: 502 });
      }),
    );
    const err = await fetchBookById(12345).catch((e) => e);
    expect(err).toBeInstanceOf(HardcoverError);
    expect(err.status).toBe(502);
  });
});

describe("searchBooks", () => {
  beforeEach(() => {
    process.env.HARDCOVER_API_TOKEN = "test-token-abc";
    __resetRateLimitForTests();
  });

  afterEach(() => {
    delete process.env.HARDCOVER_API_TOKEN;
  });

  it("returns parsed hits from the Typesense envelope fixture", async () => {
    const result = await searchBooks("wayfarers");
    expect(result.found).toBe(2);
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toMatchObject({
      id: 12345,
      title: "The Long Way to a Small, Angry Planet",
      authorNames: ["Becky Chambers"],
      releaseYear: 2014,
      rating: 4.32,
      ratingsCount: 42000,
    });
    expect(result.hits[0].coverUrl).toContain("12345.jpg");
  });

  it("rejects empty / too-short queries before the network", async () => {
    await expect(searchBooks("")).rejects.toThrow(HardcoverError);
    await expect(searchBooks("a")).rejects.toThrow(/at least 2 characters/);
  });

  it("clamps perPage to the 1..50 range", async () => {
    let capturedVars: Record<string, unknown> | undefined;
    server.use(
      graphql.link(HARDCOVER_GRAPHQL).query("SearchBooks", async ({ request }) => {
        const body = (await request.clone().json()) as unknown as {
          variables?: Record<string, unknown>;
        };
        capturedVars = body.variables;
        return HttpResponse.json({ data: { search: { results: { found: 0, hits: [] } } } });
      }),
    );
    await searchBooks("octavia butler", { perPage: 9999 });
    expect(capturedVars?.perPage).toBe(50);
    __resetRateLimitForTests();
    await searchBooks("octavia butler", { perPage: 0 });
    expect(capturedVars?.perPage).toBe(1);
  });

  it("forwards query, page, and perPage as GraphQL variables", async () => {
    let capturedVars: Record<string, unknown> | undefined;
    server.use(
      graphql.link(HARDCOVER_GRAPHQL).query("SearchBooks", async ({ request }) => {
        const body = (await request.clone().json()) as unknown as {
          variables?: Record<string, unknown>;
        };
        capturedVars = body.variables;
        return HttpResponse.json({ data: { search: { results: { found: 0, hits: [] } } } });
      }),
    );
    await searchBooks("  le guin  ", { page: 3, perPage: 5 });
    expect(capturedVars).toEqual({ query: "le guin", page: 3, perPage: 5 });
  });
});

describe("parseSearchResults", () => {
  it("returns empty for null / non-object input", () => {
    expect(parseSearchResults(null, 1, 20).hits).toHaveLength(0);
    expect(parseSearchResults("nope", 1, 20).hits).toHaveLength(0);
  });

  it("skips hits with no id or no title", () => {
    const envelope = {
      found: 3,
      hits: [
        { document: { id: "1", title: "keep" } },
        { document: { id: "", title: "no id, dropped" } },
        { document: { id: "2", title: "   " } }, // blank title
      ],
    };
    const result = parseSearchResults(envelope, 1, 20);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].id).toBe(1);
  });

  it("accepts ids as strings (Typesense) or numbers", () => {
    const envelope = {
      found: 2,
      hits: [
        { document: { id: "42", title: "A" } },
        { document: { id: 43, title: "B" } },
      ],
    };
    const result = parseSearchResults(envelope, 1, 20);
    expect(result.hits.map((h) => h.id)).toEqual([42, 43]);
  });

  it("falls back to cached_image when image.url is absent", () => {
    const envelope = {
      found: 1,
      hits: [
        {
          document: {
            id: "1",
            title: "A",
            cached_image: { url: "https://x/cached.jpg" },
          },
        },
      ],
    };
    expect(parseSearchResults(envelope, 1, 20).hits[0].coverUrl).toBe("https://x/cached.jpg");
  });

  it("tolerates missing optional fields", () => {
    const envelope = {
      found: 1,
      hits: [{ document: { id: "1", title: "A" } }],
    };
    const hit = parseSearchResults(envelope, 1, 20).hits[0];
    expect(hit.authorNames).toEqual([]);
    expect(hit.releaseYear).toBeNull();
    expect(hit.rating).toBeNull();
    expect(hit.coverUrl).toBeNull();
  });
});
