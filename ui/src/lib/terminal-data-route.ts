export type TerminalWriteSource = "live" | "replay";
export type XtermDataRoute = "human" | "protocol" | "suppress";

export function routeXtermData(input: {
  writeSource: TerminalWriteSource | undefined;
  humanEventActive: boolean;
}): XtermDataRoute {
  if (input.humanEventActive) return "human";
  if (input.writeSource === "live") return "protocol";
  if (input.writeSource === "replay") return "suppress";
  return "human";
}
