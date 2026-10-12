import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { saveLocalSession, applyLocalUiState } from "./local-session";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import type { Settings } from "./tauri-api";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
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
