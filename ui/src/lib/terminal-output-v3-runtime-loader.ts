type TerminalOutputV3RuntimeModule = typeof import("./terminal-output-v3-runtime");
const defaultLoader = () => import("./terminal-output-v3-runtime");
let loader = defaultLoader;

export function loadTerminalOutputV3Runtime(): Promise<TerminalOutputV3RuntimeModule> {
  return loader();
}

/** Test seam for proving that a pending import cannot revive an unmounted surface. */
export function setTerminalOutputV3RuntimeLoaderForTest(
  next?: () => Promise<TerminalOutputV3RuntimeModule>,
): void {
  loader = next ?? defaultLoader;
}
