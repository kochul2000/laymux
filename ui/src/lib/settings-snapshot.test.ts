import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  saveSettings: vi.fn().mockResolvedValue(undefined),
  getTerminalCwds: vi.fn().mockResolvedValue({}),
  getClaudeSessionIds: vi.fn().mockResolvedValue({}),
}));

import { saveSettings } from "@/lib/tauri-api";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  applySettingsSnapshot,
  collectSettingsSnapshot,
  saveAndApplySettingsSnapshot,
} from "./settings-snapshot";

describe("settings snapshot", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    vi.clearAllMocks();
  });

  it("collects all settings/workspace/dock stores without persisting", async () => {
    useSettingsStore.getState().setTerminal({
      pathLinkEnabled: false,
      pathLinkMaxLength: 1024,
      showScrollToBottomButton: false,
    });
    useSettingsStore.getState().setProfileDefaults({
      cursorBlink: false,
      stabilizeInteractiveCursor: false,
      maxOutputCacheKB: 512,
    });

    const snapshot = await collectSettingsSnapshot();

    expect(saveSettings).not.toHaveBeenCalled();
    expect(snapshot.terminal).toMatchObject({
      pathLinkEnabled: false,
      pathLinkMaxLength: 1024,
      showScrollToBottomButton: false,
    });
    expect(snapshot.profileDefaults).toMatchObject({
      cursorBlink: false,
      stabilizeInteractiveCursor: false,
      maxOutputCacheKB: 512,
    });
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.layouts).toHaveLength(1);
    expect(snapshot.docks).toHaveLength(4);
  });

  it("applies validated preference settings to the live stores", async () => {
    const snapshot = await collectSettingsSnapshot();
    snapshot.appearance.themeId = "github-light";
    snapshot.profiles[0].cursorBlink = false;
    snapshot.profiles[0].stabilizeInteractiveCursor = false;

    applySettingsSnapshot(snapshot, { includeStructural: false });

    expect(useSettingsStore.getState().appearance.themeId).toBe("github-light");
    expect(useSettingsStore.getState().profiles[0]).toMatchObject({
      cursorBlink: false,
      stabilizeInteractiveCursor: false,
    });
  });

  it("saves before applying so a persistence failure leaves runtime state unchanged", async () => {
    const snapshot = await collectSettingsSnapshot();
    snapshot.appearance.themeId = "github-light";
    vi.mocked(saveSettings).mockRejectedValueOnce(new Error("disk full"));

    await expect(
      saveAndApplySettingsSnapshot(snapshot, { includeStructural: false }),
    ).rejects.toThrow("disk full");

    expect(useSettingsStore.getState().appearance.themeId).toBe("catppuccin-mocha");
  });

  it("persists once and does not replace structural stores for generic settings updates", async () => {
    const originalWorkspaceName = useWorkspaceStore.getState().workspaces[0].name;
    const snapshot = await collectSettingsSnapshot();
    snapshot.appearance.themeId = "github-light";
    snapshot.workspaces[0].name = "must-not-apply";

    await saveAndApplySettingsSnapshot(snapshot, { includeStructural: false });

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith(snapshot);
    expect(useSettingsStore.getState().appearance.themeId).toBe("github-light");
    expect(useWorkspaceStore.getState().workspaces[0].name).toBe(originalWorkspaceName);
  });

  it("rejects a stale expected settings snapshot before persisting", async () => {
    const expected = await collectSettingsSnapshot();
    const candidate = structuredClone(expected);
    candidate.appearance.themeId = "github-light";
    useSettingsStore.getState().setAppearance({ themeId: "dracula" });

    await expect(
      saveAndApplySettingsSnapshot(candidate, {
        includeStructural: false,
        expectedSettings: expected,
      }),
    ).rejects.toThrow("Settings revision conflict");

    expect(saveSettings).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().appearance.themeId).toBe("dracula");
  });

  it("restores the latest store snapshot when settings change during persistence", async () => {
    let finishFirstSave: (() => void) | undefined;
    vi.mocked(saveSettings)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstSave = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const expected = await collectSettingsSnapshot();
    const candidate = structuredClone(expected);
    candidate.appearance.themeId = "github-light";

    const applying = saveAndApplySettingsSnapshot(candidate, {
      includeStructural: false,
      expectedSettings: expected,
    });
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    useSettingsStore.getState().setAppearance({ themeId: "dracula" });
    finishFirstSave?.();

    await expect(applying).rejects.toThrow("Settings revision conflict");
    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveSettings).mock.calls[1][0].appearance.themeId).toBe("dracula");
    expect(useSettingsStore.getState().appearance.themeId).toBe("dracula");
  });

  it("preserves the active workspace when applying a full structural snapshot", async () => {
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    const secondId = useWorkspaceStore.getState().workspaces[1].id;
    useWorkspaceStore.getState().setActiveWorkspace(secondId);
    const snapshot = await collectSettingsSnapshot();

    applySettingsSnapshot(snapshot, { includeStructural: true });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(secondId);
  });
});
