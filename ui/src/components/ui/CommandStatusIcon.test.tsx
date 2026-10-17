import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { StatusIconGlyph } from "@/lib/activity-markers";
import { CommandStatusIcon } from "./CommandStatusIcon";

describe("CommandStatusIcon (ADR-0341)", () => {
  it.each([
    ["⏳", "working", "lucide-hourglass"],
    ["✓", "success", "lucide-check"],
    ["✗", "failure", "lucide-x"],
    ["⊘", "interrupted", "lucide-ban"],
    ["○", "ended", "lucide-circle"],
    ["!", "waiting", "lucide-circle-alert"],
    ["—", "idle", "lucide-minus"],
    ["·", "unknown", "lucide-dot"],
  ] as const)("%s는 %s 아이콘 하나로 그린다", (status: StatusIconGlyph, kind, lucideClass) => {
    const { container } = render(<CommandStatusIcon status={status} label={kind} />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("data-status-icon")).toBe(kind);
    expect(icon?.getAttribute("aria-label")).toBe(kind);
    expect(icon?.classList.contains(lucideClass)).toBe(true);
  });
});
