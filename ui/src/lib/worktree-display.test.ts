import { describe, expect, it } from "vitest";
import { worktreeFolderName, worktreeRowStatus } from "./worktree-display";
import type { WorktreeEntry, WorktreeInspection } from "./worktree-api";

describe("워크트리 dock 표시", () => {
  it.each([
    ["D:/long/common/feature", "feature"],
    ["D:\\long\\common\\한글 작업", "한글 작업"],
    ["//wsl.localhost/Debian/home/repo\\name", "repo\\name"],
    ["/home/repo\\name", "repo\\name"],
  ])("긴 경로 %s는 폴더 말단 %s로 식별한다", (path, name) => {
    expect(worktreeFolderName(path)).toBe(name);
  });
  it("파일 수가 0이어도 인덱스 예외나 사용 관측 실패를 숨기지 않는다", () => {
    const entry = { path: "D:/tree", isMain: false } as WorktreeEntry;
    const inspection = {
      trackedChanges: 0,
      untrackedFiles: 0,
      ignoredFiles: 0,
      usage: [],
      canRemove: false,
      blockers: ["index_flags", "usage_unknown"],
    } as unknown as WorktreeInspection;
    expect(worktreeRowStatus(entry, inspection)).toContain("변경 감지를 생략한 파일 있음");
    expect(worktreeRowStatus(entry, inspection)).toContain("사용 여부 확인 실패");
    expect(worktreeRowStatus(entry, inspection)).not.toContain("정리 후보");
  });
  it("터미널 선택을 따로 표시하는 목록에서는 디렉터리 상태만 계산한다", () => {
    const entry = { path: "D:/tree", isMain: false } as WorktreeEntry;
    const inspection = {
      trackedChanges: 2,
      untrackedFiles: 1,
      ignoredFiles: 21097,
      usage: [{ terminalId: "terminal" }],
      canRemove: false,
      blockers: ["in_use", "tracked_changes", "untracked_files", "ignored_files"],
    } as unknown as WorktreeInspection;
    expect(worktreeRowStatus(entry, inspection, false)).toBe("변경 2 · 미추적 1 · 무시 21097");
    expect(worktreeRowStatus(entry, inspection)).toContain("터미널 1개");
  });
});
