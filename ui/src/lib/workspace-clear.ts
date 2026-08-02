import { getHandler, isRegisteredInteractiveApp, type RawTerminalState } from "./activity-handler";
import { CTRL_C, INTERRUPT_ROUND_INTERVAL_MS } from "./terminal-interrupt";
import { toPaneId, toTerminalId } from "./pane-ids";
import { getTerminalRestartCwd } from "./terminal-restart";
import { writeTerminalInput, writeToTerminal } from "./tauri-api";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { WorkspaceClearSettings } from "./tauri-api";

/**
 * Workspace-wide clear (issue #726, ADR-0113).
 *
 * One action clears every TerminalView pane of a workspace, asking each pane's
 * activity handler what "clear" means there — `clear`/`cls` for a shell,
 * `/clear` for Claude Code and Codex. Interactive apps without a registered
 * handler (vim, htop, less) are never written to.
 *
 * Dock panes are out of scope: docks are fixed surfaces that survive workspace
 * switches, so they are not part of "this workspace".
 */

/** What to do with a pane that is mid-task when the clear runs. */
export type WorkspaceClearBusyPolicy = "skip" | "interrupt" | "restart";

/** Why a pane was left untouched. */
export type WorkspaceClearSkipReason =
  /** Mid-task and the policy says leave it alone. */
  | "busy"
  /** An interactive app with no registered handler — writing would corrupt it. */
  | "unsupportedApp"
  /** No PTY session yet (pane still starting, or evicted while hidden). */
  | "notReady";

export type ClearActionKind =
  /** Submit the clear input right away. */
  | "submit"
  /** Ctrl+C, settle, then submit the clear input. */
  | "interruptThenSubmit"
  /** Tear the PTY down and start a fresh one; nothing is typed. */
  | "restart"
  | "skip";

export interface ClearAction {
  paneId: string;
  terminalId: string;
  kind: ClearActionKind;
  /** Present for `submit` / `interruptThenSubmit`. */
  input?: string;
  /** Present for `skip`. */
  reason?: WorkspaceClearSkipReason;
}

export interface ResolvedWorkspaceClear {
  shellCommand: string;
  busyPolicy: WorkspaceClearBusyPolicy;
  interruptRounds: number;
  settleMs: number;
}

const MIN_ROUNDS = 1;
const MAX_ROUNDS = 10;
const MIN_SETTLE_MS = 0;
const MAX_SETTLE_MS = 10_000;
const BUSY_POLICIES: WorkspaceClearBusyPolicy[] = ["skip", "interrupt", "restart"];

export const DEFAULT_SHELL_CLEAR_COMMAND = "clear";
export const DEFAULT_CLEAR_INTERRUPT_ROUNDS = 2;
export const DEFAULT_CLEAR_SETTLE_MS = 400;

/**
 * Store-facing defaults. Mirrors Rust `WorkspaceClearSettings::default()`.
 *
 * This module must not import the settings store — `clearWorkspace` takes the
 * settings from its caller instead — so the dependency runs one way and the
 * defaults still have a single owner.
 */
