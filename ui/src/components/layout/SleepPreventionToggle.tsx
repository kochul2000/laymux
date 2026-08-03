import { useCallback } from "react";
import { persistSession } from "@/lib/persist-session";
import { useSettingsStore } from "@/stores/settings-store";
import { useSleepInhibitStore } from "@/stores/sleep-inhibit-store";

/**
 * Top-bar switch for the manual "keep this machine awake" axis (issue #733,
 * ADR-0116).
 *
 * It shows one thing and changes the same thing. The standing "awake while a
 * terminal is busy" policy is a second, independent axis that lives in Settings
 * and is deliberately absent from the icon: folding both into one 14px glyph is
 * what made the old tri-state button unreadable.
 *
 * The exception is a refused request. That is not a value on either axis but a
 * fault, and hiding it lets a machine without a working inhibitor fail silently
 * for the whole session.
 */
export function SleepPreventionToggle() {
  const keepAwake = useSettingsStore((s) => s.power.keepAwake);
  const keepAwakeWhenBusy = useSettingsStore((s) => s.power.keepAwakeWhenBusy);
  const setPower = useSettingsStore((s) => s.setPower);
  const failed = useSleepInhibitStore((s) => s.failed);

  const handleClick = useCallback(() => {
    setPower({ keepAwake: !keepAwake });
    void persistSession();
  }, [keepAwake, setPower]);

  const color = failed ? "var(--claude)" : keepAwake ? "var(--accent)" : "var(--text-secondary)";
  const opacity = keepAwake || failed ? 1 : 0.4;

  // The icon carries one axis; the tooltip is where the other one and the
  // failure reason can be spelled out.
  const state = keepAwake
    ? "Sleep prevention: keeping this machine awake (click to allow sleep)"
    : "Sleep prevention: off (click to keep this machine awake)";
  const policy = keepAwakeWhenBusy
    ? " — Settings also keeps it awake while a terminal is busy"
    : "";
  const title = `${state}${policy}${failed ? " — the last inhibit request failed" : ""}`;

  // Square corners and static styling in classes, per api-contracts §15.1 —
  // only the two theme-dependent values are inline.
  return (
    <button
      data-testid="sleep-prevention-btn"
      data-keep-awake={keepAwake}
      data-failed={failed}
      onClick={handleClick}
      className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent"
      style={{ color, opacity }}
      title={title}
      aria-label="Sleep prevention"
      aria-pressed={keepAwake}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        {/* Crescent moon — sleep. */}
        <path
          d="M11.4 8.7A5 5 0 0 1 5.3 2.6 5 5 0 1 0 11.4 8.7Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        {/* Struck through while the manual switch is on. */}
        {keepAwake && (
          <line x1="2" y1="12" x2="12" y2="2" stroke="currentColor" strokeWidth="1.2" />
        )}
      </svg>
    </button>
  );
}
