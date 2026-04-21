import { graphql, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "@test/msw/server";
import {
  __resetRateLimitForTests,
  fetchBookById,
  HardcoverError,
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
        const body = (await request.clone().json()) as { operationName?: string };
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
