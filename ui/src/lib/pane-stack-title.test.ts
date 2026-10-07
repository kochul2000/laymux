import { describe, expect, it } from "vitest";

import { layerTabTitle } from "./pane-stack-title";

describe("layerTabTitle (ADR-0297)", () => {
  it("uses the view label for non-terminal layers", () => {
    expect(layerTabTitle({ viewType: "MemoView" })).toBe("Memo");
    expect(layerTabTitle({ viewType: "EmptyView" })).toBe("Empty");
  });

  it("prefers a program-set terminal title", () => {
    expect(layerTabTitle({ viewType: "TerminalView", title: "npm run dev", profile: "WSL" })).toBe(
      "npm run dev",
    );
  });

  it("replaces path-like titles with environment and directory", () => {
    expect(
      layerTabTitle({
        viewType: "TerminalView",
        title: "file://localhost/D:/PycharmProjects",
        profile: "PowerShell",
        cwd: "D:\\PycharmProjects",
      }),
    ).toBe("PS · PycharmProjects");
    expect(
      layerTabTitle({
        viewType: "TerminalView",
        title: "kochul@host: /mnt/d/x",
        profile: "WSL",
      }),
    ).toBe("kochul@host: /mnt/d/x");
    expect(
      layerTabTitle({ viewType: "TerminalView", title: "/home/me/proj", profile: "WSL" }),
    ).toBe("WSL · proj");
    expect(
      layerTabTitle({ viewType: "TerminalView", profile: "PowerShell", cwd: "C:\\Users\\me" }),
    ).toBe("PS · ~");
  });

  it("falls back to the profile name without a cwd", () => {
    expect(layerTabTitle({ viewType: "TerminalView", profile: "PowerShell" })).toBe("PowerShell");
    expect(layerTabTitle({ viewType: "TerminalView" })).toBe("Terminal");
  });
});
