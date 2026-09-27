import { describe, it, expect } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
  keybindingMatchesEvent,
  resolveKeybindingFrom,
} from "./keybinding-core";

function key(
  keyValue: string,
  opts: { ctrl?: boolean; alt?: boolean; shift?: boolean; code?: string } = {},
): KeyboardEvent {
  return {
    key: keyValue,
    code: opts.code ?? "",
    ctrlKey: opts.ctrl ?? false,
    altKey: opts.alt ?? false,
    shiftKey: opts.shift ?? false,
  } as unknown as KeyboardEvent;
}

describe("keybinding-core", () => {
  describe("Composer bindings (ADR-0269)", () => {
    it.each([
      ["composer.pc.send", "Enter"],
      ["composer.pc.newline", "Shift+Enter"],
      ["composer.remote.send", "Ctrl+Enter"],
      ["composer.remote.newline", "Enter"],
    ])("%s defaults to %s", (id, keys) => {
      const def = DEFAULT_KEYBINDINGS.find((d) => d.id === id);
      expect(def?.defaultKeys).toBe(keys);
      expect(def?.group).toBe("Composer");
      // Composer keys are handled inside the focused editor, never forwarded
      // past xterm to the document-level dispatcher.
      expect(def?.passThroughTerminal).toBeUndefined();
    });
  });

  describe("resolveKeybindingFrom", () => {
    it("prefers the override for the action", () => {
      const overrides = [{ keys: "Ctrl+J", command: "composer.remote.send" }];
      expect(resolveKeybindingFrom(overrides, "composer.remote.send")).toBe("Ctrl+J");
      expect(resolveKeybindingFrom(overrides, "composer.remote.newline")).toBe("Enter");
    });

    it("returns undefined for an unknown action", () => {
      expect(resolveKeybindingFrom([], "nope")).toBeUndefined();
    });
  });

  describe("keybindingMatchesEvent — e.code fallback (ADR-0269 §8)", () => {
    it("matches Mac Option+L (e.key = ¬) through e.code", () => {
      expect(keybindingMatchesEvent("Alt+L", key("¬", { alt: true, code: "KeyL" }))).toBe(true);
    });

    it("matches a Korean IME letter through e.code", () => {
      expect(keybindingMatchesEvent("Alt+L", key("ㅣ", { alt: true, code: "KeyL" }))).toBe(true);
    });

    it("matches an AZERTY digit row symbol through e.code", () => {
      expect(
        keybindingMatchesEvent("Ctrl+Alt+1", key("&", { ctrl: true, alt: true, code: "Digit1" })),
      ).toBe(true);
    });

    it("keeps a Latin e.key authoritative (Dvorak Ctrl+J on the physical C key)", () => {
      expect(keybindingMatchesEvent("Ctrl+C", key("j", { ctrl: true, code: "KeyC" }))).toBe(false);
      expect(keybindingMatchesEvent("Ctrl+J", key("j", { ctrl: true, code: "KeyC" }))).toBe(true);
    });

    it("never uses e.code without Ctrl or Alt", () => {
      expect(keybindingMatchesEvent("Shift+L", key("¬", { shift: true, code: "KeyL" }))).toBe(
        false,
      );
    });

    it("still requires the exact modifier set", () => {
      expect(
        keybindingMatchesEvent("Alt+L", key("¬", { alt: true, shift: true, code: "KeyL" })),
      ).toBe(false);
    });

    it("never matches while Meta is held (no combo can name it)", () => {
      const cmdAltLeft = { ...key("ArrowLeft", { alt: true }), metaKey: true } as KeyboardEvent;
      expect(keybindingMatchesEvent("Alt+Arrow", cmdAltLeft)).toBe(false);
    });

    it("never matches an unassigned combo", () => {
      expect(keybindingMatchesEvent("", key("Enter"))).toBe(false);
      expect(keybindingMatchesEvent(undefined, key("Enter"))).toBe(false);
    });

    it("matches the Arrow wildcard", () => {
      expect(keybindingMatchesEvent("Alt+Arrow", key("ArrowLeft", { alt: true }))).toBe(true);
      expect(keybindingMatchesEvent("Alt+Arrow", key("Enter", { alt: true }))).toBe(false);
    });
  });
});
