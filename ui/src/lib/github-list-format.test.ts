import { describe, it, expect } from "vitest";
import { relativeTime, shouldOpenUpward, statusMessage } from "./github-list-format";

describe("statusMessage", () => {
  it("maps every non-ready state to a user-facing reason", () => {
    expect(statusMessage({ type: "ready" })).toBeNull();
    expect(statusMessage({ type: "pending" })).toBeNull();
    expect(statusMessage({ type: "notAGithubRepo" })).toContain("No GitHub repository");
    expect(statusMessage({ type: "ghMissing" })).toContain("gh");
    expect(statusMessage({ type: "unauthorized" })).toContain("gh auth login");
    expect(statusMessage({ type: "failed", message: "HTTP 500" })).toBe("HTTP 500");
  });
});

describe("shouldOpenUpward", () => {
  const list = { top: 0, bottom: 200 };

  it("opens downward while the space below still fits the menu", () => {
    expect(shouldOpenUpward({ top: 0, bottom: 24 }, list, 96)).toBe(false);
  });

  it("opens upward for a row near the bottom of the scrolling list", () => {
    expect(shouldOpenUpward({ top: 176, bottom: 200 }, list, 96)).toBe(true);
  });

  it("stays downward when neither side fits but below is the roomier one", () => {
    // A pane too short for the menu either way: flipping would only trade one
    // clipped edge for a worse one.
    expect(shouldOpenUpward({ top: 10, bottom: 34 }, { top: 0, bottom: 80 }, 96)).toBe(false);
  });
});

describe("relativeTime", () => {
  it("compresses ages into the widths a pane row can hold", () => {
    const now = Date.parse("2026-08-01T12:00:00Z");
    expect(relativeTime("2026-08-01T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-08-01T11:30:00Z", now)).toBe("30m");
    expect(relativeTime("2026-08-01T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-07-29T12:00:00Z", now)).toBe("3d");
  });

  it("renders nothing rather than NaN for an unparseable stamp", () => {
    expect(relativeTime("not a date", Date.parse("2026-08-01T12:00:00Z"))).toBe("");
  });
});
