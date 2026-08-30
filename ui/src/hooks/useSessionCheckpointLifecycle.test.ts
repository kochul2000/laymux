import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unlisten = vi.fn();
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
}));

vi.mock("@/lib/persist-session", () => ({
  flushSessionCheckpoint: vi.fn().mockResolvedValue({
    checkpointCommitId: 17,
    frontendMutationRevision: 4,
    coverage: [],
  }),
  markSessionCheckpointMutation: vi.fn(),
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { acknowledgeSessionCheckpoint, onSessionCheckpointRequested } from "@/lib/tauri-api";
import {
  flushSessionCheckpoint,
  markSessionCheckpointMutation,
  persistSession,
} from "@/lib/persist-session";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useSessionCheckpointLifecycle } from "./useSessionCheckpointLifecycle";

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

  it("acks a native update request only after the critical checkpoint commits", async () => {
    renderHook(() => useSessionCheckpointLifecycle(true));
    await vi.waitFor(() => expect(onSessionCheckpointRequested).toHaveBeenCalledTimes(1));

    nativeListener?.({ requestId: 9, reason: "update", requireConclusive: true });

    await vi.waitFor(() => expect(acknowledgeSessionCheckpoint).toHaveBeenCalledWith(9, 17));
    expect(flushSessionCheckpoint).toHaveBeenCalledWith({
      reason: "update",
      requireConclusive: true,
      terminalIds: undefined,
    });
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
              view: { type: "TerminalView" },
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
