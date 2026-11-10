import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeWorktreeCheck, type WorktreeCheck } from "@/lib/worktree-snapshot-cache";

interface Result extends WorktreeCheck {
  cwd: string;
  sourceTerminalId?: string;
  requestKey: string;
}

export function useWorktreeSnapshot(
  workingDir: string,
  sourceTerminalId?: string,
  invalidation = "",
  retainResolvedTarget = false,
) {
  const [revision, setRevision] = useState(0);
  const requestKey = `${revision}\0${invalidation}`;
  const [run, setRun] = useState({ key: requestKey, invalidation, revision });
  const runKey = run.key;
  const [result, setResult] = useState<Result | null>(null);
  // 같은 대상의 진행 중 검사는 끝내고 복원 중 연속 이벤트는 최신 한 번으로 합친다.
  const finished =
    result?.requestKey === runKey &&
    (!!result.error ||
      (!!result.snapshot &&
        Object.keys(result.inspections).length === result.snapshot.worktrees.length));
  useEffect(() => {
    if (requestKey === runKey || !finished) return;
    const timer = setTimeout(() => setRun({ key: requestKey, invalidation, revision }), 200);
    return () => clearTimeout(timer);
  }, [requestKey, runKey, finished, invalidation, revision]);
  const resolvedTarget = useRef<{
    cwd: string;
    sourceTerminalId?: string;
    workingDir: string;
  } | null>(null);
  const refreshedRevision = useRef(0);
  useEffect(() => {
    if (!workingDir) return;
    const force = run.revision > refreshedRevision.current;
    refreshedRevision.current = run.revision;
    const resolved = resolvedTarget.current;
    const retain =
      retainResolvedTarget &&
      resolved?.cwd === workingDir &&
      resolved.sourceTerminalId === sourceTerminalId;
    return subscribeWorktreeCheck(
      JSON.stringify([workingDir, sourceTerminalId, retainResolvedTarget]),
      run.invalidation,
      retain ? resolved.workingDir : workingDir,
      retain ? undefined : sourceTerminalId,
      force,
      (next) => {
        if (next.snapshot)
          resolvedTarget.current = {
            cwd: workingDir,
            sourceTerminalId,
            workingDir: next.snapshot.workingDir,
          };
        setResult((previous) => ({
          ...next,
          snapshot:
            next.snapshot ??
            (previous?.cwd === workingDir && previous.sourceTerminalId === sourceTerminalId
              ? previous.snapshot
              : undefined),
          cwd: workingDir,
          sourceTerminalId,
          requestKey: runKey,
        }));
      },
    );
  }, [workingDir, sourceTerminalId, run, runKey, retainResolvedTarget]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const matching =
    result?.cwd === workingDir && result.sourceTerminalId === sourceTerminalId ? result : null;
  const current = matching?.requestKey === requestKey ? matching : null;
  return {
    snapshot: matching?.snapshot,
    error: current?.error,
    inspections: current?.inspections ?? {},
    loading: !!workingDir && (!current || !!current.loading),
    completed: Object.keys(matching?.inspections ?? {}).length,
    queued: requestKey !== runKey,
    version: requestKey,
    refresh,
  };
}
