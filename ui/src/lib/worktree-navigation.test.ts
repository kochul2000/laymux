import { beforeEach, describe, expect, it } from "vitest";
import { focusWorktreeUsage, openWorktreeTerminal } from "./worktree-navigation";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useUiStore } from "@/stores/ui-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import type { WorktreeUsage } from "./worktree-api";

const usage: WorktreeUsage = {
  paneId: "under",
  terminalId: "terminal-under",
  workspaceId: "ws-b",
  workspaceName: "B",
  cwd: "D:/repo",
  kind: "live",
  agentType: "codex",
};
describe("worktree navigation", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorkspaceId: "ws-a",
      workspaces: [
        {
          id: "ws-a",
          name: "A",
          panes: [
            {
              id: "a",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              activeLayerId: "a",
              layers: [{ id: "a", view: { type: "WorktreeView" } }],
            },
          ],
        },
        {
          id: "ws-b",
          name: "B",
          panes: [
            {
              id: "b",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              activeLayerId: "b",
              layers: [
                { id: "b", view: { type: "TerminalView" } },
                { id: "under", view: { type: "TerminalView" } },
              ],
            },
          ],
        },
      ],
    });
    useUiStore.setState({
      hiddenWorkspaceIds: new Set(["ws-b"]),
      hiddenPaneIds: new Set(["under", "b"]),
      evictedPaneIds: new Set(["under", "b"]),
    });
    useDockStore.setState(useDockStore.getInitialState());
    useGridStore.setState({ focusedPaneIndex: null });
    useTerminalRestartStore.setState({ requests: {} });
    const profile = useSettingsStore.getInitialState().profiles[0];
    useSettingsStore.setState({
      defaultProfile: "PowerShell",
      profiles: [
        { ...profile, name: "PowerShell", commandLine: "powershell.exe -NoLogo" },
        { ...profile, name: "Ubuntu", commandLine: "wsl.exe -d Ubuntu-22.04" },
      ],
    });
    useTerminalStore.setState({ instances: [] });
  });
  it("숨긴 workspace의 비활성 stack을 드러내고 해당 터미널만 재활성화한다", () => {
    useDockStore.getState().setFocusedDock("left");
    expect(focusWorktreeUsage(usage)).toBe(true);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-b");
    expect(useWorkspaceStore.getState().workspaces[1].panes[0].activeLayerId).toBe("under");
    expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-b")).toBe(false);
    expect(useUiStore.getState().hiddenPaneIds.has("under")).toBe(false);
    expect(useUiStore.getState().evictedPaneIds.has("under")).toBe(false);
    expect(useUiStore.getState().hiddenPaneIds.has("b")).toBe(true);
    expect(useUiStore.getState().evictedPaneIds.has("b")).toBe(true);
    expect(useDockStore.getState().focusedDock).toBeNull();
  });
  it("화면 연결이 없는 데몬 정보는 현재 포커스를 바꾸지 않는다", () => {
    expect(focusWorktreeUsage({ ...usage, paneId: null, kind: "daemon" })).toBe(false);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-a");
  });
  it("새 터미널은 명시한 worktree CWD로 시작하고 기존 view와 sync group을 보존한다", () => {
    const createdId = openWorktreeTerminal("D:/selected-worktree", "a");
    const slot = useWorkspaceStore.getState().getActiveWorkspace()!.panes[0];
    expect(slot.layers[0].view.type).toBe("WorktreeView");
    const created = slot.layers[1];
    expect(created.id).toBe(createdId);
    expect(created.view).toMatchObject({
      type: "TerminalView",
      lastCwd: "D:/selected-worktree",
      syncGroup: "none",
      cwdSend: false,
      cwdReceive: false,
    });
    expect(slot.activeLayerId).toBe(created.id);
    expect(useTerminalRestartStore.getState().requests[created.id]).toMatchObject({
      cwd: "D:/selected-worktree",
      fresh: true,
    });
  });

  it.each([
    ["//wsl.localhost/Ubuntu-22.04/tmp/worktree", "/tmp/worktree"],
    ["\\\\wsl$\\Ubuntu-22.04\\home\\worktree", "/home/worktree"],
    ["//wsl.localhost/Ubuntu-22.04/home/repo\\name", "/home/repo\\name"],
  ])("WSL 워크트리 %s는 같은 배포판의 guest CWD에서 시작한다", (path, cwd) => {
    const createdId = openWorktreeTerminal(path, "a");
    const created = useWorkspaceStore.getState().getActiveWorkspace()!.panes[0].layers[1];
    expect(created.id).toBe(createdId);
    expect(created.view).toMatchObject({ profile: "Ubuntu", lastCwd: cwd });
    expect(useTerminalRestartStore.getState().requests[created.id]).toMatchObject({ cwd });
  });

  it("기본 WSL 프로필의 native 경로는 기존 터미널 시작 변환에 맡긴다", () => {
    useSettingsStore.setState({ defaultProfile: "Ubuntu" });
    const createdId = openWorktreeTerminal("D:/selected-worktree", "a");
    const created = useWorkspaceStore.getState().getActiveWorkspace()!.panes[0].layers[1];
    expect(created.id).toBe(createdId);
    expect(created.view).toMatchObject({ profile: "Ubuntu", lastCwd: "D:/selected-worktree" });
    expect(useTerminalRestartStore.getState().requests[created.id]).toMatchObject({
      cwd: "D:/selected-worktree",
    });
  });
});
