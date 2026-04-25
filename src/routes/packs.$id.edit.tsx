import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";

import { getMeFn } from "@/server/admin";
import {
  addBookToPackDraftFn,
  deletePackDraftFn,
  getMyPackFn,
  getMyPublishUnlockFn,
  ingestHardcoverBookForBuilderFn,
  publishPackFn,
  removeBookFromPackDraftFn,
  unpublishPackFn,
  updatePackDraftFn,
  type MyPackDetail,
} from "@/server/user-packs";
import { BookSearchPanel } from "@/components/builder/BookSearchPanel";
import { checkPackComposition } from "@/lib/packs/composition";
import { DEFAULTS } from "@/lib/economy/defaults";

// Stable empty-set identity. The shared BookSearchPanel uses this set
// only to flag "In pack" rows; the user builder relies on the
// server-side `excludePackId` filter instead, so the badge is unused
// here. Module-scoping keeps the prop reference stable across renders
// (avoiding spurious effect re-runs inside the panel).
const EMPTY_BOOK_ID_SET: ReadonlySet<string> = new Set();

/**
 * User-pack builder.
 *
 * Composition: the route loads the user's draft (or published pack),
 * its books, and the composition/unlock snapshots needed to render the
 * progress meters. Everything else — search, add/remove, publish,
 * rename — happens via server-fn calls that refresh the pack locally.
 *
 * Post-publish, contents are frozen: the Add/Remove panels hide,
 * metadata edits stay live, and an "Unpublish" button surfaces for
 * creators who want to iterate.
 *
 * Auth: loader redirects anon users to sign-in; fn-layer also enforces
 * ownership so URL-guessing someone else's draft id is harmless.
 */
export const Route = createFileRoute("/packs/$id/edit")({
  loader: async ({ params }) => {
    const user = await getMeFn();
    if (!user) throw redirect({ to: "/sign-in" });
    return { packId: params.id, me: user };
  },
  component: EditPackPage,
});

function EditPackPage() {
  const { packId, me } = Route.useLoaderData();
  return <BuilderWorkspace packId={packId} myUsername={me.username ?? ""} />;
}

function BuilderWorkspace({
  packId,
  myUsername,
}: {
  packId: string;
  myUsername: string;
}) {
  const router = useRouter();
  const [pack, setPack] = useState<MyPackDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const p = await getMyPackFn({ data: { packId } });
      setPack(p);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Load failed");
    }
  }, [packId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError) {
    return (
      <main className="page-wrap py-12">
        <p
          role="alert"
          className="rounded-xl border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-2 text-xs text-[color:var(--rarity-legendary)]"
        >
          {loadError}
        </p>
      </main>
    );
  }

  if (!pack) {
    return (
      <main className="page-wrap py-12">
        <p className="text-sm text-[var(--sea-ink-soft)]">Loading…</p>
      </main>
    );
  }

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="island-kicker">
            {pack.isPublic ? "Published pack" : "Draft"}
          </p>
          <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
            {pack.name}
          </h1>
          {pack.isPublic && myUsername && (
            <button
              type="button"
              onClick={() =>
                router.navigate({
                  to: "/u/$username/$slug",
                  params: { username: myUsername, slug: pack.slug },
                })
              }
              className="mt-1 text-xs text-[var(--lagoon)] underline"
            >
              /u/{myUsername}/{pack.slug}
            </button>
          )}
        </div>
        <PublishControls pack={pack} onChange={reload} />
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-6">
          <MetadataForm pack={pack} onSaved={reload} />
          {!pack.isPublic && (
            <BookSearchPanel
              packId={pack.id}
              // Server-side filter the user-builder's current pack out
              // of local hits — keeps the list focused on additions.
              excludePackIdInSearch={pack.id}
              // Server already excludes members so the badge would be
              // dead weight; pass an empty set to suppress it.
              excludeBookIds={EMPTY_BOOK_ID_SET}
              onAddLocal={async (bookId) => {
                await addBookToPackDraftFn({ data: { packId: pack.id, bookId } });
                await reload();
              }}
              onAddHardcover={async (hardcoverId) => {
                await ingestHardcoverBookForBuilderFn({
                  data: { packId: pack.id, hardcoverId },
                });
                await reload();
              }}
            />
          )}
          <CurrentBooksPanel pack={pack} onRemoved={reload} />
        </section>
        <aside className="space-y-6">
          <CompositionPanel pack={pack} />
          {!pack.isPublic && <UnlockPanel />}
        </aside>
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

