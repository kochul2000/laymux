import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSyncGroupCwdContext } from "@/hooks/useSyncGroupCwd";
import { useWorktreeSnapshot } from "@/hooks/useWorktreeSnapshot";
import { useContainerSize } from "@/hooks/useContainerSize";
import { ViewShell } from "@/components/ui/ViewShell";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ViewBody } from "@/components/ui/ViewBody";
import { Button } from "@/components/ui/Button";
import { RefreshIcon } from "@/components/ui/icons";
import { worktreeBlockerLabel } from "@/lib/worktree-presentation";
import { worktreeFolderName, worktreeRowStatus } from "@/lib/worktree-display";
import { getInstanceId } from "@/lib/view-instance-id";
import { useTerminalStore } from "@/stores/terminal-store";
import { WorktreeDetail } from "./WorktreeDetail";
import { WorktreeRow } from "./WorktreeRow";
import { focusWorktreeUsage, openWorktreeTerminal } from "@/lib/worktree-navigation";
import { WORKTREE_ACTION_EVENT, type WorktreeViewAction } from "@/lib/worktree-view-control";
import type { WorktreeEntry } from "@/lib/worktree-api";

const EMPTY_WORKTREES: WorktreeEntry[] = [];
const WORKTREE_SPLIT_WIDTH = 640;
export interface WorktreeViewProps {
  instanceId: string;
  paneId?: string;
  syncGroup: string;
  cwdReceive?: boolean;
  repositoryPath?: string;
}
export function WorktreeView(props: WorktreeViewProps) {
  return <WorktreeSource key={props.repositoryPath || ""} {...props} />;
}
function WorktreeSource({
  instanceId,
  paneId,
  syncGroup,
  cwdReceive = true,
  repositoryPath,
}: WorktreeViewProps) {
  const { cwd, sourceTerminalId } = useSyncGroupCwdContext({
    instanceId,
    syncGroup,
    cwdReceive,
    initialCwd: repositoryPath,
  });
  return (
    <WorktreeContent
      key={`${cwd}\0${sourceTerminalId ?? ""}`}
      workingDir={cwd}
      sourceTerminalId={sourceTerminalId}
      paneId={paneId}
      cwdReceive={cwdReceive}
    />
  );
}
function WorktreeContent({
  workingDir,
  sourceTerminalId,
  paneId,
  cwdReceive,
}: {
  workingDir: string;
  sourceTerminalId?: string;
  paneId?: string;
  cwdReceive: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const returnFocusPath = useRef<string | null>(null);
  const { w } = useContainerSize(containerRef);
  const split = w >= WORKTREE_SPLIT_WIDTH;
  const [created, setCreated] = useState<{ id: string; path: string } | null>(null);
  const ready = useTerminalStore((s) =>
    created ? s.instances.some((t) => t.id === created.id && t.sessionReady) : false,
  );
  const [readyCreation, setReadyCreation] = useState<string | null>(null);
  if (created && ready && readyCreation !== created.id) setReadyCreation(created.id);
  const creationSettled = ready || readyCreation === created?.id;
  const { snapshot, error, inspections, loading, refresh, version } = useWorktreeSnapshot(
    workingDir,
    sourceTerminalId,
    created ? `${created.id}:${creationSettled}` : "",
  );
  const [filter, setFilter] = useState<"all" | "candidates">("all");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const worktrees = snapshot?.worktrees ?? EMPTY_WORKTREES;
  const creating = created && !creationSettled;
  const candidates = worktrees.filter((entry) => {
    const result = inspections[entry.path];
    return (
      !(creating && created.path === entry.path) &&
      result &&
      "value" in result &&
      result.value.canRemove
    );
  });
  const pending = error ? 0 : worktrees.length - Object.keys(inspections).length;
  const checking = loading || pending > 0;
  const entries = filter === "all" ? worktrees : candidates;
  const selected = worktrees.find((entry) => entry.path === selectedPath);
  const selectedKey = selected?.path;
  const repository = snapshot?.repositoryPath || workingDir;
  const excluded = new Map<string, number>();
  for (const result of Object.values(inspections)) {
    for (const reason of "value" in result ? result.value.blockers : ["inspection_error"]) {
      const label = reason === "inspection_error" ? "검사 실패" : worktreeBlockerLabel(reason);
      excluded.set(label, (excluded.get(label) ?? 0) + 1);
    }
  }
  useLayoutEffect(() => {
    if (selectedKey && !split && listRef.current?.contains(document.activeElement))
      containerRef.current
        ?.querySelector<HTMLButtonElement>("[data-worktree-back]")
        ?.focus({ preventScroll: true });
    if (!selectedKey && returnFocusPath.current) {
      [...(listRef.current?.querySelectorAll<HTMLElement>("[data-worktree-path]") ?? [])]
        .find((row) => row.dataset.worktreePath === returnFocusPath.current)
        ?.querySelector<HTMLButtonElement>("[data-worktree-detail]")
        ?.focus({ preventScroll: true });
      returnFocusPath.current = null;
    }
    if ((!selectedKey || split) && listRef.current) listRef.current.scrollTop = listScroll.current;
  }, [selectedKey, split]);
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<WorktreeViewAction>).detail;
      if (!paneId || detail.paneId !== paneId) return;
      if (detail.action === "refresh") {
        setCreated(null);
        refresh();
      } else if (
        detail.action === "select" &&
        worktrees.some((entry) => entry.path === detail.path)
      )
        setSelectedPath(detail.path!);
      else if (
        detail.action === "filter" &&
        (detail.filter === "all" || detail.filter === "candidates")
      ) {
        setFilter(detail.filter);
        setSelectedPath(null);
      }
    };
    window.addEventListener(WORKTREE_ACTION_EVENT, receive);
    return () => window.removeEventListener(WORKTREE_ACTION_EVENT, receive);
  }, [paneId, refresh, worktrees]);
  const blockedReason =
    created?.path === selected?.path && creating
      ? "터미널 시작을 확인하고 있습니다"
      : loading
        ? "목록과 사용 정보를 갱신하고 있습니다"
        : error
          ? "목록 갱신에 실패했습니다. 다시 검사해 주세요"
          : undefined;
  return (
    <ViewShell
      ref={containerRef}
      testId="view-worktree"
      data-pane-id={paneId}
      className={`worktree-view min-h-0 min-w-0 ${split ? "worktree-view-wide" : ""}`}
      aria-busy={checking}
    >
      <ViewHeader title="Worktrees" />
      <div className="worktree-toolbar" data-testid="worktree-filters">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span data-testid="worktree-repository" className="truncate" title={repository}>
            {repository ? worktreeFolderName(repository) : "Git 저장소 없음"}
          </span>
          <span
            className="worktree-cwd-status shrink-0"
            title={
              cwdReceive
                ? "현재 그룹의 터미널 CWD를 수신합니다"
                : "CWD 수신이 꺼져 있어 현재 대상을 유지합니다"
            }
          >
            {cwdReceive ? "CWD 수신 켜짐" : "대상 유지"}
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            className="worktree-filter"
            aria-pressed={filter === "all"}
            onClick={() => {
              setFilter("all");
              setSelectedPath(null);
            }}
          >
            전체 {worktrees.length}
          </Button>
          <Button
            className="worktree-filter"
            aria-pressed={filter === "candidates"}
            onClick={() => {
              setFilter("candidates");
              setSelectedPath(null);
            }}
          >
            정리 후보 {checking ? "· 검사 중" : candidates.length}
          </Button>
          <Button
            className="worktree-toolbar-button ml-auto"
            aria-label="워크트리 새로고침"
            title={
              !workingDir
                ? "터미널에서 저장소를 열어 주세요"
                : loading
                  ? "목록을 조회하고 있습니다"
                  : "목록과 사용 정보를 다시 검사합니다"
            }
            disabled={!workingDir || loading}
            icon={<RefreshIcon size={12} />}
            onClick={() => {
              setNotice(null);
              setCreated(null);
              refresh();
            }}
          />
        </div>
      </div>
      <div
        className={`worktree-panes ${split && selected ? "worktree-panes-split" : ""}`}
        data-testid="worktree-panes"
      >
        <ViewBody
          ref={listRef}
          testId="worktree-list"
          hidden={!!selected && !split}
          className="min-h-0 min-w-0"
          onScroll={(e) => {
            if (!selected || split) listScroll.current = e.currentTarget.scrollTop;
          }}
        >
          {!workingDir && <p className="p-3">터미널에서 Git 저장소를 열어 주세요.</p>}
          {loading && (
            <p role="status" className="p-2">
              {snapshot
                ? "기존 목록을 표시하며 다시 검사합니다…"
                : "워크트리 목록을 읽고 있습니다…"}
            </p>
          )}
          {pending > 0 && !loading && (
            <p role="status" className="p-2">
              내용 검사 중 · {worktrees.length - pending}/{worktrees.length}
            </p>
          )}
          {error && (
            <p role="alert" className="worktree-error p-2">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="p-2">
              {notice}
            </p>
          )}
          {(snapshot?.usageWarnings ?? []).map((warning) => (
            <p key={warning} className="worktree-warning p-2">
              {warning}
            </p>
          ))}
          {entries.map((entry) => {
            const result = inspections[entry.path];
            const value = result && "value" in result ? result.value : undefined;
            const summary =
              creating && created.path === entry.path
                ? "터미널 시작 중"
                : error
                  ? "목록 갱신 실패"
                  : result && "error" in result
                    ? `검사 실패: ${result.error}`
                    : worktreeRowStatus(entry, value, false);
            return (
              <WorktreeRow
                key={entry.path}
                entry={entry}
                usage={value?.usage ?? entry.usage}
                summary={summary}
                selected={selectedPath === entry.path}
                candidate={!!value?.canRemove && !creating}
                creating={!!creating && created.path === entry.path}
                onDetail={() => setSelectedPath(selectedPath === entry.path ? null : entry.path)}
                onTerminal={() => {
                  try {
                    const id = openWorktreeTerminal(entry.path, paneId);
                    if (id) setCreated({ id: getInstanceId("TerminalView", id), path: entry.path });
                    else setNotice("새 터미널을 열 작업 공간이 없습니다.");
                  } catch (reason) {
                    setNotice(reason instanceof Error ? reason.message : String(reason));
                  }
                }}
                onMove={(usage) => {
                  if (!focusWorktreeUsage(usage))
                    setNotice("해당 터미널을 찾을 수 없습니다. 새로고침해 주세요.");
                }}
              />
            );
          })}
          {snapshot && !loading && entries.length === 0 && (
            <div className="space-y-2 p-3">
              <p>
                {pending
                  ? "검사가 끝난 정리 후보부터 표시합니다."
                  : filter === "candidates"
                    ? "현재 정리 후보가 없습니다."
                    : "워크트리가 없습니다."}
              </p>
              {filter === "candidates" && !pending && (
                <>
                  <p>
                    제외 사유:{" "}
                    {[...excluded].map(([label, count]) => `${label} ${count}`).join(" · ") ||
                      "새로고침으로 사용 정보를 확인해 주세요"}
                  </p>
                  <Button onClick={() => setFilter("all")}>전체에서 확인</Button>
                </>
              )}
            </div>
          )}
        </ViewBody>
        {selected && snapshot && (
          <WorktreeDetail
            key={`${selected.path}\0${version}`}
            workingDir={snapshot.workingDir}
            entry={selected}
            paneId={paneId}
            blockedReason={blockedReason}
            onTerminalOpened={(id) => {
              setCreated({ id: getInstanceId("TerminalView", id), path: selected.path });
            }}
            onClose={() => {
              returnFocusPath.current = selected.path;
              setSelectedPath(null);
            }}
            onRemoved={(path) => {
              setSelectedPath(null);
              setNotice(`제거 완료: ${path}`);
              refresh();
            }}
          />
        )}
      </div>
    </ViewShell>
  );
}
