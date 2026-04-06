import { describe, it, expect } from "vitest";
import {
  getBranchForWorkspace,
  getCwdForWorkspace,
  getPortsForWorkspace,
  getLastCommandForWorkspace,
  computeWorkspaceSummary,
  computeWorkspaceSummaryFromBackend,
  computeCommandStatus,
  abbreviatePath,
  mntPathToWindows,
  formatRelativeTime,
  formatPorts,
  formatCommand,
  formatActivity,
} from "./workspace-summary";
import type { TerminalSummaryResponse } from "@/lib/tauri-api";
import type { TerminalInstance } from "@/stores/terminal-store";
import type { Notification } from "@/stores/notification-store";

function makeTerminal(overrides: Partial<TerminalInstance> & { id: string }): TerminalInstance {
  return {
    profile: "WSL",
    syncGroup: "g",
    workspaceId: "ws-1",
    label: "WSL",
    lastActivityAt: 1000,
    isFocused: false,
    ...overrides,
  };
}

function makeNotification(overrides: Partial<Notification> & { id: string }): Notification {
  return {
    terminalId: "t1",
    workspaceId: "ws-1",
    message: "test",
    level: "info",
    createdAt: Date.now(),
    readAt: null,
    ...overrides,
  };
}

describe("getBranchForWorkspace", () => {
  it("returns branch from most recently active terminal", () => {
    const terminals = [
      makeTerminal({ id: "t1", branch: "main", lastActivityAt: 100 }),
      makeTerminal({ id: "t2", branch: "feature/login", lastActivityAt: 200 }),
    ];
    expect(getBranchForWorkspace(terminals)).toBe("feature/login");
  });

  it("returns null when no terminals have branch", () => {
    const terminals = [makeTerminal({ id: "t1" })];
    expect(getBranchForWorkspace(terminals)).toBeNull();
  });

  it("returns null for empty terminals", () => {
    expect(getBranchForWorkspace([])).toBeNull();
  });
});

describe("getCwdForWorkspace", () => {
  it("returns cwd from focused terminal (priority 1)", () => {
    const terminals = [
      makeTerminal({ id: "t1", cwd: "/home/a", isFocused: false, lastActivityAt: 200 }),
      makeTerminal({ id: "t2", cwd: "/home/b", isFocused: true, lastActivityAt: 100 }),
    ];
    expect(getCwdForWorkspace(terminals)).toBe("/home/b");
  });

  it("falls back to most recently active terminal cwd", () => {
    const terminals = [
      makeTerminal({ id: "t1", cwd: "/home/a", lastActivityAt: 100 }),
      makeTerminal({ id: "t2", cwd: "/home/b", lastActivityAt: 200 }),
    ];
    expect(getCwdForWorkspace(terminals)).toBe("/home/b");
  });

  it("returns null for empty terminals", () => {
    expect(getCwdForWorkspace([])).toBeNull();
  });
});

describe("getPortsForWorkspace", () => {
  it("returns deduplicated sorted ports", () => {
    const terminalPorts = new Map<string, number[]>();
    terminalPorts.set("t1", [3000, 8080]);
    terminalPorts.set("t2", [3000, 5432]);
    expect(getPortsForWorkspace(terminalPorts)).toEqual([3000, 5432, 8080]);
  });

  it("returns empty array for no ports", () => {
    expect(getPortsForWorkspace(new Map())).toEqual([]);
  });
});

describe("getLastCommandForWorkspace", () => {
  it("returns last command from most recently active terminal", () => {
    const terminals = [
      makeTerminal({ id: "t1", lastCommand: "npm test", lastExitCode: 0, lastCommandAt: 100 }),
      makeTerminal({ id: "t2", lastCommand: "npm build", lastExitCode: 1, lastCommandAt: 200 }),
    ];
    const result = getLastCommandForWorkspace(terminals);
    expect(result).toEqual({ command: "npm build", exitCode: 1, timestamp: 200 });
  });

  it("returns null when no terminals have lastCommand", () => {
    const terminals = [makeTerminal({ id: "t1" })];
    expect(getLastCommandForWorkspace(terminals)).toBeNull();
  });

  it("returns null for empty terminals", () => {
    expect(getLastCommandForWorkspace([])).toBeNull();
  });

  it("returns undefined exitCode for running command", () => {
    const terminals = [makeTerminal({ id: "t1", lastCommand: "npm test", lastCommandAt: 100 })];
    const result = getLastCommandForWorkspace(terminals);
    expect(result?.command).toBe("npm test");
    expect(result?.exitCode).toBeUndefined();
  });
});

