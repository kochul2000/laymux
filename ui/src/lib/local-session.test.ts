import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { saveLocalSession, applyLocalUiState } from "./local-session";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useTerminalDisplayStore } from "@/stores/terminal-display-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { projectWorkspaceTerminals } from "./workspace-summary";
import type { Settings } from "./tauri-api";
import type { Workspace } from "@/stores/types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useTerminalDisplayStore.setState({ contexts: {} });
});
it("round trips saved display and submitted input for unmounted workspaces without live authority", async () => {
  const workspace: Workspace = {
    id: "saved",
    name: "Saved",
    panes: [
      {
        id: "slot",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        activeLayerId: "saved-layer",
        layers: [{ id: "saved-layer", view: { type: "TerminalView", profile: "PowerShell" } }],
      },
    ],
  };
  const settings = {
    workspaces: [workspace],
    docks: [],
  } as unknown as Settings;
  useTerminalStore.getState().registerInstance({
    id: "terminal-saved-layer",
    profile: "PowerShell",
    workspaceId: "saved",
    syncGroup: "saved",
  });
  useTerminalStore.getState().updateInstanceInfo("terminal-saved-layer", {
    activity: { type: "interactiveApp", name: "Codex" },
    lastUserInput: "previous question",
    lastUserInputAt: 123,
  });
  vi.mocked(invoke).mockResolvedValue({ revision: 2, needsRetry: false });
  await saveLocalSession(settings, [], false, false);
  const sent = vi.mocked(invoke).mock.calls[0][1] as {
    snapshot: Parameters<typeof applyLocalUiState>[0];
  };
  useTerminalStore.setState({ instances: [] });
  useTerminalDisplayStore.setState({ contexts: {} });
  useWorkspaceStore.setState({ workspaces: [workspace] });
  applyLocalUiState(sent.snapshot);
  const terminals = projectWorkspaceTerminals(
    "saved",
    workspace.panes,
    [],
    useTerminalDisplayStore.getState().contexts,
  );
  expect(terminals[0]).toMatchObject({
    activity: { type: "interactiveApp", name: "Codex" },
    lastUserInput: "previous question",
    lastUserInputAt: 123,
  });
  expect(useTerminalStore.getState().instances).toEqual([]);
  // Another save before visiting this workspace must retain its display.
  await saveLocalSession(settings, [], false, false);
  expect(invoke).toHaveBeenLastCalledWith(
    "save_session_checkpoint",
    expect.objectContaining({
      snapshot: expect.objectContaining({
        uiState: expect.objectContaining({
          terminalDisplayContexts: expect.objectContaining({
            "terminal-saved-layer": expect.objectContaining({ lastUserInput: "previous question" }),
          }),
        }),
      }),
    }),
  );
});
it("restores only existing local workspace selection and explicitly saved file viewer state", () => {
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  useFileViewerStore.setState(useFileViewerStore.getInitialState());
  const base = useWorkspaceStore.getState().workspaces[0];
  useWorkspaceStore.setState({ workspaces: [base, { ...base, id: "local-second" }] });
  applyLocalUiState({
    uiState: {
      activeWorkspaceId: "local-second",
      fileViewer: { open: true, path: "/tmp/local-file.md", maximized: true },
    },
  });
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("local-second");
  expect(useFileViewerStore.getState()).toMatchObject({
    open: true,
    path: "/tmp/local-file.md",
    maximized: true,
  });
  applyLocalUiState({ uiState: { activeWorkspaceId: "deleted-workspace" } });
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("local-second");
});
it("sends only local session fields to the checkpoint command", async () => {
  const settings = {
    language: "ko",
    profiles: [{ name: "local", commandLine: "secret host command" }],
    workspaces: [],
    docks: [],
    remote: { authToken: "host secret" },
  } as unknown as Settings;
  vi.mocked(invoke).mockResolvedValue({ revision: 2, needsRetry: false });
  await saveLocalSession(settings, [], false, false);
  expect(invoke).toHaveBeenCalledWith("save_session_checkpoint", {
    snapshot: expect.objectContaining({
      workspaces: [],
      docks: [],
      workspaceDisplayOrder: undefined,
      coverage: [],
      attributionLookupFailed: false,
      cwdLookupFailed: false,
      uiState: expect.any(Object),
    }),
  });
  const sent = vi.mocked(invoke).mock.calls[0][1] as { snapshot: Record<string, unknown> };
  expect(sent.snapshot).not.toHaveProperty("profiles");
  expect(sent.snapshot).not.toHaveProperty("remote");
});
