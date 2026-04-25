import { useState, useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { motion, type PanInfo } from "motion/react";
import { Sparkles } from "lucide-react";
import { getRipPacksFn, getShardBalanceFn, type PackSummary } from "@/server/collection";
import { packGradient, packBoxShadow } from "@/lib/packs/gradient";

/**
 * /rip — rip hub.
 *
 * Top-level entry to the rip flow, structured as a hub of curated
 * sections rather than a single full-bleed carousel:
 *
 *   1. Editor's picks — swipe carousel of editorial packs. Tapping
 *      the centered pack navigates to `/rip/$slug` for the tear-open
 *      experience.
 *   2. Recently shared by community — same carousel mechanics, but
 *      every slot is a placeholder. No server fn exists yet for
 *      listing public user packs; the section is scaffolded with
 *      dashed tiles + a "start building" link to /packs/new so the
 *      design slot is real (and sized correctly) the day the data
 *      arrives. When that fn ships the slots-builder feeds real
 *      pack rows into PackCarousel and the placeholder branch is
 *      dropped.
 *
 * Both carousels share `PackCarousel` so swipe physics, tap-vs-pan
 * heuristics, peek-in framing, and pagination dots stay identical
 * across sections. Per-section concerns (active-pack metadata, CTA,
 * navigation target) are passed in as render/callback props.
 *
 * Public: anonymous users can browse both sections; auth is enforced
 * only at /rip/$slug when they try to actually open a pack. This
 * matches the "see what's available before signing up" product intent
 * without letting anons burn state.
 *
 * Editorial slot count is padded with placeholders to MIN_SLOTS so
 * the carousel's peek-in framing still reads when only one real pack
 * exists — common early in the app's life.
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

  // Editorial slots = real packs + placeholders padded to MIN_SLOTS.
  // Stable ids on placeholders so motion layout effects have a key
  // to track.
  const editorialSlots = useMemo<Slot[]>(() => {
    const real = packs.map<Slot>((pack) => ({ kind: "pack", pack }));
    const padded = [...real];
    let i = 0;
    while (padded.length < MIN_SLOTS) {
      padded.push({ kind: "placeholder", id: `placeholder-${i++}` });
    }
    return padded;
  }, [packs]);

  // Community slots = all placeholders for now. Sized intentionally
  // (5) so the carousel has visible neighbours on either side of the
  // centered tile — same peek-in framing as editorial. When the
  // user-pack feed lands these become real rows.
  const communitySlots = useMemo<Slot[]>(
    () =>
      Array.from({ length: 5 }, (_, i) => ({
        kind: "placeholder",
        id: `community-${i}`,
      })),
    [],
  );

  return (
    // Hub layout: pinned to the viewport between header and bottom
    // nav (via `viewport-stage`) with an inner scroll container for
    // section content. Document-level scrolling was the original
    // approach but broke the mobile PWA layout — the fixed-position
    // bottom nav bar sat at body bottom rather than visible-viewport
    // bottom because the page exceeded the visible area, so users
    // had to scroll past content *and* nav. Pinning the page and
    // scrolling internally guarantees the nav stays anchored to the
    // device edge while the carousels remain reachable.
    <main className="viewport-stage">
      <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
        <div className="page-wrap space-y-8 px-4 pb-10 pt-6 sm:space-y-10 sm:pt-10">
          <header className="text-center">
        {/* Single h1 — dropped the "Rip a pack" kicker because it just
            restated what the h1 already says. "Choose your pack" is
            the action, that's all the framing the page needs. */}
        <h1 className="display-title text-xl font-bold text-[var(--sea-ink)] sm:text-2xl">
          Choose your pack
        </h1>
        {shards !== null && (
          // "Balance" reads as a spendable currency amount without
          // needing a verb. Icon matches the profile dropdown +
          // /rip/$slug header so the glyph consistently means shards.
          <p className="mt-1 inline-flex items-center justify-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
            Balance
            <span className="inline-flex items-center gap-1 tabular-nums text-[var(--sea-ink)]">
              {shards}
              <Sparkles aria-hidden className="h-3.5 w-3.5 text-[var(--lagoon)]" />
            </span>
          </p>
        )}
      </header>

      {/* ----- Editor's picks ----- */}
      <section aria-labelledby="rip-editorial-heading">
        <SectionHeading id="rip-editorial-heading" kicker="Curated by Tome">
          Editor&rsquo;s picks
        </SectionHeading>

        <PackCarousel
          slots={editorialSlots}
          // Tapping the active pack opens the tear-flow. Tapping a
          // neighbour just selects it (handled internally by
          // PackCarousel — this callback only fires on active taps).
          onActivate={(slot) => {
            if (slot.kind !== "pack") return;
            navigate({ to: "/rip/$slug", params: { slug: slot.pack.slug } });
          }}
          renderMetadata={(slot) =>
            slot.kind === "pack" ? (
              <>
                <h3 className="text-base font-semibold text-[var(--sea-ink)]">
                  {slot.pack.name}
                </h3>
                {slot.pack.description && (
                  <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
                    {slot.pack.description}
                  </p>
                )}
                <p className="mt-2 text-[10px] uppercase tracking-[0.18em] text-[var(--sea-ink-soft)]">
                  {slot.pack.bookCount} books sealed
                </p>
                <Link
                  to="/rip/$slug"
                  params={{ slug: slot.pack.slug }}
                  className="btn-primary mt-3 inline-flex w-full max-w-[320px] items-center justify-center rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em] sm:w-auto"
                >
                  Open pack
                </Link>
              </>
            ) : (
              <p className="text-xs uppercase tracking-[0.18em] text-[var(--sea-ink-soft)]">
                More packs coming soon
              </p>
            )
          }
        />
      </section>

      {/* ----- Recently shared by community ----- */}
      <section aria-labelledby="rip-community-heading">
        <SectionHeading id="rip-community-heading" kicker="Coming soon">
          Recently shared by community
        </SectionHeading>

        {/* Same carousel, all-placeholder slots, smaller stage so it
            visually subordinates to editorial without losing the
            peek-in framing. No metadata renderer — the trailing
            "start building" link below is the section's CTA. */}
        <PackCarousel
          slots={communitySlots}
          stageHeight="clamp(300px, 44vh, 380px)"
          tileWidth="min(48vw, 180px)"
        />

        <p className="mt-4 text-center text-xs text-[var(--sea-ink-soft)]">
          User-built packs will land here soon. Want to make one?{" "}
          <Link
            to="/packs/new"
            className="font-medium text-[var(--sea-ink)] underline decoration-dotted underline-offset-2"
          >
            Start building
          </Link>
          .
        </p>
        </section>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Section heading

