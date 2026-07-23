import { interruptTerminalOnExit as invokeInterruptTerminalOnExit } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import type { ExitSettings } from "@/lib/tauri-api";

/**
 * Kill-on-exit orchestration (issue #451).
 *
 * When `settings.exit.interruptTerminals` is on, laymux sends Ctrl+C (ETX,
 * 0x03) to every open terminal a few times as the window closes. This tears
 * down long-running/cron work and nudges Claude Code / Codex to print their
 * `--resume <id>` session hint into the scrollback. The scrollback is cached
 * right after (see `saveBeforeClose`), so the session id survives the restart.
 *
 * The write path is the same `write_to_terminal` command a keypress uses, so
 * ConPTY / the line discipline delivers a real Ctrl+C to the foreground app.
 */

/** ETX — the byte a terminal sends when the user presses Ctrl+C. */
export const CTRL_C = "\x03";

/** Fixed spacing between consecutive Ctrl+C presses. Agents need a beat between
 *  the "interrupt" press and the "confirm exit" press; not worth a setting. */
export const INTERRUPT_ROUND_INTERVAL_MS = 120;

const MIN_ROUNDS = 1;
const MAX_ROUNDS = 10;
const MIN_SETTLE_MS = 0;
const MAX_SETTLE_MS = 10_000;

export interface ResolvedExitInterrupt {
  enabled: boolean;
  rounds: number;
  settleMs: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Read + clamp the exit-interrupt config from a raw (possibly hand-edited) value. */
export function resolveExitInterrupt(exit?: Partial<ExitSettings>): ResolvedExitInterrupt {
  return {
    enabled: exit?.interruptTerminals ?? false,
    rounds: clamp(exit?.interruptRounds ?? 3, MIN_ROUNDS, MAX_ROUNDS),
    settleMs: clamp(exit?.settleMs ?? 700, MIN_SETTLE_MS, MAX_SETTLE_MS),
  };
}

/**
 * Extra time (ms) the close flow needs to finish interrupting terminals.
 * Used to widen the save timeout so a configured settle delay is not cut off.
 * Returns 0 when the feature is disabled.
 */
export function exitInterruptBudgetMs(exit?: Partial<ExitSettings>): number {
  const config = resolveExitInterrupt(exit);
  if (!config.enabled) return 0;
  return config.rounds * INTERRUPT_ROUND_INTERVAL_MS + config.settleMs;
}

export interface RunInterruptDeps {
  config: ResolvedExitInterrupt;
  getTerminalIds: () => string[];
  write: (id: string, data: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Pure, dependency-injected core so the timing/rounds logic is unit-testable
 * without Tauri or real timers. Returns the number of terminals interrupted.
 */
export async function runInterruptTerminals(deps: RunInterruptDeps): Promise<number> {
  if (!deps.config.enabled) return 0;
  const ids = Array.from(new Set(deps.getTerminalIds()));
  if (ids.length === 0) return 0;

  for (let round = 0; round < deps.config.rounds; round++) {
    // A failed write (e.g. a terminal that already exited) must not abort the
    // rest — allSettled keeps every terminal getting its Ctrl+C.
    await Promise.allSettled(ids.map((id) => deps.write(id, CTRL_C)));
    if (round < deps.config.rounds - 1) {
      await deps.sleep(INTERRUPT_ROUND_INTERVAL_MS);
    }
  }
  // Give Claude/Codex time to print the resume session id before we cache the
  // scrollback and tear the window down.
  if (deps.config.settleMs > 0) {
    await deps.sleep(deps.config.settleMs);
  }
  return ids.length;
}

/** Production entry point: read live settings + terminals and run the interrupt. */
export async function interruptTerminalsOnExit(): Promise<void> {
  const config = resolveExitInterrupt(useSettingsStore.getState().exit);
  if (!config.enabled) return;
  try {
    await runInterruptTerminals({
      config,
      getTerminalIds: () => useTerminalStore.getState().instances.map((instance) => instance.id),
      // Shutdown-only ETX path: bypasses the human-control gate so the interrupt
      // still lands while a remote client holds the control lease (issue #451).
      write: (id) => invokeInterruptTerminalOnExit(id),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  } catch (err) {
    // Never block window close on a best-effort interrupt.
    console.warn("[interruptTerminalsOnExit] failed:", err);
  }
}
