import { getHandler, isRegisteredInteractiveApp, type RawTerminalState } from "./activity-handler";
import { resolvePaneCwd, type CwdBearingPane } from "./pane-cwd";
import { toPaneId, toTerminalId } from "./pane-ids";
import { CTRL_C, INTERRUPT_ROUND_INTERVAL_MS } from "./terminal-interrupt";
import {
  writeTerminalInput,
  writeToTerminal,
  type PaneClearBusyPolicy,
  type PaneClearSettings,
} from "./tauri-api";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export type PaneClearSkipReason = "busy" | "unsupportedApp" | "notReady";

export type PaneClearActionKind = "submit" | "interruptThenSubmit" | "restart" | "skip";

export interface PaneClearAction {
  paneId: string;
  terminalId: string;
  kind: PaneClearActionKind;
  input?: string;
  reason?: PaneClearSkipReason;
}

export interface ResolvedPaneClear {
  shellCommand: string;
  busyPolicy: PaneClearBusyPolicy;
  interruptRounds: number;
  settleMs: number;
}

export const DEFAULT_PANE_CLEAR: PaneClearSettings = {
  shellCommand: "clear",
  busyPolicy: "skip",
  interruptRounds: 2,
  settleMs: 400,
};

const MIN_ROUNDS = 1;
const MAX_ROUNDS = 10;
const MIN_SETTLE_MS = 0;
const MAX_SETTLE_MS = 10_000;
const BUSY_POLICIES: PaneClearBusyPolicy[] = ["skip", "interrupt", "restart"];

export interface ResolvePaneClearOptions {
  /** Ceiling for waits owned by this module; used by the Automation bridge. */
  maxWaitMs?: number;
}

