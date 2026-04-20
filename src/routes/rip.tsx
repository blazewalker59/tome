import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { PackRip } from "@/components/cards/PackRip";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import { applyRip, pullPack, type PoolEntry, type RipOutcome } from "@/lib/cards/pull";
import { getCollectionFn, getEditorialPackFn, recordRipFn } from "@/server/collection";
import type { CardData } from "@/lib/cards/types";

/**
 * Rip route.
 *
 * Loader runs on the server during SSR (and on the client for subsequent
 * navigations). Redirects anonymous users to sign-in because rips have
 * to persist to be meaningful. The pack itself is public, but the whole
 * value proposition of /rip is building a collection.
 */
export const Route = createFileRoute("/rip")({
  loader: async () => {
    const [pack, collection] = await Promise.all([getEditorialPackFn(), getCollectionFn()]);
    if (!collection) {
      throw redirect({ to: "/sign-in" });
    }
    return { pack, collection };
  },
  component: RipPage,
});

interface RipState {
  pulledCards: CardData[];
  outcome: RipOutcome;
}

/** Roll a fresh 5-card pull using the pack's rarity-weighted pool. */
function rollRip(
  pool: ReadonlyArray<PoolEntry>,
  cardById: ReadonlyMap<string, CardData>,
  ownedBookIds: ReadonlySet<string>,
): RipState {
  const pulls = pullPack({ pool });
  const outcome = applyRip({ pulls, ownedBookIds });
  const pulledCards = pulls.map((p) => {
    const card = cardById.get(p.bookId);
    if (!card) throw new Error(`rollRip: missing card data for ${p.bookId}`);
    return card;
  });
  return { pulledCards, outcome };
}

function RipPage() {
  const { pack, collection } = Route.useLoaderData();
  const router = useRouter();

  // Memoise pool + lookup map derived from server data so re-rolls don't
  // re-compute them on every "Rip another" click.
  const { pool, cardById } = useMemo(() => {
    const cards = pack.books.map(bookRowToCardData);
    return {
      pool: cards.map<PoolEntry>((c) => ({ bookId: c.id, rarity: c.rarity })),
      cardById: new Map(cards.map((c) => [c.id, c])),
    };
  }, [pack.books]);

  const ownedBookIds = useMemo(() => new Set(collection.ownedBookIds), [collection.ownedBookIds]);

  const [ripState, setRipState] = useState<RipState>(() => rollRip(pool, cardById, ownedBookIds));
  const [ripKey, setRipKey] = useState(0);
  const [committedKey, setCommittedKey] = useState<number | null>(null);
  const [savingError, setSavingError] = useState<string | null>(null);

  async function handleRipComplete() {
    // Guard against StrictMode double-invokes and animation re-triggers.
    if (committedKey === ripKey) return;
    setCommittedKey(ripKey);
    setSavingError(null);
    try {
      await recordRipFn({
        data: {
          packId: pack.packId,
          pulledBookIds: ripState.outcome.pulls.map((p) => p.bookId),
        },
      });
      // Refresh the loader so the next render sees the new collection.
      await router.invalidate();
    } catch (err) {
      // Surface failures but don't block the animation — the user has
      // already seen the cards. Retry is implicit on "Rip another".
      console.error("[rip] recordRip failed:", err);
      setSavingError(
        err instanceof Error ? err.message : "We couldn't save that rip. Try again.",
      );
    }
  }

  function handleRipAnother() {
    setRipState(rollRip(pool, cardById, ownedBookIds));
    setRipKey((k) => k + 1);
  }

  const { outcome } = ripState;

  return (
    <main className="viewport-stage">
      <header className="px-4 pt-3 pb-2 text-center sm:pt-5 sm:pb-3">
        <p className="island-kicker">{pack.name}</p>
        <div className="mt-1 flex items-center justify-center gap-3 text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          <span>
            Owned <span className="text-[var(--sea-ink)]">{collection.ownedBookIds.length}</span>
          </span>
          <span aria-hidden>·</span>
          <span>
            Shards <span className="text-[var(--sea-ink)]">{collection.shardBalance}</span>
          </span>
        </div>
      </header>

      <PackRip
        key={ripKey}
        cards={ripState.pulledCards}
        packName={pack.name}
        onComplete={handleRipComplete}
        onRipAnother={handleRipAnother}
        summary={
          <RipSummary
            shardsEarned={outcome.shardsEarned}
            newCount={outcome.newCards.length}
            duplicateCount={outcome.duplicates.length}
            error={savingError}
          />
        }
      />
    </main>
  );
}

function RipSummary({
  shardsEarned,
  newCount,
  duplicateCount,
  error,
}: {
  shardsEarned: number;
  newCount: number;
  duplicateCount: number;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] uppercase tracking-[0.16em]">
        <span className="rounded-full border border-[color:var(--rarity-legendary)]/40 bg-[color:var(--rarity-legendary-soft)] px-3 py-1 text-[color:var(--rarity-legendary)]">
          Save failed — {error}
        </span>
      </div>
    );
  }
  if (newCount === 0 && duplicateCount === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] uppercase tracking-[0.16em]">
      <span className="rounded-full border border-[color:var(--rarity-uncommon)]/40 bg-[color:var(--rarity-uncommon-soft)] px-3 py-1 text-[color:var(--rarity-uncommon)]">
        {newCount} new
      </span>
      <span className="rounded-full border border-[color:var(--rarity-common)]/40 bg-[color:var(--rarity-common-soft)] px-3 py-1 text-[color:var(--rarity-common)]">
        {duplicateCount} dupe{duplicateCount === 1 ? "" : "s"}
      </span>
      {shardsEarned > 0 && (
        <span className="rounded-full border border-[color:var(--rarity-rare)]/40 bg-[color:var(--rarity-rare-soft)] px-3 py-1 text-[color:var(--rarity-rare)]">
          +{shardsEarned} shards
        </span>
      )}
    </div>
  );
}
