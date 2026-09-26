export type LifecycleStage =
  | "downloading"
  | "checkpoint"
  | "interrupting"
  | "settling"
  | "caching"
  | "installing"
  | "closing";
export interface ExitProgress {
  stage: LifecycleStage;
  completed: number;
  total: number | null;
  warning?: string | null;
}
export type ProgressReporter = (progress: ExitProgress) => void | Promise<void>;
export function progressPercent(
  progress: Pick<ExitProgress, "completed" | "total">,
): number | null {
  return progress.total && progress.total > 0
    ? Math.max(0, Math.min(100, Math.floor((progress.completed / progress.total) * 100)))
    : null;
}
export function lifecycleSteps(kind: "close" | "update", cleanup: boolean): LifecycleStage[] {
  return [
    ...(kind === "update" ? ["downloading" as const] : []),
    "checkpoint",
    ...(cleanup ? ["interrupting" as const] : []),
    "caching",
    kind === "update" ? "installing" : "closing",
  ];
}
export const lifecycleCopy = {
  ko: {
    downloading: "업데이트 다운로드 및 검증",
    checkpoint: "복원 정보 저장",
    interrupting: "터미널 작업 정리",
    settling: "마지막 출력 대기 중",
    caching: "터미널 기록 저장",
    installing: "설치 및 재시작",
    closing: "Laymux 종료",
    updateTitle: "Laymux 업데이트",
    closeTitle: "Laymux 종료 중",
    updateBusy: "Laymux 업데이트 중",
    subtitle: "실행 중인 작업을 정리하고 기록을 저장합니다.",
    ready: "업데이트 후 Laymux가 다시 시작됩니다.",
    cleanupOn: "작업 정리 켜짐 · 실행 중인 작업이 중단됩니다.",
    cleanupOff: "작업 정리 꺼짐 · 설치 전 터미널은 종료됩니다.",
    check: "업데이트 확인",
    install: "업데이트 후 재시작",
    later: "나중에",
    hide: "접어두기",
    details: "변경 사항",
    settings: "설정",
    stable: "정식 채널",
    beta: "베타 채널",
    latest: "현재 최신 버전입니다.",
    dev: "개발 빌드에서는 실제 업데이트를 설치하지 않습니다.",
    checking: "업데이트 확인 중…",
    failure: "작업 실패",
    retry: "다시 시도",
    wait: "계속 기다리기",
    force: "저장하지 않고 종료",
    waiting: "작업이 예상보다 지연되고 있습니다.",
    preview: "미리보기 · 실제 작업은 실행되지 않습니다",
    interrupted: "종료 신호 전달 중",
    shutdownWarning: "지금 종료하면 아직 저장하지 못한 기록이 사라질 수 있습니다.",
  },
  en: {
    downloading: "Download and verify update",
    checkpoint: "Save restore information",
    interrupting: "Clean up terminal tasks",
    settling: "Waiting for final output",
    caching: "Save terminal history",
    installing: "Install and restart",
    closing: "Close Laymux",
    updateTitle: "Laymux update",
    closeTitle: "Closing Laymux",
    updateBusy: "Updating Laymux",
    subtitle: "Cleaning up tasks and saving terminal history.",
    ready: "Laymux will restart after the update.",
    cleanupOn: "Task cleanup is on · Running tasks will be interrupted.",
    cleanupOff: "Task cleanup is off · Terminals will close before installation.",
    check: "Check for updates",
    install: "Update and restart",
    later: "Later",
    hide: "Minimize",
    details: "What's new",
    settings: "Settings",
    stable: "Stable channel",
    beta: "Beta channel",
    latest: "You're up to date.",
    dev: "Updates cannot be installed in a development build.",
    checking: "Checking for updates",
    failure: "Unable to continue",
    retry: "Try again",
    wait: "Keep waiting",
    force: "Close without saving",
    waiting: "This is taking longer than expected.",
    preview: "Preview · No tasks will run",
    interrupted: "Sending interrupt signals.",
    shutdownWarning: "Closing now may lose terminal history that has not been saved.",
  },
};
