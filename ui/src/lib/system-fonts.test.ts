import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  MONOSPACED_FONTS,
  isMonospace,
  detectInstalledFonts,
  listSystemFonts,
  getSystemMonospaceFonts,
} from "./system-fonts";

const mockedInvoke = vi.mocked(invoke);

// Helper: create a mock CanvasRenderingContext2D with controllable measureText
function makeMockCtx(widthFn: (text: string, font: string) => number): CanvasRenderingContext2D {
  let currentFont = "";
  return {
    set font(f: string) { currentFont = f; },
    get font() { return currentFont; },
    measureText: (text: string) => ({ width: widthFn(text, currentFont) }),
  } as unknown as CanvasRenderingContext2D;
}

describe("system-fonts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("MONOSPACED_FONTS", () => {
    it("contains curated fallback fonts", () => {
      expect(MONOSPACED_FONTS).toContain("Cascadia Mono");
      expect(MONOSPACED_FONTS).toContain("Consolas");
      expect(MONOSPACED_FONTS).toContain("Fira Code");
      expect(MONOSPACED_FONTS.length).toBeGreaterThan(10);
    });
  });

  describe("isMonospace", () => {
    it("returns true when narrow and wide characters have equal width", () => {
      const ctx = makeMockCtx(() => 100); // all texts same width
      expect(isMonospace(ctx, "FakeMonoFont")).toBe(true);
    });

    it("returns false when narrow and wide characters differ", () => {
      const ctx = makeMockCtx((text) => (text.includes("i") ? 50 : 150));
      expect(isMonospace(ctx, "FakeProportionalFont")).toBe(false);
    });
  });

  describe("detectInstalledFonts", () => {
    it("returns candidates when canvas is unavailable (jsdom)", () => {
      const candidates = ["FontA", "FontB"];
      // jsdom canvas getContext returns null → function returns full list
      const result = detectInstalledFonts(candidates);
      expect(result).toEqual(candidates);
    });
  });

  describe("listSystemFonts", () => {
    it("returns font list from Tauri invoke", async () => {
      const fonts = ["Arial", "Consolas", "Fira Code"];
      mockedInvoke.mockResolvedValue(fonts);

      const result = await listSystemFonts();
      expect(result).toEqual(fonts);
      expect(mockedInvoke).toHaveBeenCalledWith("list_system_fonts");
    });

    it("returns empty array when invoke fails", async () => {
      mockedInvoke.mockRejectedValue(new Error("No Tauri runtime"));

      const result = await listSystemFonts();
      expect(result).toEqual([]);
    });
  });

  describe("getSystemMonospaceFonts", () => {
    it("falls back to curated list when system enumeration returns empty", async () => {
      mockedInvoke.mockResolvedValue([]);

      const result = await getSystemMonospaceFonts();
      // In jsdom, canvas ctx is null → detectInstalledFonts returns full MONOSPACED_FONTS
      expect(result).toEqual(MONOSPACED_FONTS);
    });

    it("falls back to curated list when invoke fails", async () => {
      mockedInvoke.mockRejectedValue(new Error("No Tauri"));

      const result = await getSystemMonospaceFonts();
      expect(result).toEqual(MONOSPACED_FONTS);
    });
  });
});
