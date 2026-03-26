import { describe, it, expect } from "vitest";
import {
  parseLxCommand,
  expandHookCommand,
} from "./lx-commands";

describe("parseLxCommand", () => {
  it("parses sync-cwd command", () => {
    const cmd = parseLxCommand("lx sync-cwd /home/user/project");
    expect(cmd).toEqual({
      action: "sync-cwd",
      args: ["/home/user/project"],
      flags: {},
    });
  });

  it("parses sync-cwd with --all flag", () => {
    const cmd = parseLxCommand("lx sync-cwd /foo --all");
    expect(cmd).toEqual({
      action: "sync-cwd",
      args: ["/foo"],
      flags: { all: true },
    });
  });

  it("parses sync-cwd with --group flag", () => {
    const cmd = parseLxCommand("lx sync-cwd /foo --group project-a");
    expect(cmd).toEqual({
      action: "sync-cwd",
      args: ["/foo"],
      flags: { group: "project-a" },
    });
  });

  it("parses sync-branch command", () => {
    const cmd = parseLxCommand("lx sync-branch main");
    expect(cmd).toEqual({
      action: "sync-branch",
      args: ["main"],
      flags: {},
    });
  });

  it("parses notify command", () => {
    const cmd = parseLxCommand('lx notify "Build complete"');
    expect(cmd).toEqual({
      action: "notify",
      args: ["Build complete"],
      flags: {},
    });
  });

  it("parses set-tab-title command", () => {
    const cmd = parseLxCommand('lx set-tab-title "My Terminal"');
    expect(cmd).toEqual({
      action: "set-tab-title",
      args: ["My Terminal"],
      flags: {},
    });
  });

  it("returns null for non-lx commands", () => {
    expect(parseLxCommand("ls -la")).toBeNull();
    expect(parseLxCommand("")).toBeNull();
  });
});

describe("expandHookCommand", () => {
  it("expands $path variable from OSC 7 data", () => {
    const result = expandHookCommand("lx sync-cwd $path", {
      path: "/home/user",
    });
    expect(result).toBe("lx sync-cwd /home/user");
  });

  it("expands $exitCode variable", () => {
    const result = expandHookCommand(
      "lx notify 'Command failed (exit $exitCode)'",
      { exitCode: "1" },
    );
    expect(result).toBe("lx notify 'Command failed (exit 1)'");
  });

  it("leaves unknown variables as-is", () => {
    const result = expandHookCommand("lx sync-cwd $unknown", {});
    expect(result).toBe("lx sync-cwd $unknown");
  });
});
