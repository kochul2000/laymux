/**
 * Shared WebGL texture atlas invalidation (issue #571).
 *
 * `@xterm/addon-webgl` caches one texture atlas per render config and hands the
 * same instance to every `Terminal` whose config matches
 * (`CharAtlasCache.acquireTextureAtlas`). `TextureAtlas.clearTexture()` wipes
 * the shared pages, but only the renderer that asked for the clear follows up
 * with `_clearModel()` — every other terminal on that atlas keeps a render
 * model whose vertices point at texture coordinates that now hold different
 * glyphs, so their cells draw fragments of whatever moved into that region.
 *
 * Repainting the other terminals is not enough to repair this.
 * `WebglRenderer._updateModel()` skips any cell whose code and colors match the
 * model cache ("Nothing has changed, no updates needed"), so a full-viewport
 * `refresh()` re-walks the rows but rewrites no vertices — the stale
 * coordinates survive. Only clearing the model forces every cell through
 * `updateCell()` again, and the public door to that is `clearTextureAtlas()`,
 * which clears the caller's model on top of the atlas.
 *
 * Calling it on every terminal is safe and cheap: `clearTexture()` returns
 * early once the pages are empty, so the first call does the wipe and the rest
 * only reset their own models. The pass runs synchronously within one
 * microtask, and no glyph can be rasterized in between — the only writers into
 * the atlas are `renderRows` (always behind `requestAnimationFrame`) and
 * `warmUp` (an idle task).
 *
 * Scope: the pass covers *all* registered terminals, not only the ones sharing
 * that atlas. xterm exposes no way to ask which terminals share an atlas, and
 * reproducing its config-equality rule here would create a second owner of that
 * judgment that silently drifts from upstream. Rebuilding a model on an event
 * that already repaints (hide/show, resize, font change) is the cheaper
 * mistake.
 *
 * Cost (issue #573): each pane's `ResizeObserver` callback opens its own pass,
 * so a workspace return produces one pass per pane. A terminal that already
 * answered a pass in the current frame is skipped by the next one — its model
 * is still empty, because only `renderRows` refills it and xterm runs that from
 * `requestAnimationFrame`. That turns N passes × N rebuilds into N rebuilds.
 * The set expires at the next animation frame, and early for any terminal that
 * reports a paint through `noteTerminalRendered`.
 */

type RendererRebuild = () => void;

const rebuilders = new Map<string, RendererRebuild>();

/** Reports collected for the next flush: instance id → did it rebuild itself. */
const pendingReports = new Map<string, boolean>();
/**
 * Terminals that already answered the fan-out in the current frame (issue
 * #573). Asking them again before they render changes nothing, so the pass
 * skips them and N panes returning together cost N rebuilds instead of N².
 */
const answeredThisFrame = new Set<string>();
let flushScheduled = false;
let flushing = false;
let frameResetScheduled = false;
/** Invalidates an in-flight frame reset after `__resetAtlasRebuildersForTest`. */
let frameResetGeneration = 0;

/**
 * Expire the frame set at the next animation frame.
 *
 * A frame is the right window because a render model is only refilled by
 * `renderRows`, which xterm always runs from `requestAnimationFrame`. Until
 * that happens, a terminal the pass already rebuilt still has an empty model
 * and nothing a later wipe could invalidate.
 */
function scheduleFrameReset(): void {
  if (frameResetScheduled || answeredThisFrame.size === 0) return;
  if (typeof globalThis.requestAnimationFrame !== "function") {
    // No frame clock (non-browser host): nothing would ever expire the set, so
    // skipping would become permanent. Fall back to a rebuild per pass.
    answeredThisFrame.clear();
    return;
  }
  frameResetScheduled = true;
  const generation = frameResetGeneration;
  globalThis.requestAnimationFrame(() => {
    if (generation !== frameResetGeneration) return;
    frameResetScheduled = false;
    answeredThisFrame.clear();
  });
}

