import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";
import { resolvePaneCwd } from "./pane-cwd";

function registerTerminalCwd(paneId: string, cwd: string) {
  useTerminalStore.getState().registerInstance({
    id: `terminal-${paneId}`,
    profile: "PowerShell",
    syncGroup: "ws-1",
    workspaceId: "ws-1",
  });
  useTerminalStore.getState().updateInstanceInfo(`terminal-${paneId}`, { cwd });
}

describe("resolvePaneCwd", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
  });

  it("현재 터미널 CWD를 저장된 CWD보다 우선한다", () => {
    registerTerminalCwd("pane-1", "C:\\current");

    expect(
      resolvePaneCwd({
        id: "pane-1",
        view: { type: "TerminalView", lastCwd: "C:\\saved" },
      }),
    ).toBe("C:\\current");
  });

  it("현재 CWD가 아직 없으면 저장된 CWD를 사용한다", () => {
    expect(
      resolvePaneCwd({
        id: "pane-1",
        view: { type: "TerminalView", lastCwd: "C:\\saved" },
      }),
    ).toBe("C:\\saved");
  });

  it("CWD 개념이 없는 view 는 undefined", () => {
    expect(resolvePaneCwd({ id: "pane-1", view: { type: "MemoView" } })).toBeUndefined();
  });

  it("FileExplorerView 처럼 다른 prefix 를 쓰는 view 도 저장된 CWD 로 해석한다", () => {
    expect(
      resolvePaneCwd({
        id: "pane-2",
        view: { type: "FileExplorerView", lastCwd: "/home/user/project" },
      }),
    ).toBe("/home/user/project");
  });
});
