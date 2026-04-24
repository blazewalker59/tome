import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Gem } from "lucide-react";

/**
 * Minimal toast primitive. We reach for this whenever a server action
 * produces a side-effect the user should *notice* but shouldn't have
 * to *act on* — "+5 shards" after marking a book as reading, "+100
 * shards" after finishing a book, dupe refund totals after a rip.
 *
 * Design choices:
 *   - Imperative API via `useToast().push(...)`. A declarative prop-
 *     based shape would force every call site to own a piece of React
 *     state that it otherwise doesn't need; an imperative push matches
 *     how call sites think about it ("I just got a successful response;
 *     tell the user").
 *   - Portaled to `document.body` so absolute positioning isn't
 *     trapped inside whatever ancestor has `overflow: hidden` or a
 *     transform applied (e.g. `viewport-stage`, bottom-sheet panels).
 *   - Motion via framer-motion with AnimatePresence so toasts slide
 *     in/out instead of popping. Uses the same library that already
 *     drives PackRip/bottom-sheet, so no new dependency.
 *   - Auto-dismiss with a user-interruptible timer: hover pauses it
 *     (pointerenter), pointerleave resumes. Covers the case where a
 *     user starts reading the text at the last moment.
 *   - No stacking cap. Grants come in bursts of 1–2 (status transition
 *     + dupe-refund summary), and the `useToast().push` API is the
 *     only entry point — there's no way for runaway code to flood
 *     the UI. We can revisit if that changes.
 */

export type ToastTone = "neutral" | "success" | "shard";

export interface ToastOptions {
  /** Short title line (e.g. "Started reading"). */
  title: string;
  /** Optional longer body (e.g. "Keep it up — finish to earn 100 shards"). */
  description?: string;
  /**
   * Visual accent. `shard` uses the rarity/gem palette and shows a
   * gem glyph; `success` uses the uncommon green; `neutral` is plain.
   */
  tone?: ToastTone;
  /**
   * When set, renders "+N" prominently with the tone's accent. Used
   * by the shard-grant call sites — it's common enough across them
   * that making it a first-class field is worth the extra prop.
   */
  amount?: number;
  /** How long before auto-dismiss, ms. Defaults to 3500ms. */
  durationMs?: number;
}

interface ToastEntry extends Required<Omit<ToastOptions, "description">> {
  id: number;
  description?: string;
}

interface ToastContextValue {
  push: (opts: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fail soft: if a component calls useToast() without a provider
    // (e.g. a test harness that doesn't mount the tree), we return
    // a no-op rather than throwing. The behavior degrades silently
    // which is fine for a toast — the surrounding action still
    // succeeded, the user just doesn't see the confirmation.
    return { push: () => {} };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  // Stable id counter across renders; survives React 18 StrictMode
  // double-invokes because it's in a ref, not state.
  const nextId = useRef(1);

  const push = useCallback((opts: ToastOptions) => {
    const id = nextId.current++;
    const entry: ToastEntry = {
      id,
      title: opts.title,
      description: opts.description,
      tone: opts.tone ?? "neutral",
      amount: opts.amount ?? 0,
      durationMs: opts.durationMs ?? 3500,
    };
    setToasts((prev) => [...prev, entry]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/**
 * Renders the stack of toasts into a body-level portal. SSR-guarded
 * via a mounted flag so the server render returns null (matching the
 * initial client render) and the portal only attaches after hydration.
 */
function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ReadonlyArray<ToastEntry>;
  onDismiss: (id: number) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;

  return createPortal(
    <div
      // Positioned at the bottom so toasts don't collide with the
      // top header/back-button area. `pointer-events: none` on the
      // container means the page behind still accepts clicks; each
      // toast re-enables pointer events on itself so hover-to-pause
      // and close-button still work.
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6"
      role="region"
      aria-label="Notifications"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastEntry;
  onDismiss: (id: number) => void;
}) {
  // Timer lives in a ref so pause/resume can clear and restart it
  // without re-triggering effects. We also track the remaining time
  // so resume continues from where pause interrupted rather than
  // resetting the full duration — otherwise a user who nearly let
  // the toast expire would lose the benefit of their earlier wait.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(toast.durationMs);
  const startedAtRef = useRef<number>(Date.now());

  const scheduleDismiss = useCallback(
    (ms: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      startedAtRef.current = Date.now();
      timerRef.current = setTimeout(() => onDismiss(toast.id), ms);
    },
    [onDismiss, toast.id],
  );

  useEffect(() => {
    scheduleDismiss(toast.durationMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.durationMs, scheduleDismiss]);

  const pause = () => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    const elapsed = Date.now() - startedAtRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
  };

  const resume = () => {
    if (timerRef.current) return;
    scheduleDismiss(remainingRef.current);
  };

  // Tone → accent CSS var. Using the rarity tokens already in the
  // theme keeps toasts visually coherent with the rest of the app
  // (shard refunds map to the gem/legendary palette which already
  // means "currency" in the UI).
  const accent =
    toast.tone === "shard"
      ? "var(--rarity-legendary)"
      : toast.tone === "success"
        ? "var(--rarity-uncommon)"
        : "var(--sea-ink)";
  const accentSoft =
    toast.tone === "shard"
      ? "var(--rarity-legendary-soft)"
      : toast.tone === "success"
        ? "var(--rarity-uncommon-soft)"
        : "var(--chip-bg)";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={resume}
      // Background is intentionally solid (not `--surface`, which is
      // ~0.78 alpha across themes). A toast overlays arbitrary page
      // content, so any transparency means the text competes with
      // whatever card / image happens to sit behind it. `--sand` is
      // the theme's solid panel token; the subtle inner tint comes
      // from mixing `--surface-strong` on top, which keeps the look
      // consistent with the rest of the app's surfaces without
      // leaking through.
      className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl border border-[var(--chip-line)] px-4 py-3 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.25)]"
      style={{
        background: "var(--sand)",
        borderColor: `color-mix(in srgb, ${accent} 30%, var(--chip-line))`,
      }}
      role="status"
      aria-live="polite"
    >
      {toast.tone === "shard" ? (
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: accentSoft, color: accent }}
          aria-hidden
        >
          <Gem className="h-4 w-4" fill={accent} fillOpacity={0.2} strokeWidth={2} />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">{toast.description}</p>
        ) : null}
      </div>
      {toast.amount > 0 ? (
        <span
          className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums"
          style={{ background: accentSoft, color: accent }}
        >
          +{toast.amount}
        </span>
      ) : null}
    </motion.div>
  );
}
