import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  MONOSPACED_FONTS,
  detectInstalledFonts,
  listSystemMonospaceFonts,
  getSystemMonospaceFonts,
} from "./system-fonts";

const mockedInvoke = vi.mocked(invoke);

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

    it("contains JetBrains Hangul variants", () => {
      expect(MONOSPACED_FONTS).toContain("JetBrainsMonoBigHangul");
      expect(MONOSPACED_FONTS).toContain("JetBrainsMonoHangul");
    });
  });

  describe("detectInstalledFonts", () => {
    it("returns candidates when canvas is unavailable (jsdom)", () => {
      const candidates = ["FontA", "FontB"];
      const result = detectInstalledFonts(candidates);
      expect(result).toEqual(candidates);
    });
  });

  describe("listSystemMonospaceFonts", () => {
    it("invokes list_system_monospace_fonts Tauri command", async () => {
      const fonts = ["Consolas", "Fira Code", "D2Coding"];
      mockedInvoke.mockResolvedValue(fonts);

      const result = await listSystemMonospaceFonts();
      expect(result).toEqual(fonts);
      expect(mockedInvoke).toHaveBeenCalledWith("list_system_monospace_fonts");
    });

    it("returns empty array when invoke fails", async () => {
      mockedInvoke.mockRejectedValue(new Error("No Tauri runtime"));

      const result = await listSystemMonospaceFonts();
      expect(result).toEqual([]);
    });
  });

  describe("getSystemMonospaceFonts", () => {
    it("falls back to curated list when backend returns empty", async () => {
      mockedInvoke.mockResolvedValue([]);

      const result = await getSystemMonospaceFonts();
      // jsdom has no canvas → detectInstalledFonts returns full MONOSPACED_FONTS
      expect(result).toEqual(MONOSPACED_FONTS);
    });

    it("falls back to curated list when invoke fails", async () => {
      mockedInvoke.mockRejectedValue(new Error("No Tauri"));

      const result = await getSystemMonospaceFonts();
      expect(result).toEqual(MONOSPACED_FONTS);
    });

    it("places curated fonts at the top, then remaining system fonts", async () => {
      // Backend returns monospace fonts (alphabetically sorted)
      mockedInvoke.mockResolvedValue([
        "Consolas",
        "D2Coding",
        "Fira Code",
        "MyCustomMono",
        "ZetaMono",
      ]);

      const result = await getSystemMonospaceFonts();

      // Curated fonts that exist in system list should come first, in curated order
      const curatedSection = result.slice(0, 3);
      expect(curatedSection).toEqual(["Consolas", "Fira Code", "D2Coding"]);

      // Non-curated system fonts follow
      const restSection = result.slice(3);
      expect(restSection).toEqual(["MyCustomMono", "ZetaMono"]);
    });

    it("excludes curated fonts not found in system list", async () => {
      mockedInvoke.mockResolvedValue(["Consolas", "ExtraFont"]);

      const result = await getSystemMonospaceFonts();
      // Only "Consolas" from curated list is in system → it comes first
      expect(result[0]).toBe("Consolas");
      expect(result[1]).toBe("ExtraFont");
      expect(result).toHaveLength(2);
      // "Fira Code" etc. not in system list → excluded
      expect(result).not.toContain("Fira Code");
    });

    it("preserves curated order among curated fonts", async () => {
      // MONOSPACED_FONTS order: Cascadia Mono, Cascadia Code, Consolas, ...
      mockedInvoke.mockResolvedValue(["Consolas", "Cascadia Code", "Cascadia Mono"]);

      const result = await getSystemMonospaceFonts();
      expect(result).toEqual(["Cascadia Mono", "Cascadia Code", "Consolas"]);
    });
  });
});
