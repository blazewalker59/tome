import { useMemo, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { BookOpen, ChevronLeft, Gem, Info } from "lucide-react";
import { PackRip } from "@/components/cards/PackRip";
import { PackContentsSheet } from "@/components/PackContentsSheet";
import { useToast } from "@/components/Toast";
import { bookRowToCardData } from "@/lib/cards/book-to-card";
import { applyRip, pullPack, type PoolEntry, type RipOutcome } from "@/lib/cards/pull";
import {
  INSUFFICIENT_SHARDS_PREFIX,
  recordRipFn,
  type CollectionPayload,
  type PackPayload,
} from "@/server/collection";
import type { CardData } from "@/lib/cards/types";

/**
 * Shared rip-flow UI. Rendered by both `/rip/$slug` (editorial) and
 * `/rip/u/$username/$slug` (user-authored). Loader shape is the same
 * on both routes — `PackPayload` + `CollectionPayload` + economy — so
 * the only thing that varies is the "back" target, which the picker
 * routes own.
 *
 * Kept as a single component (not split per-section) because the
 * state machine — roll, reveal, commit, optionally reveal again —
 * is tightly interleaved and not useful to individual sections in
 * isolation.
 */
export interface EconomyView {
  packCost: number;
  shardsPerDupe: number;
}

export interface RipPackShellProps {
  pack: PackPayload;
  collection: CollectionPayload;
  economy: EconomyView;
  /** Where the "back" chip should link. Defaults to `/rip` (the
   *  editorial picker). User-pack flow passes the creator profile so
   *  the back arrow returns to the pack's public page. */
  backTo?: string;
  /** Label for the back chip, shown on ≥sm screens. */
  backLabel?: string;
}

interface RipState {
  pulledCards: CardData[];
  outcome: RipOutcome;
}

/** Roll a fresh 5-card pull using the pack's rarity-weighted pool. */
function rollRip(
  pool: ReadonlyArray<PoolEntry>,
  cardById: ReadonlyMap<string, CardData>,
  ownedBookIds: ReadonlySet<string>,
  shardsPerDupe: number,
): RipState {
  const pulls = pullPack({ pool });
  const outcome = applyRip({ pulls, ownedBookIds, shardsPerDupe });
  const pulledCards = pulls.map((p) => {
    const card = cardById.get(p.bookId);
    if (!card) throw new Error(`rollRip: missing card data for ${p.bookId}`);
    return card;
  });
  return { pulledCards, outcome };
}

export function RipPackShell({
  pack,
  collection,
  economy,
  backTo = "/rip",
  backLabel = "All packs",
}: RipPackShellProps) {
  const router = useRouter();
  const toast = useToast();

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

  // Gate the rip flow entirely when the user can't afford a pack.
  // Rolling cards only to have the server reject the commit would
  // waste the emotional beat of the reveal; blocking at page load
  // means the "need more shards" state reads as the primary thing
  // on the screen, with a clear way to earn more.
  const canAfford = collection.shardBalance >= economy.packCost;

  const [ripState, setRipState] = useState<RipState>(() =>
    // We still roll an initial rip even when the user can't afford it
    // because the component unconditionally references `ripState`
    // below; the `canAfford` branch short-circuits before anything
    // about this rolled state is rendered.
    rollRip(pool, cardById, ownedBookIds, economy.shardsPerDupe),
  );
  const [ripKey, setRipKey] = useState(0);
  const [committedKey, setCommittedKey] = useState<number | null>(null);
  const [savingError, setSavingError] = useState<string | null>(null);
  const [contentsOpen, setContentsOpen] = useState(false);

  async function handleRipComplete() {
    // Guard against StrictMode double-invokes and animation re-triggers.
    if (committedKey === ripKey) return;
    setCommittedKey(ripKey);
    setSavingError(null);
    try {
      const result = await recordRipFn({
        data: {
          packId: pack.packId,
          pulledBookIds: ripState.outcome.pulls.map((p) => p.bookId),
        },
      });

      // Surface the net shard change as a toast. We show the net
      // (refund - cost) rather than just the refund because it's
      // the number the user actually cares about — "did this rip
      // make me richer or poorer?". Skip the toast entirely on a
      // zero-dupe rip where refund == 0 and net == -packCost; the
      // summary strip on the rip screen already shows "0 dupes".
      if (result.shardsAwarded > 0) {
        const net = result.shardsAwarded - result.packCost;
        toast.push({
          title:
            result.duplicateBookIds.length === 1
              ? "1 duplicate refunded"
              : `${result.duplicateBookIds.length} duplicates refunded`,
          description:
            net >= 0
              ? `Net +${net} shards on this rip.`
              : `Net ${net} shards (pack cost ${result.packCost}).`,
          tone: "shard",
          amount: result.shardsAwarded,
        });
      }

      // Refresh the loader so the next render sees the new collection.
      await router.invalidate();
    } catch (err) {
      // Surface failures but don't block the animation — the user has
      // already seen the cards. Retry is implicit on "Rip another".
      console.error("[rip] recordRip failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith(INSUFFICIENT_SHARDS_PREFIX)) {
        setSavingError(
          "Not enough shards to commit this rip. Finish a book or start one to earn more.",
        );
      } else {
        setSavingError("We couldn't save that rip. Try again.");
      }
    }
  }

  function handleRipAnother() {
    setRipState(rollRip(pool, cardById, ownedBookIds, economy.shardsPerDupe));
    setRipKey((k) => k + 1);
  }

  const { outcome } = ripState;

  return (
    <main className="viewport-stage">
      <header className="relative px-4 pt-3 pb-2 text-center sm:pt-5 sm:pb-3">
        {/* Back link. Absolutely positioned so the pack name below
            remains visually centered regardless of the link's width;
            on mobile it sits as a pure icon to claim minimal space.
            `backTo` is a plain string href (not a typed Link `to`)
            so this component can serve both editorial and user-pack
            flows without knowing the route catalog. */}
        <a
          href={backTo}
          aria-label={`Back to ${backLabel.toLowerCase()}`}
          className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] no-underline hover:text-[var(--sea-ink)] sm:left-4 sm:px-3 sm:py-1.5"
        >
          <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{backLabel}</span>
        </a>

        {/* Info chip — mirrors the back-link chip on the opposite edge.
            Opens a bottom sheet showing every book in the pack grouped
            by rarity, so the user can see what they're rolling into
            before committing a rip. */}
        <button
          type="button"
          onClick={() => setContentsOpen(true)}
          aria-label="See what's in this pack"
          className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] sm:right-4 sm:px-3 sm:py-1.5"
        >
          <Info aria-hidden className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Contents</span>
        </button>

        <p className="island-kicker">{pack.name}</p>
        {/* Header stats strip. Shows the two numbers the user needs to
            decide whether to rip: what this pack costs, and how many
            shards they currently have. Dropped the "Owned" book count
            — it's not part of the decision here and clutters the
            header. Balance turns red when they can't afford the pack
            so the reason for the gate below is obvious at a glance. */}
        <div className="mt-1 flex items-center justify-center gap-3 text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          <span className="inline-flex items-center gap-1.5">
            Cost
            <span className="inline-flex items-center gap-1 text-[var(--sea-ink)]">
              {economy.packCost}
              <Gem aria-hidden className="h-3.5 w-3.5" />
            </span>
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1.5">
            Balance
            <span
              className={`inline-flex items-center gap-1 ${
                canAfford
                  ? "text-[var(--sea-ink)]"
                  : "text-[color:var(--rarity-legendary)]"
              }`}
            >
              {collection.shardBalance}
              <Gem aria-hidden className="h-3.5 w-3.5" />
            </span>
          </span>
        </div>
      </header>

      {canAfford ? (
        <PackRip
          key={ripKey}
          cards={ripState.pulledCards}
          packName={pack.name}
          packSlug={pack.slug}
          packGenreTags={pack.genreTags}
          packCoverImageUrl={pack.coverImageUrl}
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
      ) : (
        <InsufficientShardsState
          shardBalance={collection.shardBalance}
          packCost={economy.packCost}
        />
      )}

      <PackContentsSheet
        open={contentsOpen}
        onClose={() => setContentsOpen(false)}
        packName={pack.name}
        books={pack.books}
        subheadSuffix="Each rip draws 5"
      />
    </main>
  );
}

