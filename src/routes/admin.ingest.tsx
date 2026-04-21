import { useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { checkAdminFn, ingestBookFn, type IngestBookResult } from "@/server/ingest";

/**
 * Admin-only Hardcover ingestion route.
 *
 * Loader runs `checkAdminFn` on the server (and also client-side during
 * SPA navigations, which hits the same server fn over the wire). Three
 * outcomes:
 *   - not signed in → redirect to /sign-in
 *   - signed in but not in ADMIN_EMAILS → render a 403-style panel
 *   - admin → render the ingest form
 *
 * The form calls `ingestBookFn` and displays the result (created vs
 * re-curated, linked pack) plus a running history of ingests for this
 * session so operators can process a batch without losing context.
 *
 * Rarity is NOT recomputed here — ingest writes `common` on insert and
 * leaves the existing value alone on update. Run `pnpm db:rebucket`
 * after a batch to redistribute rarities globally.
 */
export const Route = createFileRoute("/admin/ingest")({
  loader: async () => {
    const status = await checkAdminFn();
    if (!status.signedIn) {
      throw redirect({ to: "/sign-in" });
    }
    return { status };
  },
  component: AdminIngestPage,
});

interface HistoryEntry {
  at: number;
  result: IngestBookResult;
}

function AdminIngestPage() {
  const { status } = Route.useLoaderData();

  if (!status.isAdmin) {
    return (
      <main className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-10 sm:py-16">
        <div className="island-shell w-full max-w-md rounded-3xl p-8 text-center">
          <p className="island-kicker">403 · not your shelf</p>
          <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)]">
            Admin access required
          </h1>
          <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
            Your account{status.email ? ` (${status.email})` : ""} isn&rsquo;t on the admin
            allowlist. If that&rsquo;s a mistake, ping the operator to add you to
            <code className="mx-1 rounded bg-[var(--surface-muted)] px-1 py-0.5 text-xs">
              ADMIN_EMAILS
            </code>
            .
          </p>
          <p className="mt-8 text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
            <Link to="/" className="hover:text-[var(--sea-ink)]">
              ← Back to home
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return <IngestForm />;
}

function IngestForm() {
  const [hardcoverId, setHardcoverId] = useState("");
  const [genre, setGenre] = useState("");
  const [moodTagsRaw, setMoodTagsRaw] = useState("");
  const [packSlug, setPackSlug] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setError(null);

    const idNum = Number(hardcoverId);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      setError("Hardcover id must be a positive integer.");
      return;
    }

    // Split on commas, drop empties — server re-validates kebab-case and
    // the 3-tag max, but trimming here gives instant feedback on the
    // common "trailing comma" mistake.
    const moodTags = moodTagsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (moodTags.length > 3) {
      setError(`At most 3 mood tags; got ${moodTags.length}.`);
      return;
    }

    setPending(true);
    try {
      const result = await ingestBookFn({
        data: {
          hardcoverId: idNum,
          genre: genre.trim(),
          moodTags,
          packSlug: packSlug.trim() || undefined,
        },
      });
      setHistory((h) => [{ at: Date.now(), result }, ...h].slice(0, 20));
      // Clear the id (the most likely field to change between ingests)
      // but keep genre/pack so batch-importing into a single pack is
      // low-friction.
      setHardcoverId("");
      setMoodTagsRaw("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingest failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8">
        <p className="island-kicker">Admin · catalog</p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          Ingest from Hardcover
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          Pulls a book by Hardcover id and upserts it into the catalog. Re-ingesting the same id
          updates editorial fields (genre, moods) and refreshes metadata; rarity is untouched.
          Run <code className="rounded bg-[var(--surface-muted)] px-1 py-0.5 text-xs">
            pnpm db:rebucket
          </code> after a batch to redistribute rarities.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="island-shell rounded-3xl p-6">
          <form onSubmit={handleSubmit} className="space-y-5">
            <Field
              label="Hardcover id"
              hint="Numeric id from hardcover.app. Find it in the book URL."
            >
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                required
                value={hardcoverId}
                onChange={(e) => setHardcoverId(e.target.value)}
                disabled={pending}
                className="input-field min-h-[44px] w-full rounded-full px-4 text-sm"
                placeholder="e.g. 412345"
              />
            </Field>

            <Field
              label="Genre"
              hint="Kebab-case (e.g. literary-fiction, science-fiction, memoir)."
            >
              <input
                type="text"
                required
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                disabled={pending}
                pattern="[a-z0-9][a-z0-9-]*"
                className="input-field min-h-[44px] w-full rounded-full px-4 text-sm"
                placeholder="literary-fiction"
              />
            </Field>

            <Field
              label="Mood tags"
              hint="Up to 3, comma-separated, kebab-case. Optional."
            >
              <input
                type="text"
                value={moodTagsRaw}
                onChange={(e) => setMoodTagsRaw(e.target.value)}
                disabled={pending}
                className="input-field min-h-[44px] w-full rounded-full px-4 text-sm"
                placeholder="atmospheric, slow-burn, melancholic"
              />
            </Field>

            <Field
              label="Pack slug"
              hint="Optional. Links this book into an existing pack (must already exist)."
            >
              <input
                type="text"
                value={packSlug}
                onChange={(e) => setPackSlug(e.target.value)}
                disabled={pending}
                className="input-field min-h-[44px] w-full rounded-full px-4 text-sm"
                placeholder="editorial-launch"
              />
            </Field>

            <button
              type="submit"
              disabled={pending}
              className="btn-primary w-full rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Ingesting…" : "Ingest book"}
            </button>

            {error && (
              <p
                role="alert"
                className="rounded-xl border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-2 text-xs text-[color:var(--rarity-legendary)]"
              >
                {error}
              </p>
            )}
          </form>
        </section>

        <section>
          <h2 className="island-kicker mb-3">Recent ingests · this session</h2>
          {history.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
              No ingests yet. Results will appear here.
            </p>
          ) : (
            <ul className="space-y-2">
              {history.map((h) => (
                <li
                  key={`${h.result.bookId}-${h.at}`}
                  className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                        {h.result.title}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">
                        {h.result.authors.join(", ") || "Unknown author"} · hc#
                        {h.result.hardcoverId}
                      </p>
                    </div>
                    <span
                      className={
                        "shrink-0 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] " +
                        (h.result.created
                          ? "border border-[color:var(--rarity-uncommon)]/40 bg-[color:var(--rarity-uncommon-soft)] text-[color:var(--rarity-uncommon)]"
                          : "border border-[color:var(--rarity-rare)]/40 bg-[color:var(--rarity-rare-soft)] text-[color:var(--rarity-rare)]")
                      }
                    >
                      {h.result.created ? "Added" : "Re-curated"}
                    </span>
                  </div>
                  {h.result.linkedToPackId && (
                    <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                      Linked to pack
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] text-[var(--sea-ink-soft)]">{hint}</span>}
    </label>
  );
}
