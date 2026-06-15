import { describe, it, expect } from "vitest";
import { resolveLanguage } from "./resolve-language";

describe("resolveLanguage", () => {
  it("returns explicit ko regardless of navigator locale", () => {
    expect(resolveLanguage("ko", "en-US")).toBe("ko");
    expect(resolveLanguage("ko", undefined)).toBe("ko");
  });

  it("returns explicit en regardless of navigator locale", () => {
    expect(resolveLanguage("en", "ko-KR")).toBe("en");
    expect(resolveLanguage("en", undefined)).toBe("en");
  });

  it("system maps ko* locales to Korean", () => {
    expect(resolveLanguage("system", "ko")).toBe("ko");
    expect(resolveLanguage("system", "ko-KR")).toBe("ko");
    expect(resolveLanguage("system", "KO-kr")).toBe("ko");
  });

  it("system maps non-ko locales to English", () => {
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage("system", "ja-JP")).toBe("en");
    expect(resolveLanguage("system", "fr")).toBe("en");
  });

  it("system falls back to English for missing/empty locale", () => {
    expect(resolveLanguage("system", undefined)).toBe("en");
    expect(resolveLanguage("system", null)).toBe("en");
    expect(resolveLanguage("system", "")).toBe("en");
  });
});