export const DEFAULT_WORKSPACE_CLEAR: WorkspaceClearSettings = {
  shellCommand: DEFAULT_SHELL_CLEAR_COMMAND,
  busyPolicy: "skip",
  interruptRounds: DEFAULT_CLEAR_INTERRUPT_ROUNDS,
  settleMs: DEFAULT_CLEAR_SETTLE_MS,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Longest a single terminal's interrupt→clear chain can take, in ms. Every
 * terminal runs its chain concurrently, so this is also the whole run's wait.
 */
export function clearWaitBudgetMs(config: ResolvedWorkspaceClear): number {
  if (config.busyPolicy !== "interrupt") return 0;
  return (config.interruptRounds - 1) * INTERRUPT_ROUND_INTERVAL_MS + config.settleMs;
}

export interface ResolveWorkspaceClearOptions {
  /**
   * Ceiling for `clearWaitBudgetMs`. `settleMs` (and then `interruptRounds`) is
   * trimmed to fit. Used by the Automation path, whose caller stops waiting at
   * the bridge's fixed per-request budget: a settle longer than that turns a
   * successful clear into a `504` with the per-pane result lost.
   */
  maxWaitMs?: number;
}

export interface ClearWorkspaceOptions extends ResolveWorkspaceClearOptions {
  /**
   * Wall-clock allowance for the whole run, after which no NEW write is issued.
   *
   * Distinct from `maxWaitMs`, which only trims the sleeps this module controls.
   * A chain that slept exactly its trimmed budget must still be allowed to type
   * the clear, so this has to be the LARGER of the two — it exists to stop a
   * chain whose PTY writes are dragging, not one that is on schedule.
   */
  hardDeadlineMs?: number;
}

/**
 * Read + clamp the clear config from a raw (possibly hand-edited) value.
 * An empty `shellCommand` falls back to the default rather than submitting a
 * bare Enter into every shell.
 */
export function resolveWorkspaceClear(
  settings?: Partial<WorkspaceClearSettings>,
  options: ResolveWorkspaceClearOptions = {},
): ResolvedWorkspaceClear {
  const policy = settings?.busyPolicy;
  const shellCommand = settings?.shellCommand?.trim();
  const resolved: ResolvedWorkspaceClear = {
    shellCommand: shellCommand || DEFAULT_SHELL_CLEAR_COMMAND,
    busyPolicy:
      policy && BUSY_POLICIES.includes(policy as WorkspaceClearBusyPolicy)
        ? (policy as WorkspaceClearBusyPolicy)
        : "skip",
    interruptRounds: clamp(
      settings?.interruptRounds ?? DEFAULT_CLEAR_INTERRUPT_ROUNDS,
      MIN_ROUNDS,
      MAX_ROUNDS,
    ),
    settleMs: clamp(settings?.settleMs ?? DEFAULT_CLEAR_SETTLE_MS, MIN_SETTLE_MS, MAX_SETTLE_MS),
  };

  const maxWaitMs = options.maxWaitMs;
  if (maxWaitMs === undefined) return resolved;

  // Trim the settle first — it is one wait at the end, so shortening it costs
  // the app repaint time but keeps every Ctrl+C. Only when the rounds alone
  // overrun does the round count come down, and never below one press. The
  // settle is recomputed afterwards so a round that was dropped hands its time
  // back instead of leaving the budget unspent.
  const requestedSettleMs = resolved.settleMs;
  const roundsWait = () => (resolved.interruptRounds - 1) * INTERRUPT_ROUND_INTERVAL_MS;
  while (resolved.interruptRounds > MIN_ROUNDS && roundsWait() > maxWaitMs) {
    resolved.interruptRounds -= 1;
  }
  resolved.settleMs = Math.max(
    MIN_SETTLE_MS,
    Math.min(requestedSettleMs, maxWaitMs - roundsWait()),
  );
  return resolved;
}

function toRawState(instance: TerminalInstance): RawTerminalState {
  return {
    exitCode: instance.lastExitCode,
    outputActive: instance.outputActive ?? false,
    lastCommand: instance.lastCommand,
    activityMessage: instance.activityMessage,
    activity: instance.activity,
    title: instance.title,
  };
}

/** Decide what happens to one terminal. Pure — no store or Tauri access. */
export function planTerminalClear(
  instance: TerminalInstance,
  config: ResolvedWorkspaceClear,
): ClearAction {
  const paneId = toPaneId(instance.id);
  const base = { paneId, terminalId: instance.id };

  // `sessionReady` is undefined for instances registered before the backend
  // answered; only an explicit `false` means "no PTY yet".
  if (instance.sessionReady === false) {
    return { ...base, kind: "skip", reason: "notReady" };
  }

  const activity = instance.activity;
  if (activity?.type === "interactiveApp" && !isRegisteredInteractiveApp(activity)) {
    return { ...base, kind: "skip", reason: "unsupportedApp" };
  }

  const handler = getHandler(activity);
  const input = handler.clearInput(config.shellCommand);

  if (!handler.isBusy(toRawState(instance))) {
    return { ...base, kind: "submit", input };
  }

  switch (config.busyPolicy) {
    case "interrupt":
      return { ...base, kind: "interruptThenSubmit", input };
    case "restart":
      return { ...base, kind: "restart" };
    default:
      return { ...base, kind: "skip", reason: "busy" };
  }
}

/**
 * Plan the whole workspace. `paneIds` is the workspace's TerminalView pane
 * order, so a pane whose terminal never registered still shows up as skipped
 * instead of silently vanishing from the report.
 */
export function planWorkspaceClear(
  paneIds: string[],
  instances: TerminalInstance[],
  config: ResolvedWorkspaceClear,
): ClearAction[] {
  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  return paneIds.map((paneId) => {
    const terminalId = toTerminalId(paneId);
    const instance = byId.get(terminalId);
    if (!instance) return { paneId, terminalId, kind: "skip", reason: "notReady" as const };
    return planTerminalClear(instance, config);
  });
}

export interface WorkspaceClearResult {
  cleared: string[];
  interrupted: string[];
  restarted: string[];
  skipped: { terminalId: string; reason: WorkspaceClearSkipReason }[];
  /**
   * Terminals whose write was rejected. A remote client holding the control
   * lease and a PTY that died between planning and writing both land here —
   * without this array they would leave every list empty, which reads exactly
   * like "this workspace has no terminal panes".
   */
  failed: { terminalId: string; error: string }[];
}

/** True when the clear touched nothing at all — worth telling the user about. */
export function isNoOpClearResult(result: WorkspaceClearResult): boolean {
  return (
    result.cleared.length === 0 && result.interrupted.length === 0 && result.restarted.length === 0
  );
}

/** One-line summary for a log or a toast. */
export function summarizeClearResult(result: WorkspaceClearResult): string {
  const parts = [`cleared ${result.cleared.length}`];
  if (result.restarted.length > 0) parts.push(`restarted ${result.restarted.length}`);
  if (result.skipped.length > 0) {
    const reasons = new Set(result.skipped.map((entry) => entry.reason));
    parts.push(`skipped ${result.skipped.length} (${[...reasons].join(", ")})`);
  }
  if (result.failed.length > 0) parts.push(`failed ${result.failed.length}`);
  return parts.join(", ");
}

export interface RunWorkspaceClearDeps {
  actions: ClearAction[];
  config: ResolvedWorkspaceClear;
  /** Types `text` and submits it as one line. */
  submit: (terminalId: string, text: string) => Promise<void>;
  /** Sends one Ctrl+C. */
  interrupt: (terminalId: string) => Promise<void>;
  restart: (paneId: string) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Absolute time after which no NEW write is issued; remaining terminals are
   * reported as failed instead.
   *
   * The per-write wait is not ours to bound — a single `write_to_terminal` can
   * sit in the PTY control queue for `PTY_CONTROL_JOB_TIMEOUT_MS` (15s) and JS
   * cannot cancel it. What this does prevent is the chain typing MORE text
   * after its caller has already given up: without it, an Automation request
   * that 504s at the bridge budget would keep going and land a `/clear` in a
   * pane whose caller has moved on — and a retry would then double it.
   */
  deadlineAt?: number;
}

/** What one action did. Merged into the result in plan order by the caller. */
interface ActionOutcome {
  cleared?: string;
  interrupted?: string;
  restarted?: string;
  skipped?: { terminalId: string; reason: WorkspaceClearSkipReason };
  failed?: { terminalId: string; error: string };
}

/**
 * Dependency-injected executor so the timing and per-terminal ordering are
 * testable without Tauri or real timers.
 *
 * Terminals run concurrently — each one's interrupt→settle→submit chain is
 * independent, and serialising them would make a 6-pane workspace wait
 * `6 × settleMs`. A failing terminal never aborts the others.
 *
 * Each chain returns its own outcome rather than pushing into shared arrays, so
 * the report follows the workspace's pane order instead of whichever await
 * happened to resolve first.
 */
export async function runWorkspaceClear(
  deps: RunWorkspaceClearDeps,
): Promise<WorkspaceClearResult> {
  const now = deps.now ?? (() => Date.now());
  const outOfTime = () => deps.deadlineAt !== undefined && now() >= deps.deadlineAt;

  const runAction = async (action: ClearAction): Promise<ActionOutcome> => {
    // `interrupted` is recorded as soon as the first Ctrl+C lands, not after
    // the whole loop: a later round failing must not erase the fact that the
    // pane already took an interrupt.
    const outcome: ActionOutcome = {};
    try {
      switch (action.kind) {
        case "skip":
          outcome.skipped = { terminalId: action.terminalId, reason: action.reason ?? "busy" };
          return outcome;
        case "restart":
          deps.restart(action.paneId);
          outcome.restarted = action.terminalId;
          return outcome;
        case "interruptThenSubmit": {
          for (let round = 0; round < deps.config.interruptRounds; round++) {
            if (outOfTime()) throw new Error("clear budget elapsed before this Ctrl+C");
            await deps.interrupt(action.terminalId);
            outcome.interrupted = action.terminalId;
            if (round < deps.config.interruptRounds - 1) {
              await deps.sleep(INTERRUPT_ROUND_INTERVAL_MS);
            }
          }
          // Let the agent/shell finish tearing the task down and repaint its
          // prompt; typing into a half-torn-down TUI lands in the old frame.
          if (deps.config.settleMs > 0) await deps.sleep(deps.config.settleMs);
          if (outOfTime()) throw new Error("clear budget elapsed before the clear input");
          await deps.submit(action.terminalId, action.input!);
          outcome.cleared = action.terminalId;
          return outcome;
        }
        case "submit":
          if (outOfTime()) throw new Error("clear budget elapsed before the clear input");
          await deps.submit(action.terminalId, action.input!);
          outcome.cleared = action.terminalId;
          return outcome;
      }
    } catch (error) {
      // A rejected write must be reported, not dropped: it is the difference
      // between "nothing needed clearing" and "the remote holds the lease".
      // Anything already achieved (an interrupt that landed) stays in `outcome`.
      outcome.failed = {
        terminalId: action.terminalId,
        error: error instanceof Error ? error.message : String(error),
      };
      return outcome;
    }
  };

  const outcomes = await Promise.all(deps.actions.map(runAction));

  const result: WorkspaceClearResult = {
    cleared: [],
    interrupted: [],
    restarted: [],
    skipped: [],
    failed: [],
  };
  for (const outcome of outcomes) {
    if (outcome.cleared) result.cleared.push(outcome.cleared);
    if (outcome.interrupted) result.interrupted.push(outcome.interrupted);
    if (outcome.restarted) result.restarted.push(outcome.restarted);
    if (outcome.skipped) result.skipped.push(outcome.skipped);
    if (outcome.failed) result.failed.push(outcome.failed);
  }
  return result;
}

/** Pane ids of a workspace's TerminalView panes, in layout order. */
export function terminalPaneIdsForWorkspace(workspaceId: string): string[] {
  const workspace = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId);
  if (!workspace) return [];
  return workspace.panes.filter((pane) => pane.view.type === "TerminalView").map((pane) => pane.id);
}

