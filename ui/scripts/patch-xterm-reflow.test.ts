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
const moduleCompositionKeypressOwner =
  "keypress(t){return this._isSendingComposition?(this._pendingKeypressData+=t,!0):!1}";
const commonJsCompositionKeypressOwner =
  "keypress(e){return!!this._isSendingComposition&&(this._pendingKeypressData+=e,!0)}";
const compositionReconcileOwner = "_sendCompositionInput(t){const e=this._pendingKeypressData;";
const moduleCompositionKeypressHandoff =
  "this._compositionHelper.keypress(i)||this.coreService.triggerDataEvent(i,!0)";
const commonJsCompositionKeypressHandoff =
  "this._compositionHelper.keypress(t)||this.coreService.triggerDataEvent(t,!0)";
const moduleUnreconciledKeypressSend =
  "this._showCursor(),this.coreService.triggerDataEvent(i,!0),this._keyPressHandled=!0";
const commonJsUnreconciledKeypressSend =
  "this._showCursor(),this.coreService.triggerDataEvent(t,!0),this._keyPressHandled=!0";

describe("pinned xterm bundle patches", () => {
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

  it("reconciles pending composition keypress text in both pinned xterm bundles", async () => {
    const [moduleSource, commonJsSource] = await Promise.all([
      readFile(moduleTarget, "utf8"),
      readFile(commonJsTarget, "utf8"),
    ]);

    expect(moduleSource).toContain(moduleCompositionKeypressOwner);
    expect(commonJsSource).toContain(commonJsCompositionKeypressOwner);
    expect(moduleSource).toContain(compositionReconcileOwner);
    expect(commonJsSource).toContain(compositionReconcileOwner);
    expect(moduleSource).toContain(moduleCompositionKeypressHandoff);
    expect(commonJsSource).toContain(commonJsCompositionKeypressHandoff);
    expect(moduleSource).not.toContain(moduleUnreconciledKeypressSend);
    expect(commonJsSource).not.toContain(commonJsUnreconciledKeypressSend);
  });
});
