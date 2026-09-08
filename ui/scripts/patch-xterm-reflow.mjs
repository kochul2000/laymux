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
const remoteCommonJsTarget = fileURLToPath(
  new URL("../../src-tauri/src/remote_server/assets/xterm.js", import.meta.url),
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
// keypress, compositionend.data, and the deferred finalizer. Keep those observations in one
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
const moduleCompositionObservationOwnerEndData = moduleCompositionObservationOwner.replace(
  "_finalizeComposition(t){",
  "_finalizeComposition(t,e){",
);
const commonJsCompositionObservationOwnerLegacy =
  "return 229!==e.keyCode||(this._handleAnyTextareaChanges(),!1)}keypress(e){return this._queueCompositionObservation(e)}input(e){return this._queueCompositionObservation(e)}_finalizeComposition(e){";
const commonJsCompositionObservationOwner =
  "return 229!==e.keyCode||(this._handleAnyTextareaChanges(),!1)}keypress(e){return this._queueCompositionObservation(e)}input(e){return this._queueCompositionObservation(e)}_finalizeComposition(t){";
const commonJsCompositionObservationOwnerEndData = commonJsCompositionObservationOwner.replace(
  "_finalizeComposition(t){",
  "_finalizeComposition(t,e){",
);

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
const compositionGenerationMethodsMergedObservations =
  '_finalizeComposition(t){this._compositionView.classList.remove("active");const e=this._isComposing;if(this._isComposing=!1,t){const t={start:this._compositionPosition.start,end:this._compositionPosition.end,valueEnd:null,alreadySentLength:this._dataAlreadySent.length,observed:"",done:!1};this._pendingCompositionGenerations.push(t),this._isSendingComposition=!0,setTimeout(()=>this._flushCompositionGeneration(t),0)}else{this._flushPendingCompositionGenerations();if(e){const t=this._textarea.value.substring(this._compositionPosition.start,this._compositionPosition.end);t.length>0&&this._coreService.triggerDataEvent(t,!0)}}}_boundPendingComposition(){const t=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];t&&t.valueEnd===null&&(t.valueEnd=this._textarea.value.length)}_queueCompositionObservation(t){const e=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];return e&&!e.done?(e.observed=this._mergeCompositionData(t,e.observed),!0):!1}_flushPendingCompositionGenerations(){const t=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];t?this._flushCompositionGeneration(t):this._isSendingComposition=!1}_flushCompositionGeneration(t){if(t.done)return;for(;this._pendingCompositionGenerations.length>0;){const e=this._pendingCompositionGenerations.shift();e.done=!0;const i=e.start+e.alreadySentLength,s=e.valueEnd===null?this._textarea.value.length:e.valueEnd,r=this._textarea.value.substring(i,Math.max(i,s)),n=this._mergeCompositionData(r,e.observed);if(n.length>0&&this._coreService.triggerDataEvent(n,!0),e===t)break}this._isSendingComposition=this._pendingCompositionGenerations.length>0}_mergeCompositionData(t,e){if(!t.includes(e))if(e.includes(t))t=e;else{let i=Math.min(t.length,e.length);for(;i>0&&!t.endsWith(e.substring(0,i));)i--;let s=Math.min(t.length,e.length);for(;s>0&&!e.endsWith(t.substring(0,s));)s--;t=i>s?t+e.substring(i):e+t.substring(s)}return t}';
const compositionGenerationMethodsWithoutEndData =
  '_finalizeComposition(t){this._compositionView.classList.remove("active");const e=this._isComposing;if(this._isComposing=!1,t){const t={start:this._compositionPosition.start,end:this._compositionPosition.end,valueEnd:null,alreadySentLength:this._dataAlreadySent.length,observations:[],done:!1};this._pendingCompositionGenerations.push(t),this._isSendingComposition=!0,setTimeout(()=>this._flushCompositionGeneration(t),0)}else{this._flushPendingCompositionGenerations();if(e){const t=this._textarea.value.substring(this._compositionPosition.start,this._compositionPosition.end);t.length>0&&this._coreService.triggerDataEvent(t,!0)}}}_boundPendingComposition(){const t=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];t&&t.valueEnd===null&&(t.valueEnd=this._textarea.value.length)}_queueCompositionObservation(t){const e=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];return e&&!e.done?(e.observations.push(t),!0):!1}_flushPendingCompositionGenerations(){const t=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];t?this._flushCompositionGeneration(t):this._isSendingComposition=!1}_flushCompositionGeneration(t){if(t.done)return;for(;this._pendingCompositionGenerations.length>0;){const e=this._pendingCompositionGenerations.shift();e.done=!0;const i=e.start+e.alreadySentLength,s=e.valueEnd===null?this._textarea.value.length:e.valueEnd,r=this._textarea.value.substring(i,Math.max(i,s));let n=r,o="",l=!1;for(const t of e.observations)l?n=this._mergeCompositionData(n,t,!0):n.includes(t)?(o&&(n=this._mergeCompositionData(n,o)),l=!0):o=this._mergeCompositionData(t,o);l||!o||(n=this._mergeCompositionData(n,o));if(n.length>0&&this._coreService.triggerDataEvent(n,!0),e===t)break}this._isSendingComposition=this._pendingCompositionGenerations.length>0}_mergeCompositionData(t,e,o=!1){if(!t.includes(e))if(e.includes(t))t=e;else{let i=Math.min(t.length,e.length);for(;i>0&&!t.endsWith(e.substring(0,i));)i--;let s=Math.min(t.length,e.length);for(;s>0&&!e.endsWith(t.substring(0,s));)s--;t=i>s||o&&i===s?t+e.substring(i):e+t.substring(s)}return t}';
const compositionGenerationMethodsWithEndData =
  '_finalizeComposition(t,e){this._compositionView.classList.remove("active");const i=this._isComposing;if(this._isComposing=!1,t){const t={start:this._compositionPosition.start,end:this._compositionPosition.end,valueEnd:null,alreadySentLength:this._dataAlreadySent.length,committed:e,observations:[],done:!1};this._pendingCompositionGenerations.push(t),this._isSendingComposition=!0,setTimeout(()=>this._flushCompositionGeneration(t),0)}else{this._flushPendingCompositionGenerations();if(i){const t=this._textarea.value.substring(this._compositionPosition.start,this._compositionPosition.end);t.length>0&&this._coreService.triggerDataEvent(t,!0)}}}_boundPendingComposition(){const t=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];t&&t.valueEnd===null&&(t.valueEnd=this._textarea.value.length)}_queueCompositionObservation(t){const e=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];return e&&!e.done?(e.observations.push(t),!0):!1}_flushPendingCompositionGenerations(){const t=this._pendingCompositionGenerations[this._pendingCompositionGenerations.length-1];t?this._flushCompositionGeneration(t):this._isSendingComposition=!1}_flushCompositionGeneration(t){if(t.done)return;for(;this._pendingCompositionGenerations.length>0;){const e=this._pendingCompositionGenerations.shift();e.done=!0;const i=e.start+e.alreadySentLength,s=e.valueEnd===null?this._textarea.value.length:e.valueEnd,r=this._textarea.value.substring(i,Math.max(i,s));let n=this._textarea.ownerDocument.activeElement===this._textarea?this._mergeCompositionData(r,e.committed||""):r,o="",l=!1;for(const t of e.observations)l?n=this._mergeCompositionData(n,t,!0):n.includes(t)?(o&&(n=this._mergeCompositionData(n,o)),l=!0):o=this._mergeCompositionData(t,o);l||!o||(n=this._mergeCompositionData(n,o));if(n.length>0&&this._coreService.triggerDataEvent(n,!0),e===t)break}this._isSendingComposition=this._pendingCompositionGenerations.length>0}_mergeCompositionData(t,e,o=!1){if(!t.includes(e))if(e.includes(t))t=e;else{let i=Math.min(t.length,e.length);for(;i>0&&!t.endsWith(e.substring(0,i));)i--;let s=Math.min(t.length,e.length);for(;s>0&&!e.endsWith(t.substring(0,s));)s--;t=i>s||o&&i===s?t+e.substring(i):e+t.substring(s)}return t}';
const compositionGenerationMethods = compositionGenerationMethodsWithEndData
  .replace("valueEnd:null", "valueSnapshot:null")
  .replace(
    "committed:e,observations:[]",
    "committed:this._compositionEndDataAllowed?e:void 0,cancelled:!this._compositionEndDataAllowed,observations:[]",
  )
  .replace(
    "}}_boundPendingComposition(){",
    "}}blur(){this._compositionEndDataAllowed=!1,this._flushPendingCompositionGenerations()}_boundPendingComposition(){",
  )
  .replace(
    "t&&t.valueEnd===null&&(t.valueEnd=this._textarea.value.length)",
    "t&&t.valueSnapshot===null&&(t.valueSnapshot=this._textarea.value)",
  )
  .replace(
    "return e&&!e.done?(e.observations.push(t),!0):!1",
    "return e&&!e.done&&!e.cancelled?(e.observations.push(t),!0):!1",
  )
  .replace("e.done=!0;const i=", "e.done=!0;if(e.cancelled){if(e===t)break;continue}const i=")
  .replace(
    "s=e.valueEnd===null?this._textarea.value.length:e.valueEnd,r=this._textarea.value.substring(i,Math.max(i,s))",
    "s=e.valueSnapshot===null?this._textarea.value:e.valueSnapshot,r=i>s.length&&e.committed&&s.includes(e.committed)?s:s.substring(i)",
  )
  .replace(
    'let n=this._textarea.ownerDocument.activeElement===this._textarea?this._mergeCompositionData(r,e.committed||""):r',
    'let n=this._mergeCompositionData(r,e.committed||"")',
  );
const compositionGenerationAcceptedTexts = [
  compositionGenerationMethods,
  compositionGenerationMethodsWithEndData,
  compositionGenerationMethodsWithoutEndData,
  compositionGenerationMethodsMergedObservations,
];
const compositionGenerationUpgradeTexts = [
  compositionGenerationMethodsWithEndData,
  compositionGenerationMethodsWithoutEndData,
  compositionGenerationMethodsMergedObservations,
];

const compositionEndOriginal = "compositionend(){this._finalizeComposition(!0)}";
const compositionEndPatched = "compositionend(t){this._finalizeComposition(!0,t)}";
const moduleCompositionEndListenerOriginal =
  'this._register(L(this.textarea,"compositionend",()=>this._compositionHelper.compositionend()))';
const moduleCompositionEndListenerPatched =
  'this._register(L(this.textarea,"compositionend",t=>this._compositionHelper.compositionend(t.data)))';
const commonJsCompositionEndListenerOriginal =
  'this._register((0,I.addDisposableListener)(this.textarea,"compositionend",(()=>this._compositionHelper.compositionend())))';
const commonJsCompositionEndListenerPatched =
  'this._register((0,I.addDisposableListener)(this.textarea,"compositionend",(e=>this._compositionHelper.compositionend(e.data))))';
const compositionBlurOriginal = '_handleTextAreaBlur(){this.textarea.value=""';
const compositionBlurPatched =
  '_handleTextAreaBlur(){this._compositionHelper.blur(),this.textarea.value=""';

const compositionStartOriginal =
  "compositionstart(){this._isComposing=!0,this._compositionPosition.start=this._textarea.value.length";
const compositionStartBoundOnly =
  "compositionstart(){this._boundPendingComposition(),this._isComposing=!0,this._compositionPosition.start=this._textarea.value.length";
const compositionStartPatched =
  "compositionstart(){this._boundPendingComposition(),this._compositionEpoch=(this._compositionEpoch||0)+1,this._isComposing=!0,this._compositionPosition.start=this._textarea.value.length";
const compositionStartEndDataPatched =
  "compositionstart(){this._boundPendingComposition(),this._compositionEpoch=(this._compositionEpoch||0)+1,this._compositionEndDataAllowed=!0,this._isComposing=!0,this._compositionPosition.start=this._textarea.value.length";
const compositionStartRemotePatched =
  "compositionstart(){this._compositionEpoch=(this._compositionEpoch||0)+1,this._isComposing=!0,this._compositionPosition.start=this._textarea.value.length";

const moduleTerminalKeypressSendOriginal =
  "this.coreService.triggerDataEvent(i,!0),this._keyPressHandled=!0";
const moduleTerminalKeypressSendWithoutDefaultCancel =
  "this._compositionHelper.keypress(i)||this.coreService.triggerDataEvent(i,!0),this._keyPressHandled=!0";
const moduleTerminalKeypressSendPatched =
  "this._compositionHelper.keypress(i)?this.cancel(e,!0):this.coreService.triggerDataEvent(i,!0),this._keyPressHandled=!0";
const commonJsTerminalKeypressSendOriginal =
  "this.coreService.triggerDataEvent(t,!0),this._keyPressHandled=!0";
const commonJsTerminalKeypressSendWithoutDefaultCancel =
  "this._compositionHelper.keypress(t)||this.coreService.triggerDataEvent(t,!0),this._keyPressHandled=!0";
const commonJsTerminalKeypressSendPatched =
  "this._compositionHelper.keypress(t)?this.cancel(e,!0):this.coreService.triggerDataEvent(t,!0),this._keyPressHandled=!0";

const moduleTerminalInputSendOriginal =
  "if(this._keyPressHandled)return!1;this._unprocessedDeadKey=!1;let i=e.data;return this.coreService.triggerDataEvent(i,!0),this.cancel(e),!0";
const moduleTerminalInputSendPatched =
  "let i=e.data;if(this._compositionHelper.input(i))return this.cancel(e),!0;if(this._keyPressHandled)return!1;return this._unprocessedDeadKey=!1,this.coreService.triggerDataEvent(i,!0),this.cancel(e),!0";
const commonJsTerminalInputSendOriginal =
  "if(this._keyPressHandled)return!1;this._unprocessedDeadKey=!1;const t=e.data;return this.coreService.triggerDataEvent(t,!0),this.cancel(e),!0";
const commonJsTerminalInputSendPatched =
  "const t=e.data;if(this._compositionHelper.input(t))return this.cancel(e),!0;if(this._keyPressHandled)return!1;return this._unprocessedDeadKey=!1,this.coreService.triggerDataEvent(t,!0),this.cancel(e),!0";

// xterm 6.0.0 calculates the sensitivity-adjusted wheel row count for mouse
// reporting and alternate-buffer cursor-key fallback, but then emits exactly
// one report/sequence. Preserve fractional input in CoreMouseService and emit
// the calculated number of discrete application inputs (ADR-0142).
const moduleWheelAccumulatorOriginal =
  "return e.deltaMode===WheelEvent.DOM_DELTA_PIXEL?(o/=n+0,Math.abs(e.deltaY)<50&&(o*=.3),this._wheelPartialScroll+=o,o=Math.floor(Math.abs(this._wheelPartialScroll))*(this._wheelPartialScroll>0?1:-1),this._wheelPartialScroll%=1):e.deltaMode===WheelEvent.DOM_DELTA_PAGE&&(o*=this._bufferService.rows),o";
const moduleWheelAccumulatorPatched =
  "return e.deltaMode===WheelEvent.DOM_DELTA_PIXEL?(o/=n+0,Math.abs(e.deltaY)<50&&(o*=.3)):e.deltaMode===WheelEvent.DOM_DELTA_PAGE&&(o*=this._bufferService.rows),this._wheelPartialScroll+=o,o=Math.floor(Math.abs(this._wheelPartialScroll))*(this._wheelPartialScroll>0?1:-1),this._wheelPartialScroll%=1,o";
const commonJsWheelAccumulatorOriginal =
  "return e.deltaMode===WheelEvent.DOM_DELTA_PIXEL?(r/=s+0,Math.abs(e.deltaY)<50&&(r*=.3),this._wheelPartialScroll+=r,r=Math.floor(Math.abs(this._wheelPartialScroll))*(this._wheelPartialScroll>0?1:-1),this._wheelPartialScroll%=1):e.deltaMode===WheelEvent.DOM_DELTA_PAGE&&(r*=this._bufferService.rows),r";
const commonJsWheelAccumulatorPatched =
  "return e.deltaMode===WheelEvent.DOM_DELTA_PIXEL?(r/=s+0,Math.abs(e.deltaY)<50&&(r*=.3)):e.deltaMode===WheelEvent.DOM_DELTA_PAGE&&(r*=this._bufferService.rows),this._wheelPartialScroll+=r,r=Math.floor(Math.abs(this._wheelPartialScroll))*(this._wheelPartialScroll>0?1:-1),this._wheelPartialScroll%=1,r";

const moduleMouseReportCountOriginal = "let u,h;switch(l.overrideType||l.type)";
const moduleMouseReportCountPatched = "let u,h,p=1;switch(l.overrideType||l.type)";
const moduleMouseWheelOriginal =
  "let c=l.deltaY;if(c===0||e.coreMouseService.consumeWheelEvent(l,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr)===0)return!1;h=c<0?0:1,u=4";
const moduleMouseWheelPatched =
  "let c=l.deltaY;if(c===0)return!1;let d=e.coreMouseService.consumeWheelEvent(l,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr);if(d===0)return!1;p=Math.abs(d),h=c<0?0:1,u=4";
const moduleMouseReportOriginal =
  "return h===void 0||u===void 0||u>4?!1:e.coreMouseService.triggerMouseEvent({col:a.col,row:a.row,x:a.x,y:a.y,button:u,action:h,ctrl:l.ctrlKey,alt:l.altKey,shift:l.shiftKey})";
const moduleMouseReportPatched =
  "if(h===void 0||u===void 0||u>4)return!1;for(let c=0;c<p;c++)if(!e.coreMouseService.triggerMouseEvent({col:a.col,row:a.row,x:a.x,y:a.y,button:u,action:h,ctrl:l.ctrlKey,alt:l.altKey,shift:l.shiftKey}))return!1;return!0";
const moduleAltBufferWheelOriginal =
  'if(e.coreMouseService.consumeWheelEvent(l,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr)===0)return this.cancel(l,!0);let h=b.ESC+(this.coreService.decPrivateModes.applicationCursorKeys?"O":"[")+(l.deltaY<0?"A":"B");return this.coreService.triggerDataEvent(h,!0),this.cancel(l,!0)';
const moduleAltBufferWheelConcatenated =
  'let h=e.coreMouseService.consumeWheelEvent(l,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr);if(h===0)return this.cancel(l,!0);let c=b.ESC+(this.coreService.decPrivateModes.applicationCursorKeys?"O":"[")+(l.deltaY<0?"A":"B");return this.coreService.triggerDataEvent(c.repeat(Math.abs(h)),!0),this.cancel(l,!0)';
const moduleAltBufferWheelPatched =
  'let h=e.coreMouseService.consumeWheelEvent(l,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr);if(h===0)return this.cancel(l,!0);let c=b.ESC+(this.coreService.decPrivateModes.applicationCursorKeys?"O":"[")+(l.deltaY<0?"A":"B");for(let d=0;d<Math.abs(h);d++)this.coreService.triggerDataEvent(c,!0);return this.cancel(l,!0)';

const commonJsMouseReportCountOriginal = "let s,r;switch(t.overrideType||t.type)";
const commonJsMouseReportCountPatched = "let s,r,n=1;switch(t.overrideType||t.type)";
const commonJsMouseWheelOriginal =
  "const i=t.deltaY;if(0===i)return!1;if(0===e.coreMouseService.consumeWheelEvent(t,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr))return!1;r=i<0?0:1,s=4";
const commonJsMouseWheelPatched =
  "const i=t.deltaY;if(0===i)return!1;const o=e.coreMouseService.consumeWheelEvent(t,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr);if(0===o)return!1;n=Math.abs(o),r=i<0?0:1,s=4";
const commonJsMouseReportOriginal =
  "return!(void 0===r||void 0===s||s>4)&&e.coreMouseService.triggerMouseEvent({col:i.col,row:i.row,x:i.x,y:i.y,button:s,action:r,ctrl:t.ctrlKey,alt:t.altKey,shift:t.shiftKey})";
const commonJsMouseReportPatched =
  "if(void 0===r||void 0===s||s>4)return!1;for(let o=0;o<n;o++)if(!e.coreMouseService.triggerMouseEvent({col:i.col,row:i.row,x:i.x,y:i.y,button:s,action:r,ctrl:t.ctrlKey,alt:t.altKey,shift:t.shiftKey}))return!1;return!0";
const commonJsAltBufferWheelOriginal =
  'if(0===e.coreMouseService.consumeWheelEvent(t,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr))return this.cancel(t,!0);const i=E.C0.ESC+(this.coreService.decPrivateModes.applicationCursorKeys?"O":"[")+(t.deltaY<0?"A":"B");return this.coreService.triggerDataEvent(i,!0),this.cancel(t,!0)';
const commonJsAltBufferWheelConcatenated =
  'const i=e.coreMouseService.consumeWheelEvent(t,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr);if(0===i)return this.cancel(t,!0);const s=E.C0.ESC+(this.coreService.decPrivateModes.applicationCursorKeys?"O":"[")+(t.deltaY<0?"A":"B");return this.coreService.triggerDataEvent(s.repeat(Math.abs(i)),!0),this.cancel(t,!0)';
const commonJsAltBufferWheelPatched =
  'const i=e.coreMouseService.consumeWheelEvent(t,e._renderService?.dimensions?.device?.cell?.height,e._coreBrowserService?.dpr);if(0===i)return this.cancel(t,!0);const s=E.C0.ESC+(this.coreService.decPrivateModes.applicationCursorKeys?"O":"[")+(t.deltaY<0?"A":"B");for(let r=0;r<Math.abs(i);r++)this.coreService.triggerDataEvent(s,!0);return this.cancel(t,!0)';

// xterm 6.0.0's 229 textarea-diff timer only checks `_isComposing`. A main-thread
// stall lets compositionend run first, so the delayed diff sees a finished
// composition and sends the same Hangul syllable the finalizer will send (ADR-0164).
// `_isSendingComposition` is not enough: an immediate finalize from a later
// keydown clears that flag before the 229 timer runs. Bump an epoch on
// compositionstart and skip the diff if a composition started after the snap.
const moduleTextareaDiffSkipSending =
  "_handleAnyTextareaChanges(){let t=this._textarea.value;setTimeout(()=>{if(!this._isComposing){let e=this._textarea.value";
const moduleTextareaDiffSkipSendingWhileSending =
  "_handleAnyTextareaChanges(){let t=this._textarea.value;setTimeout(()=>{if(!this._isComposing&&!this._isSendingComposition){let e=this._textarea.value";
const moduleTextareaDiffSkipSendingPatched =
  "_handleAnyTextareaChanges(){let t=this._textarea.value,s=this._compositionEpoch||0;setTimeout(()=>{if(s===(this._compositionEpoch||0)&&!this._isComposing&&!this._isSendingComposition){let e=this._textarea.value";
const commonJsTextareaDiffSkipSending =
  "_handleAnyTextareaChanges(){const e=this._textarea.value;setTimeout((()=>{if(!this._isComposing){const t=this._textarea.value";
const commonJsTextareaDiffSkipSendingWhileSending =
  "_handleAnyTextareaChanges(){const e=this._textarea.value;setTimeout((()=>{if(!this._isComposing&&!this._isSendingComposition){const t=this._textarea.value";
const commonJsTextareaDiffSkipSendingPatched =
  "_handleAnyTextareaChanges(){const e=this._textarea.value,o=this._compositionEpoch||0;setTimeout((()=>{if(o===(this._compositionEpoch||0)&&!this._isComposing&&!this._isSendingComposition){const t=this._textarea.value";
const moduleWheelPatches = [
  {
    name: "wheel fractional accumulator",
    originalText: moduleWheelAccumulatorOriginal,
    patchedText: moduleWheelAccumulatorPatched,
  },
  {
    name: "mouse report repeat count",
    originalText: moduleMouseReportCountOriginal,
    patchedText: moduleMouseReportCountPatched,
  },
  {
    name: "mouse wheel line count",
    originalText: moduleMouseWheelOriginal,
    patchedText: moduleMouseWheelPatched,
  },
  {
    name: "mouse report repetition",
    originalText: moduleMouseReportOriginal,
    patchedText: moduleMouseReportPatched,
  },
  {
    name: "alternate-buffer wheel repetition",
    originalText: moduleAltBufferWheelOriginal,
    patchedText: moduleAltBufferWheelPatched,
    upgradeTexts: [moduleAltBufferWheelConcatenated],
  },
];

const commonJsWheelPatches = [
  {
    name: "wheel fractional accumulator",
    originalText: commonJsWheelAccumulatorOriginal,
    patchedText: commonJsWheelAccumulatorPatched,
  },
  {
    name: "mouse report repeat count",
    originalText: commonJsMouseReportCountOriginal,
    patchedText: commonJsMouseReportCountPatched,
  },
  {
    name: "mouse wheel line count",
    originalText: commonJsMouseWheelOriginal,
    patchedText: commonJsMouseWheelPatched,
  },
  {
    name: "mouse report repetition",
    originalText: commonJsMouseReportOriginal,
    patchedText: commonJsMouseReportPatched,
  },
  {
    name: "alternate-buffer wheel repetition",
    originalText: commonJsAltBufferWheelOriginal,
    patchedText: commonJsAltBufferWheelPatched,
    upgradeTexts: [commonJsAltBufferWheelConcatenated],
  },
];

async function patchBundle(target, replacements) {
  const source = await readFile(target, "utf8");
  let next = source;
  for (const {
    name,
    originalText,
    patchedText,
    acceptedTexts = [],
    upgradeTexts = [],
  } of replacements) {
    const matchedUpgrade = upgradeTexts.find((text) => next.includes(text));
    if (matchedUpgrade) {
      next = next.replace(matchedUpgrade, patchedText);
      continue;
    }
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
  ...moduleWheelPatches,
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
    acceptedTexts: [moduleCompositionObservationOwner, moduleCompositionObservationOwnerEndData],
  },
  {
    name: "composition pending reset",
    originalText: moduleCompositionPendingResetOriginal,
    patchedText: moduleCompositionPendingResetLegacy,
    acceptedTexts: compositionGenerationAcceptedTexts,
  },
  {
    name: "composition deferred send",
    originalText: moduleCompositionDeferredSendOriginal,
    patchedText: moduleCompositionDeferredSendLegacy,
    acceptedTexts: compositionGenerationAcceptedTexts,
  },
  {
    name: "composition immediate send",
    originalText: moduleCompositionImmediateSendOriginal,
    patchedText: moduleCompositionImmediateSendLegacy,
    acceptedTexts: compositionGenerationAcceptedTexts,
  },
  {
    name: "terminal composition keypress handoff",
    originalText: moduleTerminalKeypressSendOriginal,
    patchedText: moduleTerminalKeypressSendPatched,
    upgradeTexts: [moduleTerminalKeypressSendWithoutDefaultCancel],
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
    acceptedTexts: [moduleCompositionObservationOwnerEndData],
  },
  {
    name: "composition generation finalizer",
    originalText: moduleCompositionFinalizeLegacy,
    patchedText: compositionGenerationMethods,
    upgradeTexts: compositionGenerationUpgradeTexts,
  },
  {
    name: "compositionend commit data",
    originalText: compositionEndOriginal,
    patchedText: compositionEndPatched,
  },
  {
    name: "terminal compositionend data handoff",
    originalText: moduleCompositionEndListenerOriginal,
    patchedText: moduleCompositionEndListenerPatched,
  },
  {
    name: "terminal composition blur flush",
    originalText: compositionBlurOriginal,
    patchedText: compositionBlurPatched,
  },
  {
    name: "composition generation boundary",
    originalText: compositionStartOriginal,
    patchedText: compositionStartEndDataPatched,
    upgradeTexts: [compositionStartPatched, compositionStartBoundOnly],
  },
  {
    name: "terminal composition input handoff",
    originalText: moduleTerminalInputSendOriginal,
    patchedText: moduleTerminalInputSendPatched,
  },
  {
    name: "textarea diff skip while sending",
    originalText: moduleTextareaDiffSkipSending,
    patchedText: moduleTextareaDiffSkipSendingPatched,
    acceptedTexts: [
      moduleTextareaDiffSkipSendingPatched,
      moduleTextareaDiffSkipSendingWhileSending,
    ],
  },
  {
    name: "textarea diff skip upgrade from sending flag",
    originalText: moduleTextareaDiffSkipSendingWhileSending,
    patchedText: moduleTextareaDiffSkipSendingPatched,
  },
]);
await patchBundle(commonJsTarget, [
  ...commonJsWheelPatches,
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
    acceptedTexts: [
      commonJsCompositionObservationOwner,
      commonJsCompositionObservationOwnerEndData,
    ],
  },
  {
    name: "composition pending reset",
    originalText: commonJsCompositionPendingResetOriginal,
    patchedText: commonJsCompositionPendingResetLegacy,
    acceptedTexts: compositionGenerationAcceptedTexts,
  },
  {
    name: "composition deferred send",
    originalText: commonJsCompositionDeferredSendOriginal,
    patchedText: commonJsCompositionDeferredSendLegacy,
    acceptedTexts: compositionGenerationAcceptedTexts,
  },
  {
    name: "composition immediate send",
    originalText: commonJsCompositionImmediateSendOriginal,
    patchedText: commonJsCompositionImmediateSendLegacy,
    acceptedTexts: compositionGenerationAcceptedTexts,
  },
  {
    name: "terminal composition keypress handoff",
    originalText: commonJsTerminalKeypressSendOriginal,
    patchedText: commonJsTerminalKeypressSendPatched,
    upgradeTexts: [commonJsTerminalKeypressSendWithoutDefaultCancel],
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
    acceptedTexts: [
      commonJsCompositionObservationOwner,
      commonJsCompositionObservationOwnerEndData,
    ],
  },
  {
    name: "composition generation finalizer",
    originalText: commonJsCompositionFinalizeLegacy,
    patchedText: compositionGenerationMethods,
    upgradeTexts: compositionGenerationUpgradeTexts,
  },
  {
    name: "compositionend commit data",
    originalText: compositionEndOriginal,
    patchedText: compositionEndPatched,
  },
  {
    name: "terminal compositionend data handoff",
    originalText: commonJsCompositionEndListenerOriginal,
    patchedText: commonJsCompositionEndListenerPatched,
  },
  {
    name: "terminal composition blur flush",
    originalText: compositionBlurOriginal,
    patchedText: compositionBlurPatched,
  },
  {
    name: "composition generation boundary",
    originalText: compositionStartOriginal,
    patchedText: compositionStartEndDataPatched,
    upgradeTexts: [compositionStartPatched, compositionStartBoundOnly],
  },
  {
    name: "terminal composition input handoff",
    originalText: commonJsTerminalInputSendOriginal,
    patchedText: commonJsTerminalInputSendPatched,
  },
  {
    name: "textarea diff skip while sending",
    originalText: commonJsTextareaDiffSkipSending,
    patchedText: commonJsTextareaDiffSkipSendingPatched,
    acceptedTexts: [
      commonJsTextareaDiffSkipSendingPatched,
      commonJsTextareaDiffSkipSendingWhileSending,
    ],
  },
  {
    name: "textarea diff skip upgrade from sending flag",
    originalText: commonJsTextareaDiffSkipSendingWhileSending,
    patchedText: commonJsTextareaDiffSkipSendingPatched,
  },
]);
await patchBundle(remoteCommonJsTarget, [
  ...commonJsWheelPatches,
  {
    name: "textarea diff skip while sending",
    originalText: commonJsTextareaDiffSkipSending,
    patchedText: commonJsTextareaDiffSkipSendingPatched,
    acceptedTexts: [
      commonJsTextareaDiffSkipSendingPatched,
      commonJsTextareaDiffSkipSendingWhileSending,
    ],
  },
  {
    name: "textarea diff skip upgrade from sending flag",
    originalText: commonJsTextareaDiffSkipSendingWhileSending,
    patchedText: commonJsTextareaDiffSkipSendingPatched,
  },
  {
    name: "composition epoch bump",
    originalText: compositionStartOriginal,
    patchedText: compositionStartRemotePatched,
    acceptedTexts: [compositionStartRemotePatched],
  },
]);
