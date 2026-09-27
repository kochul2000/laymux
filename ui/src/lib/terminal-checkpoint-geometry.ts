/** A lifecycle query may temporarily widen the existing local xterm grid. */
export interface CheckpointGeometry {
  cols: number;
  rows: number;
}
type ApplyGeometry = (geometry: CheckpointGeometry, restore: boolean) => void;
const registry = new Map<string, ApplyGeometry>();
const leases = new Map<string, symbol>();

export function registerCheckpointGeometry(id: string, apply: ApplyGeometry): () => void {
  registry.set(id, apply);
  return () => {
    if (registry.get(id) === apply) {
      registry.delete(id);
      leases.delete(id);
    }
  };
}

export function acquireCheckpointGeometry(
  id: string,
  geometry: CheckpointGeometry,
  original: CheckpointGeometry,
): () => void {
  const apply = registry.get(id);
  if (!apply) throw new Error(`Codex status: terminal geometry is unavailable for ${id}`);
  if (leases.has(id))
    throw new Error(`Codex status: terminal geometry is already reserved for ${id}`);
  const lease = Symbol();
  leases.set(id, lease);
  try {
    apply(geometry, false);
  } catch (error) {
    if (leases.get(id) === lease) leases.delete(id);
    throw error;
  }
  return () => {
    if (leases.get(id) !== lease) return;
    leases.delete(id);
    if (registry.get(id) === apply) apply(original, true);
  };
}
