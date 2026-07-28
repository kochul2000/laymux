/**
 * Shared classification of composition-side input events.
 *
 * Committing a composition puts the confirmed text into the helper textarea, so
 * a `beforeinput`/`input` pair always fires for it. WebView2/Chromium can
 * deliver that pair **after** `compositionend`, and at that point the event
 * reports `isComposing === false` — indistinguishable from the user typing
 * something new if only that one flag is checked. The `inputType` values are
 * what separate them.
 *
 * Two independent consumers need this exact judgement:
 * - `ime-composition-controller.ts` — commit-side input must not count toward
 *   the quiescence check in the deferred finalize.
 * - `linux-ime-candidate-guard.ts` — commit-side input must not close the
 *   post-composition candidate window (issue #528; ADR-0060).
 *
 * It lives here so the two cannot drift: a fix to one is a fix to both.
 */

export type CompositionSideInputLike = {
  isComposing?: boolean;
  inputType?: string;
};

export type CompositionSideKeyLike = {
  isComposing?: boolean;
  key?: string;
  keyCode?: number;
};

/** Browser marker for a key whose interpretation still belongs to the IME. */
export const IME_PROCESSING_KEY_CODE = 229;

/** `inputType` values a browser uses for composition commit/cancel edits. */
const COMPOSITION_INPUT_TYPES = new Set([
  "insertCompositionText",
  "insertFromComposition",
  "deleteCompositionText",
]);

/**
 * True when an input-like event belongs to a composition rather than to the user
 * typing fresh text — including the commit that lands after `compositionend`.
 */
export function isCompositionSideInput(event: CompositionSideInputLike): boolean {
  if (event.isComposing === true) return true;
  return event.inputType !== undefined && COMPOSITION_INPUT_TYPES.has(event.inputType);
}

/**
 * True when a keyboard event still belongs to an IME composition, including
 * browsers that expose only the legacy 229/`Process` marker.
 */
export function isCompositionSideKey(event: CompositionSideKeyLike): boolean {
  return (
    event.isComposing === true ||
    event.keyCode === IME_PROCESSING_KEY_CODE ||
    event.key === "Process"
  );
}
