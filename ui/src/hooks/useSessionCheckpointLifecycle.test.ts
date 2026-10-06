import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unlisten = vi.fn();
vi.mock("@/lib/codex-status-probe", () => ({
  withCodexStatusCheckpoint: vi.fn(
    (_enabled: boolean, _request: number, checkpoint: () => Promise<unknown>) => checkpoint(),
  ),
}));
let deferListenerRegistration = false;
let finishListenerRegistration: (() => void) | undefined;
let nativeListener:
  | ((request: {
      requestId: number;
      reason: "watchdog" | "update" | "eviction";
      requireConclusive: boolean;
      terminalIds?: string[];
    }) => void)
  | undefined;

vi.mock("@/lib/tauri-api", () => ({
  onSessionCheckpointRequested: vi.fn().mockImplementation((listener) => {
    nativeListener = listener;
    if (!deferListenerRegistration) return Promise.resolve(unlisten);
    return new Promise<() => void>((resolve) => {
      finishListenerRegistration = () => resolve(unlisten);
    });
  }),
  acknowledgeSessionCheckpoint: vi.fn().mockResolvedValue(undefined),
  onAppUpdateStatusChanged: vi.fn().mockResolvedValue(() => {}),
  getAppUpdateStatus: vi.fn().mockResolvedValue({
    operation: "preparing",
    exitSettings: { interruptTerminals: true, interruptRounds: 2, settleMs: 500 },
  }),
  reportAppUpdatePreparation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/persist-session", () => ({
  flushSessionCheckpoint: vi.fn().mockResolvedValue({
    checkpointCommitId: 17,
    frontendMutationRevision: 4,
    coverage: [],
  }),
  prepareTerminalExit: vi.fn().mockResolvedValue(undefined),
  setPreparingUpdate: vi.fn(),
  markSessionCheckpointMutation: vi.fn(),
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import {
  acknowledgeSessionCheckpoint,
  onSessionCheckpointRequested,
  onAppUpdateStatusChanged,
  type AppUpdateStatus,
} from "@/lib/tauri-api";
import {
  flushSessionCheckpoint,
  prepareTerminalExit,
  setPreparingUpdate,
  markSessionCheckpointMutation,
  persistSession,
} from "@/lib/persist-session";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { claimHiddenEvictionEligibility } from "@/lib/hidden-eviction-eligibility";
import { useSessionCheckpointLifecycle } from "./useSessionCheckpointLifecycle";
import { withCodexStatusCheckpoint } from "@/lib/codex-status-probe";

describe("useSessionCheckpointLifecycle", () => {
  beforeEach(() => {
    nativeListener = undefined;
    deferListenerRegistration = false;
    finishListenerRegistration = undefined;
    vi.clearAllMocks();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("blocks background persistence for a forced update without a checkpoint request", () => {
    renderHook(() => useSessionCheckpointLifecycle(true));
    const listener = vi.mocked(onAppUpdateStatusChanged).mock.calls[0][0];
    listener({ operation: "preparing" } as AppUpdateStatus);
    expect(setPreparingUpdate).toHaveBeenLastCalledWith(true);
    expect(flushSessionCheckpoint).not.toHaveBeenCalled();
    listener({ operation: "installing" } as AppUpdateStatus);
    expect(setPreparingUpdate).toHaveBeenLastCalledWith(true);
    listener({ operation: "idle" } as AppUpdateStatus);
    expect(setPreparingUpdate).toHaveBeenLastCalledWith(false);
  });

  it("acks a native update request only after the critical checkpoint commits", async () => {
    renderHook(() => useSessionCheckpointLifecycle(true));
    await vi.waitFor(() => expect(onSessionCheckpointRequested).toHaveBeenCalledTimes(1));

    nativeListener?.({ requestId: 9, reason: "update", requireConclusive: true });
    await vi.waitFor(() =>
      expect(withCodexStatusCheckpoint).toHaveBeenCalledWith(true, 9, expect.any(Function)),
    );

    await vi.waitFor(() => expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(9, 17));
    expect(flushSessionCheckpoint).toHaveBeenCalledWith({
      reason: "update",
      requireConclusive: true,
      terminalIds: undefined,
    });
  });

  it("returns the pane and manual retry guidance to the PC updater without tearing down tasks", async () => {
    const message =
      "Codex 확인 실패 [백엔드 · pane 2 · API 작업]\n표시된 pane의 작업을 수동으로 종료한 뒤 다시 시도하세요.";
    vi.mocked(withCodexStatusCheckpoint).mockRejectedValueOnce(new Error(message));
    renderHook(() => useSessionCheckpointLifecycle(true));
    await vi.waitFor(() => expect(onSessionCheckpointRequested).toHaveBeenCalledTimes(1));
    nativeListener?.({ requestId: 29, reason: "update", requireConclusive: true });
    await vi.waitFor(() =>
      expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(29, undefined, message),
    );
    expect(flushSessionCheckpoint).not.toHaveBeenCalled();
    expect(prepareTerminalExit).not.toHaveBeenCalled();
    expect(setPreparingUpdate).toHaveBeenLastCalledWith(false);
  });

  it("fences optional status verification under the original update request before saving", async () => {
    useSettingsStore.setState((state) => ({
      codex: { ...state.codex, restoreSession: true, verifySessionOnExit: true },
    }));
    let finishProbe!: () => void;
    vi.mocked(withCodexStatusCheckpoint).mockImplementationOnce(
      async (_enabled, _id, checkpoint) => {
        await new Promise<void>((resolve) => {
          finishProbe = resolve;
        });
        return checkpoint();
      },
    );
    renderHook(() => useSessionCheckpointLifecycle(true));
    await vi.waitFor(() => expect(onSessionCheckpointRequested).toHaveBeenCalledTimes(1));
    nativeListener?.({ requestId: 42, reason: "update", requireConclusive: true });
    expect(setPreparingUpdate).toHaveBeenCalledWith(true);
    expect(withCodexStatusCheckpoint).toHaveBeenCalledWith(true, 42, expect.any(Function));
    expect(flushSessionCheckpoint).not.toHaveBeenCalled();
    finishProbe();
    await vi.waitFor(() => expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(42, 17));
    expect(flushSessionCheckpoint).toHaveBeenCalledWith({
      reason: "update",
      requireConclusive: true,
      terminalIds: undefined,
    });
  });

  it("does not inject status for a watchdog request even with the option enabled", async () => {
    useSettingsStore.setState((state) => ({
      codex: { ...state.codex, restoreSession: true, verifySessionOnExit: true },
    }));
    renderHook(() => useSessionCheckpointLifecycle(true));
    await vi.waitFor(() => expect(onSessionCheckpointRequested).toHaveBeenCalledTimes(1));
    nativeListener?.({ requestId: 43, reason: "watchdog", requireConclusive: false });
    await vi.waitFor(() => expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(43, 17));
    expect(withCodexStatusCheckpoint).toHaveBeenCalledWith(false, 43, expect.any(Function));
  });

  it("error-acks a request delivered to a listener cancelled during StrictMode registration", async () => {
    deferListenerRegistration = true;
    const { unmount } = renderHook(() => useSessionCheckpointLifecycle(true));
    await vi.waitFor(() => expect(nativeListener).toBeDefined());
    unmount();

    nativeListener?.({ requestId: 12, reason: "update", requireConclusive: true });
    finishListenerRegistration?.();

    await vi.waitFor(() =>
      expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(
        12,
        undefined,
        "session checkpoint listener cancelled",
      ),
    );
    expect(flushSessionCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects an eviction checkpoint when its target became visible before ACK", async () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    renderHook(() => useSessionCheckpointLifecycle(true));
    await vi.waitFor(() => expect(onSessionCheckpointRequested).toHaveBeenCalledTimes(1));

    nativeListener?.({
      requestId: 10,
      reason: "eviction",
      requireConclusive: true,
      terminalIds: ["terminal-visible-pane"],
    });

    await vi.waitFor(() =>
      expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(
        10,
        undefined,
        "hidden terminal eviction target is no longer eligible",
      ),
    );
  });

  it("acks a targeted eviction while the pane remains hidden", async () => {
    const eligibility = claimHiddenEvictionEligibility();
    eligibility.publish(new Set(["p-hidden"]));
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-hidden",
          name: "Hidden",
          panes: [
            {
              id: "p-hidden",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              layers: [{ id: "p-hidden", view: { type: "TerminalView" } }],
              activeLayerId: "p-hidden",
            },
          ],
        },
      ],
      activeWorkspaceId: null,
    });
    useUiStore.getState().setWorkspaceHidden("ws-hidden", true);
    renderHook(() => useSessionCheckpointLifecycle(true));
    await vi.waitFor(() => expect(onSessionCheckpointRequested).toHaveBeenCalledTimes(1));

    nativeListener?.({
      requestId: 11,
      reason: "eviction",
      requireConclusive: true,
      terminalIds: ["terminal-p-hidden"],
    });

    await vi.waitFor(() => expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(11, 17));
    expect(flushSessionCheckpoint).toHaveBeenCalledWith({
      reason: "eviction",
      requireConclusive: true,
      terminalIds: ["terminal-p-hidden"],
    });
    eligibility.release();
  });

  it("rejects an eviction when a longer timeout makes the target unexpired before ACK", async () => {
    let finishCheckpoint: (() => void) | undefined;
    vi.mocked(flushSessionCheckpoint).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheckpoint = () =>
            resolve({ checkpointCommitId: 17, frontendMutationRevision: 4, coverage: [] });
        }),
    );
    const eligibility = claimHiddenEvictionEligibility();
    eligibility.publish(new Set(["p-hidden"]));
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    renderHook(() => useSessionCheckpointLifecycle(true));
    await vi.waitFor(() => expect(onSessionCheckpointRequested).toHaveBeenCalledTimes(1));

    nativeListener?.({
      requestId: 13,
      reason: "eviction",
      requireConclusive: true,
      terminalIds: ["terminal-p-hidden"],
    });
    eligibility.publish(new Set());
    finishCheckpoint?.();

    await vi.waitFor(() =>
      expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(
        13,
        undefined,
        "hidden terminal eviction target is no longer eligible",
      ),
    );
    eligibility.release();
  });

  it("marks structural revisions and checkpoints workspace entry", async () => {
    renderHook(() => useSessionCheckpointLifecycle(true));
    const workspace = useWorkspaceStore.getState().workspaces[0];
    act(() => useWorkspaceStore.getState().renameWorkspace(workspace.id, "Renamed"));
    expect(markSessionCheckpointMutation).toHaveBeenCalled();

    act(() => useWorkspaceStore.getState().addWorkspace("Second", "default-layout"));
    const second = useWorkspaceStore.getState().workspaces[1];
    act(() => useWorkspaceStore.getState().setActiveWorkspace(second.id));
    expect(persistSession).toHaveBeenCalledWith({ reason: "workspaceEntry" });
  });

  it("runs an initial workspace-entry catch-up after the resume grace", () => {
    vi.useFakeTimers();
    renderHook(() => useSessionCheckpointLifecycle(true));
    expect(persistSession).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(15_000));

    expect(persistSession).toHaveBeenCalledWith({ reason: "workspaceEntry" });
  });
});

it("does not ACK success until task cleanup and history saving finish", async () => {
  let finish!: () => void;
  vi.mocked(prepareTerminalExit).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(acknowledgeSessionCheckpoint).mockClear();
  renderHook(() => useSessionCheckpointLifecycle(true));
  await vi.waitFor(() => expect(nativeListener).toBeDefined());
  nativeListener?.({ requestId: 91, reason: "update", requireConclusive: true });
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(setPreparingUpdate).toHaveBeenCalledWith(true);
  expect(prepareTerminalExit).toHaveBeenLastCalledWith(expect.any(Function), {
    interruptTerminals: true,
    interruptRounds: 2,
    settleMs: 500,
  });
  expect(acknowledgeSessionCheckpoint).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(91, 17));
});
it("rejects installation when output preparation fails", async () => {
  vi.mocked(prepareTerminalExit).mockRejectedValueOnce(new Error("cache failed"));
  renderHook(() => useSessionCheckpointLifecycle(true));
  await vi.waitFor(() => expect(nativeListener).toBeDefined());
  nativeListener?.({ requestId: 92, reason: "update", requireConclusive: true });
  await vi.waitFor(() =>
    expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(92, undefined, "cache failed"),
  );
});
