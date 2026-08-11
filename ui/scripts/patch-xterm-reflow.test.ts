import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const moduleTarget = resolve(process.cwd(), "node_modules/@xterm/xterm/lib/xterm.mjs");
const commonJsTarget = resolve(process.cwd(), "node_modules/@xterm/xterm/lib/xterm.js");
const remoteCommonJsTarget = resolve(
  process.cwd(),
  "../src-tauri/src/remote_server/assets/xterm.js",
);
const stale = "m>0&&(o.push(l+h.length-m),o.push(m)),l+=h.length-1";
const fixed =
  "m>0&&(h[c].isWrapped=!1,u&&(u.isWrapped=!1),o.push(l+h.length-m),o.push(m)),l+=h.length-1";
const staleDisableStdinGate = "if(this._optionsService.rawOptions.disableStdin)return;";
const moduleUserOnlyDisableStdinGate = "if(this._optionsService.rawOptions.disableStdin&&i)return;";
const commonJsUserOnlyDisableStdinGate =
  "if(this._optionsService.rawOptions.disableStdin&&t)return;";
const compositionGenerationState = "this._pendingCompositionGenerations=[]";
const moduleCompositionKeypressOwner =
  "keypress(t){return this._queueCompositionObservation(t)}input(t){return this._queueCompositionObservation(t)}";
const commonJsCompositionKeypressOwner =
  "keypress(e){return this._queueCompositionObservation(e)}input(e){return this._queueCompositionObservation(e)}";
const compositionGenerationFinalizer =
  "_flushCompositionGeneration(t){if(t.done)return;for(;this._pendingCompositionGenerations.length>0;)";
const compositionBoundaryOwner = "compositionstart(){this._boundPendingComposition()";
const moduleCompositionKeypressHandoff =
  "this._compositionHelper.keypress(i)||this.coreService.triggerDataEvent(i,!0)";
const commonJsCompositionKeypressHandoff =
  "this._compositionHelper.keypress(t)||this.coreService.triggerDataEvent(t,!0)";
const moduleCompositionInputHandoff = "if(this._compositionHelper.input(i))";
const commonJsCompositionInputHandoff = "if(this._compositionHelper.input(t))";
const staleSingleGenerationState = "_pendingKeypressData";
const moduleUnreconciledKeypressSend =
  "this._showCursor(),this.coreService.triggerDataEvent(i,!0),this._keyPressHandled=!0";
const commonJsUnreconciledKeypressSend =
  "this._showCursor(),this.coreService.triggerDataEvent(t,!0),this._keyPressHandled=!0";
const moduleWheelAccumulator =
  "this._wheelPartialScroll+=o,o=Math.floor(Math.abs(this._wheelPartialScroll))";
const commonJsWheelAccumulator =
  "this._wheelPartialScroll+=r,r=Math.floor(Math.abs(this._wheelPartialScroll))";
const moduleMouseReportRepetition = "for(let c=0;c<p;c++)";
const commonJsMouseReportRepetition = "for(let o=0;o<n;o++)";
const moduleAltBufferRepetition = "c.repeat(Math.abs(h))";
const commonJsAltBufferRepetition = "s.repeat(Math.abs(i))";

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

  it("queues input and keypress observations per composition generation in both bundles", async () => {
    const [moduleSource, commonJsSource] = await Promise.all([
      readFile(moduleTarget, "utf8"),
      readFile(commonJsTarget, "utf8"),
    ]);

    expect(moduleSource).toContain(compositionGenerationState);
    expect(commonJsSource).toContain(compositionGenerationState);
    expect(moduleSource).toContain(moduleCompositionKeypressOwner);
    expect(commonJsSource).toContain(commonJsCompositionKeypressOwner);
    expect(moduleSource).toContain(compositionGenerationFinalizer);
    expect(commonJsSource).toContain(compositionGenerationFinalizer);
    expect(moduleSource).toContain(compositionBoundaryOwner);
    expect(commonJsSource).toContain(compositionBoundaryOwner);
    expect(moduleSource).toContain(moduleCompositionKeypressHandoff);
    expect(commonJsSource).toContain(commonJsCompositionKeypressHandoff);
    expect(moduleSource).toContain(moduleCompositionInputHandoff);
    expect(commonJsSource).toContain(commonJsCompositionInputHandoff);
    expect(moduleSource).not.toContain(staleSingleGenerationState);
    expect(commonJsSource).not.toContain(staleSingleGenerationState);
    expect(moduleSource).not.toContain(moduleUnreconciledKeypressSend);
    expect(commonJsSource).not.toContain(commonJsUnreconciledKeypressSend);
  });

  it("emits every sensitivity-adjusted application wheel row in all shipped bundles", async () => {
    const [moduleSource, commonJsSource, remoteCommonJsSource] = await Promise.all([
      readFile(moduleTarget, "utf8"),
      readFile(commonJsTarget, "utf8"),
      readFile(remoteCommonJsTarget, "utf8"),
    ]);

    expect(moduleSource).toContain(moduleWheelAccumulator);
    expect(moduleSource).toContain(moduleMouseReportRepetition);
    expect(moduleSource).toContain(moduleAltBufferRepetition);
    expect(commonJsSource).toContain(commonJsWheelAccumulator);
    expect(commonJsSource).toContain(commonJsMouseReportRepetition);
    expect(commonJsSource).toContain(commonJsAltBufferRepetition);
    expect(remoteCommonJsSource).toContain(commonJsWheelAccumulator);
    expect(remoteCommonJsSource).toContain(commonJsMouseReportRepetition);
    expect(remoteCommonJsSource).toContain(commonJsAltBufferRepetition);
  });
});
