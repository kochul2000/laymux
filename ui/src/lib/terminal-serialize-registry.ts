type SerializeFn = () => Uint8Array;

const registry = new Map<string, SerializeFn>();

export function registerTerminalSerializer(paneId: string, fn: SerializeFn): void {
  registry.set(paneId, fn);
}

export function unregisterTerminalSerializer(paneId: string): void {
  registry.delete(paneId);
}

export function getTerminalSerializeMap(): Map<string, SerializeFn> {
  return registry;
}
