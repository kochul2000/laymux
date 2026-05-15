import { describe, it, expect } from "vitest";
import {
  detectActivityFromTitle,
  detectActivityFromCommand,
  detectActivityFromOutput,
  detectNewCodexInputPendingPrompt,
  detectCodexConversationMessageFromOutput,
  detectCodexStatusMessageFromOutput,
  detectClaudeInputPendingFromOutput,
  detectNewClaudeInputPendingPrompt,
  shouldDismissClaudeInputPendingFromOutput,
} from "./activity-detection";

describe("detectActivityFromTitle", () => {
  it("detects vim from title", () => {
    expect(detectActivityFromTitle("vim")).toEqual({ type: "interactiveApp", name: "vim" });
  });

  it("detects vim in longer title", () => {
    expect(detectActivityFromTitle("vim - file.txt")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
  });

  it("detects Claude Code as Claude", () => {
    expect(detectActivityFromTitle("Claude Code")).toEqual({
      type: "interactiveApp",
      name: "Claude",
    });
  });

  it("detects Codex title variants", () => {
    expect(detectActivityFromTitle("OpenAI Codex")).toEqual({
      type: "interactiveApp",
      name: "Codex",
    });
    expect(detectActivityFromTitle("codex")).toBeUndefined();
  });

  it("detects nvim as neovim", () => {
    expect(detectActivityFromTitle("nvim")).toEqual({ type: "interactiveApp", name: "neovim" });
  });

  it("returns undefined for unknown title", () => {
    expect(detectActivityFromTitle("bash")).toBeUndefined();
  });

  it("returns undefined for empty title", () => {
    expect(detectActivityFromTitle("")).toBeUndefined();
  });

  it("does not false-positive on app names embedded in words", () => {
    expect(detectActivityFromTitle("Review current directory structure")).toBeUndefined();
    expect(detectActivityFromTitle("⠋Review code changes")).toBeUndefined();
    expect(detectActivityFromTitle("navigation helper")).toBeUndefined();
    expect(detectActivityFromTitle("environment variables")).toBeUndefined();
  });

  it("detects app names with surrounding delimiters", () => {
    expect(detectActivityFromTitle("vim - file.txt")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
    expect(detectActivityFromTitle("vi file.txt")).toEqual({ type: "interactiveApp", name: "vim" });
    expect(detectActivityFromTitle("running:vim")).toEqual({ type: "interactiveApp", name: "vim" });
  });

  it("returns undefined for path-like titles containing app names", () => {
    expect(
      detectActivityFromTitle("//wsl.localhost/Ubuntu/home/user/python_projects"),
    ).toBeUndefined();
    expect(detectActivityFromTitle("/home/user/vim-config")).toBeUndefined();
    expect(detectActivityFromTitle("C:\\Users\\name\\node_modules")).toBeUndefined();
  });
});

describe("detectClaudeInputPendingFromOutput", () => {
  // Claude Code renders permission modals with an arrowed numbered option
  // (e.g. "❯ 1. Yes") plus sibling options on consecutive lines. Both the
  // arrow AND at least two numbered options are required so the regular
  // input prompt "╰─❯ 1. anything" the user could type does not false-fire.

  it("detects a Yes/No permission modal", () => {
    expect(
      detectClaudeInputPendingFromOutput(
        "│ Do you want to make this edit to file.rs?  │\r\n" +
          "│ ❯ 1. Yes                                    │\r\n" +
          "│   2. Yes, and don't ask again this session  │\r\n" +
          "│   3. No                                     │\r\n",
      ),
    ).toBe(true);
  });

  it("detects when the selection arrow is on a later option", () => {
    expect(
      detectClaudeInputPendingFromOutput(
        "   1. Yes\r\n" + "   2. Yes, and don't ask again\r\n" + " ❯ 3. No\r\n",
      ),
    ).toBe(true);
  });

  it("ignores the regular Claude input prompt with user-typed text", () => {
    // The steady-state Claude prompt is "╰─❯ " — when the user starts a
    // message with "1. test" the arrow + numbered shape appears, but there
    // is only ONE numbered option in the rolling tail, so detection must
    // refuse to fire and avoid a spurious notification.
    expect(detectClaudeInputPendingFromOutput("╰─❯ 1. test draft for the team")).toBe(false);
  });

  it("ignores unrelated multi-line output containing numbered lists", () => {
    expect(
      detectClaudeInputPendingFromOutput(
        "Steps to reproduce:\r\n 1. open file\r\n 2. press enter\r\n 3. observe\r\n",
      ),
    ).toBe(false);
  });

  it("detects a modal interleaved with ANSI color escapes", () => {
    // The real PTY stream Claude Code emits puts SGR codes (e.g.
    // `\x1b[38;5;246m`) BETWEEN the selection arrow and the option text:
    //   "❯ \x1b[38;5;246m1. \x1b[38;5;153m1"
    // Without stripping CSI sequences first, the arrowed-option regex looked
    // for `❯\s*\d+` and saw `❯ \x1b` instead of `❯ 1`, so the modal in
    // a live WSL Claude session never matched — the notification badge never
    // fired even though the user was parked on a y/N prompt.
    expect(
      detectClaudeInputPendingFromOutput(
        "\x1b[1m선택지를\x1b[m\x1b[38;5;231m\x1b[1m 고르시겠습니까?\x1b[m\r\n" +
          "\x1b[38;5;153m\r\n❯ \x1b[38;5;246m1. \x1b[38;5;153m1\x1b[K\x1b[m\r\n" +
          "     \x1b[38;5;246m첫 번째 선택지\x1b[K\x1b[m\r\n" +
          "  \x1b[38;5;246m2. \x1b[m2\x1b[K\r\n" +
          "     \x1b[38;5;246m두 번째 선택지\x1b[K\x1b[m\r\n" +
          "  \x1b[38;5;246m3. \x1b[m3\x1b[K\r\n",
      ),
    ).toBe(true);
  });

  it("detects a modal that renders option rows via CUP/CUF cursor escapes (real WSL Claude)", () => {
    // This is the bytestream shape captured from a live WSL Claude session
    // that the previous detector silently refused to fire on. Unlike the
    // synthetic fixtures above (which use literal '\r\n' and spaces),
    // Claude in alt-screen mode actually paints the modal frame using
    // cursor-control escapes:
    //   - `\x1b[1C` (CUF: cursor forward 1) for the space between the
    //     option number and its text
    //   - `\x1b[17;3H` (CUP: cursor position) for placing each option on
    //     its own terminal row
    // After a naïve strip-all-CSI pass, "2.\x1b[1C코드" collapses to
    // "2.코드" (no whitespace) and "\x1b[17;3H2." collapses next to the
    // previous option (no line break), so the `\d+\.\s+\S` regex finds
    // exactly ONE match — failing the two-options floor and never
    // notifying the user. The fix converts CUP to '\n' and CUF(N) to N
    // spaces inside stripAnsi so the regex sees the layout the user sees.
    const realWslModal =
      "❯ \x1b[38;5;246m1. \x1b[38;5;153m코드 작성/수정\x1b[K\x1b[m" +
      "\x1b[16;3H   \x1b[38;5;246m새 기능 구현, 버그 수정, 리팩토링 등\x1b[K" +
      "\x1b[17;3H2.\x1b[m\x1b[1C코드\x1b[1C탐색/분석\x1b[38;5;246m" +
      "\x1b[18;6H코드베이스\x1b[1C구조\x1b[1C파악,\x1b[1C특정\x1b[1C함수\x1b[1C찾기" +
      "\x1b[19;3H3.\x1b[m\x1b[1C문서/설명\x1b[38;5;246m" +
      "\x1b[20;6H코드\x1b[1C동작\x1b[1C설명,\x1b[1C문서\x1b[1C작성" +
      "\x1b[21;3H4.\x1b[m\x1b[1C기타\x1b[38;5;246m" +
      "\x1b[22;6H위에\x1b[1C해당하지\x1b[1C않는\x1b[1C작업" +
      "\x1b[23;3H5.\x1b[1CType\x1b[1Csomething.\n";
    expect(detectClaudeInputPendingFromOutput(realWslModal)).toBe(true);
  });
});

describe("detectNewClaudeInputPendingPrompt", () => {
  it("detects a freshly rendered permission modal", () => {
    expect(
      detectNewClaudeInputPendingPrompt(
        "✶ Working on task\r\n",
        "│ Do you want to make this edit?  │\r\n" +
          "│ ❯ 1. Yes                        │\r\n" +
          "│   2. No                         │\r\n",
      ),
    ).toBe(true);
  });

  it("still reports true while a modal sits in the rolling buffer — dedupe is the caller's job", () => {
    // This function intentionally does NOT subtract `previousText`. WSL
    // splits a modal frame across many small PTY chunks, so a "no arrow
    // in this chunk" early-return would refuse to fire on continuation
    // chunks even though the combined buffer holds the complete modal.
    // Dedupe is owned by the call site's marker (CLAUDE_INPUT_PENDING_MARKER)
    // which also clears the detection buffer on dismissal, so this function
    // can stay simple and report ground truth: "is a modal visible in the
    // rolling window right now?"
    const modal =
      "│ Do you want to make this edit?  │\r\n" +
      "│ ❯ 1. Yes                        │\r\n" +
      "│   2. No                         │\r\n";
    expect(detectNewClaudeInputPendingPrompt(modal, "later spinner frame\r\n")).toBe(true);
  });

  it("does not fire when neither the new chunk nor the tail has a selection arrow", () => {
    // The arrow is the unique TUI cursor for Claude's modal; without it
    // anywhere in the combined buffer the detector must refuse, even if
    // the text happens to look like a numbered list.
    expect(
      detectNewClaudeInputPendingPrompt(
        "previous spinner frame\r\n",
        "  1. apples\r\n  2. oranges\r\n  3. pears\r\n",
      ),
    ).toBe(false);
  });

  it("fires when an ANSI-coloured modal frame arrives", () => {
    // Matches the live-stream shape from a real WSL Claude prompt. The
    // unit-test fixture above (`detects a modal interleaved with ANSI color
    // escapes`) is the steady-state combined buffer; this verifies the
    // newness check also tolerates the ANSI-laden chunk.
    expect(
      detectNewClaudeInputPendingPrompt(
        "✶ Hashing… (5m 25s)\r\n",
        "\x1b[38;5;153m\r\n❯ \x1b[38;5;246m1. \x1b[m1\x1b[K\r\n" +
          "  \x1b[38;5;246m2. \x1b[m2\x1b[K\r\n" +
          "  \x1b[38;5;246m3. \x1b[m3\x1b[K\r\n",
      ),
    ).toBe(true);
  });

  it("still detects when ANSI-laden filler pushes the modal out of a small slice", () => {
    // Real WSL Claude: alt-screen redraws every spinner tick (~150ms),
    // re-emitting box-drawing + colour codes for the entire modal frame.
    // A single frame easily exceeds 4 KB once ANSI escapes are counted —
    // the actual session that hit this bug had 29 KB of raw output where
    // the last 1 KB held only spinner footer text. If the detector
    // collapsed the combined buffer to 1 KB it would scroll the modal
    // off the window and never fire. Mirror that shape with ~8 KB of
    // ANSI-cursor filler trailing the modal text.
    const modalChunk =
      "\x1b[1m어떤 것을 선택하시겠습니까?\x1b[m\r\n" +
      "\x1b[38;5;153m❯ \x1b[38;5;246m1. \x1b[m1번 선택지\x1b[K\r\n" +
      "  \x1b[38;5;246m2. \x1b[m2번 선택지\x1b[K\r\n" +
      "  \x1b[38;5;246m3. \x1b[m3번 선택지\x1b[K\r\n";
    const spinnerFiller =
      "\x1b[1;1H\x1b[K\x1b[2;1H\x1b[K\x1b[3;1H\x1b[K\x1b[4;1H\x1b[K".repeat(80) +
      "\x1b[1m✶ Hashing… (28s)\x1b[m\r\n";
    // Combined > 8 KB; modal sits in `previousText`, only spinner in `nextText`
    // that includes a fresh arrow to satisfy the gate.
    expect(
      detectNewClaudeInputPendingPrompt(modalChunk, "\x1b[38;5;153m❯\x1b[m" + spinnerFiller),
    ).toBe(true);
  });

  it("detects every fresh modal even when the previous one lingers in the tail", () => {
    // Real WSL Claude session: the user answers modal #1 and Claude continues
    // working, then renders modal #2 within a few seconds. The 1024-char
    // rolling tail still contains modal #1's text, so a naive
    // `!previousText.has(modal)` check would say "not new" and the second
    // notification would never fire — exactly the regression the user hit
    // ("first modal alerts, follow-up modals do not"). De-duplication is
    // the call-site marker's job, not this function's: as long as the new
    // chunk itself shows the modal shape, return true.
    const firstModal =
      "│ ❯ 1. Yes                       │\r\n" + "│   2. No                        │\r\n";
    const secondModalChunk = "✶ Hashing…\r\n│ ❯ 1. Option A     │\r\n│   2. Option B     │\r\n";
    expect(detectNewClaudeInputPendingPrompt(firstModal, secondModalChunk)).toBe(true);
  });
});

describe("shouldDismissClaudeInputPendingFromOutput", () => {
  it("dismisses when Claude returns to its normal input prompt", () => {
    expect(shouldDismissClaudeInputPendingFromOutput("╰─❯ ")).toBe(true);
  });

  it("does not mistake a visible modal selection arrow for dismissal", () => {
    expect(
      shouldDismissClaudeInputPendingFromOutput(
        "│ ❯ 1. Yes                        │\r\n" + "│   2. No                         │\r\n",
      ),
    ).toBe(false);
  });
});

describe("detectNewCodexInputPendingPrompt", () => {
  it("detects a newly completed Codex approval prompt", () => {
    expect(
      detectNewCodexInputPendingPrompt(
        "Would you like to run the fol",
        "lowing command?\r\nReason: needs approval\r\n",
      ),
    ).toBe(true);
  });

  it("does not match broad non-prompt fragments", () => {
    expect(
      detectNewCodexInputPendingPrompt(
        "",
        "Reason: retry budget exceeded\r\nPress Ctrl+C to cancel the process\r\n",
      ),
    ).toBe(false);
  });

  it("does not report a stale prompt as new", () => {
    const prompt = "Would you like to run the following command?\r\n";
    expect(detectNewCodexInputPendingPrompt(prompt, "later output\r\n")).toBe(false);
  });
});

describe("detectActivityFromCommand", () => {
  it("detects vim command", () => {
    expect(detectActivityFromCommand("vim file.txt")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
  });

  it("detects bare vim", () => {
    expect(detectActivityFromCommand("vim")).toEqual({ type: "interactiveApp", name: "vim" });
  });

  it("detects nvim as neovim", () => {
    expect(detectActivityFromCommand("nvim src/main.rs")).toEqual({
      type: "interactiveApp",
      name: "neovim",
    });
  });

  it("detects nano", () => {
    expect(detectActivityFromCommand("nano /etc/hosts")).toEqual({
      type: "interactiveApp",
      name: "nano",
    });
  });

  it("detects htop", () => {
    expect(detectActivityFromCommand("htop")).toEqual({ type: "interactiveApp", name: "htop" });
  });

  it("detects python3", () => {
    expect(detectActivityFromCommand("python3")).toEqual({
      type: "interactiveApp",
      name: "python",
    });
  });

  it("detects python (not python3 script.py style)", () => {
    expect(detectActivityFromCommand("python")).toEqual({ type: "interactiveApp", name: "python" });
  });

  it("does not detect unknown commands", () => {
    expect(detectActivityFromCommand("ls -la")).toBeUndefined();
    expect(detectActivityFromCommand("npm test")).toBeUndefined();
    expect(detectActivityFromCommand("cargo build")).toBeUndefined();
  });

  it("does not detect __preexec__ marker", () => {
    expect(detectActivityFromCommand("__preexec__")).toBeUndefined();
  });

  it("handles sudo prefix", () => {
    expect(detectActivityFromCommand("sudo vim /etc/hosts")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
  });

  it("handles commands with path prefix", () => {
    expect(detectActivityFromCommand("/usr/bin/vim file.txt")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
  });

  it("detects claude as Claude", () => {
    expect(detectActivityFromCommand("claude")).toEqual({ type: "interactiveApp", name: "Claude" });
  });

  it("detects codex as Codex", () => {
    expect(detectActivityFromCommand("codex")).toEqual({ type: "interactiveApp", name: "Codex" });
    expect(detectActivityFromCommand("codex.exe")).toEqual({
      type: "interactiveApp",
      name: "Codex",
    });
    expect(detectActivityFromCommand("node /opt/codex/bin/codex.js")).toEqual({
      type: "interactiveApp",
      name: "Codex",
    });
    expect(detectActivityFromCommand("npx @openai/codex --model gpt-5")).toEqual({
      type: "interactiveApp",
      name: "Codex",
    });
    expect(detectActivityFromCommand("sudo codex --full-auto")).toEqual({
      type: "interactiveApp",
      name: "Codex",
    });
    expect(detectActivityFromCommand("codex resume 129381204f-81293801")).toEqual({
      type: "interactiveApp",
      name: "Codex",
    });
  });

  it("returns undefined for empty command", () => {
    expect(detectActivityFromCommand("")).toBeUndefined();
  });
});

describe("detectActivityFromOutput", () => {
  it("detects Codex banner text", () => {
    expect(
      detectActivityFromOutput(
        ">- OpenAI Codex (v0.118.0)\r\nmodel: gpt-5.4 medium\r\ndirectory: C:\\Users\r\n",
      ),
    ).toEqual({ type: "interactiveApp", name: "Codex" });
  });

  it("ignores unrelated output", () => {
    expect(detectActivityFromOutput("PS C:\\Users\\kochul> dir")).toBeUndefined();
  });

  it("does not misclassify plain output mentions of OpenAI Codex", () => {
    expect(
      detectActivityFromOutput("README.md: OpenAI Codex is available in this repository\r\n"),
    ).toBeUndefined();
  });

  it("detects Codex 0.120+ box-framed banner", () => {
    // v0.120+ emits the banner inside a Unicode box; the `>_ OpenAI Codex (v…)`
    // line has leading `│ ` and trailing spaces + `│`, and the metadata lines
    // are likewise boxed.
    expect(
      detectActivityFromOutput(
        "│ >_ OpenAI Codex (v0.120.0)                   │\r\n" +
          "│ model:     gpt-5.4 medium   /model to change │\r\n" +
          "│ directory: D:\\PycharmProjects\\laymux        │\r\n",
      ),
    ).toEqual({ type: "interactiveApp", name: "Codex" });
  });
});

describe("detectCodexStatusMessageFromOutput", () => {
  it("parses the Codex footer status line", () => {
    expect(
      detectCodexStatusMessageFromOutput(
        "Use /skills to list available skills\r\ngpt-5.4 medium · 93% left · C:\\Users\r\n",
      ),
    ).toBe("gpt-5.4 medium · 93% left · C:\\Users");
  });

  it("ignores unrelated footer lines", () => {
    expect(detectCodexStatusMessageFromOutput("PS C:\\Users> codex\r\n")).toBeUndefined();
  });
});

describe("detectCodexConversationMessageFromOutput", () => {
  it("prefers the latest assistant bullet reply", () => {
    expect(
      detectCodexConversationMessageFromOutput(
        "> hello\r\n• Hello.\r\n> Improve documentation\r\ngpt-5.4 medium · 93% left · C:\\Users\r\n",
      ),
    ).toBe("Hello.");
  });

  it("ignores tool execution bullets", () => {
    expect(
      detectCodexConversationMessageFromOutput(
        "• Ran Get-ChildItem\r\ngpt-5.4 medium · 93% left · C:\\Users\r\n",
      ),
    ).toBeUndefined();
  });
});