export interface ClearPaneOptions extends ResolvePaneClearOptions {
  /** Wall-clock allowance after which this run issues no new writes. */
  hardDeadlineMs?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function paneClearWaitBudgetMs(config: ResolvedPaneClear): number {
  if (config.busyPolicy !== "interrupt") return 0;
  return (config.interruptRounds - 1) * INTERRUPT_ROUND_INTERVAL_MS + config.settleMs;
}

export function resolvePaneClear(
  settings?: Partial<PaneClearSettings>,
  options: ResolvePaneClearOptions = {},
): ResolvedPaneClear {
  const policy = settings?.busyPolicy;
  const shellCommand = settings?.shellCommand?.trim();
  const resolved: ResolvedPaneClear = {
    shellCommand: shellCommand || DEFAULT_PANE_CLEAR.shellCommand,
    busyPolicy:
      policy && BUSY_POLICIES.includes(policy as PaneClearBusyPolicy)
        ? (policy as PaneClearBusyPolicy)
        : DEFAULT_PANE_CLEAR.busyPolicy,
    interruptRounds: clamp(
      settings?.interruptRounds ?? DEFAULT_PANE_CLEAR.interruptRounds,
      MIN_ROUNDS,
      MAX_ROUNDS,
    ),
    settleMs: clamp(
      settings?.settleMs ?? DEFAULT_PANE_CLEAR.settleMs,
      MIN_SETTLE_MS,
      MAX_SETTLE_MS,
    ),
  };

  const maxWaitMs = options.maxWaitMs;
  if (maxWaitMs === undefined) return resolved;

  const cappedWaitMs = Math.max(0, maxWaitMs);
  const requestedSettleMs = resolved.settleMs;
  const roundsWait = () => (resolved.interruptRounds - 1) * INTERRUPT_ROUND_INTERVAL_MS;
  while (resolved.interruptRounds > MIN_ROUNDS && roundsWait() > cappedWaitMs) {
    resolved.interruptRounds -= 1;
  }
  resolved.settleMs = Math.max(
    MIN_SETTLE_MS,
    Math.min(requestedSettleMs, cappedWaitMs - roundsWait()),
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

/** Pure activity-aware decision for one registered terminal. */
export function planTerminalClear(
  instance: TerminalInstance,
  config: ResolvedPaneClear,
): PaneClearAction {
  const paneId = toPaneId(instance.id);
  const base = { paneId, terminalId: instance.id };

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

export interface PaneClearResult {
  cleared: string[];
  interrupted: string[];
  restarted: string[];
  skipped: { terminalId: string; reason: PaneClearSkipReason }[];
  failed: { terminalId: string; error: string }[];
}

export function isNoOpPaneClearResult(result: PaneClearResult): boolean {
  return (
    result.cleared.length === 0 && result.interrupted.length === 0 && result.restarted.length === 0
  );
}

export function summarizePaneClearResult(result: PaneClearResult): string {
  const parts = [`cleared ${result.cleared.length}`];
  if (result.interrupted.length > 0) parts.push(`interrupted ${result.interrupted.length}`);
  if (result.restarted.length > 0) parts.push(`restarted ${result.restarted.length}`);
  if (result.skipped.length > 0) {
    const reasons = new Set(result.skipped.map((entry) => entry.reason));
    parts.push(`skipped ${result.skipped.length} (${[...reasons].join(", ")})`);
  }
  if (result.failed.length > 0) parts.push(`failed ${result.failed.length}`);
  return parts.join(", ");
}

export interface RunPaneClearActionDeps {
  action: PaneClearAction;
  config: ResolvedPaneClear;
  submit: (terminalId: string, text: string) => Promise<void>;
  interrupt: (terminalId: string) => Promise<void>;
  restart: (paneId: string) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  deadlineAt?: number;
}

export async function runPaneClearAction(deps: RunPaneClearActionDeps): Promise<PaneClearResult> {
  const result: PaneClearResult = {
    cleared: [],
    interrupted: [],
    restarted: [],
    skipped: [],
    failed: [],
  };
  const { action } = deps;
  const now = deps.now ?? (() => Date.now());
  const outOfTime = () => deps.deadlineAt !== undefined && now() >= deps.deadlineAt;

  try {
    switch (action.kind) {
      case "skip":
        result.skipped.push({ terminalId: action.terminalId, reason: action.reason ?? "busy" });
        return result;
      case "restart":
        deps.restart(action.paneId);
        result.restarted.push(action.terminalId);
        return result;
      case "interruptThenSubmit":
        for (let round = 0; round < deps.config.interruptRounds; round++) {
          if (outOfTime()) throw new Error("pane clear budget elapsed before this Ctrl+C");
          await deps.interrupt(action.terminalId);
          if (result.interrupted.length === 0) result.interrupted.push(action.terminalId);
          if (round < deps.config.interruptRounds - 1) {
            await deps.sleep(INTERRUPT_ROUND_INTERVAL_MS);
          }
        }
        if (deps.config.settleMs > 0) await deps.sleep(deps.config.settleMs);
        if (outOfTime()) throw new Error("pane clear budget elapsed before the clear input");
        await deps.submit(action.terminalId, action.input!);
        result.cleared.push(action.terminalId);
        return result;
      case "submit":
        if (outOfTime()) throw new Error("pane clear budget elapsed before the clear input");
        await deps.submit(action.terminalId, action.input!);
        result.cleared.push(action.terminalId);
        return result;
    }
  } catch (error) {
    result.failed.push({
      terminalId: action.terminalId,
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
}

/** Locate a clearable pane across every workspace and dock. Pane ids are global. */
export function findTerminalPane(paneId: string): CwdBearingPane | null {
  const gridPane = useWorkspaceStore
    .getState()
    .workspaces.flatMap((workspace) => workspace.panes)
    .find((pane) => pane.id === paneId);
  const pane =
    gridPane ??
    useDockStore
      .getState()
      .docks.flatMap((dock) => dock.panes)
      .find((dockPane) => dockPane.id === paneId);
  if (!pane || pane.view.type !== "TerminalView") return null;
  return pane;
}

/** Production entry point for `pane.clearTerminal` and Automation. */
export async function clearPane(
  paneId: string,
  settings?: Partial<PaneClearSettings>,
  options: ClearPaneOptions = {},
): Promise<PaneClearResult> {
  if (!findTerminalPane(paneId)) throw new Error(`Pane '${paneId}' is not a terminal pane`);

  const config = resolvePaneClear(settings, options);
  const terminalId = toTerminalId(paneId);
  const instance = useTerminalStore
    .getState()
    .instances.find((candidate) => candidate.id === terminalId);
  const action: PaneClearAction = instance
    ? planTerminalClear(instance, config)
    : { paneId, terminalId, kind: "skip", reason: "notReady" };
  const deadlineAt =
    options.hardDeadlineMs === undefined ? undefined : Date.now() + options.hardDeadlineMs;

  return runPaneClearAction({
    action,
    config,
    submit: (id, text) => writeTerminalInput(id, text, true),
    interrupt: (id) => writeToTerminal(id, CTRL_C),
    restart: (id) => {
      const pane = findTerminalPane(id);
      useTerminalRestartStore
        .getState()
        .requestRestart(id, pane ? resolvePaneCwd(pane) : undefined);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    deadlineAt,
  });
}
