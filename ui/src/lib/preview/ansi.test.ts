import { describe, expect, it } from "vitest";
import { createAnsiParser, detectLogLevel, hasAnsiSequences } from "./ansi";

const DEFAULT_FG = "#cdd6f4";
const DEFAULT_BG = "#1e1e2e";

describe("createAnsiParser SGR colors", () => {
  it("maps the 16 base colors to the Catppuccin Mocha ANSI palette", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[31mred\x1b[0m")).toEqual([{ text: "red", fg: "#f38ba8" }]);
    expect(parser.parseLine("\x1b[32mgreen\x1b[0m")).toEqual([{ text: "green", fg: "#a6e3a1" }]);
    expect(parser.parseLine("\x1b[33myellow\x1b[0m")).toEqual([{ text: "yellow", fg: "#f9e2af" }]);
    expect(parser.parseLine("\x1b[34mblue\x1b[0m")).toEqual([{ text: "blue", fg: "#89b4fa" }]);
    expect(parser.parseLine("\x1b[30mblack\x1b[0m")).toEqual([{ text: "black", fg: "#45475a" }]);
    expect(parser.parseLine("\x1b[37mwhite\x1b[0m")).toEqual([{ text: "white", fg: "#bac2de" }]);
    expect(parser.parseLine("\x1b[90mgrey\x1b[0m")).toEqual([{ text: "grey", fg: "#585b70" }]);
    expect(parser.parseLine("\x1b[97mbright\x1b[0m")).toEqual([{ text: "bright", fg: "#a6adc8" }]);
  });

  it("applies background colors and their bright variants", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[41mred bg\x1b[0m")).toEqual([{ text: "red bg", bg: "#f38ba8" }]);
    expect(parser.parseLine("\x1b[107mbright bg\x1b[0m")).toEqual([
      { text: "bright bg", bg: "#a6adc8" },
    ]);
  });

  it("restores the default foreground with 39 and the default background with 49", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[31;41mon\x1b[39mfg\x1b[49mboth")).toEqual([
      { text: "on", fg: "#f38ba8", bg: "#f38ba8" },
      { text: "fg", bg: "#f38ba8" },
      { text: "both" },
    ]);
  });

  it("computes the 256-color cube and grayscale ramp arithmetically", () => {
    const parser = createAnsiParser();

    // Cube corners and axes: level(v) === v === 0 ? 0 : 55 + v * 40.
    expect(parser.parseLine("\x1b[38;5;16mx")[0].fg).toBe("#000000");
    expect(parser.parseLine("\x1b[38;5;231mx")[0].fg).toBe("#ffffff");
    expect(parser.parseLine("\x1b[38;5;21mx")[0].fg).toBe("#0000ff");
    expect(parser.parseLine("\x1b[38;5;196mx")[0].fg).toBe("#ff0000");
    expect(parser.parseLine("\x1b[38;5;46mx")[0].fg).toBe("#00ff00");
    // Grayscale ramp: 8 + (index - 232) * 10.
    expect(parser.parseLine("\x1b[38;5;232mx")[0].fg).toBe("#080808");
    expect(parser.parseLine("\x1b[38;5;244mx")[0].fg).toBe("#808080");
    expect(parser.parseLine("\x1b[38;5;255mx")[0].fg).toBe("#eeeeee");
    // Indices below 16 fall back to the Catppuccin base palette.
    expect(parser.parseLine("\x1b[48;5;9mx")[0].bg).toBe("#f38ba8");
  });

  it("supports truecolor foreground and background", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[38;2;255;128;0m\x1b[48;2;0;17;34mx")).toEqual([
      { text: "x", fg: "#ff8000", bg: "#001122" },
    ]);
  });
});

describe("createAnsiParser SGR attributes", () => {
  it("tracks bold, dim, italic, underline, and strike", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[1;2;3;4;9mall")).toEqual([
      { text: "all", bold: true, dim: true, italic: true, underline: true, strike: true },
    ]);
  });

  it("clears bold and dim together with 22 and clears the rest individually", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[1;2;3;4;9ma\x1b[22mb\x1b[23mc\x1b[24md\x1b[29me")).toEqual([
      { text: "a", bold: true, dim: true, italic: true, underline: true, strike: true },
      { text: "b", italic: true, underline: true, strike: true },
      { text: "c", underline: true, strike: true },
      { text: "d", strike: true },
      { text: "e" },
    ]);
  });

  it("treats an empty parameter as a full reset", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[31;1ma\x1b[mb")).toEqual([
      { text: "a", fg: "#f38ba8", bold: true },
      { text: "b" },
    ]);
  });

  it("ignores unknown SGR codes without dropping the rest of the sequence", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[31;53;1mx")).toEqual([{ text: "x", fg: "#f38ba8", bold: true }]);
  });
});

