import { describe, it, expect } from "vitest";
import { relativeTime, statusMessage } from "./github-list-format";

describe("statusMessage", () => {
  it("maps every non-ready state to a user-facing reason", () => {
    expect(statusMessage({ type: "ready" })).toBeNull();
    expect(statusMessage({ type: "notAGithubRepo" })).toContain("No GitHub repository");
    expect(statusMessage({ type: "ghMissing" })).toContain("gh");
    expect(statusMessage({ type: "unauthorized" })).toContain("gh auth login");
    expect(statusMessage({ type: "failed", message: "HTTP 500" })).toBe("HTTP 500");
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
