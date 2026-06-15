import { describe, it, expect } from "vitest";
import ko from "./locales/ko.json";
import en from "./locales/en.json";

/** Recursively collect dotted leaf-key paths (string values only). */
function collectKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      out.push(...collectKeys(v, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

describe("locale key parity (ko vs en)", () => {
  const koKeys = new Set(collectKeys(ko));
  const enKeys = new Set(collectKeys(en));

  it("has no keys present in ko but missing from en", () => {
    const missingInEn = [...koKeys].filter((k) => !enKeys.has(k));
    expect(missingInEn).toEqual([]);
  });

  it("has no keys present in en but missing from ko", () => {
    const missingInKo = [...enKeys].filter((k) => !koKeys.has(k));
    expect(missingInKo).toEqual([]);
  });

  it("has no empty string values in either locale", () => {
    const emptyEntries = (obj: unknown, prefix = ""): string[] => {
      if (obj === null || typeof obj !== "object") return [];
      const out: string[] = [];
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === "object") out.push(...emptyEntries(v, path));
        else if (typeof v === "string" && v.trim() === "") out.push(path);
      }
      return out;
    };
    expect(emptyEntries(ko)).toEqual([]);
    expect(emptyEntries(en)).toEqual([]);
  });
});
