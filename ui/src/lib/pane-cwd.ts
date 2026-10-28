import { useTerminalStore } from "@/stores/terminal-store";
import type { ViewInstanceConfig } from "@/stores/types";
import { getPaneInstanceId } from "./view-instance-id";
import { useSettingsStore, FALLBACK_PROFILE } from "@/stores/settings-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";

/** CWD 를 해석할 수 있는 최소 pane 모양 — workspace pane 과 dock pane 모두 만족한다. */
export interface CwdBearingPane {
  id: string;
  view: ViewInstanceConfig;
}

/**
 * 이 pane 이 "지금 있는" 디렉터리.
 *
 * 살아 있는 세션이 보고한 CWD(백엔드 SoT 의 프론트 미러, [ADR-0003]·[ADR-0130])가
 * 최우선이고, 아직 세션이 없거나 CWD 를 못 받은 pane 만 설정에 저장된 `lastCwd` 로
 * 차선 해석한다. CWD 개념이 없는 view(Memo 등)는 `undefined`.
 */
export function resolvePaneCwd(pane: CwdBearingPane): string | undefined {
  const instanceId = getPaneInstanceId(pane);
  const runtimeCwd = instanceId
    ? useTerminalStore.getState().instances.find((instance) => instance.id === instanceId)?.cwd
    : undefined;
  if (runtimeCwd) return runtimeCwd;

  const savedCwd = pane.view.lastCwd;
  return typeof savedCwd === "string" && savedCwd.length > 0 ? savedCwd : undefined;
}

/** CWD는 즉시 캡처하고 Git/WSL 경로 결정은 첫 PTY 생성까지 지연한다. */
export function seedInheritedPaneCwd(
  paneId: string,
  source: CwdBearingPane,
  clearEmpty = false,
): void {
  const cwd = resolvePaneCwd(source);
  if (!cwd && !clearEmpty) return;
  const instanceId = getPaneInstanceId(source);
  const settings = useSettingsStore.getState();
  const profile =
    useTerminalStore.getState().instances.find((instance) => instance.id === instanceId)?.profile ??
    (typeof source.view.profile === "string" ? source.view.profile : undefined) ??
    settings.defaultProfile ??
    FALLBACK_PROFILE;
  // CWD가 없는 Remote 원본도 기존 슬롯의 시드를 지워야 다른 레이어의 경로가 새지 않는다.
  useTerminalRestartStore.getState().requestRestart(paneId, cwd, false, cwd ? profile : undefined);
}
