import { useCallback } from "react";
import { persistSession } from "@/lib/persist-session";
import { cycleSleepPreventionMode } from "@/lib/sleep-prevention";
import { useSettingsStore } from "@/stores/settings-store";
import { useSleepInhibitStore } from "@/stores/sleep-inhibit-store";

const TITLES: Record<string, string> = {
  off: "Sleep prevention: off (click to keep awake)",
  always: "Sleep prevention: always awake (click to follow terminals)",
  whenBusy: "Sleep prevention: awake while terminals are busy (click to turn off)",
};

/**
 * Top-bar tri-state toggle for sleep prevention (issue #727, ADR-0114).
 *
 * The icon carries two facts, not one: which mode is selected, and whether
 * sleep is being inhibited *right now*. In `whenBusy` those differ whenever the
 * terminals are idle, and after a failed request they differ in the direction
 * that matters — so "now" is the backend's answer, never the derived intent.
 */
export function SleepPreventionToggle() {
  const mode = useSettingsStore((s) => s.power.sleepPrevention);
  const setPower = useSettingsStore((s) => s.setPower);
  const inhibiting = useSleepInhibitStore((s) => s.active);
  const failed = useSleepInhibitStore((s) => s.failed);

  const handleClick = useCallback(() => {
    setPower({ sleepPrevention: cycleSleepPreventionMode(mode) });
    void persistSession();
  }, [mode, setPower]);

  // A refused request is the one case where the mode alone would mislead: the
  // user asked to stay awake and the machine will sleep anyway.
  const color = failed ? "var(--claude)" : inhibiting ? "var(--accent)" : "var(--text-secondary)";
  const opacity = mode === "off" && !failed ? 0.35 : inhibiting || failed ? 1 : 0.65;
  const title = `${TITLES[mode] ?? TITLES.off}${failed ? " — the last request failed" : ""}`;

  // Square corners and static styling in classes, per api-contracts §15.1 —
  // only the two theme-dependent values are inline.
  return (
    <button
      data-testid="sleep-prevention-btn"
      data-mode={mode}
      data-inhibiting={inhibiting}
      data-failed={failed}
      onClick={handleClick}
      className="flex h-6 w-6 cursor-pointer items-center justify-center border-0 bg-transparent"
      style={{ color, opacity }}
      title={title}
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
