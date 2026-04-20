import { graphql, http, HttpResponse } from "msw";
import hardcoverBook from "./fixtures/hardcover-book.json" with { type: "json" };

const HARDCOVER_GRAPHQL = "https://api.hardcover.app/v1/graphql";

export const handlers = [
  // Hardcover GraphQL — returns a single book by id.
  graphql.link(HARDCOVER_GRAPHQL).query("GetBook", () => {
    return HttpResponse.json({ data: hardcoverBook });
  }),

  // Generic catch-all for cover images so jsdom doesn't blow up on <img src>.
  http.get("https://assets.hardcover.app/*", () => {
    return new HttpResponse(null, { status: 200 });
  }),
];