describe("formatCommand", () => {
  it("returns short commands as-is", () => {
    expect(formatCommand("npm test")).toBe("npm test");
  });

  it("truncates long commands with ellipsis", () => {
    const long = "npm run build -- --production --verbose --output dist";
    const result = formatCommand(long, 30);
    expect(result.length).toBe(30);
    expect(result.endsWith("…")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(formatCommand("  npm test  ")).toBe("npm test");
  });
});

describe("computeWorkspaceSummary", () => {
  it("computes full summary", () => {
    const terminals = [
      makeTerminal({
        id: "t1",
        workspaceId: "ws-1",
        branch: "main",
        cwd: "/home/a",
        lastActivityAt: 200,
        isFocused: true,
        lastCommand: "npm test",
        lastExitCode: 0,
        lastCommandAt: 200,
      }),
      makeTerminal({
        id: "t2",
        workspaceId: "ws-1",
        branch: "dev",
        cwd: "/home/b",
        lastActivityAt: 100,
      }),
    ];
    const ports = new Map([
      ["t1", [3000]],
      ["t2", [8080]],
    ]);
    const notifications: Notification[] = [
      makeNotification({ id: "n1", workspaceId: "ws-1", message: "Build done", createdAt: 1000 }),
      makeNotification({ id: "n2", workspaceId: "ws-1", message: "Tests passed", createdAt: 2000 }),
      makeNotification({ id: "n3", workspaceId: "ws-2", message: "Other" }),
    ];

    const summary = computeWorkspaceSummary("ws-1", terminals, ports, notifications);

    expect(summary.workspaceId).toBe("ws-1");
    expect(summary.branch).toBe("main"); // t1 has higher lastActivityAt
    expect(summary.cwd).toBe("/home/a"); // t1 is focused
    expect(summary.ports).toEqual([3000, 8080]);
    expect(summary.unreadCount).toBe(2);
    expect(summary.hasUnread).toBe(true);
    expect(summary.latestNotification?.message).toBe("Tests passed");
    expect(summary.lastCommand).toEqual({ command: "npm test", exitCode: 0, timestamp: 200 });
  });

  it("returns empty summary for workspace with no terminals", () => {
    const summary = computeWorkspaceSummary("ws-1", [], new Map(), []);
    expect(summary.branch).toBeNull();
    expect(summary.cwd).toBeNull();
    expect(summary.ports).toEqual([]);
    expect(summary.unreadCount).toBe(0);
    expect(summary.hasUnread).toBe(false);
    expect(summary.latestNotification).toBeNull();
    expect(summary.lastCommand).toBeNull();
  });

  it("excludes read notifications from unread count", () => {
    const notifications: Notification[] = [
      makeNotification({ id: "n1", workspaceId: "ws-1", readAt: 999 }),
      makeNotification({ id: "n2", workspaceId: "ws-1", readAt: null }),
    ];
    const summary = computeWorkspaceSummary("ws-1", [], new Map(), notifications);
    expect(summary.unreadCount).toBe(1);
  });
});

describe("computeWorkspaceSummary - terminal summaries", () => {
  it("includes terminalCount and per-terminal summaries", () => {
    const terminals = [
      makeTerminal({
        id: "t1",
        workspaceId: "ws-1",
        profile: "WSL",
        label: "WSL",
        cwd: "/home/user/project",
        branch: "main",
        lastCommand: "npm test",
        lastExitCode: 0,
        lastCommandAt: 200,
      }),
      makeTerminal({
        id: "t2",
        workspaceId: "ws-1",
        profile: "PowerShell",
        label: "PS",
        cwd: "/home/user/api",
        lastCommand: "cargo build",
        lastCommandAt: 100,
      }),
    ];
    const summary = computeWorkspaceSummary("ws-1", terminals, new Map(), []);

    expect(summary.terminalCount).toBe(2);
    expect(summary.terminalSummaries).toHaveLength(2);

    // Most recently active first
    expect(summary.terminalSummaries[0].label).toBe("WSL");
    expect(summary.terminalSummaries[0].cwd).toBe("/home/user/project");
    expect(summary.terminalSummaries[0].lastCommand).toBe("npm test");
    expect(summary.terminalSummaries[0].lastExitCode).toBe(0);

    expect(summary.terminalSummaries[1].label).toBe("PS");
    expect(summary.terminalSummaries[1].cwd).toBe("/home/user/api");
    expect(summary.terminalSummaries[1].lastCommand).toBe("cargo build");
    expect(summary.terminalSummaries[1].lastExitCode).toBeUndefined();
  });

  it("returns empty terminalSummaries when no terminals", () => {
    const summary = computeWorkspaceSummary("ws-1", [], new Map(), []);
    expect(summary.terminalCount).toBe(0);
    expect(summary.terminalSummaries).toHaveLength(0);
  });

  it("excludes dock terminals (empty workspaceId) from summary", () => {
    const terminals = [
      makeTerminal({ id: "t1", workspaceId: "ws-1", profile: "WSL", label: "WSL" }),
      makeTerminal({ id: "t2", workspaceId: "", syncGroup: "MyWS", profile: "PS", label: "PS" }),
    ];
    const summary = computeWorkspaceSummary("ws-1", terminals, new Map(), [], "MyWS");
    // Dock terminal (workspaceId="") should NOT be included even if syncGroup matches
    expect(summary.terminalCount).toBe(1);
    expect(summary.terminalSummaries).toHaveLength(1);
    expect(summary.terminalSummaries[0].id).toBe("t1");
  });

  it("does not show dock terminal last command in workspace summary", () => {
    const terminals = [
      makeTerminal({
        id: "t1",
        workspaceId: "ws-1",
        lastCommand: "npm test",
        lastExitCode: 0,
        lastCommandAt: 100,
      }),
      makeTerminal({
        id: "dock-t",
        workspaceId: "",
        syncGroup: "MyWS",
        lastCommand: "cargo build",
        lastExitCode: 1,
        lastCommandAt: 200,
      }),
    ];
    const summary = computeWorkspaceSummary("ws-1", terminals, new Map(), [], "MyWS");
    // Should show workspace terminal's command, not dock terminal's more recent command
    expect(summary.lastCommand?.command).toBe("npm test");
    expect(summary.lastCommand?.exitCode).toBe(0);
  });

  it("includes hasUnreadNotification in terminal summaries", () => {
    const terminals = [
      makeTerminal({ id: "t1", workspaceId: "ws-1", profile: "WSL", label: "WSL" }),
      makeTerminal({ id: "t2", workspaceId: "ws-1", profile: "PS", label: "PS" }),
    ];
    const notifications: Notification[] = [
      makeNotification({ id: "n1", workspaceId: "ws-1", terminalId: "t1", readAt: null }),
      makeNotification({ id: "n2", workspaceId: "ws-1", terminalId: "t2", readAt: Date.now() }), // already read
    ];
    const summary = computeWorkspaceSummary("ws-1", terminals, new Map(), notifications);
    const t1Summary = summary.terminalSummaries.find((ts) => ts.id === "t1");
    const t2Summary = summary.terminalSummaries.find((ts) => ts.id === "t2");
    expect(t1Summary?.hasUnreadNotification).toBe(true);
    expect(t2Summary?.hasUnreadNotification).toBe(false);
  });

  it("hasUnreadNotification is false when no notifications exist", () => {
    const terminals = [
      makeTerminal({ id: "t1", workspaceId: "ws-1", profile: "WSL", label: "WSL" }),
    ];
    const summary = computeWorkspaceSummary("ws-1", terminals, new Map(), []);
    expect(summary.terminalSummaries[0].hasUnreadNotification).toBe(false);
  });
});

describe("getLastCommandForWorkspace — interactive app cleanup", () => {
  it("returns null when terminal had interactiveApp command that was cleared", () => {
    // After an interactive app exits, lastCommand should be cleared.
    // This simulates the state AFTER clearCommandState was called.
    const terminals = [
      makeTerminal({
        id: "t1",
        lastCommand: undefined,
        lastExitCode: undefined,
        lastCommandAt: undefined,
      }),
    ];
    expect(getLastCommandForWorkspace(terminals)).toBeNull();
  });

  it("includes terminal title in lastCommand for Claude idle detection", () => {
    const terminals = [
      makeTerminal({
        id: "t1",
        lastCommand: "Claude task",
        lastExitCode: 0,
        lastCommandAt: 200,
        title: "✳ Claude Code",
        activity: { type: "interactiveApp", name: "Claude" },
      }),
    ];
    const result = getLastCommandForWorkspace(terminals);
    expect(result?.title).toBe("✳ Claude Code");
    expect(result?.activity).toEqual({ type: "interactiveApp", name: "Claude" });
  });

  it("returns other terminal command after one terminal's command state was cleared", () => {
    const terminals = [
      makeTerminal({
        id: "t1",
        lastCommand: undefined,
        lastExitCode: undefined,
        lastCommandAt: undefined,
      }),
      makeTerminal({ id: "t2", lastCommand: "npm test", lastExitCode: 0, lastCommandAt: 200 }),
    ];
    const result = getLastCommandForWorkspace(terminals);
    expect(result).toEqual({ command: "npm test", exitCode: 0, timestamp: 200 });
  });
});

describe("abbreviatePath", () => {
  it("shortens Unix home directory to ~", () => {
    expect(abbreviatePath("/home/user/dev/project")).toBe("~/dev/project");
  });

  it("shortens Unix home directory at root to ~", () => {
    expect(abbreviatePath("/home/user")).toBe("~");
  });

  it("shortens WSL path with home directory to ~", () => {
    expect(abbreviatePath("//wsl.localhost/Ubuntu-22.04/home/kochul/python_projects")).toBe(
      "~/python_projects",
    );
  });

  it("shortens WSL home root to ~", () => {
    expect(abbreviatePath("//wsl.localhost/Ubuntu-22.04/home/kochul")).toBe("~");
  });

  it("shortens WSL non-home path to distro-relative", () => {
    expect(abbreviatePath("//wsl.localhost/Ubuntu-22.04/var/log")).toBe("/var/log");
  });

  it("shortens Windows home directory to ~", () => {
    expect(abbreviatePath("C:\\Users\\kochul\\dev")).toBe("~/dev");
  });

  it("shortens Windows home root to ~", () => {
    expect(abbreviatePath("C:\\Users\\kochul")).toBe("~");
  });

  it("strips file:// prefix and shortens Windows home to ~", () => {
    expect(abbreviatePath("file://localhost/C:/Users/kochul")).toBe("~");
  });

  it("strips file:// prefix and shortens Windows home subpath to ~", () => {
    expect(abbreviatePath("file://localhost/C:/Users/kochul/Documents")).toBe("~/Documents");
  });

  it("truncates long paths (default ellipsis=start)", () => {
    const longPath = "/var/lib/really/deeply/nested/directory/structure";
    const result = abbreviatePath(longPath);
    expect(result.startsWith(".../")).toBe(true);
    expect(result.length).toBeLessThan(longPath.length);
  });

  it("truncates long paths with ellipsis=end (keeps beginning)", () => {
    const longPath = "/var/lib/really/deeply/nested/directory/structure";
    const result = abbreviatePath(longPath, "end");
    expect(result.endsWith("/...")).toBe(true);
    expect(result.length).toBeLessThan(longPath.length);
  });

  it("ellipsis=start shows last 2 segments", () => {
    const longPath = "/var/lib/really/deeply/nested/directory/structure";
    const result = abbreviatePath(longPath, "start");
    expect(result).toBe(".../directory/structure");
  });

  it("ellipsis=end shows first 2 segments", () => {
    const longPath = "/var/lib/really/deeply/nested/directory/structure";
    const result = abbreviatePath(longPath, "end");
    expect(result).toBe("/var/lib/...");
  });

  it("returns short paths as-is regardless of ellipsis mode", () => {
    expect(abbreviatePath("/tmp/foo")).toBe("/tmp/foo");
    expect(abbreviatePath("/tmp/foo", "start")).toBe("/tmp/foo");
    expect(abbreviatePath("/tmp/foo", "end")).toBe("/tmp/foo");
  });

  it("uses backslash separator for Windows long paths (ellipsis=start)", () => {
    const winPath = "D:\\Projects\\work\\really\\deeply\\nested\\dir\\sub";
    const result = abbreviatePath(winPath, "start");
    expect(result).toBe("...\\dir\\sub");
  });

  it("uses backslash separator for Windows long paths (ellipsis=end)", () => {
    const winPath = "D:\\Projects\\work\\really\\deeply\\nested\\dir\\sub";
    const result = abbreviatePath(winPath, "end");
    expect(result).toBe("D:\\Projects\\work\\...");
  });
});

describe("mntPathToWindows", () => {
  it("converts /mnt/c/Users/test to C:\\Users\\test", () => {
    expect(mntPathToWindows("/mnt/c/Users/test")).toBe("C:\\Users\\test");
  });

  it("converts /mnt/d/Projects to D:\\Projects", () => {
    expect(mntPathToWindows("/mnt/d/Projects")).toBe("D:\\Projects");
  });

  it("converts /mnt/c/ to C:\\", () => {
    expect(mntPathToWindows("/mnt/c/")).toBe("C:\\");
  });

  it("converts /mnt/c to C:\\", () => {
    expect(mntPathToWindows("/mnt/c")).toBe("C:\\");
  });

  it("returns non-mnt paths unchanged", () => {
    expect(mntPathToWindows("/home/user")).toBe("/home/user");
    expect(mntPathToWindows("/tmp")).toBe("/tmp");
    expect(mntPathToWindows("C:\\Users")).toBe("C:\\Users");
  });
});

describe("formatPorts", () => {
  it("returns empty string for no ports", () => {
    expect(formatPorts([])).toBe("");
  });

  it("formats ports with colon prefix", () => {
    expect(formatPorts([3000, 8080])).toBe(":3000  :8080");
  });

  it("shows all ports when 5 or fewer", () => {
    expect(formatPorts([3000, 3001, 3002, 3003, 3004])).toBe(":3000  :3001  :3002  :3003  :3004");
  });

  it("truncates ports over maxDisplay with +N", () => {
    expect(formatPorts([80, 443, 3000, 5432, 8080, 8443, 9090])).toBe(
      ":80  :443  :3000  :5432  :8080  +2",
    );
  });

  it("respects custom maxDisplay", () => {
    expect(formatPorts([3000, 8080, 9090], 2)).toBe(":3000  :8080  +1");
  });
});

describe("formatActivity", () => {
  it("returns 'shell' with secondary color for undefined activity", () => {
    const result = formatActivity(undefined);
    expect(result.label).toBe("shell");
    expect(result.color).toBe("var(--text-secondary)");
  });

  it("returns 'shell' for shell activity type", () => {
    const result = formatActivity({ type: "shell" });
    expect(result.label).toBe("shell");
  });

  it("returns 'running' with yellow for running activity", () => {
    const result = formatActivity({ type: "running" });
    expect(result.label).toBe("running");
    expect(result.color).toBe("var(--yellow)");
  });

  it("returns app name with accent for generic interactive app", () => {
    const result = formatActivity({ type: "interactiveApp", name: "neovim" });
    expect(result.label).toBe("neovim");
    expect(result.color).toBe("var(--accent)");
  });

  it("returns 'app' for interactive app without name", () => {
    const result = formatActivity({ type: "interactiveApp" });
    expect(result.label).toBe("app");
    expect(result.color).toBe("var(--accent)");
  });

  it("returns Claude brand color (#D97757) for Claude app", () => {
    const result = formatActivity({ type: "interactiveApp", name: "Claude" });
    expect(result.label).toBe("Claude");
    expect(result.color).toBe("#D97757");
  });

  it("returns plain 'Claude' label regardless of title mode", () => {
    const plan = formatActivity({ type: "interactiveApp", name: "Claude" }, "✶ Plan: approach");
    expect(plan.label).toBe("Claude");
    expect(plan.claudeMode).toBe("plan");
    expect(plan.color).toBe("#D97757");

    const danger = formatActivity({ type: "interactiveApp", name: "Claude" }, "✳ Danger mode");
    expect(danger.label).toBe("Claude");
    expect(danger.claudeMode).toBe("danger");

    const idle = formatActivity({ type: "interactiveApp", name: "Claude" }, "✳ Claude Code");
    expect(idle.label).toBe("Claude");
    expect(idle.claudeMode).toBe("idle");
  });

  it("tracks Ralph state without changing label", () => {
    const result = formatActivity({ type: "interactiveApp", name: "Claude" }, "✶ Ralph: fixing");
    expect(result.ralph).toBe(true);
    expect(result.label).toBe("Claude");
  });
});

describe("computeWorkspaceSummaryFromBackend", () => {
  function makeBackendSummary(
    overrides: Partial<TerminalSummaryResponse> & { id: string },
  ): TerminalSummaryResponse {
    return {
      profile: "WSL",
      title: "",
      cwd: null,
      branch: null,
      lastCommand: null,
      lastExitCode: null,
      lastCommandAt: null,
      commandRunning: false,
      activity: { type: "shell" },
      outputActive: false,
      isClaude: false,
      unreadNotificationCount: 0,
      latestNotification: null,
      ...overrides,
    };
  }

  it("uses provided ports for active workspace", () => {
    const summaries = [makeBackendSummary({ id: "t1" })];
    const result = computeWorkspaceSummaryFromBackend("ws-1", summaries, [3000, 8080]);
    expect(result.ports).toEqual([3000, 8080]);
  });

  it("defaults to empty ports when not provided", () => {
    const summaries = [makeBackendSummary({ id: "t1" })];
    const result = computeWorkspaceSummaryFromBackend("ws-1", summaries);
    expect(result.ports).toEqual([]);
  });

  it("returns empty ports for inactive workspace", () => {
    const summaries = [makeBackendSummary({ id: "t1" })];
    const result = computeWorkspaceSummaryFromBackend("ws-1", summaries, []);
    expect(result.ports).toEqual([]);
  });

  it("includes outputActive in terminal summaries", () => {
    const summaries = [
      makeBackendSummary({ id: "t1", outputActive: true }),
      makeBackendSummary({ id: "t2", outputActive: false }),
    ];
    const result = computeWorkspaceSummaryFromBackend("ws-1", summaries);
    expect(result.terminalSummaries[0].outputActive).toBe(true);
    expect(result.terminalSummaries[1].outputActive).toBe(false);
  });

  it("sets outputActive on workspace lastCommand from the source terminal", () => {
    const summaries = [
      makeBackendSummary({
        id: "t1",
        lastCommand: "pytest",
        lastExitCode: 0,
        lastCommandAt: 200,
        outputActive: true,
      }),
      makeBackendSummary({
        id: "t2",
        lastCommand: "npm test",
        lastExitCode: 0,
        lastCommandAt: 100,
        outputActive: false,
      }),
    ];
    const result = computeWorkspaceSummaryFromBackend("ws-1", summaries);
    // lastCommand should come from t1 (most recent) and carry its outputActive
    expect(result.lastCommand?.command).toBe("pytest");
    expect(result.lastCommand?.outputActive).toBe(true);
  });

  it("sets outputActive=false on workspace lastCommand when source terminal has no output", () => {
    const summaries = [
      makeBackendSummary({
        id: "t1",
        lastCommand: "npm test",
        lastExitCode: 0,
        lastCommandAt: 200,
        outputActive: false,
      }),
    ];
    const result = computeWorkspaceSummaryFromBackend("ws-1", summaries);
    expect(result.lastCommand?.outputActive).toBe(false);
  });

  it("includes activity in workspace lastCommand from the source terminal", () => {
    const summaries = [
      makeBackendSummary({
        id: "t1",
        lastCommand: "gh pr view 3237",
        lastExitCode: 1,
        lastCommandAt: 200,
        outputActive: false,
        activity: { type: "interactiveApp", name: "Claude" },
      }),
    ];
    const result = computeWorkspaceSummaryFromBackend("ws-1", summaries);
    expect(result.lastCommand?.activity).toEqual({ type: "interactiveApp", name: "Claude" });
  });

  it("includes activity in workspace lastCommand for running activity", () => {
    const summaries = [
      makeBackendSummary({
        id: "t1",
        lastCommand: "cargo build",
        lastExitCode: 1,
        lastCommandAt: 200,
        outputActive: false,
        activity: { type: "running" },
      }),
    ];
    const result = computeWorkspaceSummaryFromBackend("ws-1", summaries);
    expect(result.lastCommand?.activity).toEqual({ type: "running" });
  });
});

describe("computeCommandStatus", () => {
  // Shell commands
  it("returns ⏳ when exitCode is undefined (command running)", () => {
    const s = computeCommandStatus(undefined, false, { type: "shell" }, undefined);
    expect(s.icon).toBe("⏳");
    expect(s.color).toBe("var(--yellow)");
  });

  it("returns ✓ for exitCode 0", () => {
    const s = computeCommandStatus(0, false, { type: "shell" }, undefined);
    expect(s.icon).toBe("✓");
    expect(s.color).toBe("var(--green)");
  });

  it("returns ✗ for non-zero exitCode", () => {
    const s = computeCommandStatus(1, false, { type: "shell" }, undefined);
    expect(s.icon).toBe("✗");
    expect(s.color).toBe("var(--red)");
  });

  it("returns ⏳ when outputActive even with exitCode", () => {
    const s = computeCommandStatus(0, true, { type: "shell" }, undefined);
    expect(s.icon).toBe("⏳");
  });

  it("returns ⏳ for running activity", () => {
    const s = computeCommandStatus(0, false, { type: "running" }, undefined);
    expect(s.icon).toBe("⏳");
  });

  // Interactive apps (non-Claude)
  it("returns ⏳ for generic interactiveApp", () => {
    const s = computeCommandStatus(0, false, { type: "interactiveApp", name: "vim" }, undefined);
    expect(s.icon).toBe("⏳");
  });

  // Claude: uses title idle detection
  it("returns ✓ for Claude idle (✳ prefix)", () => {
    const s = computeCommandStatus(
      undefined,
      false,
      { type: "interactiveApp", name: "Claude" },
      "✳ Claude Code",
    );
    expect(s.icon).toBe("✓");
    expect(s.color).toBe("var(--green)");
  });

  it("returns ⏳ for Claude working (spinner prefix)", () => {
    const s = computeCommandStatus(
      undefined,
      false,
      { type: "interactiveApp", name: "Claude" },
      "✶ fixing bug",
    );
    expect(s.icon).toBe("⏳");
    expect(s.color).toBe("var(--yellow)");
  });

  it("returns ⏳ for Claude with no title", () => {
    const s = computeCommandStatus(
      undefined,
      false,
      { type: "interactiveApp", name: "Claude" },
      undefined,
    );
    expect(s.icon).toBe("⏳");
  });

  it("ignores exitCode for Claude — uses title only", () => {
    // exitCode=1 from sub-command, but Claude is idle → ✓
    const s = computeCommandStatus(
      1,
      false,
      { type: "interactiveApp", name: "Claude" },
      "✳ Claude Code",
    );
    expect(s.icon).toBe("✓");
  });
});

describe("formatRelativeTime", () => {
  it("returns '방금' for less than 60 seconds", () => {
    expect(formatRelativeTime(Date.now() - 30000)).toBe("방금");
  });

  it("returns minutes for less than 1 hour", () => {
    expect(formatRelativeTime(Date.now() - 5 * 60000)).toBe("5분 전");
  });

  it("returns hours for more than 1 hour", () => {
    expect(formatRelativeTime(Date.now() - 3 * 3600000)).toBe("3시간 전");
  });
});
