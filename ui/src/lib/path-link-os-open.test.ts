import { describe, it, expect } from "vitest";
import {
  decidePathLinkClickAction,
  isOsHandoffAction,
  needsOsOpenConfirm,
  requiresHardConfirm,
  HARD_CONFIRM_EXTENSIONS,
} from "./path-link-os-open";

const NO_MODS = { ctrlKey: false, shiftKey: false, altKey: false };
const CTRL = { ctrlKey: true, shiftKey: false, altKey: false };
const CTRL_SHIFT = { ctrlKey: true, shiftKey: true, altKey: false };

describe("decidePathLinkClickAction", () => {
  it("keeps the existing behavior without modifiers", () => {
    expect(decidePathLinkClickAction(NO_MODS, false, true)).toBe("viewer");
    expect(decidePathLinkClickAction(NO_MODS, true, true)).toBe("changeDir");
  });

  it("maps Ctrl to an OS open for both files and directories", () => {
    expect(decidePathLinkClickAction(CTRL, false, true)).toBe("osOpen");
    expect(decidePathLinkClickAction(CTRL, true, true)).toBe("osOpen");
  });

  it("maps Ctrl+Shift to reveal for both files and directories", () => {
    expect(decidePathLinkClickAction(CTRL_SHIFT, false, true)).toBe("osReveal");
    expect(decidePathLinkClickAction(CTRL_SHIFT, true, true)).toBe("osReveal");
  });

  it("does not claim Shift or Alt on their own (#352 / xterm own those)", () => {
    const shift = { ctrlKey: false, shiftKey: true, altKey: false };
    const alt = { ctrlKey: false, shiftKey: false, altKey: true };
    expect(decidePathLinkClickAction(shift, false, true)).toBe("viewer");
    expect(decidePathLinkClickAction(alt, false, true)).toBe("viewer");
    expect(decidePathLinkClickAction(alt, true, true)).toBe("changeDir");
  });

  it("does not claim Ctrl+Alt", () => {
    const ctrlAlt = { ctrlKey: true, shiftKey: false, altKey: true };
    expect(decidePathLinkClickAction(ctrlAlt, false, true)).toBe("viewer");
  });

  it("falls back to the existing behavior when the feature is disabled", () => {
    expect(decidePathLinkClickAction(CTRL, false, false)).toBe("viewer");
    expect(decidePathLinkClickAction(CTRL_SHIFT, true, false)).toBe("changeDir");
  });
});

describe("isOsHandoffAction", () => {
  it("is true only for the OS handoff actions", () => {
    expect(isOsHandoffAction("osOpen")).toBe(true);
    expect(isOsHandoffAction("osReveal")).toBe(true);
    expect(isOsHandoffAction("viewer")).toBe(false);
    expect(isOsHandoffAction("changeDir")).toBe(false);
  });
});

describe("requiresHardConfirm", () => {
  it("flags directly executable and script-host extensions", () => {
    expect(requiresHardConfirm("C:/tools/setup.exe")).toBe(true);
    expect(requiresHardConfirm("/home/u/build.bat")).toBe(true);
    expect(requiresHardConfirm("/home/u/patch.reg")).toBe(true);
    expect(requiresHardConfirm("/home/u/install.msi")).toBe(true);
  });

  it("flags .js because Windows runs it through the Script Host", () => {
    expect(requiresHardConfirm("/home/u/project/vite.config.js")).toBe(true);
    expect(requiresHardConfirm("/home/u/project/a.jse")).toBe(true);
  });

  it("does not flag ordinary documents", () => {
    expect(requiresHardConfirm("/home/u/notes.txt")).toBe(false);
    expect(requiresHardConfirm("/home/u/README.md")).toBe(false);
    expect(requiresHardConfirm("/home/u/page.html")).toBe(false);
    expect(requiresHardConfirm("/home/u/shot.png")).toBe(false);
    expect(requiresHardConfirm("/home/u/main.ts")).toBe(false);
  });

  it("is case-insensitive on the extension", () => {
    expect(requiresHardConfirm("C:/tools/Setup.EXE")).toBe(true);
  });

  it("does not flag extensionless files or dotfiles", () => {
    expect(requiresHardConfirm("/usr/local/bin/laymux")).toBe(false);
    expect(requiresHardConfirm("/home/u/.bashrc")).toBe(false);
  });

  it("keeps the hard list sorted and free of duplicates", () => {
    const sorted = [...HARD_CONFIRM_EXTENSIONS].sort();
    expect(HARD_CONFIRM_EXTENSIONS).toEqual(sorted);
    expect(new Set(HARD_CONFIRM_EXTENSIONS).size).toBe(HARD_CONFIRM_EXTENSIONS.length);
  });
});

describe("needsOsOpenConfirm", () => {
  it("confirms every file open while the setting is on", () => {
    expect(
      needsOsOpenConfirm({
        action: "osOpen",
        path: "/home/u/notes.txt",
        isDirectory: false,
        confirmAlways: true,
      }),
    ).toBe(true);
  });

  it("still confirms hard-class files once the setting is off", () => {
    expect(
      needsOsOpenConfirm({
        action: "osOpen",
        path: "/home/u/project/vite.config.js",
        isDirectory: false,
        confirmAlways: false,
      }),
    ).toBe(true);
  });

  it("skips the dialog for ordinary files once the setting is off", () => {
    expect(
      needsOsOpenConfirm({
        action: "osOpen",
        path: "/home/u/notes.txt",
        isDirectory: false,
        confirmAlways: false,
      }),
    ).toBe(false);
  });

  it("never confirms reveal — it does not run the target", () => {
    expect(
      needsOsOpenConfirm({
        action: "osReveal",
        path: "C:/tools/setup.exe",
        isDirectory: false,
        confirmAlways: true,
      }),
    ).toBe(false);
  });

  it("never confirms opening a directory in the file manager", () => {
    expect(
      needsOsOpenConfirm({
        action: "osOpen",
        path: "/home/u/project",
        isDirectory: true,
        confirmAlways: true,
      }),
    ).toBe(false);
  });

  it("never confirms the in-app actions", () => {
    expect(
      needsOsOpenConfirm({
        action: "viewer",
        path: "C:/tools/setup.exe",
        isDirectory: false,
        confirmAlways: true,
      }),
    ).toBe(false);
    expect(
      needsOsOpenConfirm({
        action: "changeDir",
        path: "/home/u/project",
        isDirectory: true,
        confirmAlways: true,
      }),
    ).toBe(false);
  });
});
