import { useState, useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { motion, type PanInfo } from "motion/react";
import { getRipPacksFn, getShardBalanceFn, type PackSummary } from "@/server/collection";
import { packGradient, packBoxShadow } from "@/lib/packs/gradient";

/**
 * /rip — pack picker.
 *
 * Top-level layer of the two-layer rip flow. Shows every editorial pack
 * as a carousel with the active pack centered and neighboring packs
 * peeking in from either side. Tapping the center pack navigates to
 * `/rip/$slug` for the tear-open experience.
 *
 * Public: anonymous users can browse the catalog; auth is enforced
 * only at /rip/$slug when they try to actually open a pack. This
 * matches the "see what's available before signing up" product intent
 * without letting anons burn state.
 *
 * Minimum slot count is padded with placeholders so the carousel's
 * peek-in framing still reads when only one pack exists. That'll
 * happen often early in the app's life.
 */
export const Route = createFileRoute("/rip/")({
  loader: async () => {
    const [packs, shardInfo] = await Promise.all([getRipPacksFn(), getShardBalanceFn()]);
    return { packs, shards: shardInfo?.shards ?? null };
  },
  component: RipPickerPage,
});

// Minimum slots the carousel renders. With < MIN_SLOTS packs we fill
// the tail with "coming soon" placeholders so the active pack always
// has a neighbor visible — the peek-in framing is the whole point of
// the carousel, and it falls apart with one item on a black stage.
const MIN_SLOTS = 3;

type Slot = { kind: "pack"; pack: PackSummary } | { kind: "placeholder"; id: string };

function RipPickerPage() {
  const { packs, shards } = Route.useLoaderData();
  const navigate = useNavigate();
  const [activeIndex, setActiveIndex] = useState(0);

  // Slots = real packs + placeholders padded to MIN_SLOTS. Stable ids
  // on placeholders so motion layout effects have a key to track.
  const slots = useMemo<Slot[]>(() => {
    const real = packs.map<Slot>((pack) => ({ kind: "pack", pack }));
    const padded = [...real];
    let i = 0;
    while (padded.length < MIN_SLOTS) {
      padded.push({ kind: "placeholder", id: `placeholder-${i++}` });
    }
    return padded;
  }, [packs]);

  function gotoDelta(delta: number) {
    const next = Math.max(0, Math.min(slots.length - 1, activeIndex + delta));
    setActiveIndex(next);
  }

  function handlePanEnd(_: unknown, info: PanInfo) {
    // Threshold-gated swipe navigation. Matches the feel of the
    // post-rip card reveal (same module uses the same thresholds) so
    // users get a consistent gesture vocabulary across the flow.
    const distance = Math.abs(info.offset.x) > 60;
    const velocity = Math.abs(info.velocity.x) > 400;
    if (distance || velocity) {
      gotoDelta(info.offset.x < 0 ? 1 : -1);
    }
  }

  function openActive() {
    const active = slots[activeIndex];
    if (active?.kind !== "pack") return;
    navigate({ to: "/rip/$slug", params: { slug: active.pack.slug } });
  }

  const activeSlot = slots[activeIndex];

  return (
    <main className="viewport-stage">
      <header className="px-4 pt-3 pb-2 text-center sm:pt-5 sm:pb-3">
        <p className="island-kicker">Rip a pack</p>
        <h1 className="mt-1 display-title text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
          Choose your pack
        </h1>
        {shards !== null && (
          <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
            Shards <span className="text-[var(--sea-ink)]">{shards}</span>
          </p>
        )}
      </header>

      {/* Stage. `onPanEnd` on the outer wrapper handles swipe
          navigation; motion's built-in tap-vs-pan heuristic has a ~3px
          movement threshold, so small taps fall through to the
          child buttons cleanly. We kept the animation transform on a
          plain `motion.div` (not `motion.button`) for each pack so
          `disabled` attribute flipping can't interrupt in-flight
          clicks. */}
      <motion.div
        className="relative flex min-h-0 flex-1 items-center justify-center touch-none select-none"
        onPanEnd={handlePanEnd}
      >
        <div className="relative h-full w-full">
          {slots.map((slot, idx) => (
            <PackCarouselItem
              key={slot.kind === "pack" ? slot.pack.id : slot.id}
              slot={slot}
              offset={idx - activeIndex}
              onClick={() => {
                if (idx === activeIndex) openActive();
                else setActiveIndex(idx);
              }}
            />
          ))}
        </div>
      </motion.div>

      {/* Pack metadata under the carousel — only shown for real packs.
          Placeholder stays visual-only to keep the "more coming" vibe
          without advertising an empty name. */}
      <div className="px-4 pb-3 text-center">
        {activeSlot?.kind === "pack" ? (
          <>
            <h2 className="text-base font-semibold text-[var(--sea-ink)]">
              {activeSlot.pack.name}
            </h2>
            {activeSlot.pack.description && (
              <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
                {activeSlot.pack.description}
              </p>
            )}
            <p className="mt-2 text-[10px] uppercase tracking-[0.18em] text-[var(--sea-ink-soft)]">
              {activeSlot.pack.bookCount} books sealed
            </p>
            <Link
              to="/rip/$slug"
              params={{ slug: activeSlot.pack.slug }}
              className="btn-primary mt-3 inline-flex w-full max-w-[320px] items-center justify-center rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em] sm:w-auto"
            >
              Open pack
            </Link>
          </>
        ) : (
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--sea-ink-soft)]">
            More packs coming soon
          </p>
        )}
      </div>

      {/* Pagination dots. Cheap orientation cue; only rendered if we
          have at least one real pack (placeholders aren't navigable
          destinations, but they count as slots so user doesn't feel
          the carousel "jumps" past them). */}
      {slots.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 pb-4">
          {slots.map((slot, idx) => (
            <button
              key={slot.kind === "pack" ? slot.pack.id : slot.id}
              type="button"
              aria-label={
                slot.kind === "pack" ? `Go to ${slot.pack.name}` : `Upcoming pack ${idx + 1}`
              }
              onClick={() => setActiveIndex(idx)}
              className={`h-1.5 rounded-full transition-all ${
                idx === activeIndex
                  ? "w-6 bg-[var(--sea-ink)]"
                  : "w-1.5 bg-[var(--sea-ink-soft)]/50"
              }`}
            />
          ))}
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Carousel item

interface PackCarouselItemProps {
  slot: Slot;
  /** Position relative to active: 0 = center, -1 = one slot left, etc. */
  offset: number;
  onClick: () => void;
}

/**
 * A single pack in the carousel. Absolutely positioned in the stage;
 * scale/opacity/translate driven entirely by `offset` so the parent
 * just needs to swap the active index to animate the whole carousel
 * into its new configuration. Motion's spring on the `animate` target
 * produces the physics feel for the peek-in effect.
 *
 * We split animation from interactivity: an outer `motion.div` owns
 * the transform/opacity spring, and an inner plain `<button>` owns
 * the click. Mixing `motion.button` with a pan-enabled parent made
 * fast taps get swallowed as micro-pans; keeping them as separate
 * elements avoids that race and also sidesteps the `disabled`-
 * attribute-flipping-mid-click issue on far-off slots.
 */
function PackCarouselItem({ slot, offset, onClick }: PackCarouselItemProps) {
  // Neighboring packs sit ~55% of their own width away from center,
  // with aggressive scale falloff so 2+ steps away fade almost to
  // nothing. Keeps the composition readable at small screen widths
  // without the carousel sprawling.
  const abs = Math.abs(offset);
  const scale = abs === 0 ? 1 : abs === 1 ? 0.68 : abs === 2 ? 0.5 : 0.4;
  const opacity = abs === 0 ? 1 : abs === 1 ? 0.55 : abs === 2 ? 0.25 : 0;
  const x = `${offset * 55}%`;
  // Slight y-drop on off-center items so they read as "behind" the
  // active pack without needing a real 3D transform.
  const y = abs === 0 ? 0 : 8 * abs;
  // Far-off slots stop receiving pointer events so the scaled-down
  // packs on the edges don't intercept taps aimed at the center or
  // its direct neighbors.
  const interactive = abs <= 1;

  return (
    <motion.div
      className="absolute top-1/2 left-1/2"
      initial={false}
      animate={{
        x: `calc(-50% + ${x})`,
        y: `calc(-50% + ${y}px)`,
        scale,
        opacity,
        zIndex: 10 - abs,
      }}
      transition={{ type: "spring", stiffness: 260, damping: 28, mass: 0.9 }}
      style={{
        // Viewport-based width, not container-query units — the stage
        // isn't a container-query context so `cqw` collapses to 0 and
        // the pack renders at zero width (invisible tap target). This
        // was the "click does nothing" bug.
        width: "min(60vw, 220px)",
        aspectRatio: "2 / 3",
        pointerEvents: interactive ? "auto" : "none",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-hidden={!interactive}
        tabIndex={interactive ? 0 : -1}
        className="block h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--lagoon)] rounded-2xl"
      >
        {/* Inner wrapper carries the idle wobble loop. Only the active
            pack animates — off-center packs stay still so the stage
            reads as "this is the one that's live", and the whole
            carousel doesn't jitter when neighbors are visible.
            Matches the wobble on /rip/$slug's idle pack (same rotate
            amplitude, period, and easing) so the visual handoff from
            picker → opener is seamless. Kept as a separate
            motion.div from the outer positioning spring so the two
            animations don't fight. */}
        <motion.div
          className="h-full w-full"
          animate={
            abs === 0
              ? { rotate: [-2, 2, -2], y: [0, -4, 0] }
              : { rotate: 0, y: 0 }
          }
          transition={
            abs === 0
              ? { duration: 4, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.3 }
          }
        >
          {slot.kind === "pack" ? (
            <PackPreview pack={slot.pack} active={abs === 0} />
          ) : (
            <PackPlaceholder />
          )}
        </motion.div>
      </button>
    </motion.div>
  );
}

/**
 * Miniature sealed-pack preview. Visually mirrors the full-size pack
 * used on /rip/$slug's idle state so the handoff feels seamless —
 * same lagoon→palm gradient, same sparkle overlay, same typography.
 * When `active`, a diagonal shimmer sweeps across the surface on a
 * slow loop with a long pause between passes, making the centered
 * pack feel alive without dominating the stage.
 * No tear interaction here; tapping just selects/navigates.
 */
function PackPreview({ pack, active }: { pack: PackSummary; active: boolean }) {
  const gradient = packGradient(pack.slug, pack.genreTags);
  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-2xl shadow-2xl"
      style={{
        background: gradient.background,
        boxShadow: packBoxShadow(gradient),
      }}
    >
      <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_30%_20%,white,transparent_45%),radial-gradient(circle_at_70%_80%,white,transparent_45%)]" />
      {/* Pack cover art (when set) sits above the gradient at reduced
          opacity to preserve the brand feel; the name is printed over
          it regardless. */}
      {pack.coverImageUrl && (
        <img
          src={pack.coverImageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-40 mix-blend-overlay"
        />
      )}

      {/* Shimmer sweep. A narrow diagonal highlight band travels
          from the top-left edge to the bottom-right, offscreen-to-
          offscreen, then pauses for most of the loop. Renders only
          when `active` so dormant carousel neighbours stay calm; the
          parent rounded-2xl + overflow-hidden clips it to the pack
          silhouette. Tuned to read as light grazing a real foil
          surface — narrow band, low peak opacity, soft falloff,
          and `soft-light` blending so it tints the underlying
          gradient instead of painting a white stripe on top. */}
      {active && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            // Wider band (~24% of the sweep's travel) with long,
            // feathered tails. Peak alpha kept low (0.18) so the
            // highlight suggests sheen rather than spotlight.
            background:
              "linear-gradient(115deg, transparent 38%, rgba(255,255,255,0.06) 44%, rgba(255,255,255,0.18) 50%, rgba(255,255,255,0.06) 56%, transparent 62%)",
            mixBlendMode: "soft-light",
          }}
          initial={{ x: "-120%" }}
          animate={{ x: ["-120%", "120%"] }}
          transition={{
            // 3.3s sweep, 5.7s rest, 9s total cycle. Long enough that
            // the shimmer feels deliberate — a slow gleam catching
            // the foil rather than a flickering strobe.
            duration: 9,
            times: [0, 0.37],
            ease: "easeInOut",
            repeat: Infinity,
            repeatDelay: 0,
          }}
        />
      )}

      <div className="relative flex h-full flex-col items-center justify-center p-5 text-center text-[var(--on-accent)]">
        <div>
          <h3 className="display-title text-lg font-bold leading-tight">{pack.name}</h3>
          <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-[var(--on-accent)]/70">
            {pack.bookCount} books · sealed
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Placeholder slot. Dashed border + muted palette signals "something
 * will be here" without promising anything specific. Fills the
 * carousel to MIN_SLOTS so the peek-in framing still reads with a
 * single real pack.
 */
function PackPlaceholder() {
  return (
    <div
      className="flex h-full w-full items-center justify-center rounded-2xl border-2 border-dashed text-center text-[var(--sea-ink-soft)]"
      style={{
        borderColor: "color-mix(in oklab, var(--sea-ink-soft) 60%, transparent)",
        background: "color-mix(in oklab, var(--surface) 40%, transparent)",
      }}
    >
      <p className="px-4 text-[10px] uppercase tracking-[0.18em]">Coming soon</p>
    </div>
  );
}
