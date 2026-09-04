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
const compositionObservationList = "observations:[]";
const compositionEndCommitData = "committed:this._compositionEndDataAllowed?e:void 0";
const compositionBlurFlush =
  "blur(){this._compositionEndDataAllowed=!1,this._flushPendingCompositionGenerations()}";
const compositionEndDataEnabledAtStart = "this._compositionEndDataAllowed=!0";
const compositionBlurHandoff =
  '_handleTextAreaBlur(){this._compositionHelper.blur(),this.textarea.value=""';
const compositionCancelledFlush = "if(e.cancelled){if(e===t)break;continue}";
const compositionGenerationSnapshot =
  "t&&t.valueSnapshot===null&&(t.valueSnapshot=this._textarea.value)";
const compositionSnapshotCandidate =
  "s=e.valueSnapshot===null?this._textarea.value:e.valueSnapshot,r=s.substring(i)";
const compositionCandidateFirstFold =
  'let n=this._mergeCompositionData(r,e.committed||""),o="",l=!1;for(const t of e.observations)l?n=this._mergeCompositionData(n,t,!0):n.includes(t)?(o&&(n=this._mergeCompositionData(n,o)),l=!0):o=this._mergeCompositionData(t,o);l||!o||(n=this._mergeCompositionData(n,o))';
const compositionAnchoredTieOrder = "i>s||o&&i===s?t+e.substring(i):e+t.substring(s)";
const staleMergedObservationState = 'observed:""';
const staleMergedObservationQueue = "e.observed=this._mergeCompositionData(t,e.observed)";
const compositionBoundaryOwner = "compositionstart(){this._boundPendingComposition()";
const moduleCompositionKeypressHandoff =
  "this._compositionHelper.keypress(i)?this.cancel(e,!0):this.coreService.triggerDataEvent(i,!0)";
const commonJsCompositionKeypressHandoff =
  "this._compositionHelper.keypress(t)?this.cancel(e,!0):this.coreService.triggerDataEvent(t,!0)";
const moduleCompositionKeypressWithoutDefaultCancel =
  "this._compositionHelper.keypress(i)||this.coreService.triggerDataEvent(i,!0)";
const commonJsCompositionKeypressWithoutDefaultCancel =
  "this._compositionHelper.keypress(t)||this.coreService.triggerDataEvent(t,!0)";
const moduleDuplicatedCompositionKeypressHandoff =
  "this._compositionHelper.keypress(i)||this._compositionHelper.keypress(i)?this.cancel(e,!0)";
const commonJsDuplicatedCompositionKeypressHandoff =
  "this._compositionHelper.keypress(t)||this._compositionHelper.keypress(t)?this.cancel(e,!0)";
const moduleCompositionInputHandoff = "if(this._compositionHelper.input(i))";
const commonJsCompositionInputHandoff = "if(this._compositionHelper.input(t))";
const moduleCompositionEndDataHandoff =
  '"compositionend",t=>this._compositionHelper.compositionend(t.data)';
const commonJsCompositionEndDataHandoff =
  '"compositionend",(e=>this._compositionHelper.compositionend(e.data))';
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
const moduleAltBufferRepetition =
  "for(let d=0;d<Math.abs(h);d++)this.coreService.triggerDataEvent(c,!0)";
const commonJsAltBufferRepetition =
  "for(let r=0;r<Math.abs(i);r++)this.coreService.triggerDataEvent(s,!0)";
const moduleTextareaDiffSkipSending =
  "_handleAnyTextareaChanges(){let t=this._textarea.value,s=this._compositionEpoch||0;setTimeout(()=>{if(s===(this._compositionEpoch||0)&&!this._isComposing&&!this._isSendingComposition){let e=this._textarea.value";
const commonJsTextareaDiffSkipSending =
  "_handleAnyTextareaChanges(){const e=this._textarea.value,o=this._compositionEpoch||0;setTimeout((()=>{if(o===(this._compositionEpoch||0)&&!this._isComposing&&!this._isSendingComposition){const t=this._textarea.value";
const staleModuleTextareaDiffSkipSending =
  "_handleAnyTextareaChanges(){let t=this._textarea.value;setTimeout(()=>{if(!this._isComposing){let e=this._textarea.value";
