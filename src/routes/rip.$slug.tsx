import { useMemo, useState } from "react";
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { PackRip } from "@/components/cards/PackRip";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import { applyRip, pullPack, type PoolEntry, type RipOutcome } from "@/lib/cards/pull";
import { getCollectionFn, getPackBySlugFn, recordRipFn } from "@/server/collection";
import type { CardData } from "@/lib/cards/types";

/**
 * /rip/$slug — the tear-open experience for a specific pack.
 *
 * The picker lives at /rip and navigates here once the user selects a
 * pack. We split the flow in two routes (picker list vs. open flow) so
 * each URL is shareable and so the open flow doesn't have to carry the
 * picker's carousel state. Auth is enforced only at this level: anons
 * can browse the picker but have to sign in to actually commit a rip,
 * which matches the "collection is the value" product framing.
 */
export const Route = createFileRoute("/rip/$slug")({
  loader: async ({ params }) => {
    const [pack, collection] = await Promise.all([
      getPackBySlugFn({ data: { slug: params.slug } }),
      getCollectionFn(),
    ]);
    if (!collection) {
      // Stash the pack slug on the sign-in URL so we can bounce back
      // after auth. (sign-in's redirect handling can wire this up
      // later; for now a plain redirect preserves the product flow.)
      throw redirect({ to: "/sign-in" });
    }
    return { pack, collection };
  },
  component: RipPackPage,
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

function RipPackPage() {
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
      <header className="relative px-4 pt-3 pb-2 text-center sm:pt-5 sm:pb-3">
        {/* Back link to the picker. Absolutely positioned so the
            pack name below remains visually centered regardless of
            the link's width; on mobile it sits as a pure icon to
            claim minimal space. The route is `/rip` (the layout
            index) so we're always popping out to the carousel, not
            relying on history which might not contain it (e.g. a
            deep link straight to /rip/$slug). */}
        <Link
          to="/rip"
          aria-label="Back to all packs"
          className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] no-underline hover:text-[var(--sea-ink)] sm:left-4 sm:px-3 sm:py-1.5"
        >
          <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">All packs</span>
        </Link>

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
