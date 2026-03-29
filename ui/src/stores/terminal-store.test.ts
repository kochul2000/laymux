import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalStore } from "./terminal-store";

describe("TerminalStore", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
  });

  it("starts with no terminal instances", () => {
    expect(useTerminalStore.getState().instances).toHaveLength(0);
  });

  it("registers a terminal instance with new fields", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "project-a",
      workspaceId: "ws-1",
      label: "PS",
    });
    const inst = useTerminalStore.getState().instances[0];
    expect(inst.id).toBe("t1");
    expect(inst.workspaceId).toBe("ws-1");
    expect(inst.label).toBe("PS");
    expect(inst.lastActivityAt).toBeGreaterThan(0);
    expect(inst.isFocused).toBe(false);
  });

  it("registers with default label from profile when label not provided", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws-1",
    });
    expect(useTerminalStore.getState().instances[0].label).toBe("WSL");
  });

  it("unregisters a terminal instance", () => {
    const { registerInstance } = useTerminalStore.getState();
    registerInstance({ id: "t1", profile: "WSL", syncGroup: "", workspaceId: "ws-1" });
    registerInstance({ id: "t2", profile: "WSL", syncGroup: "", workspaceId: "ws-1" });

    useTerminalStore.getState().unregisterInstance("t1");
    expect(useTerminalStore.getState().instances).toHaveLength(1);
    expect(useTerminalStore.getState().instances[0].id).toBe("t2");
  });

  it("gets instances by sync group", () => {
    const { registerInstance } = useTerminalStore.getState();
    registerInstance({ id: "t1", profile: "WSL", syncGroup: "group-a", workspaceId: "ws-1" });
    registerInstance({ id: "t2", profile: "WSL", syncGroup: "group-a", workspaceId: "ws-1" });
    registerInstance({ id: "t3", profile: "WSL", syncGroup: "group-b", workspaceId: "ws-2" });

    const groupA = useTerminalStore.getState().getInstancesBySyncGroup("group-a");
    expect(groupA).toHaveLength(2);

    const groupB = useTerminalStore.getState().getInstancesBySyncGroup("group-b");
    expect(groupB).toHaveLength(1);
  });

  it("updates terminal info (cwd, branch)", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws-1",
    });

    useTerminalStore.getState().updateInstanceInfo("t1", {
      cwd: "/home/user/project",
      branch: "main",
    });

    const inst = useTerminalStore.getState().instances[0];
    expect(inst.cwd).toBe("/home/user/project");
    expect(inst.branch).toBe("main");
  });

  it("updates terminal activity timestamp", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws-1",
    });

    const before = useTerminalStore.getState().instances[0].lastActivityAt;

    // Wait a tiny bit to ensure timestamp differs
    useTerminalStore.getState().updateTerminalActivity("t1");
    const after = useTerminalStore.getState().instances[0].lastActivityAt;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("sets terminal focus and clears others in same workspace", () => {
    const { registerInstance } = useTerminalStore.getState();
    registerInstance({ id: "t1", profile: "WSL", syncGroup: "g", workspaceId: "ws-1" });
    registerInstance({ id: "t2", profile: "PS", syncGroup: "g", workspaceId: "ws-1" });
    registerInstance({ id: "t3", profile: "WSL", syncGroup: "g", workspaceId: "ws-2" });

    useTerminalStore.getState().setTerminalFocus("t2");

    const instances = useTerminalStore.getState().instances;
    expect(instances.find((i) => i.id === "t1")!.isFocused).toBe(false);
    expect(instances.find((i) => i.id === "t2")!.isFocused).toBe(true);
    // t3 is in different workspace, should not be affected
    expect(instances.find((i) => i.id === "t3")!.isFocused).toBe(false);
  });

  it("gets terminals for a workspace", () => {
    const { registerInstance } = useTerminalStore.getState();
    registerInstance({ id: "t1", profile: "WSL", syncGroup: "g", workspaceId: "ws-1" });
    registerInstance({ id: "t2", profile: "PS", syncGroup: "g", workspaceId: "ws-1" });
    registerInstance({ id: "t3", profile: "WSL", syncGroup: "g", workspaceId: "ws-2" });

    const ws1Terminals = useTerminalStore.getState().getTerminalsForWorkspace("ws-1");
    expect(ws1Terminals).toHaveLength(2);
    expect(ws1Terminals.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("replaces existing instance on duplicate registration instead of creating duplicate", () => {
    const { registerInstance } = useTerminalStore.getState();
    registerInstance({ id: "t1", profile: "WSL", syncGroup: "g1", workspaceId: "ws-1" });
    registerInstance({ id: "t1", profile: "PowerShell", syncGroup: "g2", workspaceId: "ws-2" });

    const instances = useTerminalStore.getState().instances;
    expect(instances).toHaveLength(1);
    expect(instances[0].profile).toBe("PowerShell");
    expect(instances[0].syncGroup).toBe("g2");
  });

  describe("clearCommandState", () => {
    it("clears lastCommand, lastExitCode, and lastCommandAt for given terminal", () => {
      useTerminalStore.getState().registerInstance({
        id: "t1",
        profile: "WSL",
        syncGroup: "g",
        workspaceId: "ws-1",
      });
      useTerminalStore.getState().updateInstanceInfo("t1", {
        lastCommand: "Claude task",
        lastExitCode: 0,
        lastCommandAt: 12345,
      });

      // Pre-condition: command state is set
      let inst = useTerminalStore.getState().instances[0];
      expect(inst.lastCommand).toBe("Claude task");
      expect(inst.lastExitCode).toBe(0);
      expect(inst.lastCommandAt).toBe(12345);

      useTerminalStore.getState().clearCommandState("t1");

      inst = useTerminalStore.getState().instances[0];
      expect(inst.lastCommand).toBeUndefined();
      expect(inst.lastExitCode).toBeUndefined();
      expect(inst.lastCommandAt).toBeUndefined();
    });

    it("does not affect other terminal instances", () => {
      const { registerInstance } = useTerminalStore.getState();
      registerInstance({ id: "t1", profile: "WSL", syncGroup: "g", workspaceId: "ws-1" });
      registerInstance({ id: "t2", profile: "PS", syncGroup: "g", workspaceId: "ws-1" });
      useTerminalStore.getState().updateInstanceInfo("t1", {
        lastCommand: "cmd1",
        lastExitCode: 0,
        lastCommandAt: 100,
      });
      useTerminalStore.getState().updateInstanceInfo("t2", {
        lastCommand: "cmd2",
        lastExitCode: 1,
        lastCommandAt: 200,
      });

      useTerminalStore.getState().clearCommandState("t1");

      const t1 = useTerminalStore.getState().instances.find((i) => i.id === "t1")!;
      const t2 = useTerminalStore.getState().instances.find((i) => i.id === "t2")!;
      expect(t1.lastCommand).toBeUndefined();
      expect(t2.lastCommand).toBe("cmd2");
      expect(t2.lastExitCode).toBe(1);
    });

    it("is a no-op for non-existent terminal id", () => {
      useTerminalStore.getState().registerInstance({
        id: "t1",
        profile: "WSL",
        syncGroup: "g",
        workspaceId: "ws-1",
      });

      // Should not throw
      useTerminalStore.getState().clearCommandState("non-existent");
      expect(useTerminalStore.getState().instances).toHaveLength(1);
    });
  });
});
