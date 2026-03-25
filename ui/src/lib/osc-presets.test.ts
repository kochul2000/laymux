import { describe, it, expect } from "vitest";
import { getPresetHooks, OscPresetName } from "./osc-presets";

describe("OSC Presets", () => {
  it("returns sync-cwd preset with OSC 7 only", () => {
    const hooks = getPresetHooks("sync-cwd");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(7);
    expect(hooks[0].run).toContain("sync-cwd");
  });

  it("returns set-wsl-distro preset with OSC 9;9", () => {
    const hooks = getPresetHooks("set-wsl-distro");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(9);
    expect(hooks[0].when).toContain("message.startsWith('9;')");
    expect(hooks[0].run).toContain("set-wsl-distro");
  });

  it("returns sync-branch preset hooks", () => {
    const hooks = getPresetHooks("sync-branch");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(133);
    expect(hooks[0].param).toBe("E");
  });

  it("returns notify-on-fail preset hooks", () => {
    const hooks = getPresetHooks("notify-on-fail");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(133);
    expect(hooks[0].param).toBe("D");
    expect(hooks[0].when).toBeDefined();
    expect(hooks[0].run).toContain("--level error");
  });

  it("returns set-title-cwd preset hooks for OSC 7 and OSC 9;9", () => {
    const hooks = getPresetHooks("set-title-cwd");
    expect(hooks).toHaveLength(2);
    expect(hooks[0].osc).toBe(7);
    expect(hooks[0].run).toContain("set-tab-title");
    // OSC 9;9 ConEmu/WSL CWD report
    expect(hooks[1].osc).toBe(9);
    expect(hooks[1].when).toContain("message.startsWith('9;')");
    expect(hooks[1].run).toContain("set-tab-title");
  });

  it("returns notify-osc9 preset hooks excluding CWD sub-codes", () => {
    const hooks = getPresetHooks("notify-osc9");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(9);
    expect(hooks[0].run).toContain("notify");
    // Should exclude OSC 9;9 CWD reports
    expect(hooks[0].when).toContain("!message.startsWith('9;')");
  });

  it("returns notify-osc99 preset hooks", () => {
    const hooks = getPresetHooks("notify-osc99");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(99);
  });

  it("returns notify-osc777 preset hooks", () => {
    const hooks = getPresetHooks("notify-osc777");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(777);
  });

  it("returns track-command preset hooks", () => {
    const hooks = getPresetHooks("track-command");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(133);
    expect(hooks[0].param).toBe("E");
    expect(hooks[0].run).toContain("set-command-status");
    expect(hooks[0].run).toContain("--command");
  });

  it("returns track-command-result preset hooks", () => {
    const hooks = getPresetHooks("track-command-result");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(133);
    expect(hooks[0].param).toBe("D");
    expect(hooks[0].run).toContain("set-command-status");
    expect(hooks[0].run).toContain("--exit-code");
  });

  it("returns notify-on-complete preset hooks for exit code 0", () => {
    const hooks = getPresetHooks("notify-on-complete");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(133);
    expect(hooks[0].param).toBe("D");
    expect(hooks[0].when).toContain("exitCode === '0'");
    expect(hooks[0].run).toContain("--level success");
  });

  it("returns track-command-start preset hooks", () => {
    const hooks = getPresetHooks("track-command-start");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].osc).toBe(133);
    expect(hooks[0].param).toBe("C");
    expect(hooks[0].run).toContain("set-command-status");
    expect(hooks[0].run).toContain("--command");
  });

  it("returns all presets", () => {
    const presets: OscPresetName[] = [
      "sync-cwd",
      "sync-branch",
      "notify-on-fail",
      "notify-on-complete",
      "set-title-cwd",
      "notify-osc9",
      "notify-osc99",
      "notify-osc777",
      "track-command",
      "track-command-result",
      "track-command-start",
    ];
    for (const name of presets) {
      const hooks = getPresetHooks(name);
      expect(hooks.length).toBeGreaterThan(0);
    }
  });
});