describe("createAnsiParser inverse", () => {
  it("swaps colors at emit time, substituting the terminal defaults", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[7mplain")).toEqual([
      { text: "plain", fg: DEFAULT_BG, bg: DEFAULT_FG },
    ]);
    expect(parser.parseLine("\x1b[0m\x1b[31;7mfg only")).toEqual([
      { text: "fg only", fg: DEFAULT_BG, bg: "#f38ba8" },
    ]);
  });

  it("does not mutate the stored colors, so 27 restores the original pair", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[31;44m\x1b[7ma\x1b[27mb")).toEqual([
      { text: "a", fg: "#89b4fa", bg: "#f38ba8" },
      { text: "b", fg: "#f38ba8", bg: "#89b4fa" },
    ]);
  });
});

describe("createAnsiParser escape handling", () => {
  it("drops non-SGR CSI sequences", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[2Kclear\x1b[1A\x1b[?25lline")).toEqual([{ text: "clearline" }]);
  });

  it("drops OSC sequences terminated by BEL or by ST", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b]0;window title\x07after")).toEqual([{ text: "after" }]);
    expect(parser.parseLine("\x1b]8;;https://example.com\x1b\\link")).toEqual([{ text: "link" }]);
  });

  it("drops a lone or unterminated escape at end of line", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("tail\x1b")).toEqual([{ text: "tail" }]);
    expect(parser.parseLine("tail\x1b[31")).toEqual([{ text: "tail" }]);
  });
});

describe("createAnsiParser span emission", () => {
  it("coalesces consecutive text with an identical style", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[31ma\x1b[31mb\x1b[0m\x1b[31mc")).toEqual([
      { text: "abc", fg: "#f38ba8" },
    ]);
  });

  it("never emits zero-length spans", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[31m\x1b[32m\x1b[0mtext")).toEqual([{ text: "text" }]);
  });

  it("returns an empty array for an empty line", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("")).toEqual([]);
    expect(parser.parseLine("\x1b[31m")).toEqual([]);
  });
});

describe("createAnsiParser cross-line state", () => {
  it("carries SGR state into the next line like a terminal", () => {
    const parser = createAnsiParser();

    expect(parser.parseLine("\x1b[31mfirst")).toEqual([{ text: "first", fg: "#f38ba8" }]);
    expect(parser.parseLine("second")).toEqual([{ text: "second", fg: "#f38ba8" }]);
  });

  it("keeps a reset issued on an earlier line", () => {
    const parser = createAnsiParser();

    parser.parseLine("\x1b[31;1mfirst\x1b[0m");
    expect(parser.parseLine("second")).toEqual([{ text: "second" }]);
  });
});

describe("detectLogLevel", () => {
  it("detects each level from a bare word", () => {
    expect(detectLogLevel("2024-01-01 ERROR boom")).toBe("error");
    expect(detectLogLevel("err: boom")).toBe("error");
    expect(detectLogLevel("fatal: cannot start")).toBe("error");
    expect(detectLogLevel("PANIC in worker")).toBe("error");
    expect(detectLogLevel("critical failure")).toBe("error");
    expect(detectLogLevel("warn: disk almost full")).toBe("warn");
    expect(detectLogLevel("WARNING: retrying")).toBe("warn");
    expect(detectLogLevel("info server started")).toBe("info");
    expect(detectLogLevel("NOTICE reload requested")).toBe("info");
    expect(detectLogLevel("debug payload=1")).toBe("debug");
    expect(detectLogLevel("TRACE entering handler")).toBe("trace");
  });

  it("matches structured level fields and bracketed levels", () => {
    expect(detectLogLevel("ts=1 level=error msg=boom")).toBe("error");
    expect(detectLogLevel('{"level":"warn","msg":"slow"}')).toBe("warn");
    expect(detectLogLevel("[DEBUG] cache hit")).toBe("debug");
  });

  it("returns the highest severity present", () => {
    expect(detectLogLevel("INFO handled but ERROR followed")).toBe("error");
    expect(detectLogLevel("trace debug info warn")).toBe("warn");
  });

  it("does not match inside a longer word or inside a path", () => {
    expect(detectLogLevel("TERROR strikes the village")).toBeNull();
    expect(detectLogLevel("INFORMATION desk is closed")).toBeNull();
    expect(detectLogLevel("reading /var/log/errors/app.log")).toBeNull();
    expect(detectLogLevel("reading /var/log/error/app.log")).toBeNull();
    expect(detectLogLevel("run with --warn-only")).toBeNull();
    expect(detectLogLevel("nothing interesting here")).toBeNull();
  });

  it("only scans the first 200 characters", () => {
    expect(detectLogLevel(`${"x".repeat(200)} ERROR too late`)).toBeNull();
    expect(detectLogLevel(`${"x".repeat(190)} ERROR in range`)).toBe("error");
  });
});

describe("hasAnsiSequences", () => {
  it("detects CSI and OSC introducers", () => {
    expect(hasAnsiSequences("\x1b[31mred")).toBe(true);
    expect(hasAnsiSequences("\x1b[2K")).toBe(true);
    expect(hasAnsiSequences("\x1b]0;title\x07")).toBe(true);
  });

  it("returns false for plain text that merely looks like parameters", () => {
    expect(hasAnsiSequences("plain text")).toBe(false);
    expect(hasAnsiSequences("[31m is not an escape")).toBe(false);
    expect(hasAnsiSequences("")).toBe(false);
  });
});
