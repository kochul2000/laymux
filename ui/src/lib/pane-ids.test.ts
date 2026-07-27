import { describe, expect, it } from "vitest";

import { toPaneId, toTerminalId } from "./pane-ids";

describe("pane-ids", () => {
  it("derives the terminal id from the pane id", () => {
    expect(toTerminalId("pane-1")).toBe("terminal-pane-1");
  });

  it("round-trips a pane id through both directions", () => {
    expect(toPaneId(toTerminalId("pane-1"))).toBe("pane-1");
  });

  it("passes through a value that is already a pane id", () => {
    expect(toPaneId("pane-1")).toBe("pane-1");
  });

  // A pane id may itself start with `terminal-`; only the derived prefix is
  // stripped, so the inverse stays exact instead of eating the id.
  it("strips only one leading prefix", () => {
    expect(toPaneId("terminal-terminal-1")).toBe("terminal-1");
  });
});
