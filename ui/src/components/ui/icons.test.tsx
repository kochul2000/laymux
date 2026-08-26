import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { ExternalLinkIcon } from "./icons";

describe("application icons", () => {
  it("applies the shared decorative icon defaults", () => {
    render(<ExternalLinkIcon data-testid="icon" />);

    const icon = screen.getByTestId("icon");
    expect(icon).toHaveAttribute("width", "12");
    expect(icon).toHaveAttribute("height", "12");
    expect(icon).toHaveAttribute("stroke", "currentColor");
    expect(icon).toHaveAttribute("stroke-width", "2");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("focusable", "false");
    expect(icon).toHaveStyle({ flex: "0 0 auto" });
  });

  it("keeps handwritten SVG limited to product-specific diagrams", async () => {
    const componentsRoot = path.resolve("src/components");
    const entries = await readdir(componentsRoot, { recursive: true });
    const inlineSvgOwners: string[] = [];

    for (const entry of entries) {
      const normalized = entry.replaceAll("\\", "/");
      if (!normalized.endsWith(".tsx") || normalized.endsWith(".test.tsx")) continue;
      const source = await readFile(path.join(componentsRoot, entry), "utf8");
      const count = source.match(/<svg\b/g)?.length ?? 0;
      if (count > 0) inlineSvgOwners.push(`${normalized}:${count}`);
    }

    expect(inlineSvgOwners.sort()).toEqual(
      ["views/PaneMinimap.tsx:1", "views/WorkspaceSelectorView.tsx:1"].sort(),
    );
  });

  it("keeps lucide imports behind the shared application boundary", async () => {
    const componentsRoot = path.resolve("src/components");
    const entries = await readdir(componentsRoot, { recursive: true });
    const importers: string[] = [];

    for (const entry of entries) {
      const normalized = entry.replaceAll("\\", "/");
      if (!normalized.endsWith(".tsx") || normalized.endsWith(".test.tsx")) continue;
      const source = await readFile(path.join(componentsRoot, entry), "utf8");
      if (source.includes('from "lucide-react"')) importers.push(normalized);
    }

    expect(importers).toEqual(["ui/icons.tsx"]);
  });

  it("does not depend on OS icon fonts", async () => {
    const componentsRoot = path.resolve("src/components");
    const entries = await readdir(componentsRoot, { recursive: true });
    const offenders: string[] = [];

    for (const entry of entries) {
      const normalized = entry.replaceAll("\\", "/");
      if (!normalized.endsWith(".tsx") || normalized.endsWith(".test.tsx")) continue;
      const source = await readFile(path.join(componentsRoot, entry), "utf8");
      if (/Segoe (?:Fluent Icons|MDL2 Assets)/.test(source)) offenders.push(normalized);
    }

    expect(offenders).toEqual([]);
  });

  it("does not render legacy character glyphs as desktop application icons", async () => {
    const componentsRoot = path.resolve("src/components");
    const entries = await readdir(componentsRoot, { recursive: true });
    const legacyIconPatterns = [
      />\s*⠿\s*</,
      />\s*●\s*</,
      />\s*[🗗🗖←→⟳▾▸+−]\s*</u,
      /[📁🔗📄🗀]/u,
      /["']↗["']/,
      /&#10005;/,
    ];
    const offenders: string[] = [];

    for (const entry of entries) {
      const normalized = entry.replaceAll("\\", "/");
      if (!normalized.endsWith(".tsx") || normalized.endsWith(".test.tsx")) continue;
      const source = await readFile(path.join(componentsRoot, entry), "utf8");
      if (legacyIconPatterns.some((pattern) => pattern.test(source))) offenders.push(normalized);
    }

    expect(offenders).toEqual([]);
  });
});
