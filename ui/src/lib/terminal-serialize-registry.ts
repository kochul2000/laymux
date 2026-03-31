type SerializeFn = () => string;

const registry = new Map<string, SerializeFn>();

export function registerTerminalSerializer(paneId: string, fn: SerializeFn): void {
  registry.set(paneId, fn);
}

export function unregisterTerminalSerializer(paneId: string): void {
  registry.delete(paneId);
}

export function getTerminalSerializeMap(): ReadonlyMap<string, SerializeFn> {
  return new Map(registry);
}