function MetadataForm({
  pack,
  onSaved,
}: {
  pack: MyPackDetail;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(pack.name);
  const [description, setDescription] = useState(pack.description ?? "");
  const [coverImageUrl, setCoverImageUrl] = useState(pack.coverImageUrl ?? "");
  const [genreTags, setGenreTags] = useState(pack.genreTags.join(", "));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Re-seed the inputs when the pack reloads (e.g. after publish flip)
  // so stale edits don't clobber the fresh server state.
  useEffect(() => {
    setName(pack.name);
    setDescription(pack.description ?? "");
    setCoverImageUrl(pack.coverImageUrl ?? "");
    setGenreTags(pack.genreTags.join(", "));
  }, [pack]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    setSaving(true);
    try {
      await updatePackDraftFn({
        data: {
          packId: pack.id,
          name: name.trim() || undefined,
          description: description.trim().length > 0 ? description.trim() : null,
          coverImageUrl: coverImageUrl.trim().length > 0 ? coverImageUrl.trim() : null,
          genreTags: genreTags
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
        },
      });
      await onSaved();
      setStatus("Saved");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="island-shell space-y-4 rounded-3xl p-5">
      <h2 className="island-kicker">Details</h2>
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          Name
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          Description
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={2000}
          className="input-field w-full rounded-2xl px-4 py-3 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          Cover image URL
        </span>
        <input
          type="url"
          value={coverImageUrl}
          onChange={(e) => setCoverImageUrl(e.target.value)}
          className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
          placeholder="https://…"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          Genre tags
        </span>
        <input
          type="text"
          value={genreTags}
          onChange={(e) => setGenreTags(e.target.value)}
          className="input-field min-h-[40px] w-full rounded-full px-4 text-sm"
          placeholder="science-fiction, space-opera"
        />
        <span className="mt-1.5 block text-[11px] text-[var(--sea-ink-soft)]">
          Up to 3, comma-separated, kebab-case.
        </span>
      </label>
      <div className="flex items-center justify-between">
        <button
          type="submit"
          disabled={saving}
          className="btn-primary rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em] disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {status && (
          <span className="text-xs text-[var(--sea-ink-soft)]">{status}</span>
        )}
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Author byline helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a compact, cap-width author byline. Hardcover hits sometimes
 * list every contributor (translators, editors, illustrators, …) which
 * produces a single comma-joined string long enough to blow past
 * `truncate`'s effective width on narrow flex items — the full string
 * still counts toward the row's min-content size even if it's clipped
 * visually, and on mobile that pushed trailing buttons off the viewport
 * edge. Showing at most one name plus a "+N more" tail keeps the line
 * short enough that truncation on the *title* is the only thing the
 * layout has to handle. Used by `CurrentBooksPanel`; the shared
 * `BookSearchPanel` has its own copy of this logic.
 */
function formatAuthors(authors: ReadonlyArray<string>): string {
  if (authors.length === 0) return "Unknown author";
  if (authors.length === 1) return authors[0]!;
  return `${authors[0]} +${authors.length - 1} more`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Current books
// ─────────────────────────────────────────────────────────────────────────────

function CurrentBooksPanel({
  pack,
  onRemoved,
}: {
  pack: MyPackDetail;
  onRemoved: () => Promise<void>;
}) {
  const onRemove = async (bookId: string) => {
    try {
      await removeBookFromPackDraftFn({ data: { packId: pack.id, bookId } });
      await onRemoved();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : "Failed to remove");
    }
  };

  return (
    <section className="island-shell rounded-3xl p-5">
      <h2 className="island-kicker mb-3">
        Books · {pack.books.length}
      </h2>
      {pack.books.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--sea-ink-soft)]">
          No books yet. Search above to add some.
        </p>
      ) : (
        <ul className="space-y-2">
          {pack.books.map((b) => (
            <li
              key={b.id}
              className="flex min-w-0 flex-wrap items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3"
            >
              {b.coverUrl ? (
                <img
                  src={b.coverUrl}
                  alt=""
                  className="h-14 w-10 shrink-0 rounded-md object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="h-14 w-10 shrink-0 rounded-md bg-[var(--surface-muted)]" />
              )}
              <div className="min-w-0 flex-1">
                <p
                  title={b.title}
                  className="line-clamp-1 text-sm font-semibold text-[var(--sea-ink)] [overflow-wrap:anywhere]"
                >
                  {b.title}
                </p>
                <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                  {formatAuthors(b.authors)} · {b.rarity}
                </p>
              </div>
              {!pack.isPublic && (
                <button
                  type="button"
                  onClick={() => void onRemove(b.id)}
                  className="shrink-0 rounded-full border border-[var(--line)] px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition meter
// ─────────────────────────────────────────────────────────────────────────────

function CompositionPanel({ pack }: { pack: MyPackDetail }) {
  // Compute client-side from the loaded pack's rarities. Server re-runs
  // the same check at publish time so this is an advisory meter only;
  // config is read from DEFAULTS here because the client doesn't
  // currently have a "get economy" endpoint — thresholds are stable
  // enough that this is acceptable for now.
  const check = useMemo(
    () =>
      checkPackComposition(
        pack.books.map((b) => b.rarity),
        DEFAULTS.packComposition,
      ),
    [pack.books],
  );

  return (
    <section className="island-shell rounded-3xl p-5">
      <h2 className="island-kicker mb-3">Composition</h2>
      <ul className="space-y-2 text-xs">
        <Meter
          label="Total books"
          have={check.counts.total}
          need={DEFAULTS.packComposition.minBooks}
        />
        <Meter
          label="Uncommon or better"
          have={check.counts.uncommonOrAbove}
          need={DEFAULTS.packComposition.minUncommonOrAbove}
        />
        <Meter
          label="Rare or better"
          have={check.counts.rareOrAbove}
          need={DEFAULTS.packComposition.minRareOrAbove}
        />
      </ul>
      <p
        className={`mt-3 text-[11px] ${
          check.ok ? "text-[var(--palm)]" : "text-[var(--sea-ink-soft)]"
        }`}
      >
        {check.ok ? "Composition looks good." : "Meet every bar above to publish."}
      </p>
    </section>
  );
}

function Meter({ label, have, need }: { label: string; have: number; need: number }) {
  const pct = Math.min(100, (have / Math.max(need, 1)) * 100);
  const met = have >= need;
  return (
    <li>
      <div className="flex items-center justify-between">
        <span className="text-[var(--sea-ink)]">{label}</span>
        <span className={met ? "text-[var(--palm)]" : "text-[var(--sea-ink-soft)]"}>
          {have}/{need}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-[var(--surface-muted)]">
        <div
          className={`h-full rounded-full ${met ? "bg-[var(--palm)]" : "bg-[var(--lagoon)]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Unlock meter (finished books)
// ─────────────────────────────────────────────────────────────────────────────

function UnlockPanel() {
  const [state, setState] = useState<{ have: number; need: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await getMyPublishUnlockFn();
        if (!cancelled) setState({ have: result.finishedBooks, need: result.threshold });
      } catch {
        // Swallow — the meter is advisory; failure to load just hides it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state) return null;
  return (
    <section className="island-shell rounded-3xl p-5">
      <h2 className="island-kicker mb-3">Publish unlock</h2>
      <ul className="space-y-2 text-xs">
        <Meter label="Books you've finished" have={state.have} need={state.need} />
      </ul>
      <p className="mt-3 text-[11px] text-[var(--sea-ink-soft)]">
        Mark books as read in your Library to raise this.
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Publish controls
// ─────────────────────────────────────────────────────────────────────────────

function PublishControls({
  pack,
  onChange,
}: {
  pack: MyPackDetail;
  onChange: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPublish = async () => {
    setError(null);
    setBusy(true);
    try {
      await publishPackFn({ data: { packId: pack.id } });
      await onChange();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Publish failed";
      // Translate the structured error prefixes into plainer strings.
      if (msg.startsWith("PUBLISH_UNLOCK:")) {
        setError("Finish more books before publishing — see the unlock meter.");
      } else if (msg.startsWith("PUBLISH_COMPOSITION:")) {
        setError("Composition doesn't meet the bar yet — see the checklist.");
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const onUnpublish = async () => {
    setError(null);
    setBusy(true);
    try {
      await unpublishPackFn({ data: { packId: pack.id } });
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unpublish failed");
    } finally {
      setBusy(false);
    }
  };

  // Native confirm() is sufficient for now — discard is rare, and a
  // bespoke modal is more weight than this action warrants. The
  // server is the source of truth on "is this a draft?", but we
  // gate the button at render time too so a published pack never
  // shows it.
  const onDiscard = async () => {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(
        `Discard "${pack.name}"? This permanently deletes the draft and its book list.`,
      );
      if (!confirmed) return;
    }
    setError(null);
    setBusy(true);
    try {
      await deletePackDraftFn({ data: { packId: pack.id } });
      // Bounce to the user's pack list — the edit URL is now invalid
      // and there's nothing useful to render here.
      await navigate({ to: "/packs" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Discard failed";
      if (msg.startsWith("DELETE_PUBLISHED:")) {
        setError("Unpublish first, then discard.");
      } else {
        setError(msg);
      }
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {/* Discard sits left of the primary action and is only
            offered on drafts. The legendary-tinted border keeps the
            destructive intent visible without making it red-on-red
            against the page background. */}
        {!pack.isPublic && (
          <button
            type="button"
            onClick={() => void onDiscard()}
            disabled={busy}
            className="rounded-full border border-[color:var(--rarity-legendary)]/40 px-4 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--rarity-legendary)] hover:bg-[color:var(--rarity-legendary-soft)] disabled:opacity-60"
          >
            Discard
          </button>
        )}
        {pack.isPublic ? (
          <button
            type="button"
            onClick={() => void onUnpublish()}
            disabled={busy}
            className="rounded-full border border-[var(--line)] px-4 py-2 text-xs uppercase tracking-[0.16em] text-[var(--sea-ink)] hover:bg-[var(--surface-muted)] disabled:opacity-60"
          >
            {busy ? "Working…" : "Unpublish"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void onPublish()}
            disabled={busy}
            className="btn-primary rounded-full px-4 py-2 text-xs uppercase tracking-[0.16em] disabled:opacity-60"
          >
            {busy ? "Publishing…" : "Publish"}
          </button>
        )}
      </div>
      {error && (
        <p className="max-w-xs text-right text-[11px] text-[color:var(--rarity-legendary)]">
          {error}
        </p>
      )}
    </div>
  );
}
