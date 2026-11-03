import { resolvePaneLink, type PaneLinkTarget, type PaneLinkWorkspace } from "../lib/pane-link";
import type { PaneLinkDependencies } from "../lib/pane-link-provider";

interface Snapshot {
  paneLinkEnabled?: boolean;
  workspaces?: PaneLinkWorkspace[];
}
interface Context {
  terminalId: string | null;
  leaseId: string | null;
  outputEpoch: number;
  ready: boolean;
}
interface Dependencies {
  getSnapshot: () => Snapshot | null;
  getContext: () => Context;
  loadSnapshot: () => Promise<Snapshot>;
  installSnapshot: (snapshot: Snapshot) => void;
  select: (target: PaneLinkTarget) => Promise<void>;
  onError: (error: unknown) => void;
}

/** 번호·설정은 클릭 뒤 최신 host snapshot으로 재검증하고, 탐색은 기존 선택 경로에 위임한다. */
export function remotePaneLinkDependencies(deps: Dependencies): PaneLinkDependencies {
  let pending = false;
  return {
    enabled: () => deps.getSnapshot()?.paneLinkEnabled !== false,
    resolve: (text) => resolvePaneLink(text, deps.getSnapshot()?.workspaces ?? []),
    navigate: (_target, text, isCurrent) => {
      const context = deps.getContext();
      if (pending || !context.ready || !context.terminalId || !context.leaseId) return;
      const stillAllowed = () => {
        const current = deps.getContext();
        return (
          current.ready &&
          current.terminalId === context.terminalId &&
          current.leaseId === context.leaseId &&
          current.outputEpoch === context.outputEpoch &&
          isCurrent()
        );
      };
      pending = true;
      void (async () => {
        const snapshot = await deps.loadSnapshot();
        if (!stillAllowed()) return;
        deps.installSnapshot(snapshot);
        if (snapshot.paneLinkEnabled === false) return;
        const target = resolvePaneLink(text, snapshot.workspaces ?? []);
        if (target) await deps.select(target);
      })()
        .catch(deps.onError)
        .finally(() => {
          pending = false;
        });
    },
  };
}
