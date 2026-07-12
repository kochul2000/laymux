import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const target = resolve(process.cwd(), "node_modules/@xterm/xterm/lib/xterm.mjs");
const stale = "m>0&&(o.push(l+h.length-m),o.push(m)),l+=h.length-1";
const fixed =
  "m>0&&(h[c].isWrapped=!1,u&&(u.isWrapped=!1),o.push(l+h.length-m),o.push(m)),l+=h.length-1";

describe("xterm wider-reflow patch", () => {
  it("is applied to the pinned xterm bundle", async () => {
    const source = await readFile(target, "utf8");

    expect(source).toContain(fixed);
    expect(source).not.toContain(stale);
  });
});
