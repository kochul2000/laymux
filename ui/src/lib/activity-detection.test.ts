import { describe, it, expect } from "vitest";
import {
  detectActivityFromTitle,
  detectActivityFromCommand,
  detectActivityFromOutput,
  detectCodexConversationMessageFromOutput,
  detectCodexStatusMessageFromOutput,
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
