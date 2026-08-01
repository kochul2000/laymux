import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { WIDGET_DEFINITIONS, findWidgetDefinition } from "./registry";

/**
 * The Rust write path validates `type` against its own list, so the two must
 * agree — otherwise Settings offers a widget that `update_settings` rejects, or
 * the backend accepts one nothing can draw (ADR-0105).
 */
function rustWidgetTypes(): string[] {
  // vitest runs with `ui/` as cwd; the Rust list lives beside it.
  const constantsPath = resolve(process.cwd(), "../src-tauri/src/constants.rs");
  const source = readFileSync(constantsPath, "utf8");
  const block = source.match(/pub const WIDGET_TYPES: &\[&str\] = &\[([\s\S]*?)\];/);
  if (!block) throw new Error("WIDGET_TYPES not found in constants.rs");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("widget registry", () => {
  it("exposes exactly the types the backend accepts", () => {
    const frontend = WIDGET_DEFINITIONS.map((definition) => definition.type).sort();
    expect(frontend).toEqual(rustWidgetTypes().sort());
  });

  it("has no duplicate type names", () => {
    const types = WIDGET_DEFINITIONS.map((definition) => definition.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("returns undefined for an unregistered type instead of throwing", () => {
    expect(findWidgetDefinition("fromTheFuture")).toBeUndefined();
  });

  it("declares every option it exposes in its own defaults", () => {
    for (const definition of WIDGET_DEFINITIONS) {
      for (const spec of definition.optionSpecs) {
        expect(Object.keys(definition.defaultOptions)).toContain(spec.key);
      }
    }
  });
});
