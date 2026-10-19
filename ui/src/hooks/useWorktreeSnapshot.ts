import { useCallback, useEffect, useRef, useState } from "react";
import {
  getWorktreeSnapshot,
  inspectWorktree,
  type WorktreeInspection,
  type WorktreeSnapshot,
} from "@/lib/worktree-api";

export type WorktreeInspectionResult = { value: WorktreeInspection } | { error: string };
interface Result {
  cwd: string;
  sourceTerminalId?: string;
  requestKey: string;
  snapshot?: WorktreeSnapshot;
  error?: string;
  inspections: Record<string, WorktreeInspectionResult>;
}

/** Manual refresh, with bounded Git concurrency and no stale repository publications. */
export function useWorktreeSnapshot(
  workingDir: string,
  sourceTerminalId?: string,
  invalidation = "",
  retainResolvedTarget = false,
) {
  const [revision, setRevision] = useState(0);
  const requestKey = `${revision}\0${invalidation}`;
  const [result, setResult] = useState<Result | null>(null);
  const resolvedTarget = useRef<{
    cwd: string;
    sourceTerminalId?: string;
    workingDir: string;
  } | null>(null);
  useEffect(() => {
    if (!workingDir) return;
    let cancelled = false;
    const resolved = resolvedTarget.current;
    // 수신을 끄면 이미 검증된 실행 환경 주소(WSL 배포판 포함)를 유지한다.
    // 원본 세션의 이후 cd/종료는 유지 대상의 주소를 무효화하지 않는다.
    (retainResolvedTarget &&
    resolved?.cwd === workingDir &&
    resolved.sourceTerminalId === sourceTerminalId
      ? getWorktreeSnapshot(resolved.workingDir)
      : sourceTerminalId
        ? getWorktreeSnapshot(workingDir, sourceTerminalId)
        : getWorktreeSnapshot(workingDir)
    )
      .then(async (snapshot) => {
        if (cancelled) return;
        resolvedTarget.current = {
          cwd: workingDir,
          sourceTerminalId,
          workingDir: snapshot.workingDir,
        };
        const base: Result = {
          cwd: workingDir,
          sourceTerminalId,
          requestKey,
          snapshot,
          inspections: {},
        };
        setResult(base);
        let next = 0;
        const inspectNext = async () => {
          while (!cancelled && next < snapshot.worktrees.length) {
            const entry = snapshot.worktrees[next++];
            let inspection: WorktreeInspectionResult;
            try {
              inspection = { value: await inspectWorktree(snapshot.workingDir, entry.path) };
            } catch (error) {
              inspection = { error: String(error) };
            }
            if (cancelled) return;
            setResult((current) =>
              current?.cwd === workingDir &&
              current.sourceTerminalId === sourceTerminalId &&
              current.requestKey === requestKey
                ? { ...current, inspections: { ...current.inspections, [entry.path]: inspection } }
                : current,
            );
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(3, snapshot.worktrees.length) }, inspectNext),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setResult((previous) => ({
            cwd: workingDir,
            sourceTerminalId,
            requestKey,
            snapshot:
              previous?.cwd === workingDir && previous.sourceTerminalId === sourceTerminalId
                ? previous.snapshot
                : undefined,
            error: String(error),
            inspections: {},
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [workingDir, sourceTerminalId, requestKey, retainResolvedTarget]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const matching =
    result?.cwd === workingDir && result.sourceTerminalId === sourceTerminalId ? result : null;
  const current = matching?.requestKey === requestKey ? matching : null;
  return {
    snapshot: matching?.snapshot,
    error: current?.error,
    inspections: current?.inspections ?? {},
    loading: !!workingDir && !current,
    version: requestKey,
    refresh,
  };
}
