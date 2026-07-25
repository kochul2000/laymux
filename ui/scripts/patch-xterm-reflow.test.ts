import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const moduleTarget = resolve(process.cwd(), "node_modules/@xterm/xterm/lib/xterm.mjs");
const commonJsTarget = resolve(process.cwd(), "node_modules/@xterm/xterm/lib/xterm.js");
const stale = "m>0&&(o.push(l+h.length-m),o.push(m)),l+=h.length-1";
const fixed =
  "m>0&&(h[c].isWrapped=!1,u&&(u.isWrapped=!1),o.push(l+h.length-m),o.push(m)),l+=h.length-1";
const staleDisableStdinGate = "if(this._optionsService.rawOptions.disableStdin)return;";
const moduleUserOnlyDisableStdinGate = "if(this._optionsService.rawOptions.disableStdin&&i)return;";
const commonJsUserOnlyDisableStdinGate =
  "if(this._optionsService.rawOptions.disableStdin&&t)return;";

describe("xterm wider-reflow patch", () => {
  it("is applied to the pinned xterm bundle", async () => {
    const source = await readFile(moduleTarget, "utf8");

    expect(source).toContain(fixed);
    expect(source).not.toContain(stale);
  });

  it("keeps parser-generated protocol replies enabled while human stdin is disabled", async () => {
    const [moduleSource, commonJsSource] = await Promise.all([
      readFile(moduleTarget, "utf8"),
      readFile(commonJsTarget, "utf8"),
    ]);

    expect(moduleSource).toContain(moduleUserOnlyDisableStdinGate);
    expect(commonJsSource).toContain(commonJsUserOnlyDisableStdinGate);
    expect(moduleSource).not.toContain(staleDisableStdinGate);
    expect(commonJsSource).not.toContain(staleDisableStdinGate);
  });
});
