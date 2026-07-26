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
 * microtask, before any renderer can repopulate the atlas.
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

let flushScheduled = false;
const pendingClearers = new Set<string>();

function flush(): void {
  flushScheduled = false;
  // A terminal that reported a clear has already rebuilt itself. Skipping it is
  // only safe when it is the sole reporter: with two reporters in one task, the
  // first one rebuilt before the second wiped the atlas, so it is stale too.
  const skip = pendingClearers.size === 1 ? [...pendingClearers][0] : undefined;
  pendingClearers.clear();
  for (const [instanceId, rebuild] of [...rebuilders]) {
    if (instanceId === skip) continue;
    try {
      rebuild();
    } catch {
      // A terminal disposed between the notify and the flush — the next mount
      // rebuilds its own atlas anyway.
    }
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
 * Report that this terminal cleared the shared texture atlas and has already
 * rebuilt its own renderer. Runs the rebuild in a microtask so every clear
 * queued in the same task (one `ResizeObserver` callback carries all panes of a
 * returning workspace) is covered by a single pass, and so the rebuild lands
 * before the browser's next paint.
 */
export function notifyTextureAtlasCleared(instanceId: string): void {
  pendingClearers.add(instanceId);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/** Test hook — drops registrations and any pending flush. */
export function __resetAtlasRebuildersForTest(): void {
  rebuilders.clear();
  pendingClearers.clear();
  flushScheduled = false;
}
