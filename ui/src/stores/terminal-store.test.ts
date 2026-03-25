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
});
