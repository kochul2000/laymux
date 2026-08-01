import { useCallback } from "react";
import { persistSession } from "@/lib/persist-session";
import { cycleSleepPreventionMode, shouldInhibitSleep } from "@/lib/sleep-prevention";
import { hasBusyTerminal } from "@/lib/terminal-busy";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

const TITLES: Record<string, string> = {
  off: "Sleep prevention: off (click to keep awake)",
  always: "Sleep prevention: always awake (click to follow terminals)",
  whenBusy: "Sleep prevention: awake while terminals are busy (click to turn off)",
};

/**
 * Top-bar tri-state toggle for sleep prevention (issue #727, ADR-0113).
 *
 * The icon carries two facts, not one: which mode is selected, and whether
 * sleep is being inhibited *right now*. In `whenBusy` those differ, and hiding
 * that would make the mode look broken whenever the terminals are idle.
 */
export function SleepPreventionToggle() {
  const mode = useSettingsStore((s) => s.power.sleepPrevention);
  const setPower = useSettingsStore((s) => s.setPower);
  const busy = useTerminalStore((s) => hasBusyTerminal(s.instances));

  const inhibiting = shouldInhibitSleep(mode, busy);

  const handleClick = useCallback(() => {
    setPower({ sleepPrevention: cycleSleepPreventionMode(mode) });
    void persistSession();
  }, [mode, setPower]);

  const color = mode === "off" || !inhibiting ? "var(--text-secondary)" : "var(--accent)";
  const opacity = mode === "off" ? 0.35 : inhibiting ? 1 : 0.65;

  return (
    <button
      data-testid="sleep-prevention-btn"
      data-mode={mode}
      data-inhibiting={inhibiting}
      onClick={handleClick}
      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded"
      style={{ color, opacity, background: "transparent", border: "none" }}
      title={TITLES[mode] ?? TITLES.off}
      aria-label="Sleep prevention"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        {/* Crescent moon — sleep. */}
        <path
          d="M11.4 8.7A5 5 0 0 1 5.3 2.6 5 5 0 1 0 11.4 8.7Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        {/* Struck through once sleep is being prevented in any mode. */}
        {mode !== "off" && (
          <line x1="2" y1="12" x2="12" y2="2" stroke="currentColor" strokeWidth="1.2" />
        )}
        {/* The extra mark that separates "conditional" from "always". */}
        {mode === "whenBusy" && <circle cx="11.6" cy="11.6" r="1.7" fill="currentColor" />}
      </svg>
    </button>
  );
}
