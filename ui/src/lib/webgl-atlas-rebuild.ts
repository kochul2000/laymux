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
 */

type RendererRebuild = () => void;

const rebuilders = new Map<string, RendererRebuild>();

/** Reports collected for the next flush: instance id → did it rebuild itself. */
const pendingReports = new Map<string, boolean>();
let flushScheduled = false;
let flushing = false;

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
    for (const [instanceId, rebuild] of [...rebuilders]) {
      if (instanceId === skip) continue;
      try {
        rebuild();
      } catch {
        // A terminal disposed between the notify and the flush — the next mount
        // rebuilds its own atlas anyway.
      }
    }
  } finally {
    flushing = false;
  }
}

/**
 * Register a terminal's renderer rebuild (atlas clear + full repaint). Keyed by
 * the terminal instance id so a pane that also registers under its paneId
 * elsewhere is not rebuilt twice.
 */
export function registerAtlasRebuilder(instanceId: string, rebuild: RendererRebuild): void {
  rebuilders.set(instanceId, rebuild);
}

export function unregisterAtlasRebuilder(instanceId: string): void {
  rebuilders.delete(instanceId);
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
 * `ResizeObserver` callbacks — so N panes cost N passes. That is accepted:
 * widening the window to an animation frame would put a paint between the clear
 * and the rebuild, which is the corrupted frame this module exists to prevent.
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
  flushScheduled = false;
  flushing = false;
}
