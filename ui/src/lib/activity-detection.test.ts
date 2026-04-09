import { describe, it, expect } from "vitest";
import { detectActivityFromTitle, detectActivityFromCommand } from "./activity-detection";

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
    expect(detectActivityFromTitle("codex")).toEqual({
      type: "interactiveApp",
      name: "Codex",
    });
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
    expect(detectActivityFromTitle("✳ Review code changes")).toBeUndefined();
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
    // 'python' bare is interactive REPL
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
    expect(detectActivityFromCommand("sudo codex --full-auto")).toEqual({
      type: "interactiveApp",
      name: "Codex",
    });
  });

  it("returns undefined for empty command", () => {
    expect(detectActivityFromCommand("")).toBeUndefined();
  });
});
