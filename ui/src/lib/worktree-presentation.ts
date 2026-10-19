const BLOCKER_LABELS: Record<string, string> = {
  main: "기본 워크트리",
  bare: "bare 저장소",
  locked: "잠금 설정됨",
  prunable: "경로 또는 연결 정보 확인 필요",
  detached: "브랜치 없는 HEAD",
  submodules: "서브모듈 포함",
  tracked_changes: "추적 파일 변경 있음",
  untracked_files: "미추적 파일 있음",
  ignored_files: "무시된 파일 있음",
  current_directory: "현재 조회 경로",
  in_use: "laymux에서 사용 중",
  usage_unknown: "laymux 사용 여부 확인 실패",
  index_flags: "변경 감지를 생략한 파일 있음",
};
export function worktreeBlockerLabel(code: string): string {
  return BLOCKER_LABELS[code] ?? code;
}
export function worktreeBranchLabel(branch?: string): string {
  return branch?.replace(/^refs\/heads\//, "") || "브랜치 없음";
}
