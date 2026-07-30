import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";
import { getTerminalRestartCwd } from "./terminal-restart";

describe("getTerminalRestartCwd", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
  });

  it("현재 터미널 CWD를 저장된 CWD보다 우선한다", () => {
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-1",
      profile: "PowerShell",
      syncGroup: "ws-1",
      workspaceId: "ws-1",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-1", { cwd: "C:\\current" });

    expect(
      getTerminalRestartCwd("pane-1", {
        type: "TerminalView",
        lastCwd: "C:\\saved",
      }),
    ).toBe("C:\\current");
  });

  it("현재 CWD가 아직 없으면 저장된 CWD를 사용한다", () => {
    expect(
      getTerminalRestartCwd("pane-1", {
        type: "TerminalView",
        lastCwd: "C:\\saved",
      }),
    ).toBe("C:\\saved");
  });
});
