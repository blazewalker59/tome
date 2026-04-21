import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "auto";

function getInitialMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "auto";
  }

  const stored = window.localStorage.getItem("theme");
  if (stored === "light" || stored === "dark" || stored === "auto") {
    return stored;
  }

  return "auto";
}

function applyThemeMode(mode: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = mode === "auto" ? (prefersDark ? "dark" : "light") : mode;

  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolved);

  if (mode === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }

  document.documentElement.style.colorScheme = resolved;
}

/**
 * Reads the persisted theme mode, applies it to <html>, and keeps it in
 * sync with `prefers-color-scheme` when the user has chosen "auto".
 *
 * Returns `[mode, setMode]` — setting a mode persists to localStorage and
 * reflects the new resolved theme immediately on <html>.
 *
 * Shared by the desktop cycle-button variant (`ThemeToggle`) and any
 * future in-menu segmented controls so both stay in lockstep.
 */
export function useThemeMode(): [ThemeMode, (next: ThemeMode) => void] {
  const [mode, setModeState] = useState<ThemeMode>("auto");

  useEffect(() => {
    const initialMode = getInitialMode();
    setModeState(initialMode);
    applyThemeMode(initialMode);
  }, []);

  useEffect(() => {
    if (mode !== "auto") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeMode("auto");

    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [mode]);

  function setMode(next: ThemeMode) {
    setModeState(next);
    applyThemeMode(next);
    window.localStorage.setItem("theme", next);
  }

  return [mode, setMode];
}

/**
 * Desktop-bar variant: single pill that cycles light → dark → auto.
 * Compact and keyboard-activatable. On mobile we hide this and render a
 * segmented control inside the profile menu instead (see `ThemeSegmented`).
 */
export default function ThemeToggle() {
  const [mode, setMode] = useThemeMode();

  function toggleMode() {
    const nextMode: ThemeMode = mode === "light" ? "dark" : mode === "dark" ? "auto" : "light";
    setMode(nextMode);
  }

  const label =
    mode === "auto"
      ? "Theme mode: auto (system). Click to switch to light mode."
      : `Theme mode: ${mode}. Click to switch mode.`;

  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-label={label}
      title={label}
      className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_22px_rgba(30,90,72,0.08)] transition hover:-translate-y-0.5"
    >
      {mode === "auto" ? "Auto" : mode === "dark" ? "Dark" : "Light"}
    </button>
  );
}

/**
 * Three-option segmented control — Auto / Light / Dark. Designed to sit
 * inside the profile dropdown on mobile where the inline pill toggle
 * is hidden. Larger hit targets, all three modes visible at once (no
 * guessing what the next cycle is).
 */
export function ThemeSegmented() {
  const [mode, setMode] = useThemeMode();

  const options: Array<{ value: ThemeMode; label: string }> = [
    { value: "auto", label: "Auto" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="grid grid-cols-3 gap-1 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] p-1"
    >
      {options.map((opt) => {
        const isActive = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => setMode(opt.value)}
            className={
              "rounded-full px-3 py-1.5 text-xs font-semibold transition " +
              (isActive
                ? "bg-[var(--lagoon)] text-[var(--on-accent)]"
                : "text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]")
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
