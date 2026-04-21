import { graphql, http, HttpResponse } from "msw";
import hardcoverBook from "./fixtures/hardcover-book.json" with { type: "json" };

const HARDCOVER_GRAPHQL = "https://api.hardcover.app/v1/graphql";

export const handlers = [
  // Hardcover GraphQL — returns a single book by id.
  //
  // Wraps our fixture in the `books_by_pk` Hasura envelope so the
  // response shape matches production exactly. When the test passes an
  // id other than the fixture's (12345), we return `null` to simulate
  // the "book not found" case — tests can still override per-call via
  // `server.use(...)` to return specific fixtures.
  graphql.link(HARDCOVER_GRAPHQL).query("GetBook", ({ variables }) => {
    const id = (variables as { id?: number } | undefined)?.id;
    if (id !== undefined && id !== hardcoverBook.id) {
      return HttpResponse.json({ data: { books_by_pk: null } });
    }
    return HttpResponse.json({ data: { books_by_pk: hardcoverBook } });
  }),

  // Generic catch-all for cover images so jsdom doesn't blow up on <img src>.
  http.get("https://assets.hardcover.app/*", () => {
    return new HttpResponse(null, { status: 200 });
  }),
];
