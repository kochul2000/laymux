import type { TerminalInstance } from "@/stores/terminal-store";

export function heuristicTask(instance: TerminalInstance) {
  return (
    instance.heuristicTask ?? (instance.taskDetectionSource !== "hooks" ? instance.task : undefined)
  );
}

/** Raw adapters remain independent; only this function chooses the displayed task. */
export function selectDetectedTask(
  instance: TerminalInstance,
  mode: "heuristic" | "hooks",
  now = Date.now(),
): TerminalInstance {
  const hook = instance.agentHook;
  const usable =
    mode === "hooks" &&
    hook &&
    instance.sessionReady !== false &&
    instance.generation === hook.snapshot.generation &&
    instance.activity?.type === "interactiveApp" &&
    instance.activity.name?.toLowerCase() === hook.snapshot.provider &&
    now - hook.verifiedAt < 6000 &&
    hook.snapshot.observedAtMs >= (instance.lastUserInputAt ?? 0) &&
    now - hook.snapshot.observedAtMs <= 60000;
  const task = usable ? hook.task : heuristicTask(instance);
  const taskDetectionSource = usable ? "hooks" : "heuristic";
  return instance.task === task && instance.taskDetectionSource === taskDetectionSource
    ? instance
    : { ...instance, task, taskDetectionSource };
}
