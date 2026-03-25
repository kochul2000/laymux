import { describe, it, expect } from "vitest";
import { colorSchemeToXtermTheme, type WTColorScheme } from "./color-scheme";

describe("color-scheme", () => {
  const oneDark: WTColorScheme = {
    name: "One Dark",
    foreground: "#ABB2BF",
    background: "#282C34",
    cursorColor: "#528BFF",
    selectionBackground: "#3E4451",
    black: "#282C34",
    red: "#E06C75",
    green: "#98C379",
    yellow: "#E5C07B",
    blue: "#61AFEF",
    purple: "#C678DD",
    cyan: "#56B6C2",
    white: "#ABB2BF",
    brightBlack: "#5C6370",
    brightRed: "#E06C75",
    brightGreen: "#98C379",
    brightYellow: "#E5C07B",
    brightBlue: "#61AFEF",
    brightPurple: "#C678DD",
    brightCyan: "#56B6C2",
    brightWhite: "#FFFFFF",
  };

  it("maps foreground and background", () => {
    const theme = colorSchemeToXtermTheme(oneDark);
    expect(theme.foreground).toBe("#ABB2BF");
    expect(theme.background).toBe("#282C34");
  });

  it("maps cursor color", () => {
    const theme = colorSchemeToXtermTheme(oneDark);
    expect(theme.cursor).toBe("#528BFF");
  });

  it("maps selection background", () => {
    const theme = colorSchemeToXtermTheme(oneDark);
    expect(theme.selectionBackground).toBe("#3E4451");
  });

  it("maps ANSI colors", () => {
    const theme = colorSchemeToXtermTheme(oneDark);
    expect(theme.black).toBe("#282C34");
    expect(theme.red).toBe("#E06C75");
    expect(theme.green).toBe("#98C379");
    expect(theme.yellow).toBe("#E5C07B");
    expect(theme.blue).toBe("#61AFEF");
    expect(theme.magenta).toBe("#C678DD"); // purple → magenta
    expect(theme.cyan).toBe("#56B6C2");
    expect(theme.white).toBe("#ABB2BF");
  });

  it("maps bright ANSI colors", () => {
    const theme = colorSchemeToXtermTheme(oneDark);
    expect(theme.brightBlack).toBe("#5C6370");
    expect(theme.brightRed).toBe("#E06C75");
    expect(theme.brightGreen).toBe("#98C379");
    expect(theme.brightYellow).toBe("#E5C07B");
    expect(theme.brightBlue).toBe("#61AFEF");
    expect(theme.brightMagenta).toBe("#C678DD");
    expect(theme.brightCyan).toBe("#56B6C2");
    expect(theme.brightWhite).toBe("#FFFFFF");
  });

  it("returns empty theme for empty scheme", () => {
    const empty: WTColorScheme = {
      name: "Empty",
      foreground: "",
      background: "",
      cursorColor: "",
      selectionBackground: "",
      black: "",
      red: "",
      green: "",
      yellow: "",
      blue: "",
      purple: "",
      cyan: "",
      white: "",
      brightBlack: "",
      brightRed: "",
      brightGreen: "",
      brightYellow: "",
      brightBlue: "",
      brightPurple: "",
      brightCyan: "",
      brightWhite: "",
    };
    const theme = colorSchemeToXtermTheme(empty);
    // Empty strings should not be set
    expect(theme.foreground).toBeUndefined();
    expect(theme.background).toBeUndefined();
  });
});