/**
 * Shared heading style for hub sections. Kicker on top, big title
 * underneath. Mirrors the framing used elsewhere in the app (home
 * hero, library shelves) so the hub doesn't introduce a third text
 * vocabulary.
 */
function SectionHeading({
  id,
  kicker,
  children,
}: {
  id?: string;
  kicker?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 px-1 text-center sm:text-left">
      {kicker && <p className="island-kicker">{kicker}</p>}
      <h2
        id={id}
        className="mt-1 display-title text-lg font-bold text-[var(--sea-ink)] sm:text-xl"
      >
        {children}
      </h2>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PackCarousel
//
// Reusable swipeable carousel: peek-in framing, dot pagination,
// optional metadata strip below the active tile. Both the editorial
// and community sections render through this so swipe physics and
// visual language stay identical across the hub.
//
// Each instance owns its own activeIndex; sections are independent
// and don't share the swipe pointer. `onActivate` fires when the
// user taps the *centered* tile — neighbours just shift focus to
// themselves and never trigger activation. That keeps the gesture
// vocabulary simple: tap-to-select for off-center, tap-to-open for
// center.

interface PackCarouselProps {
  slots: Slot[];
  /**
   * Called when the centered slot is tapped. Receives the slot so the
   * parent can branch on `kind` — placeholder taps are surfaced too,
   * but the editorial section ignores them (and community has no
   * activation target yet). If unset, taps on the centered tile are
   * a no-op.
   */
  onActivate?: (slot: Slot) => void;
  /**
   * Optional metadata block rendered below the carousel + dots.
   * Receives the currently centered slot so the consumer can branch
   * on real-pack vs placeholder. Editorial uses this for the
   * name/description/CTA; community omits it.
   */
  renderMetadata?: (slot: Slot) => React.ReactNode;
  /** CSS height for the carousel stage. Defaults to the editorial size. */
  stageHeight?: string;
  /** Per-tile width passed through to PackCarouselItem. */
  tileWidth?: string;
}

function PackCarousel({
  slots,
  onActivate,
  renderMetadata,
  stageHeight = "clamp(380px, 56vh, 480px)",
  tileWidth = "min(60vw, 220px)",
}: PackCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);

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

  const activeSlot = slots[activeIndex];

  return (
    <>
      {/* Stage. Fixed-height so the carousel composes with the rest
          of the page rather than swallowing the viewport. clamp keeps
          it readable on short phones without sprawling on tablets.
          `onPanEnd` handles swipe nav; motion's tap-vs-pan heuristic
          (~3px) lets small taps reach child buttons. Animation
          transforms live on `motion.div` (not `motion.button`) so
          `disabled` flipping mid-tap can't kill in-flight clicks.
          `touch-pan-y` (not `touch-none`) leaves vertical scrolling
          to the browser so users can scroll past the carousel to the
          next section. `touch-none` was correct on the old
          full-viewport layout but broke page scroll once /rip became
          a multi-section hub — vertical drags starting on the stage
          got eaten by motion's pan handler instead of scrolling the
          page, leaving the bottom-tab-overlapped content unreachable.
          `overflow-hidden` clips the absolutely-positioned off-center
          tiles whose `left: 50%` + negative-x transforms otherwise
          push past the viewport edge, letting the user pan the
          document horizontally. */}
      <motion.div
        className="relative flex items-center justify-center overflow-hidden touch-pan-y select-none"
        style={{ height: stageHeight }}
        onPanEnd={handlePanEnd}
      >
        <div className="relative h-full w-full">
          {slots.map((slot, idx) => (
            <PackCarouselItem
              key={slot.kind === "pack" ? slot.pack.id : slot.id}
              slot={slot}
              offset={idx - activeIndex}
              tileWidth={tileWidth}
              onClick={() => {
                if (idx === activeIndex) onActivate?.(slot);
                else setActiveIndex(idx);
              }}
            />
          ))}
        </div>
      </motion.div>

      {/* Pagination dots. Cheap orientation cue; rendered for any
          carousel with multiple slots — placeholders count too, since
          they're real swipeable destinations within the section. */}
      {slots.length > 1 && (
        <div className="mt-2 flex items-center justify-center gap-1.5">
          {slots.map((slot, idx) => (
            <button
              key={slot.kind === "pack" ? slot.pack.id : slot.id}
              type="button"
              aria-label={
                slot.kind === "pack"
                  ? `Go to ${slot.pack.name}`
                  : `Upcoming pack ${idx + 1}`
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

      {/* Optional metadata block — editorial uses it for name/CTA;
          community omits it. Rendered only when both a renderer and a
          slot exist so we don't paint an empty centered div. */}
      {renderMetadata && activeSlot && (
        <div className="mt-4 text-center">{renderMetadata(activeSlot)}</div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Carousel item

interface PackCarouselItemProps {
  slot: Slot;
  /** Position relative to active: 0 = center, -1 = one slot left, etc. */
  offset: number;
  /** CSS width for the tile. Driven by parent so different carousels
   *  can scale tiles independently while sharing all other physics. */
  tileWidth: string;
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
function PackCarouselItem({ slot, offset, tileWidth, onClick }: PackCarouselItemProps) {
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
        // was the "click does nothing" bug. Width is parent-supplied
        // so editorial and community can scale tiles independently.
        width: tileWidth,
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
  // Cover art, when present, owns the seal — we skip the gradient,
  // sparkle field, and shimmer sweep so the photograph reads as the
  // intended hero image. Packs without art still get the full
  // genre-coded treatment as before.
  const hasCover = Boolean(pack.coverImageUrl);
  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-2xl shadow-2xl"
      style={{
        background: hasCover ? undefined : gradient.background,
        // Keep the genre-tinted halo even with cover art so the seal
        // still feels lit by its palette on the carousel stage.
        boxShadow: packBoxShadow(gradient),
      }}
    >
      {hasCover ? (
        <img
          src={pack.coverImageUrl ?? undefined}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_30%_20%,white,transparent_45%),radial-gradient(circle_at_70%_80%,white,transparent_45%)]" />
      )}

      {/* Shimmer sweep. A narrow diagonal highlight band travels
          from the top-left edge to the bottom-right, offscreen-to-
          offscreen, then pauses for most of the loop. Renders only
          when `active` so dormant carousel neighbours stay calm; the
          parent rounded-2xl + overflow-hidden clips it to the pack
          silhouette. Tuned to read as light grazing a real foil
          surface — narrow band, low peak opacity, soft falloff,
          and `soft-light` blending so it tints the underlying
          gradient instead of painting a white stripe on top.
          Skipped on cover-art packs because the shimmer is part of
          the genre-foil treatment; cover packs are art, not foil. */}
      {active && !hasCover && (
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

      {/* Bottom-up scrim under the title — only shown when the pack
          has cover art, since the foil-on-gradient case is already
          high-contrast. Keeps the title legible against any photo
          without darkening the whole image. */}
      {hasCover && (
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.65)_0%,rgba(0,0,0,0.25)_45%,transparent_70%)]" />
      )}

      <div className="relative flex h-full flex-col items-center justify-end p-5 text-center text-[var(--on-accent)]">
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
