import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "./settings-store";
import { useWorkspaceStore } from "./workspace-store";
import { useTerminalRestartStore } from "./terminal-restart-store";
import { useTerminalStore } from "./terminal-store";
import { activeLayer } from "@/lib/pane-layers";

vi.mock("@/lib/persist-session", () => ({ persistSession: vi.fn() }));

describe("분할·stack 프로필 상속", () => {
  it("명시 CWD는 새 레이어를 공개하는 순간부터 상속 표식 없이 준비된다", () => {
    let published: unknown;
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      const layers = state.getActiveWorkspace()!.panes[0].layers;
      if (layers.length > 1)
        published = useTerminalRestartStore.getState().requests[layers.at(-1)!.id];
    });
    try {
      useWorkspaceStore.getState().stackPane(0, { type: "TerminalView", lastCwd: "/explicit" });
      expect(published).toEqual({ epoch: 1, cwd: "/explicit", fresh: true });
    } finally {
      unsubscribe();
    }
  });
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useTerminalRestartStore.setState({ requests: {} });
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useWorkspaceStore.getState().setPaneView(0, {
      type: "TerminalView",
      profile: "WSL",
      lastCwd: "/repo",
      lastClaudeSession: "source",
      lastCodexSession: "source",
      lastGrokSession: "source",
      syncGroup: "private",
      font: { size: 30 },
    });
  });

  it.each(["horizontal", "vertical", "stack"] as const)(
    "%s는 프로필만 선택하고 CWD 시드를 유지한다",
    (action) => {
      const state = useWorkspaceStore.getState();
      if (action === "stack") state.stackPane(0);
      else state.splitPane(0, action);
      const slot = useWorkspaceStore.getState().getActiveWorkspace()!.panes[
        action === "stack" ? 0 : 1
      ];
      const layer = activeLayer(slot);
      expect(layer.view).toEqual({ type: "TerminalView", profile: "WSL" });
      expect(useTerminalRestartStore.getState().requests[layer.id]?.cwd).toBe("/repo");
      expect(useTerminalRestartStore.getState().requests[layer.id]?.cwdSourceProfile).toBe("WSL");
    },
  );

  it.each(["horizontal", "vertical", "stack"] as const)(
    "옵션을 끄면 %s는 Empty로 열린다",
    (action) => {
      useSettingsStore.getState().setTerminal({ inheritProfileOnSplit: false });
      const state = useWorkspaceStore.getState();
      if (action === "stack") state.stackPane(0);
      else state.splitPane(0, action);
      const slot = useWorkspaceStore.getState().getActiveWorkspace()!.panes[
        action === "stack" ? 0 : 1
      ];
      expect(activeLayer(slot).view).toEqual({ type: "EmptyView" });
    },
  );

  it("활성 레이어를 기준으로 삼고 명시한 view와 프로필을 보존한다", () => {
    const state = useWorkspaceStore.getState();
    state.stackPane(0, { type: "TerminalView", profile: "PowerShell" });
    state.splitPane(0, "vertical");
    expect(
      activeLayer(useWorkspaceStore.getState().getActiveWorkspace()!.panes[1]).view.profile,
    ).toBe("PowerShell");
    const id = state.stackPane(0, { type: "MemoView" })!;
    expect(
      useWorkspaceStore
        .getState()
        .getActiveWorkspace()!
        .panes[0].layers.find((l) => l.id === id)!.view,
    ).toEqual({ type: "MemoView" });
  });

  it.each(["horizontal", "vertical", "stack"] as const)(
    "%s는 저장된 프로필보다 실행 중 프로필을 우선한다",
    (action) => {
      const state = useWorkspaceStore.getState();
      const source = activeLayer(state.getActiveWorkspace()!.panes[0]);
      useTerminalStore
        .getState()
        .registerInstance({ id: `terminal-${source.id}`, profile: "Runtime", syncGroup: "none" });
      if (action === "stack") state.stackPane(0);
      else state.splitPane(0, action);
      const slot = state.getActiveWorkspace()!.panes[action === "stack" ? 0 : 1];
      expect(activeLayer(slot).view).toEqual({ type: "TerminalView", profile: "Runtime" });
    },
  );

  it("터미널이 아닌 원본은 Empty로 열린다", () => {
    const state = useWorkspaceStore.getState();
    state.setPaneView(0, { type: "MemoView" });
    state.stackPane(0);
    expect(activeLayer(useWorkspaceStore.getState().getActiveWorkspace()!.panes[0]).view.type).toBe(
      "EmptyView",
    );
  });
});
