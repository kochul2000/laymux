import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { TerminalActivityChip } from "@/components/ui/TerminalActivityChip";
import { CopyIcon } from "@/components/ui/icons";
import { clipboardWriteText } from "@/lib/tauri-api";
import {
  inspectWorktree,
  removeWorktree,
  type WorktreeEntry,
  type WorktreeInspection,
} from "@/lib/worktree-api";
import { focusWorktreeUsage, openWorktreeTerminal } from "@/lib/worktree-navigation";
import { worktreeBlockerLabel, worktreeBranchLabel } from "@/lib/worktree-presentation";
import { worktreeFolderName } from "@/lib/worktree-display";
import { joinPath } from "@/lib/file-explorer-parse";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

interface Props {
  workingDir: string;
  entry: WorktreeEntry;
  paneId?: string;
  blockedReason?: string;
  onTerminalOpened: (paneId: string) => void;
  onClose: () => void;
  onRemoved: (path: string) => void;
}
export function WorktreeDetail({
  workingDir,
  entry,
  paneId,
  blockedReason,
  onTerminalOpened,
  onClose,
  onRemoved,
}: Props) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [inspection, setInspection] = useState<WorktreeInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    inspectWorktree(workingDir, entry.path)
      .then((next) => {
        if (!cancelled) setInspection(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [workingDir, entry.path]);
  const blockers = inspection?.blockers.map(worktreeBlockerLabel) ?? [];
  const removeReason = running
    ? "제거 중입니다"
    : blockedReason ||
      (!inspection
        ? "내용 검사가 완료되어야 합니다"
        : !inspection.canRemove
          ? blockers.join(" · ") || "제거할 수 없는 상태입니다"
          : undefined);
  const applyRemove = async () => {
    if (!inspection?.canRemove || removeReason) return;
    setRunning(true);
    setError(null);
    try {
      await removeWorktree(workingDir, entry.path, inspection.worktree.head);
      if (alive.current) onRemoved(entry.path);
    } catch (reason) {
      if (alive.current) {
        setError(String(reason));
        setConfirming(false);
        setInspection(null);
      }
    } finally {
      if (alive.current) setRunning(false);
    }
  };
  return (
    <section data-testid="worktree-detail" className="worktree-detail-panel">
      <div className="worktree-detail-header">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <strong className="block truncate" title={entry.path}>
              {worktreeFolderName(entry.path)}
            </strong>
            <span className="block truncate" title={worktreeBranchLabel(entry.branch)}>
              {worktreeBranchLabel(entry.branch)}
            </span>
          </div>
          <Button
            data-worktree-back
            aria-label="목록으로 돌아가기"
            title={running ? "제거가 완료될 때까지 기다려 주세요" : "목록으로 돌아가기"}
            disabled={running}
            onClick={onClose}
          >
            목록
          </Button>
        </div>
        {!confirming && (
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              icon={<CopyIcon />}
              onClick={() => {
                clipboardWriteText(entry.path)
                  .then(() => {
                    if (alive.current) setCopied(true);
                  })
                  .catch((reason: unknown) => {
                    if (alive.current) setError(String(reason));
                  });
              }}
            >
              {copied ? "복사됨" : "경로 복사"}
            </Button>
            {!entry.bare && !entry.prunable && (
              <Button
                disabled={!!blockedReason}
                title={blockedReason || "현재 작업공간에 새 터미널을 엽니다"}
                onClick={() => {
                  try {
                    const id = openWorktreeTerminal(entry.path, paneId);
                    if (id) onTerminalOpened(id);
                    else setError("새 터미널을 열 작업 공간이 없습니다.");
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : String(reason));
                  }
                }}
              >
                새 터미널
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="worktree-detail-body space-y-3" data-testid="worktree-detail-body">
        {error && (
          <p role="alert" className="worktree-error">
            {error}
          </p>
        )}
        {blockedReason && (
          <p role="status" className="worktree-warning">
            {blockedReason}
          </p>
        )}
        {!inspection && !error && <p role="status">최신 상태를 검사하고 있습니다…</p>}
        {confirming ? (
          <div className="space-y-3">
            <p className="break-all">{entry.path} 폴더를 제거합니다. 브랜치는 유지됩니다.</p>
            <p>파일과 laymux 사용 정보를 다시 검사한 뒤 제거합니다.</p>
          </div>
        ) : (
          inspection && (
            <>
              <div className="space-y-1" data-testid="worktree-detail-summary">
                <p>
                  변경 {inspection.trackedChanges} · 미추적 {inspection.untrackedFiles} · 무시{" "}
                  {inspection.ignoredFiles}
                </p>
              </div>
              {blockers.length > 0 && (
                <p className="worktree-warning">보존: {blockers.join(" · ")}</p>
              )}
              {inspection.usage.length > 0 && (
                <div className="space-y-1">
                  <p>터미널 {inspection.usage.length}개</p>
                  {inspection.usage.map((usage, index) => (
                    <Button
                      key={`${usage.kind}-${usage.paneId}-${index}`}
                      className="max-w-full"
                      disabled={!usage.paneId}
                      title={
                        usage.paneId
                          ? usage.cwd
                          : "이 터미널은 이동할 pane에 연결되어 있지 않습니다"
                      }
                      onClick={() => {
                        if (!focusWorktreeUsage(usage))
                          setError("연결된 터미널을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="truncate">
                          {usage.workspaceName ||
                            workspaces.find((w) =>
                              w.panes.some((s) => s.layers.some((l) => l.id === usage.paneId)),
                            )?.name ||
                            (usage.kind === "daemon" ? "데몬" : "터미널")}
                        </span>
                        <TerminalActivityChip
                          activity={
                            usage.agentType
                              ? {
                                  type: "interactiveApp",
                                  name:
                                    (
                                      { claude: "Claude", codex: "Codex", grok: "Grok" } as Record<
                                        string,
                                        string
                                      >
                                    )[usage.agentType.toLowerCase()] || usage.agentType,
                                }
                              : undefined
                          }
                        />
                        <span className="shrink-0">
                          {usage.kind === "saved"
                            ? "저장된 세션"
                            : usage.kind === "daemon"
                              ? "연결 대기"
                              : "실행 중"}
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              )}
              {(inspection.usageWarnings ?? []).map((warning) => (
                <p key={warning} className="worktree-warning">
                  {warning}
                </p>
              ))}
              {inspection.files.length > 0 && (
                <details open>
                  <summary className="cursor-pointer">
                    변경 파일 목록 ({inspection.files.length}
                    {inspection.filesTruncated ? "+" : ""})
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {inspection.files.map((file, index) => (
                      <li key={`${file.kind}-${file.path}-${index}`}>
                        <Button
                          className="max-w-full text-left"
                          title="파일 뷰어에서 내용을 확인합니다"
                          onClick={() =>
                            useFileViewerStore
                              .getState()
                              .openFileViewer(joinPath(entry.path, file.path))
                          }
                        >
                          <span className="break-all whitespace-normal">
                            {file.kind === "tracked"
                              ? "변경"
                              : file.kind === "untracked"
                                ? "미추적"
                                : "무시"}{" "}
                            · {file.path}
                          </span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <details>
                <summary className="cursor-pointer">경로 · Git 정보</summary>
                <div className="mt-2 space-y-1 break-all">
                  <p>{entry.path}</p>
                  <p>HEAD {inspection.worktree.head.slice(0, 12)}</p>
                  <p>
                    {inspection.upstream
                      ? `${inspection.upstream} · 앞섬 ${inspection.ahead ?? "?"} / 뒤처짐 ${inspection.behind ?? "?"}`
                      : "추적 브랜치 없음"}
                  </p>
                </div>
              </details>
              <details>
                <summary className="cursor-pointer">제거 기준</summary>
                <p className="mt-2">
                  정리 후보는 파일 변경과 laymux 사용 여부 기준입니다. 병합 여부와 로컬 커밋은
                  별도로 확인하세요.
                </p>
              </details>
            </>
          )
        )}
      </div>
      {(inspection || blockedReason) && (
        <div className="worktree-detail-footer flex flex-wrap gap-1">
          {confirming ? (
            <>
              <Button
                data-testid="worktree-confirm-remove"
                variant="primary"
                disabled={!!removeReason}
                title={removeReason || "최신 상태를 다시 검사한 뒤 제거합니다"}
                onClick={() => void applyRemove()}
              >
                {running ? "제거 중…" : "제거 확인"}
              </Button>
              <Button
                disabled={running}
                title={running ? "제거 중입니다" : "제거 취소"}
                onClick={() => setConfirming(false)}
              >
                취소
              </Button>
            </>
          ) : (
            <Button
              data-testid="worktree-remove"
              disabled={!!removeReason}
              title={removeReason || "제거할 경로를 확인합니다"}
              onClick={() => setConfirming(true)}
            >
              워크트리 제거
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
