import { getAppUpdateStatus } from "./tauri-api";
import { useLifecycleStore } from "@/stores/lifecycle-store";
import type { LifecycleStage } from "./lifecycle-progress";

/** Only imported by the dev Automation bridge; never executes lifecycle work. */
export async function previewLifecycle(params: Record<string, unknown>) {
  if (!import.meta.env.DEV) throw new Error("Lifecycle preview is dev-only");
  if (params.action === "close") {
    useLifecycleStore.setState({
      open: false,
      preview: false,
      kind: "update",
      progress: null,
      error: null,
    });
    useLifecycleStore.getState().receiveStatus(await getAppUpdateStatus());
    return { open: false };
  }
  if (params.action === "open") {
    useLifecycleStore.getState().openUpdate();
    return { open: true };
  }
  const kind = params.kind === "close" ? "close" : "update";
  const stage = typeof params.stage === "string" ? params.stage : "settling";
  const stages = [
    "ready",
    "downloading",
    "checkpoint",
    "interrupting",
    "settling",
    "caching",
    "installing",
    "closing",
  ];
  if (!stages.includes(stage)) throw new Error("Unknown lifecycle stage");
  const cleanup = params.cleanup !== false;
  const snapshot = await getAppUpdateStatus();
  useLifecycleStore.setState({
    open: true,
    kind,
    preview: true,
    cleanup,
    error: typeof params.error === "string" ? params.error : null,
    progress:
      stage === "ready"
        ? null
        : {
            stage: stage as LifecycleStage,
            completed: Number(params.completed ?? 420),
            total: Number(params.total ?? 700),
          },
    status: {
      ...snapshot,
      availableVersion: "1.0.15",
      notes:
        "종료와 업데이트의 진행 상황을 한 화면에서 확인합니다.\nPC와 리모트에서 같은 준비 단계를 표시합니다.",
      operation:
        stage === "ready"
          ? "idle"
          : stage === "downloading"
            ? "downloading"
            : stage === "installing"
              ? "installing"
              : "preparing",
      exitSettings: { interruptTerminals: cleanup, interruptRounds: 3, settleMs: 700 },
    },
  });
  return { open: true, preview: true, kind, stage };
}
