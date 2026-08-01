import { getHandler, isRegisteredInteractiveApp, type RawTerminalState } from "./activity-handler";
import { CTRL_C, INTERRUPT_ROUND_INTERVAL_MS } from "./interrupt-terminals-on-exit";
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
 * Read + clamp the clear config from a raw (possibly hand-edited) value.
 * An empty `shellCommand` falls back to the default rather than submitting a
 * bare Enter into every shell.
 */
export function resolveWorkspaceClear(
  settings?: Partial<WorkspaceClearSettings>,
): ResolvedWorkspaceClear {
  const policy = settings?.busyPolicy;
  const shellCommand = settings?.shellCommand?.trim();
  return {
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
}

/**
 * Dependency-injected executor so the timing and per-terminal ordering are
 * testable without Tauri or real timers.
 *
 * Terminals run concurrently — each one's interrupt→settle→submit chain is
 * independent, and serialising them would make a 6-pane workspace wait
 * `6 × settleMs`. A failing terminal never aborts the others.
 */
export async function runWorkspaceClear(
  deps: RunWorkspaceClearDeps,
): Promise<WorkspaceClearResult> {
  const result: WorkspaceClearResult = {
    cleared: [],
    interrupted: [],
    restarted: [],
    skipped: [],
  };

  const chains = deps.actions.map(async (action) => {
    switch (action.kind) {
      case "skip":
        result.skipped.push({
          terminalId: action.terminalId,
          reason: action.reason ?? "busy",
        });
        return;
      case "restart":
        deps.restart(action.paneId);
        result.restarted.push(action.terminalId);
        return;
      case "interruptThenSubmit": {
        for (let round = 0; round < deps.config.interruptRounds; round++) {
          await deps.interrupt(action.terminalId);
          if (round < deps.config.interruptRounds - 1) {
            await deps.sleep(INTERRUPT_ROUND_INTERVAL_MS);
          }
        }
        result.interrupted.push(action.terminalId);
        // Let the agent/shell finish tearing the task down and repaint its
        // prompt; typing into a half-torn-down TUI lands in the old frame.
        if (deps.config.settleMs > 0) await deps.sleep(deps.config.settleMs);
        await deps.submit(action.terminalId, action.input!);
        result.cleared.push(action.terminalId);
        return;
      }
      case "submit":
        await deps.submit(action.terminalId, action.input!);
        result.cleared.push(action.terminalId);
        return;
    }
  });

  await Promise.allSettled(chains);
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
): Promise<WorkspaceClearResult> {
  const config = resolveWorkspaceClear(settings);
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
  });
}
