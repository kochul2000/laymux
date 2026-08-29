import { describe, expect, it } from "vitest";
import {
  createDirectInputCapture,
  normalizeSubmittedInput,
  selectLatestTerminalInput,
  selectTerminalLastInput,
  selectTerminalLastInputEntry,
} from "./terminal-last-input";

describe("terminal last input", () => {
  it("collapses multiline submissions into one selector line", () => {
    expect(normalizeSubmittedInput("  첫 줄\n\n  둘째 줄  ")).toBe("첫 줄 둘째 줄");
  });

  it("captures only completed direct-input submissions and applies common line edits", () => {
    const capture = createDirectInputCapture();

    expect(capture.push("초안 입렫")).toEqual([]);
    expect(capture.push("\u007f")).toEqual([]);
    expect(capture.push("력\r")).toEqual(["초안 입력"]);
    expect(capture.push("지울 내용\u0015새 질문\r")).toEqual(["새 질문"]);
  });

  it("keeps cursor edits in the submitted direct-input value", () => {
    const capture = createDirectInputCapture();

    expect(capture.push("abc\u001b[D\u001b[DZ\r")).toEqual(["aZbc"]);
  });

  it("moves the cursor for Home/End keys only, not for same-parameter sequences", () => {
    const capture = createDirectInputCapture();

    // xterm/VT220 Home (CSI 1 ~) and End (CSI 4 ~) jump within the edited line.
    expect(capture.push("bc\u001b[1~a\u001b[4~d\r")).toEqual(["abcd"]);
    // A bare parameter of 1 or 4 on another final byte is not Home/End: cursor
    // up (CSI 1 A) and erase-in-line (CSI 4 K) must leave the cursor alone.
    expect(capture.push("ab\u001b[1Ac\u001b[4Kd\r")).toEqual(["abcd"]);
  });

  it("ignores SGR mouse reports instead of exposing their coordinates as input", () => {
    const capture = createDirectInputCapture();

    expect(capture.push("\u001b[<35;118;41M\u001b[<35;119;41M")).toEqual([]);
    expect(capture.push("실제 질문\u001b[<0;72;42m\r")).toEqual(["실제 질문"]);
  });

  it("keeps an SGR mouse report out across every push boundary", () => {
    const report = "\u001b[<35;118;41M";

    for (let split = 1; split < report.length; split += 1) {
      const capture = createDirectInputCapture();
      expect(capture.push(report.slice(0, split))).toEqual([]);
      expect(capture.push(`${report.slice(split)}분할 뒤 질문\r`)).toEqual(["분할 뒤 질문"]);
    }
  });

  it("does not let an incomplete escape prefix consume later plain input", () => {
    const escapeCapture = createDirectInputCapture();
    expect(escapeCapture.push("\u001b")).toEqual([]);
    expect(escapeCapture.push("plain after escape\r")).toEqual(["plain after escape"]);

    const csiCapture = createDirectInputCapture();
    expect(csiCapture.push("\u001b[")).toEqual([]);
    expect(csiCapture.push("plain after csi\r")).toEqual(["plain after csi"]);
  });

  it("drops an overlong incomplete CSI prefix without retaining unbounded state", () => {
    const capture = createDirectInputCapture();

    expect(capture.push(`\u001b[<${"1".repeat(300)}`)).toEqual([]);
    expect(capture.push("plain after malformed report\r")).toEqual([
      "plain after malformed report",
    ]);
  });

  it("ignores a complete legacy URXVT mouse report", () => {
    const capture = createDirectInputCapture();

    expect(capture.push("\u001b[35;72;42M")).toEqual([]);
    expect(capture.push("다른 TUI 입력\r")).toEqual(["다른 TUI 입력"]);
  });

  it("chooses the newest shell command or agent input", () => {
    expect(
      selectTerminalLastInput({
        lastCommand: "codex",
        lastCommandAt: 10,
        lastUserInput: "마지막 사용자 질문",
        lastUserInputAt: 20,
      }),
    ).toBe("마지막 사용자 질문");

    expect(
      selectTerminalLastInput({
        lastCommand: "npm test",
        lastCommandAt: 30,
        lastUserInput: "이전 질문",
        lastUserInputAt: 20,
      }),
    ).toBe("npm test");
  });

  it("returns the timestamp together with the selected pane input", () => {
    expect(
      selectTerminalLastInputEntry({
        lastCommand: "npm test",
        lastCommandAt: 30,
        lastUserInput: "older question",
        lastUserInputAt: 20,
      }),
    ).toEqual({ text: "npm test", timestamp: 30 });
  });

  it("selects the newest submitted input across terminal panes", () => {
    expect(
      selectLatestTerminalInput([
        { lastUserInput: "first pane", lastUserInputAt: 10 },
        { lastCommand: "cargo test", lastCommandAt: 30 },
        { lastUserInput: "latest pane", lastUserInputAt: 40 },
      ]),
    ).toEqual({ text: "latest pane", timestamp: 40 });
  });
});
