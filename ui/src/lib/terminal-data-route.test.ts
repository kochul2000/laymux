import { describe, expect, it } from "vitest";
import { routeXtermData } from "./terminal-data-route";

describe("routeXtermData", () => {
  it("routes live-parser replies through the protocol path", () => {
    expect(routeXtermData({ writeSource: "live", humanEventActive: false })).toBe("protocol");
  });

  it("suppresses replies generated while replaying cache or snapshots", () => {
    expect(routeXtermData({ writeSource: "replay", humanEventActive: false })).toBe("suppress");
  });

  it("keeps human events on the owner-gated path even while a write is being parsed", () => {
    expect(routeXtermData({ writeSource: "live", humanEventActive: true })).toBe("human");
  });

  it("treats data outside parser writes as human input", () => {
    expect(routeXtermData({ writeSource: undefined, humanEventActive: false })).toBe("human");
  });
});
