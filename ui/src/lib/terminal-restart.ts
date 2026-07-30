import { useTerminalStore } from "@/stores/terminal-store";
import type { ViewInstanceConfig } from "@/stores/types";
import { getInstanceId } from "./view-instance-id";

/**
 * 사용자 요청 재시작은 살아 있는 세션이 보고한 CWD를 최우선으로 쓴다.
 * 아직 OSC 7을 받지 못한 초기 세션만 저장된 lastCwd를 차선으로 사용한다.
 */
export function getTerminalRestartCwd(
  paneId: string,
  view: ViewInstanceConfig,
): string | undefined {
  const runtimeCwd = useTerminalStore
    .getState()
    .instances.find((instance) => instance.id === getInstanceId("TerminalView", paneId))?.cwd;
  if (runtimeCwd) return runtimeCwd;

  const savedCwd = view.lastCwd;
  return typeof savedCwd === "string" && savedCwd.length > 0 ? savedCwd : undefined;
}
