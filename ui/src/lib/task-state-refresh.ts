type RefreshListener = (terminalIds: readonly string[]) => void;
const listeners = new Set<RefreshListener>();

/** Re-read existing evidence; entering a pane never manufactures an idle task. */
export function requestTaskStateRefresh(terminalIds: readonly string[]): void {
  if (terminalIds.length) for (const listener of listeners) listener(terminalIds);
}

export function onTaskStateRefresh(listener: RefreshListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