function flush(): void {
  flushScheduled = false;
  // A reset (or a cancelled flush) can leave this microtask with nothing to do.
  // Running the pass anyway would rebuild every terminal for no reason.
  if (pendingReports.size === 0) return;

  // A reporter that rebuilt itself is already correct, so it can be skipped —
  // but only when it is the sole reporter. Two reporters are left in, not
  // because the first is provably stale (its model is empty, so it is not), but
  // because the skip is an optimization and we do not want its correctness to
  // rest on reasoning about a second wipe landing on an already-empty atlas.
  const reporters = [...pendingReports];
  const skip = reporters.length === 1 && reporters[0][1] ? reporters[0][0] : undefined;
  pendingReports.clear();

  flushing = true;
  try {
    // `skip` is deliberately not marked as answered for the frame. It could be
    // — its model is empty, so a later clear has nothing of its to invalidate —
    // but that is the same "a second wipe lands on an already-empty atlas"
    // reasoning the paragraph above refuses to rest on, and marking it would
    // extend that reasoning from one pass to the whole frame. The cost of
    // leaving it out is one extra rebuild per frame, and only when a second
    // terminal clears in the same frame.
    for (const [instanceId, rebuild] of [...rebuilders]) {
      if (instanceId === skip) continue;
      if (answeredThisFrame.has(instanceId)) continue;
      // Marked before the call, not after: a callback that paints synchronously
      // reports through `noteTerminalRendered`, and that delete has to win. An
      // add running afterwards would undo it and re-open the hole this hook
      // closes. xterm paints from `requestAnimationFrame` today, but the
      // ordering of these two lines should not be what makes that safe.
      answeredThisFrame.add(instanceId);
      try {
        rebuild();
      } catch {
        // A terminal disposed between the notify and the flush — the next mount
        // rebuilds its own atlas anyway. It did nothing, so it does not count as
        // answered and the next pass in this frame must reach it again.
        answeredThisFrame.delete(instanceId);
      }
    }
  } finally {
    flushing = false;
  }
  scheduleFrameReset();
}

/**
 * Register a terminal's renderer rebuild (atlas clear + full repaint). Keyed by
 * the terminal instance id so a pane that also registers under its paneId
 * elsewhere is not rebuilt twice.
 *
 * The callback may decline the work — a hidden terminal defers it to its
 * hide→show return instead (issue #573). Declining still counts as answering
 * for this frame: the decision cannot change until the container resizes, and
 * that path rebuilds on its own.
 */
export function registerAtlasRebuilder(instanceId: string, rebuild: RendererRebuild): void {
  // A profile switch replaces the xterm instance under the same id. The new
  // terminal owns a different model, so the old one's answer says nothing.
  answeredThisFrame.delete(instanceId);
  rebuilders.set(instanceId, rebuild);
}

export function unregisterAtlasRebuilder(instanceId: string): void {
  answeredThisFrame.delete(instanceId);
  rebuilders.delete(instanceId);
}

/**
 * Report that this terminal painted (xterm's `onRender`).
 *
 * That is the moment its render model is refilled with coordinates into the
 * *current* atlas, so whatever it answered earlier in this frame no longer
 * holds and the next clear has to reach it again.
 */
export function noteTerminalRendered(instanceId: string): void {
  answeredThisFrame.delete(instanceId);
}

/**
 * Report that this terminal cleared the shared texture atlas.
 *
 * `selfRebuilt` says whether the reporter's own renderer came back up. A
 * reporter whose rebuild threw is stale like everyone else and must not be
 * skipped.
 *
 * The pass runs in a microtask, before the browser's next paint. Clears queued
 * in the same task share one pass; clears in separate tasks do not. A workspace
 * returning from `display: none` is the latter case — every `TerminalView`
 * observes its own container, and a microtask checkpoint runs between
 * `ResizeObserver` callbacks — so N panes still open N passes. Widening the
 * window to an animation frame would put a paint between the clear and the
 * rebuild, which is the corrupted frame this module exists to prevent; the
 * frame set above is what keeps those N passes at N rebuilds instead of N².
 */
export function notifyTextureAtlasCleared(instanceId: string, selfRebuilt: boolean): void {
  // A rebuild callback reporting back would re-arm the microtask from inside
  // the pass and starve the event loop. Callbacks are not supposed to do this;
  // the guard makes a mistake cheap instead of fatal.
  if (flushing) return;
  pendingReports.set(instanceId, selfRebuilt);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/** Test hook — drops registrations and disarms any pending flush. */
export function __resetAtlasRebuildersForTest(): void {
  rebuilders.clear();
  pendingReports.clear();
  answeredThisFrame.clear();
  flushScheduled = false;
  flushing = false;
  // An animation frame already queued would otherwise clear the next test's
  // frame set out from under it.
  frameResetScheduled = false;
  frameResetGeneration += 1;
}
