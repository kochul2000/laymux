import { describe, expect, it } from "vitest";

import { isStaleActivity } from "./activity-order";

describe("isStaleActivity", () => {
  it("rejects a verdict derived before the one already applied", () => {
    expect(isStaleActivity(100, 90)).toBe(true);
  });

  it("accepts a verdict derived after the one already applied", () => {
    expect(isStaleActivity(90, 100)).toBe(false);
  });

  it("rejects a repeat of the verdict already applied", () => {
    expect(isStaleActivity(100, 100)).toBe(true);
  });

  // The mount-time pull carries no stamp; refusing it would leave the pane
  // unclassified until the next reconcile pass.
  it("accepts unstamped input", () => {
    expect(isStaleActivity(100, undefined)).toBe(false);
  });

  it("accepts anything for a pane that has applied nothing yet", () => {
    expect(isStaleActivity(undefined, 1)).toBe(false);
  });
});
