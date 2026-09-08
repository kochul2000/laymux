import { describe, expect, it } from "vitest";

import { fileKindIconName as desktopFileKindIconName } from "../lib/file-kind-icon";
import {
  commandStatusIconName,
  createRemoteIcon,
  fileKindIconName,
  hydrateRemoteIcons,
  setRemoteIcon,
} from "./remote-icons.js";

describe("Remote Lucide icon boundary", () => {
  it("owns the shared decorative SVG defaults", () => {
    const icon = createRemoteIcon("Copy");

    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect(icon.getAttribute("width")).toBe("14");
    expect(icon.getAttribute("height")).toBe("14");
    expect(icon.getAttribute("stroke-width")).toBe("2");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("focusable")).toBe("false");
    expect(icon.getAttribute("data-remote-icon-name")).toBe("Copy");
    expect(icon.classList.contains("remote-icon")).toBe(true);
  });

  it("hydrates static placeholders and preserves their host attributes", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<span id="copy" class="extra" hidden data-remote-icon="Copy" data-icon-size="20"></span>';

    hydrateRemoteIcons(host);

    const icon = host.querySelector("svg");
    expect(icon?.id).toBe("copy");
    expect(icon?.classList.contains("extra")).toBe(true);
    expect(icon?.hasAttribute("hidden")).toBe(true);
    expect(icon?.getAttribute("width")).toBe("20");
  });

  it("replaces dynamic icon hosts without copying string SVG markup", () => {
    const host = document.createElement("span");

    setRemoteIcon(host, "Folder", { size: 18 });

    expect(host.childElementCount).toBe(1);
    expect(host.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(host.firstElementChild?.getAttribute("width")).toBe("18");
  });

  it.each([
    ["⏳", "Hourglass"],
    ["✓", "Check"],
    ["✗", "X"],
    ["—", "Minus"],
  ])("maps the Remote status contract %s at the render boundary", (status, icon) => {
    expect(commandStatusIconName(status)).toBe(icon);
  });

  it("maps directory rows with the same names as the desktop explorer", () => {
    const cases = [
      [{ isDirectory: true }, true],
      [{ isDirectory: true, isSymlink: true }, false],
      [{ isDirectory: false, isSymlink: true }, false],
      [{ isDirectory: false, isSymlink: false }, false],
    ] as const;
    for (const [entry, isParent] of cases) {
      expect(fileKindIconName(entry, isParent)).toBe(desktopFileKindIconName(entry, isParent));
    }
    expect(createRemoteIcon("FolderUp").getAttribute("data-remote-icon-name")).toBe("FolderUp");
    expect(createRemoteIcon("Link").getAttribute("data-remote-icon-name")).toBe("Link");
  });
});
