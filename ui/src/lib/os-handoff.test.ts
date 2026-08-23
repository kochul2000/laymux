import { describe, it, expect } from "vitest";
import {
  needsOsHandoffConfirm,
  osHandoffConfirmKey,
  requiresHardConfirm,
  HARD_CONFIRM_EXTENSIONS,
} from "./os-handoff";

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

describe("needsOsHandoffConfirm", () => {
  it("confirms every file open while the setting is on", () => {
    expect(
      needsOsHandoffConfirm({
        mode: "open",
        path: "/home/u/notes.txt",
        isDirectory: false,
        confirmAlways: true,
      }),
    ).toBe(true);
  });

  it("still confirms hard-class files once the setting is off", () => {
    expect(
      needsOsHandoffConfirm({
        mode: "open",
        path: "/home/u/project/vite.config.js",
        isDirectory: false,
        confirmAlways: false,
      }),
    ).toBe(true);
  });

  it("skips the dialog for ordinary files once the setting is off", () => {
    expect(
      needsOsHandoffConfirm({
        mode: "open",
        path: "/home/u/notes.txt",
        isDirectory: false,
        confirmAlways: false,
      }),
    ).toBe(false);
  });

  it("never confirms reveal — it does not run the target", () => {
    expect(
      needsOsHandoffConfirm({
        mode: "reveal",
        path: "C:/tools/setup.exe",
        isDirectory: false,
        confirmAlways: true,
      }),
    ).toBe(false);
  });

  it("never confirms opening a directory in the file manager", () => {
    expect(
      needsOsHandoffConfirm({
        mode: "open",
        path: "/home/u/project",
        isDirectory: true,
        confirmAlways: true,
      }),
    ).toBe(false);
  });
});

describe("osHandoffConfirmKey", () => {
  it("warns explicitly for the hard class and stays neutral otherwise", () => {
    expect(osHandoffConfirmKey("C:/tools/setup.exe")).toBe("osHandoff.confirmExecutable");
    expect(osHandoffConfirmKey("/home/u/project/vite.config.js")).toBe(
      "osHandoff.confirmExecutable",
    );
    expect(osHandoffConfirmKey("/home/u/notes.txt")).toBe("osHandoff.confirm");
  });
});
