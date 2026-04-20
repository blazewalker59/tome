import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;

if (!url) {
  // We don't throw at import time so unit tests that don't touch the db
  // can still import other modules from this file.
  // Server functions that need a real connection will throw on first use.
  console.warn("[tome/db] DATABASE_URL is not set. DB calls will fail until configured.");
}

const client = url ? postgres(url, { prepare: false }) : null;

export const db = client ? drizzle(client, { schema }) : null;

export { schema };