const staleCommonJsTextareaDiffSkipSending =
  "_handleAnyTextareaChanges(){const e=this._textarea.value;setTimeout((()=>{if(!this._isComposing){const t=this._textarea.value";
const compositionEpochBump = "this._compositionEpoch=(this._compositionEpoch||0)+1";

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
    expect(moduleSource).toContain(compositionObservationList);
    expect(commonJsSource).toContain(compositionObservationList);
    expect(moduleSource).toContain(compositionEndCommitData);
    expect(commonJsSource).toContain(compositionEndCommitData);
    expect(moduleSource).toContain(compositionBlurFlush);
    expect(commonJsSource).toContain(compositionBlurFlush);
    expect(moduleSource).toContain(compositionEndDataEnabledAtStart);
    expect(commonJsSource).toContain(compositionEndDataEnabledAtStart);
    expect(moduleSource).toContain(compositionBlurHandoff);
    expect(commonJsSource).toContain(compositionBlurHandoff);
    expect(moduleSource).toContain(compositionCancelledFlush);
    expect(commonJsSource).toContain(compositionCancelledFlush);
    expect(moduleSource).toContain(compositionGenerationSnapshot);
    expect(commonJsSource).toContain(compositionGenerationSnapshot);
    expect(moduleSource).toContain(compositionSnapshotCandidate);
    expect(commonJsSource).toContain(compositionSnapshotCandidate);
    expect(moduleSource).toContain(compositionCandidateFirstFold);
    expect(commonJsSource).toContain(compositionCandidateFirstFold);
    expect(moduleSource).toContain(moduleCompositionEndDataHandoff);
    expect(commonJsSource).toContain(commonJsCompositionEndDataHandoff);
    expect(moduleSource).toContain(compositionAnchoredTieOrder);
    expect(commonJsSource).toContain(compositionAnchoredTieOrder);
    expect(moduleSource).toContain(compositionBoundaryOwner);
    expect(commonJsSource).toContain(compositionBoundaryOwner);
    expect(moduleSource).toContain(moduleCompositionKeypressHandoff);
    expect(commonJsSource).toContain(commonJsCompositionKeypressHandoff);
    expect(moduleSource).not.toContain(moduleCompositionKeypressWithoutDefaultCancel);
    expect(commonJsSource).not.toContain(commonJsCompositionKeypressWithoutDefaultCancel);
    expect(moduleSource).not.toContain(moduleDuplicatedCompositionKeypressHandoff);
    expect(commonJsSource).not.toContain(commonJsDuplicatedCompositionKeypressHandoff);
    expect(moduleSource).toContain(moduleCompositionInputHandoff);
    expect(commonJsSource).toContain(commonJsCompositionInputHandoff);
    expect(moduleSource).not.toContain(staleSingleGenerationState);
    expect(commonJsSource).not.toContain(staleSingleGenerationState);
    expect(moduleSource).not.toContain(staleMergedObservationState);
    expect(commonJsSource).not.toContain(staleMergedObservationState);
    expect(moduleSource).not.toContain(staleMergedObservationQueue);
    expect(commonJsSource).not.toContain(staleMergedObservationQueue);
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

  it("skips the 229 textarea-diff send while a composition finalizer is pending", async () => {
    const [moduleSource, commonJsSource, remoteCommonJsSource] = await Promise.all([
      readFile(moduleTarget, "utf8"),
      readFile(commonJsTarget, "utf8"),
      readFile(remoteCommonJsTarget, "utf8"),
    ]);

    expect(moduleSource).toContain(moduleTextareaDiffSkipSending);
    expect(commonJsSource).toContain(commonJsTextareaDiffSkipSending);
    expect(remoteCommonJsSource).toContain(commonJsTextareaDiffSkipSending);
    expect(moduleSource).not.toContain(staleModuleTextareaDiffSkipSending);
    expect(commonJsSource).not.toContain(staleCommonJsTextareaDiffSkipSending);
    expect(remoteCommonJsSource).not.toContain(staleCommonJsTextareaDiffSkipSending);
    expect(moduleSource).toContain(compositionEpochBump);
    expect(commonJsSource).toContain(compositionEpochBump);
    expect(remoteCommonJsSource).toContain(compositionEpochBump);
  });
});