/**
 * Shown in place of the rip flow when the user doesn't have enough
 * shards to commit. Frames the shortage as a next-action ("keep
 * reading to earn more") rather than a dead-end. The two CTAs map
 * to the two ways a user can actually earn shards right now: mark
 * a book as reading/read, or browse the library to find something
 * to start.
 */
function InsufficientShardsState({
  shardBalance,
  packCost,
}: {
  shardBalance: number;
  packCost: number;
}) {
  const shortfall = Math.max(0, packCost - shardBalance);
  return (
    <section className="px-4 pt-8 pb-16 sm:pt-12">
      <div className="mx-auto max-w-md">
        <div className="island-shell rounded-3xl p-6 text-center sm:p-8">
          <div className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--rarity-legendary-soft)] text-[color:var(--rarity-legendary)]">
            <Gem aria-hidden className="h-6 w-6" />
          </div>
          <p className="island-kicker">Not enough shards</p>
          <h2 className="display-title mt-2 text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
            You need {shortfall} more to rip this pack
          </h2>
          <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
            Shards are earned by reading. Mark a book as{" "}
            <em>reading</em> for a small boost, and finishing a book
            pays out a full pack's worth.
          </p>

          {/* Balance vs cost, shown numerically so the gap isn't
              ambiguous. Tabular numerals so the two rows line up. */}
          <dl className="mt-5 grid grid-cols-2 gap-3 text-xs tabular-nums">
            <div className="rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-2">
              <dt className="uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">You have</dt>
              <dd className="mt-1 text-lg font-semibold text-[var(--sea-ink)]">{shardBalance}</dd>
            </div>
            <div className="rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-2">
              <dt className="uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">Pack cost</dt>
              <dd className="mt-1 text-lg font-semibold text-[var(--sea-ink)]">{packCost}</dd>
            </div>
          </dl>

          <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
            <Link
              to="/library/collection"
              className="btn-primary w-full rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em] sm:w-auto"
            >
              <BookOpen aria-hidden className="mr-1.5 inline-block h-4 w-4" />
              Go read
            </Link>
            <Link
              to="/rip"
              className="btn-secondary w-full rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em] sm:w-auto"
            >
              Back to packs
            </Link>
          </div>
        </div>
      </div>
    </section>
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
