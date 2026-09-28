import { describe, expect, it } from "vitest";
import {
  isCodexStatusCommandSelected,
  isCodexIdleTextComposer,
  isCodexDismissibleMenu,
} from "./codex-status-probe";
import type { TerminalBufferDump } from "./terminal-serialize-registry";

function screen(text: string): TerminalBufferDump {
  const lines = text.split("\n").map((text, index) => ({ index, text, isWrapped: false }));
  return { cols: 96, rows: 40, length: 40, baseY: 0, lines };
}

describe("Codex status submission guard", () => {
  it("dismisses only supported model/permissions menus and never an active task or setup dialog", () => {
    for (const title of ["Select Model and Effort", "Update Model Permissions"]) {
      expect(
        isCodexDismissibleMenu(screen(`  ${title}\n› 1. current\n\n  enter select · esc back`)),
      ).toBe(true);
    }
    for (const title of [
      "Set up the Codex agent sandbox",
      "Task is still running",
      "Approve command?",
    ]) {
      expect(
        isCodexDismissibleMenu(screen(`  ${title}\n› 1. current\n\n  enter select · esc back`)),
      ).toBe(false);
    }
    expect(
      isCodexDismissibleMenu(screen("  Select Model and Effort\n› 1. model\n  esc to interrupt")),
    ).toBe(false);
  });
  it("selects Status from the current composer while earlier status cards remain", () => {
    const menu =
      "› /status      show current session configuration and token usage\n\n› /statu\n\n  Context 100% left";
    expect(isCodexStatusCommandSelected(screen(menu))).toBe(true);
    expect(isCodexStatusCommandSelected(screen("│ Session: old-id │\n" + menu))).toBe(true);
    expect(
      isCodexStatusCommandSelected(screen(menu.replace("› /statu\n", "› /statu\n  leftover"))),
    ).toBe(false);
    expect(isCodexStatusCommandSelected(screen(menu.replace("› /status ", "› /statusline ")))).toBe(
      false,
    );
  });
  it("does not confuse normal draft text or SQL with a Vim footer", () => {
    expect(
      isCodexIdleTextComposer(
        screen("previous NORMAL output\n› normal 처리, INSERT INTO users\n\n  Context 100% left"),
      ),
    ).toBe(true);
    for (const mode of ["Normal", "Insert", "Replace"]) {
      expect(isCodexIdleTextComposer(screen(`› draft\n\n  Context 100% left | Vim: ${mode}`))).toBe(
        false,
      );
    }
  });
  it("accepts the selected built-in command and the exact current composer", () => {
    expect(
      isCodexStatusCommandSelected(
        screen(
          [
            "› /status      show current session configuration and token usage",
            "  /statusline  configure which items appear in the status line",
            "",
            "› /status",
            "",
            "  GPT-6-Astra · Context 100% left",
          ].join("\n"),
        ),
      ),
    ).toBe(true);
  });

  it.each([
    "› unsent draft/status",
    "› /status with leftover text",
    "› /statusline",
    "› /status\n  remaining line",
    "PS> /status",
  ])("does not submit an unverified composer: %s", (composer) => {
    expect(
      isCodexStatusCommandSelected(
        screen(
          [
            "› /status      show current session configuration and token usage",
            "",
            composer,
            "",
            "  GPT-6-Astra · Context 100% left",
          ].join("\n"),
        ),
      ),
    ).toBe(false);
  });

  it("does not mistake old command output above a modal for the current selector", () => {
    expect(
      isCodexStatusCommandSelected(
        screen(
          [
            "› /status      show current session configuration and token usage",
            "› /status",
            "",
            "Task is still running",
            "› Exit",
          ].join("\n"),
        ),
      ),
    ).toBe(false);
  });

  it("ignores matching scrollback above the live viewport", () => {
    const dump = screen(
      "› /status      show current session configuration and token usage\n\n› /status\n\nfooter",
    );
    dump.baseY = 5;
    expect(isCodexStatusCommandSelected(dump)).toBe(false);
  });
});
