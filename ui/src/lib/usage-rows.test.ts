import { describe, expect, it } from "vitest";
import { buildGrokUsageRows } from "./usage-rows";

function at(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("buildGrokUsageRows", () => {
  it("derives weekly elapsed from the reset text the probe captured", () => {
    const rows = buildGrokUsageRows(
      [{ key: "weekly", percent: 66, reset: "August 20, 16:13" }],
      at(2026, 8, 17, 4, 13),
    );

    expect(rows).toEqual([
      {
        visibleKey: "weekly",
        row: expect.objectContaining({
          key: "weekly",
          percent: 66,
          reset: "August 20, 16:13",
          elapsed: 50,
        }),
      },
    ]);
  });

  it("omits elapsed on credits and payg — those buckets have no window", () => {
    const rows = buildGrokUsageRows(
      [
        { key: "credits", percent: null, remaining: 12, reset: null },
        { key: "payg", percent: 15, reset: null },
      ],
      at(2026, 8, 17, 4, 13),
    );

    expect(rows.map((entry) => [entry.visibleKey, entry.row.elapsed])).toEqual([
      ["credits", null],
      ["payg", null],
    ]);
  });

  it("leaves weekly elapsed null when the reset text cannot be read", () => {
    const [entry] = buildGrokUsageRows(
      [{ key: "weekly", percent: 10, reset: "sometime soon" }],
      at(2026, 8, 17, 4, 13),
    );

    expect(entry.row.elapsed).toBeNull();
  });
});
