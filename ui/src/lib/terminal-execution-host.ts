export type InitialExecutionHost = "nativeWindows" | "wsl" | "directSsh" | "nonWindows" | "unknown";

export function shouldStabilizeInitialExecutionHost(host: InitialExecutionHost): boolean {
  return host === "nativeWindows";
}
