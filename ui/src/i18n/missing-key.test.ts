import { describe, it, expect, vi } from "vitest";
import { reportMissingKey } from "./index";

describe("reportMissingKey (dev missing-key reporter)", () => {
  it("warns with the active language, namespace and key", () => {
    const warn = vi.fn();
    reportMissingKey(["en"], "settings", "startup.title", warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[i18n] Missing translation: "en:settings:startup.title"');
  });

  it("uses the first (active) language when several are passed", () => {
    const warn = vi.fn();
    reportMissingKey(["en", "ko"], "common", "language.system", warn);
    expect(warn).toHaveBeenCalledWith('[i18n] Missing translation: "en:common:language.system"');
  });

  it("falls back to '?' when no language is provided", () => {
    const warn = vi.fn();
    reportMissingKey([], "settings", "foo", warn);
    expect(warn).toHaveBeenCalledWith('[i18n] Missing translation: "?:settings:foo"');
  });
});
