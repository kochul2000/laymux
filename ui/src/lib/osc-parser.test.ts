import { describe, it, expect } from "vitest";
import { parseOsc, OscEvent, matchHook, OscHook } from "./osc-parser";

describe("parseOsc", () => {
  it("parses OSC 7 (CWD change)", () => {
    const result = parseOsc("\x1b]7;file://localhost/home/user/project\x07");
    expect(result).toEqual({
      code: 7,
      param: undefined,
      data: "file://localhost/home/user/project",
    });
  });

  it("parses OSC 133 with param D (command finished)", () => {
    const result = parseOsc("\x1b]133;D;0\x07");
    expect(result).toEqual({
      code: 133,
      param: "D",
      data: "0",
    });
  });

  it("parses OSC 133 with param E (command line)", () => {
    const result = parseOsc("\x1b]133;E;git switch main\x07");
    expect(result).toEqual({
      code: 133,
      param: "E",
      data: "git switch main",
    });
  });

  it("parses OSC 9 (notification)", () => {
    const result = parseOsc("\x1b]9;Build complete\x07");
    expect(result).toEqual({
      code: 9,
      param: undefined,
      data: "Build complete",
    });
  });

  it("parses OSC 99 (notification)", () => {
    const result = parseOsc("\x1b]99;Deploy finished\x07");
    expect(result).toEqual({
      code: 99,
      param: undefined,
      data: "Deploy finished",
    });
  });

  it("parses OSC 777 (notification)", () => {
    const result = parseOsc("\x1b]777;notify;Title;Body text\x07");
    expect(result).toEqual({
      code: 777,
      param: undefined,
      data: "notify;Title;Body text",
    });
  });

  it("returns null for non-OSC sequences", () => {
    expect(parseOsc("hello")).toBeNull();
    expect(parseOsc("\x1b[31m")).toBeNull();
  });

  it("handles ST terminator (\\x1b\\\\)", () => {
    const result = parseOsc("\x1b]7;file:///foo\x1b\\");
    expect(result).toEqual({
      code: 7,
      param: undefined,
      data: "file:///foo",
    });
  });
});

describe("matchHook", () => {
  const hooks: OscHook[] = [
    {
      osc: 7,
      run: "ide sync-cwd $path",
    },
    {
      osc: 133,
      param: "D",
      when: "exitCode !== '0'",
      run: "ide notify 'Command failed (exit $exitCode)'",
    },
    {
      osc: 133,
      param: "E",
      when: "command.startsWith('git switch') || command.startsWith('git checkout')",
      run: "ide sync-branch $branch",
    },
  ];

  it("matches OSC 7 hook", () => {
    const event: OscEvent = { code: 7, data: "file:///home/user" };
    const matched = matchHook(hooks, event);
    expect(matched).toHaveLength(1);
    expect(matched[0].run).toBe("ide sync-cwd $path");
  });

  it("matches OSC 133 D hook with condition", () => {
    const event: OscEvent = { code: 133, param: "D", data: "1" };
    const matched = matchHook(hooks, event);
    expect(matched).toHaveLength(1);
    expect(matched[0].run).toContain("ide notify");
  });

  it("does not match OSC 133 D when exitCode is 0", () => {
    const event: OscEvent = { code: 133, param: "D", data: "0" };
    const matched = matchHook(hooks, event);
    expect(matched).toHaveLength(0);
  });

  it("matches OSC 133 E for git switch", () => {
    const event: OscEvent = {
      code: 133,
      param: "E",
      data: "git switch main",
    };
    const matched = matchHook(hooks, event);
    expect(matched).toHaveLength(1);
  });

  it("does not match OSC 133 E for non-git commands", () => {
    const event: OscEvent = { code: 133, param: "E", data: "ls -la" };
    const matched = matchHook(hooks, event);
    expect(matched).toHaveLength(0);
  });
});
