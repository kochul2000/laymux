import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

// xterm.js #5997 / e9c648f: widening can leave stale isWrapped flags on
// retained rows. Remove this once a stable @xterm/xterm release contains it.
const moduleTarget = fileURLToPath(
  new URL("../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url),
);
const commonJsTarget = fileURLToPath(
  new URL("../node_modules/@xterm/xterm/lib/xterm.js", import.meta.url),
);
const original = "m>0&&(o.push(l+h.length-m),o.push(m)),l+=h.length-1";
const patched =
  "m>0&&(h[c].isWrapped=!1,u&&(u.isWrapped=!1),o.push(l+h.length-m),o.push(m)),l+=h.length-1";
// xterm 6.0.0 CoreService treats disableStdin as a blanket onData gate, which
// also drops parser-generated OSC/DSR replies. Preserve the user-input gate but
// allow protocol replies (`wasUserInput === false`) to reach Terminal.onData.
const disableStdinOriginal = "if(this._optionsService.rawOptions.disableStdin)return;";
const moduleDisableStdinPatched = "if(this._optionsService.rawOptions.disableStdin&&i)return;";
const commonJsDisableStdinPatched = "if(this._optionsService.rawOptions.disableStdin&&t)return;";

// xterm 6.0.0 can expose one composition commit through textarea input,
// keypress, and the deferred finalizer. Keep those observations in one
// generation-scoped CompositionHelper queue so rapid consecutive commits do
// not clear or consume each other's state. The single-generation merge started
// as a backport of stablyai/orca#9235; the input handoff and generation queue
// additionally cover the Windows/WebView2 orderings from laymux issue #660.
const moduleCompositionStateOriginal =
  'this._compositionPosition={start:0,end:0},this._dataAlreadySent=""';
const moduleCompositionStateLegacy =
  'this._compositionPosition={start:0,end:0},this._dataAlreadySent="",this._pendingKeypressData=""';
const commonJsCompositionStateOriginal =
  'this._compositionPosition={start:0,end:0},this._dataAlreadySent=""';
const commonJsCompositionStateLegacy =
  'this._compositionPosition={start:0,end:0},this._dataAlreadySent="",this._pendingKeypressData=""';
const compositionGenerationState =
  'this._compositionPosition={start:0,end:0},this._pendingCompositionGenerations=[],this._dataAlreadySent=""';

const moduleCompositionKeypressOriginal =
  "return t.keyCode===229?(this._handleAnyTextareaChanges(),!1):!0}_finalizeComposition(t){";
const moduleCompositionKeypressLegacy =
  "return t.keyCode===229?(this._handleAnyTextareaChanges(),!1):!0}keypress(t){return this._isSendingComposition?(this._pendingKeypressData+=t,!0):!1}_finalizeComposition(t){";
const commonJsCompositionKeypressOriginal =
  "return 229!==e.keyCode||(this._handleAnyTextareaChanges(),!1)}_finalizeComposition(e){";
const commonJsCompositionKeypressLegacy =
  "return 229!==e.keyCode||(this._handleAnyTextareaChanges(),!1)}keypress(e){return!!this._isSendingComposition&&(this._pendingKeypressData+=e,!0)}_finalizeComposition(e){";
const moduleCompositionObservationOwner =
  "return t.keyCode===229?(this._handleAnyTextareaChanges(),!1):!0}keypress(t){return this._queueCompositionObservation(t)}input(t){return this._queueCompositionObservation(t)}_finalizeComposition(t){";
const commonJsCompositionObservationOwnerLegacy =
  "return 229!==e.keyCode||(this._handleAnyTextareaChanges(),!1)}keypress(e){return this._queueCompositionObservation(e)}input(e){return this._queueCompositionObservation(e)}_finalizeComposition(e){";
const commonJsCompositionObservationOwner =
  "return 229!==e.keyCode||(this._handleAnyTextareaChanges(),!1)}keypress(e){return this._queueCompositionObservation(e)}input(e){return this._queueCompositionObservation(e)}_finalizeComposition(t){";

const moduleCompositionPendingResetOriginal =
  "let e={start:this._compositionPosition.start,end:this._compositionPosition.end};this._isSendingComposition=!0";
const moduleCompositionPendingResetLegacy =
  'let e={start:this._compositionPosition.start,end:this._compositionPosition.end};this._pendingKeypressData="",this._isSendingComposition=!0';
const commonJsCompositionPendingResetOriginal =
  "const e={start:this._compositionPosition.start,end:this._compositionPosition.end};this._isSendingComposition=!0";
const commonJsCompositionPendingResetLegacy =
  'const e={start:this._compositionPosition.start,end:this._compositionPosition.end};this._pendingKeypressData="",this._isSendingComposition=!0';

const moduleCompositionDeferredSendOriginal =
  "i.length>0&&this._coreService.triggerDataEvent(i,!0)";
const moduleCompositionDeferredSendLegacy = "this._sendCompositionInput(i)";
const commonJsCompositionDeferredSendOriginal =
  "t.length>0&&this._coreService.triggerDataEvent(t,!0)";
const commonJsCompositionDeferredSendLegacy = "this._sendCompositionInput(t)";

const compositionReconcileMethod =
  '_sendCompositionInput(t){const e=this._pendingKeypressData;if(!t.includes(e))if(e.includes(t))t=e;else{let i=Math.min(t.length,e.length);for(;i>0&&!t.endsWith(e.substring(0,i));)i--;let s=Math.min(t.length,e.length);for(;s>0&&!e.endsWith(t.substring(0,s));)s--;t=i>s?t+e.substring(i):e+t.substring(s)}this._pendingKeypressData="",t.length>0&&this._coreService.triggerDataEvent(t,!0)}';
const moduleCompositionImmediateSendOriginal =
  "this._coreService.triggerDataEvent(e,!0)}}_handleAnyTextareaChanges(){";
const moduleCompositionImmediateSendLegacy = `this._sendCompositionInput(e)}}${compositionReconcileMethod}_handleAnyTextareaChanges(){`;
const commonJsCompositionImmediateSendOriginal =
  "this._coreService.triggerDataEvent(e,!0)}}_handleAnyTextareaChanges(){";
const commonJsCompositionImmediateSendLegacy = `this._sendCompositionInput(e)}}${compositionReconcileMethod}_handleAnyTextareaChanges(){`;

const moduleCompositionFinalizeLegacy =
  '_finalizeComposition(t){if(this._compositionView.classList.remove("active"),this._isComposing=!1,t){let e={start:this._compositionPosition.start,end:this._compositionPosition.end};this._pendingKeypressData="",this._isSendingComposition=!0,setTimeout(()=>{if(this._isSendingComposition){this._isSendingComposition=!1;let i;e.start+=this._dataAlreadySent.length,this._isComposing?i=this._textarea.value.substring(e.start,this._compositionPosition.start):i=this._textarea.value.substring(e.start),this._sendCompositionInput(i)}},0)}else{this._isSendingComposition=!1;let e=this._textarea.value.substring(this._compositionPosition.start,this._compositionPosition.end);this._sendCompositionInput(e)}}' +
  compositionReconcileMethod;
const commonJsCompositionFinalizeLegacy =
  '_finalizeComposition(e){if(this._compositionView.classList.remove("active"),this._isComposing=!1,e){const e={start:this._compositionPosition.start,end:this._compositionPosition.end};this._pendingKeypressData="",this._isSendingComposition=!0,setTimeout((()=>{if(this._isSendingComposition){let t;this._isSendingComposition=!1,e.start+=this._dataAlreadySent.length,t=this._isComposing?this._textarea.value.substring(e.start,this._compositionPosition.start):this._textarea.value.substring(e.start),this._sendCompositionInput(t)}}),0)}else{this._isSendingComposition=!1;const e=this._textarea.value.substring(this._compositionPosition.start,this._compositionPosition.end);this._sendCompositionInput(e)}}' +
  compositionReconcileMethod;
const compositionGenerationMethods =
  '_finalizeComposition(t){this._compositionView.classList.remove("active");const e=this._isComposing;if(this._isComposing=!1,t){const t={start:this._compositionPosition.start,end:this._compositionPosition.end,valueEnd:null,alreadySentLength:this._dataAlreadySent.length,observed:"",done:!1};this._pendingCompositionGenerations.push(t),this._isSendingComposition=!0,setTimeout(()=>this._flushCompositionGeneration(t),0)}else{this._flushPendingCompositionGenerations();if(e){const t=this._textarea.value.substring(this._compositionPosition.start,this._compositionPosition.end);t.length>0&&this._coreService.triggerDataEvent(t,!0)}}}_boundPendingComposition(){const t=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];t&&t.valueEnd===null&&(t.valueEnd=this._textarea.value.length)}_queueCompositionObservation(t){const e=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];return e&&!e.done?(e.observed=this._mergeCompositionData(t,e.observed),!0):!1}_flushPendingCompositionGenerations(){const t=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];t?this._flushCompositionGeneration(t):this._isSendingComposition=!1}_flushCompositionGeneration(t){if(t.done)return;for(;this._pendingCompositionGenerations.length>0;){const e=this._pendingCompositionGenerations.shift();e.done=!0;const i=e.start+e.alreadySentLength,s=e.valueEnd===null?this._textarea.value.length:e.valueEnd,r=this._textarea.value.substring(i,Math.max(i,s)),n=this._mergeCompositionData(r,e.observed);if(n.length>0&&this._coreService.triggerDataEvent(n,!0),e===t)break}this._isSendingComposition=this._pendingCompositionGenerations.length>0}_mergeCompositionData(t,e){if(!t.includes(e))if(e.includes(t))t=e;else{let i=Math.min(t.length,e.length);for(;i>0&&!t.endsWith(e.substring(0,i));)i--;let s=Math.min(t.length,e.length);for(;s>0&&!e.endsWith(t.substring(0,s));)s--;t=i>s?t+e.substring(i):e+t.substring(s)}return t}';

const compositionStartOriginal =
  "compositionstart(){this._isComposing=!0,this._compositionPosition.start=this._textarea.value.length";
const compositionStartPatched =
  "compositionstart(){this._boundPendingComposition(),this._isComposing=!0,this._compositionPosition.start=this._textarea.value.length";

const moduleTerminalKeypressSendOriginal =
  "this.coreService.triggerDataEvent(i,!0),this._keyPressHandled=!0";
const moduleTerminalKeypressSendPatched =
  "this._compositionHelper.keypress(i)||this.coreService.triggerDataEvent(i,!0),this._keyPressHandled=!0";
const commonJsTerminalKeypressSendOriginal =
  "this.coreService.triggerDataEvent(t,!0),this._keyPressHandled=!0";
const commonJsTerminalKeypressSendPatched =
  "this._compositionHelper.keypress(t)||this.coreService.triggerDataEvent(t,!0),this._keyPressHandled=!0";

const moduleTerminalInputSendOriginal =
  "if(this._keyPressHandled)return!1;this._unprocessedDeadKey=!1;let i=e.data;return this.coreService.triggerDataEvent(i,!0),this.cancel(e),!0";
const moduleTerminalInputSendPatched =
  "let i=e.data;if(this._compositionHelper.input(i))return this.cancel(e),!0;if(this._keyPressHandled)return!1;return this._unprocessedDeadKey=!1,this.coreService.triggerDataEvent(i,!0),this.cancel(e),!0";
const commonJsTerminalInputSendOriginal =
  "if(this._keyPressHandled)return!1;this._unprocessedDeadKey=!1;const t=e.data;return this.coreService.triggerDataEvent(t,!0),this.cancel(e),!0";
const commonJsTerminalInputSendPatched =
  "const t=e.data;if(this._compositionHelper.input(t))return this.cancel(e),!0;if(this._keyPressHandled)return!1;return this._unprocessedDeadKey=!1,this.coreService.triggerDataEvent(t,!0),this.cancel(e),!0";

async function patchBundle(target, replacements) {
  const source = await readFile(target, "utf8");
  let next = source;
  for (const { name, originalText, patchedText, acceptedTexts = [] } of replacements) {
    if (next.includes(patchedText) || acceptedTexts.some((text) => next.includes(text))) continue;
    if (!next.includes(originalText)) {
      throw new Error(`Unsupported @xterm/xterm bundle: ${name} patch target not found`);
    }
    next = next.replace(originalText, patchedText);
  }

  if (next !== source) {
    await writeFile(target, next, "utf8");
  }
}

await patchBundle(moduleTarget, [
  { name: "reflow", originalText: original, patchedText: patched },
  {
    name: "disableStdin",
    originalText: disableStdinOriginal,
    patchedText: moduleDisableStdinPatched,
  },
  {
    name: "composition state",
    originalText: moduleCompositionStateOriginal,
    patchedText: moduleCompositionStateLegacy,
    acceptedTexts: [compositionGenerationState],
  },
  {
    name: "composition keypress owner",
    originalText: moduleCompositionKeypressOriginal,
    patchedText: moduleCompositionKeypressLegacy,
    acceptedTexts: [moduleCompositionObservationOwner],
  },
  {
    name: "composition pending reset",
    originalText: moduleCompositionPendingResetOriginal,
    patchedText: moduleCompositionPendingResetLegacy,
    acceptedTexts: [compositionGenerationMethods],
  },
  {
    name: "composition deferred send",
    originalText: moduleCompositionDeferredSendOriginal,
    patchedText: moduleCompositionDeferredSendLegacy,
    acceptedTexts: [compositionGenerationMethods],
  },
  {
    name: "composition immediate send",
    originalText: moduleCompositionImmediateSendOriginal,
    patchedText: moduleCompositionImmediateSendLegacy,
    acceptedTexts: [compositionGenerationMethods],
  },
  {
    name: "terminal composition keypress handoff",
    originalText: moduleTerminalKeypressSendOriginal,
    patchedText: moduleTerminalKeypressSendPatched,
  },
  {
    name: "composition generation state",
    originalText: moduleCompositionStateLegacy,
    patchedText: compositionGenerationState,
  },
  {
    name: "composition observation owner",
    originalText: moduleCompositionKeypressLegacy,
    patchedText: moduleCompositionObservationOwner,
  },
  {
    name: "composition generation finalizer",
    originalText: moduleCompositionFinalizeLegacy,
    patchedText: compositionGenerationMethods,
  },
  {
    name: "composition generation boundary",
    originalText: compositionStartOriginal,
    patchedText: compositionStartPatched,
  },
  {
    name: "terminal composition input handoff",
    originalText: moduleTerminalInputSendOriginal,
    patchedText: moduleTerminalInputSendPatched,
  },
]);
await patchBundle(commonJsTarget, [
  {
    name: "disableStdin",
    originalText: disableStdinOriginal,
    patchedText: commonJsDisableStdinPatched,
  },
  {
    name: "composition state",
    originalText: commonJsCompositionStateOriginal,
    patchedText: commonJsCompositionStateLegacy,
    acceptedTexts: [compositionGenerationState],
  },
  {
    name: "composition keypress owner",
    originalText: commonJsCompositionKeypressOriginal,
    patchedText: commonJsCompositionKeypressLegacy,
    acceptedTexts: [commonJsCompositionObservationOwner],
  },
  {
    name: "composition pending reset",
    originalText: commonJsCompositionPendingResetOriginal,
    patchedText: commonJsCompositionPendingResetLegacy,
    acceptedTexts: [compositionGenerationMethods],
  },
  {
    name: "composition deferred send",
    originalText: commonJsCompositionDeferredSendOriginal,
    patchedText: commonJsCompositionDeferredSendLegacy,
    acceptedTexts: [compositionGenerationMethods],
  },
  {
    name: "composition immediate send",
    originalText: commonJsCompositionImmediateSendOriginal,
    patchedText: commonJsCompositionImmediateSendLegacy,
    acceptedTexts: [compositionGenerationMethods],
  },
  {
    name: "terminal composition keypress handoff",
    originalText: commonJsTerminalKeypressSendOriginal,
    patchedText: commonJsTerminalKeypressSendPatched,
  },
  {
    name: "composition generation state",
    originalText: commonJsCompositionStateLegacy,
    patchedText: compositionGenerationState,
  },
  {
    name: "composition observation owner",
    originalText: commonJsCompositionKeypressLegacy,
    patchedText: commonJsCompositionObservationOwnerLegacy,
    acceptedTexts: [commonJsCompositionObservationOwner],
  },
  {
    name: "composition generation finalizer",
    originalText: commonJsCompositionFinalizeLegacy,
    patchedText: compositionGenerationMethods,
  },
  {
    name: "composition generation boundary",
    originalText: compositionStartOriginal,
    patchedText: compositionStartPatched,
  },
  {
    name: "terminal composition input handoff",
    originalText: commonJsTerminalInputSendOriginal,
    patchedText: commonJsTerminalInputSendPatched,
  },
]);
