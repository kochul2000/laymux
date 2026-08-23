import { describe, it, expect } from "vitest";
import {
  decidePathLinkClickAction,
  isOsHandoffAction,
  osHandoffModeForAction,
  pathLinkHintKey,
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

  it("does not claim Ctrl+Alt or Ctrl+Meta", () => {
    const ctrlAlt = { ctrlKey: true, shiftKey: false, altKey: true };
    const ctrlMeta = { ctrlKey: true, shiftKey: false, altKey: false, metaKey: true };
    expect(decidePathLinkClickAction(ctrlAlt, false, true)).toBe("viewer");
    expect(decidePathLinkClickAction(ctrlMeta, false, true)).toBe("viewer");
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

describe("pathLinkHintKey", () => {
  it("tells the user which modifiers do what, per target kind", () => {
    expect(pathLinkHintKey(false, true)).toBe("terminal.pathLinkHintFile");
    expect(pathLinkHintKey(true, true)).toBe("terminal.pathLinkHintDir");
  });

  it("says nothing when the feature is disabled", () => {
    expect(pathLinkHintKey(false, false)).toBeNull();
    expect(pathLinkHintKey(true, false)).toBeNull();
  });
});

describe("osHandoffModeForAction", () => {
  it("maps the two handoff actions to the backend mode and nothing else", () => {
    expect(osHandoffModeForAction("osOpen")).toBe("open");
    expect(osHandoffModeForAction("osReveal")).toBe("reveal");
    expect(osHandoffModeForAction("viewer")).toBeNull();
    expect(osHandoffModeForAction("changeDir")).toBeNull();
  });
});
