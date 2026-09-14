import { getCodexTurnStates, type CodexTurnSnapshot } from "./tauri-api";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { persistSession } from "./persist-session";
import { resolveWorkspaceId } from "./workspace-utils";
import { sendDesktopNotification } from "@/hooks/useOsNotification";
import { CODEX_INPUT_PENDING_MARKER } from "./activity-markers";

const POLL_MS = 1000;
const STALE_MS = 6000;

function isCodex(instance: TerminalInstance): boolean {
  return (
    instance.sessionReady !== false &&
    instance.activity?.type === "interactiveApp" &&
    instance.activity.name === "Codex"
  );
}

function sourceKey(turn: CodexTurnSnapshot): string {
  return `${turn.generation}:${turn.selectionKey ?? ""}:${turn.sessionId ?? ""}`;
}

function turnKey(turn: CodexTurnSnapshot): string {
  return `${sourceKey(turn)}:${turn.turnId ?? ""}`;
}

function sameSnapshot(before: CodexTurnSnapshot | undefined, next: CodexTurnSnapshot): boolean {
  return !!before && before.state === next.state && turnKey(before) === turnKey(next);
}

/** One in-flight lookup for all panes. Output events keep their independent state. */
export function subscribeCodexTurnStates(): () => void {
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  const epochs = new Map(
    useTerminalStore.getState().instances.map((instance) => [instance.id, ++epoch]),
  );
  const previous = new Map<string, CodexTurnSnapshot>();

  function unknown(id: string, reset = true) {
    const current = useTerminalStore.getState().instances.find((instance) => instance.id === id);
    if (!current || !isCodex(current)) return;
    if (reset) previous.delete(id);
    const codexTurn: CodexTurnSnapshot = {
      generation: current.codexTurn?.generation ?? 0,
      state: "unknown",
    };
    if (!sameSnapshot(current.codexTurn, codexTurn))
      useTerminalStore.getState().updateInstanceInfo(id, { codexTurn });
  }

  function schedule(delay = POLL_MS) {
    if (disposed || inFlight || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
  }

  async function poll() {
    if (disposed || inFlight) return;
    const targets = useTerminalStore.getState().instances.filter(isCodex);
    if (targets.length === 0) return;
    inFlight = true;
    const stamps = new Map(
      targets.map((instance) => [
        instance.id,
        {
          epoch: epochs.get(instance.id) ?? 0,
          inputAt: instance.lastUserInputAt,
        },
      ]),
    );
    function currentTarget(id: string): TerminalInstance | undefined {
      const current = useTerminalStore.getState().instances.find((instance) => instance.id === id);
      const stamp = stamps.get(id);
      return current &&
        stamp &&
        isCodex(current) &&
        stamp.epoch === (epochs.get(id) ?? 0) &&
        stamp.inputAt === current.lastUserInputAt
        ? current
        : undefined;
    }
    let expired = false;
    expiry = setTimeout(() => {
      expired = true;
      if (!disposed) for (const id of stamps.keys()) if (currentTarget(id)) unknown(id);
    }, STALE_MS);
    try {
      const snapshots = await getCodexTurnStates();
      if (disposed || expired) return;
      for (const id of stamps.keys()) {
        const current = currentTarget(id);
        if (!current) continue;
        const snapshot = snapshots[id];
        if (!snapshot || snapshot.state === "unknown") {
          unknown(id);
          continue;
        }
        const before = previous.get(id);
        previous.set(id, snapshot);
        if (!sameSnapshot(current.codexTurn, snapshot))
          useTerminalStore.getState().updateInstanceInfo(id, { codexTurn: snapshot });
        // Seed historical snapshots silently. A new source is a selection or
        // process change, never a completion of the previously observed turn.
        if (
          snapshot.state !== "completed" ||
          !snapshot.turnId ||
          !before ||
          sourceKey(before) !== sourceKey(snapshot) ||
          (before.state === "completed" && before.turnId === snapshot.turnId)
        )
          continue;
        const workspaceId = resolveWorkspaceId(id);
        const message = "Codex task completed";
        useNotificationStore
          .getState()
          .addNotification({ terminalId: id, workspaceId, message, level: "success" });
        void persistSession({ reason: "completion" });
        if (
          !document.hasFocus() ||
          useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
        ) {
          void sendDesktopNotification("Laymux", message);
        }
      }
    } catch {
      if (!disposed) for (const id of stamps.keys()) if (currentTarget(id)) unknown(id);
    } finally {
      clearTimeout(expiry);
      expiry = undefined;
      inFlight = false;
      schedule();
    }
  }

  const unsubscribe = useTerminalStore.subscribe((state, before) => {
    const currentById = new Map(state.instances.map((instance) => [instance.id, instance]));
    const oldById = new Map(before.instances.map((instance) => [instance.id, instance]));
    const ids = new Set([...currentById.keys(), ...oldById.keys()]);
    for (const id of ids) {
      const current = currentById.get(id);
      const old = oldById.get(id);
      if (
        !!current !== !!old ||
        (current &&
          old &&
          (isCodex(current) !== isCodex(old) || current.sessionReady !== old.sessionReady))
      ) {
        if (current) epochs.set(id, ++epoch);
        else epochs.delete(id);
        previous.delete(id);
        if (current?.codexTurn)
          useTerminalStore.getState().updateInstanceInfo(id, { codexTurn: undefined });
      }
      if (current && old && isCodex(current) && current.lastUserInputAt !== old.lastUserInputAt) {
        const turn = previous.get(id);
        if (turn && turn.state !== "running") {
          // Local commands such as /status may never start another turn.
          // Invalidate this frame, then let the next observation be authoritative.
          unknown(id, false);
        }
      }
      if (
        current &&
        isCodex(current) &&
        current.activityMessage === CODEX_INPUT_PENDING_MARKER &&
        old?.activityMessage !== CODEX_INPUT_PENDING_MARKER
      ) {
        const workspaceId = resolveWorkspaceId(id);
        const message = "Codex is awaiting input";
        useNotificationStore
          .getState()
          .addNotification({ terminalId: id, workspaceId, message, level: "info" });
        if (
          !document.hasFocus() ||
          useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
        ) {
          void sendDesktopNotification("Laymux", message);
        }
      }
    }
    if (state.instances.some(isCodex)) schedule(0);
  });
  schedule(0);
  return () => {
    disposed = true;
    unsubscribe();
    clearTimeout(timer);
    clearTimeout(expiry);
  };
}