/**
 * Production entry point: read live terminals and run the clear.
 *
 * `settings` comes from the caller (`useSettingsStore.getState().workspaceClear`)
 * rather than being read here, so this module never imports the settings store
 * that imports its defaults.
 */
export async function clearWorkspace(
  workspaceId: string,
  settings?: Partial<WorkspaceClearSettings>,
  options: ClearWorkspaceOptions = {},
): Promise<WorkspaceClearResult> {
  const config = resolveWorkspaceClear(settings, options);
  const deadlineAt =
    options.hardDeadlineMs === undefined ? undefined : Date.now() + options.hardDeadlineMs;
  const paneIds = terminalPaneIdsForWorkspace(workspaceId);
  const actions = planWorkspaceClear(paneIds, useTerminalStore.getState().instances, config);
  const workspace = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId);

  return runWorkspaceClear({
    actions,
    config,
    submit: (terminalId, text) => writeTerminalInput(terminalId, text, true),
    // ETX must reach the PTY as a raw byte: the structured input path wraps its
    // body in bracketed paste when the app enabled it, and `\x1b[200~\x03\x1b[201~`
    // is pasted text, not an interrupt. `write_to_terminal` is the same command
    // a real Ctrl+C keypress uses, and carries the same human-control gate.
    interrupt: (terminalId) => writeToTerminal(terminalId, CTRL_C),
    restart: (paneId) => {
      const view = workspace?.panes.find((pane) => pane.id === paneId)?.view;
      const cwd = view ? getTerminalRestartCwd(paneId, view) : undefined;
      useTerminalRestartStore.getState().requestRestart(paneId, cwd);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    deadlineAt,
  });
}
