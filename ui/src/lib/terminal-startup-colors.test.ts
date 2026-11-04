import { describe, expect, it } from "vitest";
import { terminalStartupColors } from "./terminal-startup-colors";

describe("terminalStartupColors", () => {
  it("uses the exact initial terminal theme, including a light background", () => {
    expect(terminalStartupColors({ foreground: "#1234AB", background: "#fefdfc" })).toEqual({
      foreground: "\x1b]10;rgb:1212/3434/abab\x1b\\",
      background: "\x1b]11;rgb:fefe/fdfd/fcfc\x1b\\",
    });
  });
  it.each([undefined, "", "red", "#ffffff80", "#gg0000"])(
    "does not grant a reply snapshot for an unresolved color %s",
    (foreground) => {
      expect(terminalStartupColors({ foreground, background: "#ffffff" })).toBeUndefined();
    },
  );
});
