import { afterEach, describe, it, expect } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
  isShellOwnedCombo,
  keybindingMatchesEvent,
  resolveKeybindingFrom,
} from "./keybinding-core";

function key(
  keyValue: string,
  opts: { ctrl?: boolean; alt?: boolean; shift?: boolean; code?: string; altGraph?: boolean } = {},
): KeyboardEvent {
  return {
    key: keyValue,
    code: opts.code ?? "",
    ctrlKey: opts.ctrl ?? false,
    altKey: opts.alt ?? false,
    shiftKey: opts.shift ?? false,
    getModifierState: (name: string) => name === "AltGraph" && (opts.altGraph ?? false),
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

  // ADR-0272 (narrowing ADR-0269 §8): the physical-key fallback may never take
  // a character the user is typing.
  describe("keybindingMatchesEvent — e.code fallback only when no text is typed", () => {
    it("matches a Korean IME letter through e.code", () => {
      expect(keybindingMatchesEvent("Alt+L", key("ㅣ", { alt: true, code: "KeyL" }))).toBe(true);
      expect(
        keybindingMatchesEvent("Ctrl+Alt+L", key("ㅣ", { ctrl: true, alt: true, code: "KeyL" })),
      ).toBe(true);
    });

    it("matches a Ctrl-only chord on a non-Latin layout (Russian Ctrl+С)", () => {
      expect(keybindingMatchesEvent("Ctrl+C", key("с", { ctrl: true, code: "KeyC" }))).toBe(true);
    });

    it("matches a dead key (no character yet) through e.code", () => {
      expect(keybindingMatchesEvent("Alt+E", key("Dead", { alt: true, code: "KeyE" }))).toBe(true);
    });

    // Windows reports AltGr as Ctrl+Alt: these are characters, not shortcuts.
    it.each([
      ["German AltGr+7 {", "Ctrl+Alt+7", "{", "Digit7"],
      ["French AltGr+5 [", "Ctrl+Alt+5", "[", "Digit5"],
      ["Polish AltGr+L ł", "Ctrl+Alt+L", "ł", "KeyL"],
      ["Hungarian AltGr+W |", "Ctrl+Alt+W", "|", "KeyW"],
    ])("never takes Windows AltGr text: %s", (_name, combo, keyValue, code) => {
      expect(keybindingMatchesEvent(combo, key(keyValue, { ctrl: true, alt: true, code }))).toBe(
        false,
      );
      expect(
        keybindingMatchesEvent(
          combo,
          key(keyValue, { ctrl: true, alt: true, code, altGraph: true }),
        ),
      ).toBe(false);
    });

    // Mac Option types characters; which one depends on the layout.
    it.each([
      ["German Mac Option+L @", "@"],
      ["US Mac Option+L ¬", "¬"],
      ["Polish Mac Option+L ł", "ł"],
    ])("never takes Mac Option text: %s", (_name, keyValue) => {
      expect(keybindingMatchesEvent("Alt+L", key(keyValue, { alt: true, code: "KeyL" }))).toBe(
        false,
      );
    });

    it("never uses e.code under AltGraph, even with a Ctrl-only report", () => {
      expect(
        keybindingMatchesEvent("Ctrl+L", key("ł", { ctrl: true, code: "KeyL", altGraph: true })),
      ).toBe(false);
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
        keybindingMatchesEvent("Alt+L", key("ㅣ", { alt: true, shift: true, code: "KeyL" })),
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

  // Round 2 (PR #1088 review): Apple Ctrl chords and non-Latin shell ownership.
  describe("Apple platforms: Ctrl never types text", () => {
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
    function setPlatform(value: string) {
      Object.defineProperty(navigator, "platform", { value, configurable: true });
    }
    afterEach(() => {
      delete (navigator as unknown as Record<string, unknown>).platform;
      if (original) Object.defineProperty(Navigator.prototype, "platform", original);
    });

    it("matches Mac Chrome Ctrl+Option+digit/letter through e.code", () => {
      setPlatform("MacIntel");
      expect(
        keybindingMatchesEvent("Ctrl+Alt+1", key("¡", { ctrl: true, alt: true, code: "Digit1" })),
      ).toBe(true);
      expect(
        keybindingMatchesEvent("Ctrl+Alt+L", key("¬", { ctrl: true, alt: true, code: "KeyL" })),
      ).toBe(true);
    });

    it("still treats Option alone as text on a Mac", () => {
      setPlatform("MacIntel");
      expect(keybindingMatchesEvent("Alt+L", key("@", { alt: true, code: "KeyL" }))).toBe(false);
    });

    it("keeps Windows Ctrl+Alt (AltGr) text as text", () => {
      setPlatform("Win32");
      expect(
        keybindingMatchesEvent("Ctrl+Alt+7", key("{", { ctrl: true, alt: true, code: "Digit7" })),
      ).toBe(false);
    });
  });

  describe("isShellOwnedCombo", () => {
    it("owns Ctrl+letter/digit on Latin and non-Latin layouts alike", () => {
      expect(isShellOwnedCombo(key("b", { ctrl: true, code: "KeyB" }))).toBe(true);
      expect(isShellOwnedCombo(key("и", { ctrl: true, code: "KeyB" }))).toBe(true);
      expect(isShellOwnedCombo(key("ㅠ", { ctrl: true, code: "KeyB" }))).toBe(true);
    });

    it("leaves other chords to the keybinding system", () => {
      expect(isShellOwnedCombo(key("b", { ctrl: true, alt: true, code: "KeyB" }))).toBe(false);
      expect(isShellOwnedCombo(key("B", { ctrl: true, shift: true, code: "KeyB" }))).toBe(false);
      expect(isShellOwnedCombo(key("Enter", { ctrl: true, code: "Enter" }))).toBe(false);
      expect(isShellOwnedCombo(key(",", { ctrl: true, code: "Comma" }))).toBe(false);
      expect(isShellOwnedCombo(key("ł", { ctrl: true, code: "KeyL", altGraph: true }))).toBe(false);
    });
  });
});
