import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  saveSettings: vi.fn().mockResolvedValue(undefined),
  getTerminalCwds: vi.fn().mockResolvedValue({}),
  getClaudeSessionIds: vi.fn().mockResolvedValue({}),
  getCodexSessionIds: vi.fn().mockResolvedValue({}),
  getGrokSessionIds: vi.fn().mockResolvedValue({}),
}));

import {
  getClaudeSessionIds,
  getCodexSessionIds,
  getGrokSessionIds,
  getTerminalCwds,
  saveSettings,
} from "@/lib/tauri-api";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { defaultWidgets } from "@/lib/widget-placement";
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
    useSettingsStore.getState().setPaneClear({ shellCommand: "cls", busyPolicy: "interrupt" });
    useSettingsStore.getState().setGithub({ fontSize: 17 });

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
    expect(snapshot.paneClear).toMatchObject({ shellCommand: "cls", busyPolicy: "interrupt" });
    expect(snapshot.github).toMatchObject({
      fontSize: 17,
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
    snapshot.paneClear = {
      shellCommand: "reset",
      busyPolicy: "restart",
      interruptRounds: 3,
      settleMs: 250,
    };
    snapshot.github = {
      ...useSettingsStore.getState().github,
      fontSize: 19,
    };

    applySettingsSnapshot(snapshot, { includeStructural: false });

    expect(useSettingsStore.getState().appearance.themeId).toBe("github-light");
    expect(useSettingsStore.getState().profiles[0]).toMatchObject({
      cursorBlink: false,
      stabilizeInteractiveCursor: false,
    });
    expect(useSettingsStore.getState().paneClear).toEqual(snapshot.paneClear);
    expect(useSettingsStore.getState().github.fontSize).toBe(19);
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

  it("uses caller-provided revision ignored paths instead of a frontend field list", async () => {
    const expected = await collectSettingsSnapshot();
    const candidate = structuredClone(expected);
    candidate.appearance.themeId = "github-light";
    const workspace = useWorkspaceStore.getState().workspaces[0];
    useWorkspaceStore.getState().renameWorkspace(workspace.id, "Concurrent rename");

    await expect(
      saveAndApplySettingsSnapshot(candidate, {
        includeStructural: false,
        expectedSettings: expected,
        revisionIgnoredPaths: [],
      }),
    ).rejects.toThrow("Settings revision conflict");

    await expect(
      saveAndApplySettingsSnapshot(candidate, {
        includeStructural: false,
        expectedSettings: expected,
        revisionIgnoredPaths: ["/workspaces"],
      }),
    ).resolves.toBeUndefined();
  });

  it("does not repeat backend runtime-state IPC while checking an expected snapshot", async () => {
    const expected = await collectSettingsSnapshot();
    const candidate = structuredClone(expected);
    candidate.appearance.themeId = "github-light";
    vi.clearAllMocks();

    await saveAndApplySettingsSnapshot(candidate, {
      includeStructural: false,
      expectedSettings: expected,
      revisionIgnoredPaths: [
        "/workspaces",
        "/layouts",
        "/docks",
        "/workspaceDisplayOrder",
        "/remote/cloudInstanceId",
        "/remote/cloudTunnelUrl",
        "/remote/cloudServerBaseUrl",
      ],
    });

    expect(getTerminalCwds).not.toHaveBeenCalled();
    expect(getClaudeSessionIds).not.toHaveBeenCalled();
    expect(getCodexSessionIds).not.toHaveBeenCalled();
    expect(getGrokSessionIds).not.toHaveBeenCalled();
    expect(saveSettings).toHaveBeenCalledTimes(1);
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

describe("settings snapshot — widget placement and usage", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    vi.clearAllMocks();
  });

  it("round-trips widget placement through collect and apply", async () => {
    useSettingsStore.getState().setWidgets({
      ...defaultWidgets(),
      fontFamily: "JetBrains Mono",
      fontSize: 12,
      topBar: {
        left: [{ id: "w1", type: "claudeUsage", options: { display: "bar", configDir: "" } }],
        right: [],
      },
      statusLine: { enabled: true, left: [], right: [{ id: "w2", type: "cwd", options: {} }] },
      overflow: "collapse",
    });

    const snapshot = await collectSettingsSnapshot();
    expect(snapshot.widgets.topBar.left[0].options).toEqual({ display: "bar", configDir: "" });
    expect(snapshot.widgets.fontFamily).toBe("JetBrains Mono");
    expect(snapshot.widgets.fontSize).toBe(12);

    useSettingsStore.setState(useSettingsStore.getInitialState());
    applySettingsSnapshot(snapshot, { includeStructural: false });

    const widgets = useSettingsStore.getState().widgets;
    expect(widgets.topBar.left.map((w) => w.id)).toEqual(["w1"]);
    expect(widgets.statusLine.enabled).toBe(true);
    expect(widgets.statusLine.right.map((w) => w.id)).toEqual(["w2"]);
    expect(widgets.fontFamily).toBe("JetBrains Mono");
    expect(widgets.fontSize).toBe(12);
  });

  it("keeps an unknown widget type across a save round trip", async () => {
    // Loading a file from another build must not quietly delete a placement.
    applySettingsSnapshot(
      {
        widgets: {
          topBar: { left: [{ id: "w1", type: "fromTheFuture", options: {} }], right: [] },
          statusLine: { enabled: false, left: [], right: [] },
          overflow: "collapse",
        },
      } as unknown as Parameters<typeof applySettingsSnapshot>[0],
      { includeStructural: false },
    );

    const snapshot = await collectSettingsSnapshot();
    expect(snapshot.widgets.topBar.left[0].type).toBe("fromTheFuture");
  });

  it("carries usage settings so they survive the next save", async () => {
    useSettingsStore.getState().setUsageAgent("claude", { visibleRows: ["session"] });

    const snapshot = await collectSettingsSnapshot();

    expect(snapshot.usage.claude.visibleRows).toEqual(["session"]);
  });

  it("hydrates grok integration settings from disk instead of defaults", () => {
    applySettingsSnapshot(
      {
        grok: {
          command: "grok --yolo",
          restoreSession: false,
          sessionMaxAgeHours: 6,
          statusMessageMode: "title",
        },
      } as unknown as Parameters<typeof applySettingsSnapshot>[0],
      { includeStructural: false },
    );

    expect(useSettingsStore.getState().grok).toMatchObject({
      command: "grok --yolo",
      restoreSession: false,
      sessionMaxAgeHours: 6,
      statusMessageMode: "title",
    });
  });
});

describe("settings snapshot — save/load round trip does not drop sections", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    vi.clearAllMocks();
  });

  it("writes back what it loaded for every settings-owned section", async () => {
    // `save_settings` overwrites the whole document, so any section missing from
    // the snapshot is silently reset on the next save of anything else.
    const loaded = {
      usage: {
        claude: {
          profile: "WSL",
          refreshSeconds: 900,
          configDirs: ["/alt"],
          visibleRows: ["session"],
          colors: { used: "#111111", pace: "#222222", track: "#333333" },
        },
        codex: {
          profile: "",
          refreshSeconds: 600,
          configDirs: [],
          visibleRows: ["weekly"],
          colors: { used: "#444444", pace: "#555555", track: "#666666" },
        },
        grok: {
          profile: "",
          refreshSeconds: 600,
          configDirs: [],
          visibleRows: ["weekly", "credits"],
          colors: { used: "#777777", pace: "#888888", track: "#999999" },
        },
      },
      grok: {
        command: "grok --yolo",
        restoreSession: false,
        sessionMaxAgeHours: 6,
        statusMessageMode: "title",
      },
      widgets: {
        topBar: { left: [{ id: "w1", type: "cwd", options: {} }], right: [] },
        statusLine: { enabled: true, left: [], right: [] },
        overflow: "collapse",
      },
    } as unknown as Parameters<typeof applySettingsSnapshot>[0];

    applySettingsSnapshot(loaded, { includeStructural: false });
    const written = await collectSettingsSnapshot();

    expect(written.usage.claude.profile).toBe("WSL");
    expect(written.usage.claude.configDirs).toEqual(["/alt"]);
    expect(written.usage.claude.visibleRows).toEqual(["session"]);
    expect(written.usage.claude.colors.used).toBe("#111111");
    expect(written.usage.codex.colors.used).toBe("#444444");
    expect(written.usage.grok.visibleRows).toEqual(["weekly", "credits"]);
    expect(written.usage.grok.colors.used).toBe("#777777");
    expect(written.grok.command).toBe("grok --yolo");
    expect(written.grok.restoreSession).toBe(false);
    expect(written.widgets.topBar.left.map((w) => w.id)).toEqual(["w1"]);
    expect(written.widgets.statusLine.enabled).toBe(true);
  });

  it("round-trips the two sleep prevention axes independently", async () => {
    applySettingsSnapshot(
      { power: { keepAwakeWhenBusy: true } } as unknown as Parameters<
        typeof applySettingsSnapshot
      >[0],
      { includeStructural: false },
    );

    expect(useSettingsStore.getState().power).toEqual({
      keepAwake: false,
      keepAwakeWhenBusy: true,
    });
    const snapshot = (await collectSettingsSnapshot()).power;
    expect(snapshot?.keepAwakeWhenBusy).toBe(true);
    expect(snapshot?.keepAwake).toBe(false);
  });

  it("round-trips the update channel", async () => {
    applySettingsSnapshot(
      { update: { channel: "beta" } } as unknown as Parameters<typeof applySettingsSnapshot>[0],
      { includeStructural: false },
    );

    expect(useSettingsStore.getState().update).toEqual({ channel: "beta" });
    expect((await collectSettingsSnapshot()).update?.channel).toBe("beta");
  });

  it("resolves an unknown update channel to stable instead of persisting it", async () => {
    applySettingsSnapshot(
      { update: { channel: "nightly" } } as unknown as Parameters<typeof applySettingsSnapshot>[0],
      { includeStructural: false },
    );

    expect(useSettingsStore.getState().update).toEqual({ channel: "stable" });
    expect((await collectSettingsSnapshot()).update?.channel).toBe("stable");
  });

  it("falls back to off for a hand-edited value instead of reading it for truthiness", async () => {
    applySettingsSnapshot(
      { power: { keepAwake: "true", keepAwakeWhenBusy: 1 } } as unknown as Parameters<
        typeof applySettingsSnapshot
      >[0],
      { includeStructural: false },
    );

    expect(useSettingsStore.getState().power).toEqual({
      keepAwake: false,
      keepAwakeWhenBusy: false,
    });
  });
});
