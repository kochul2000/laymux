import {
  getWorktreeSnapshot,
  inspectWorktree,
  type WorktreeInspection,
  type WorktreeSnapshot,
} from "./worktree-api";

export type WorktreeInspectionResult = { value: WorktreeInspection } | { error: string };
export interface WorktreeCheck {
  loading?: boolean;
  snapshot?: WorktreeSnapshot;
  error?: string;
  inspections: Record<string, WorktreeInspectionResult>;
}
interface Task {
  value: WorktreeCheck;
  listeners: Set<(value: WorktreeCheck) => void>;
  completedAt?: number;
}
const tasks = new Map<string, Task>();
const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 12;
let loads = 0;
let hits = 0;
let shared = 0;
export function worktreeCacheMetrics() {
  return { loads, hits, shared, targets: tasks.size };
}

export function clearWorktreeSnapshotCache() {
  tasks.clear();
  loads = hits = shared = 0;
}

/** 같은 대상의 진행 중 작업과 최근 완료 결과를 공유한다. 화면 이탈은 Git 작업을 재시작하지 않는다. */
export function subscribeWorktreeCheck(
  target: string,
  invalidation: string,
  workingDir: string,
  sourceTerminalId: string | undefined,
  force: boolean,
  listener: (value: WorktreeCheck) => void,
) {
  const key = JSON.stringify([target, invalidation]);
  let task = tasks.get(key);
  if (force || (task?.completedAt && Date.now() - task.completedAt >= CACHE_TTL_MS)) {
    tasks.delete(key);
    task = undefined;
  }
  if (!task) {
    loads++;
    task = { value: { loading: true, inspections: {} }, listeners: new Set() };
    tasks.set(key, task);
    while (tasks.size > CACHE_LIMIT) tasks.delete(tasks.keys().next().value!);
    const owner = task;
    const publish = (value: WorktreeCheck) => {
      owner.value = value;
      owner.listeners.forEach((notify) => notify(value));
    };
    (sourceTerminalId
      ? getWorktreeSnapshot(workingDir, sourceTerminalId)
      : getWorktreeSnapshot(workingDir)
    )
      .then(async (snapshot) => {
        publish({ snapshot, inspections: {} });
        let next = 0;
        const inspectNext = async () => {
          while (next < snapshot.worktrees.length) {
            const entry = snapshot.worktrees[next++];
            let result: WorktreeInspectionResult;
            try {
              result = { value: await inspectWorktree(snapshot.workingDir, entry.path) };
            } catch (error) {
              result = { error: String(error) };
            }
            publish({
              snapshot,
              inspections: { ...owner.value.inspections, [entry.path]: result },
            });
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(3, snapshot.worktrees.length) }, inspectNext),
        );
        owner.completedAt = Date.now();
      })
      .catch((error: unknown) => {
        publish({ error: String(error), inspections: {} });
        if (tasks.get(key) === owner) tasks.delete(key);
      });
  } else if (task.completedAt) hits++;
  else shared++;
  task.listeners.add(listener);
  const subscribed = task;
  queueMicrotask(() => {
    if (subscribed.listeners.has(listener)) listener(subscribed.value);
  });
  return () => {
    subscribed.listeners.delete(listener);
  };
}
