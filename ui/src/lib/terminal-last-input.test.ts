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
