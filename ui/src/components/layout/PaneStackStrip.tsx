import { useShallow } from "zustand/react/shallow";
import { PlusIcon, XIcon } from "@/components/ui/icons";
import { useResolvedKeybinding } from "@/lib/keybinding-registry";
import { toTerminalId } from "@/lib/pane-ids";
import { viewLabel } from "@/lib/view-labels";
import { useNotificationStore } from "@/stores/notification-store";
import { useTerminalStore } from "@/stores/terminal-store";
import type { PaneLayer } from "@/stores/types";

export interface PaneStackStripProps {
  /** The slot's layers in stack order. */
  layers: readonly PaneLayer[];
  activeLayerId: string;
  /** Spatial numbers keyed by layer id (ADR-0295), or null when unnumbered. */
  paneNumbers?: Map<string, number> | null;
  onActivate: (layerId: string) => void;
  onClose?: (layerId: string) => void;
  onAdd?: () => void;
}

interface TabState {
  title: string;
  dot: "unread" | "active" | null;
}

/**
 * Fixed top row of a stacked slot (ADR-0295): one tab per layer plus an add
 * button. Click activates, middle-click or × closes, `+` stacks a new layer.
 * Only rendered for slots holding two or more layers.
 */
export function PaneStackStrip({
  layers,
  activeLayerId,
  paneNumbers,
  onActivate,
  onClose,
  onAdd,
}: PaneStackStripProps) {
  const stackKeys = useResolvedKeybinding("pane.stack");
  const layerKeys = useResolvedKeybinding("pane.layer");
  const terminalIds = layers.map((layer) =>
    layer.view.type === "TerminalView" ? toTerminalId(layer.id) : null,
  );

  // Primitive per-tab facts so the strip re-renders only when a tab changes.
  const titles = useTerminalStore(
    useShallow((s) =>
      terminalIds.map((id) => {
        if (!id) return "";
        const instance = s.instances.find((candidate) => candidate.id === id);
        return instance?.title || instance?.label || "";
      }),
    ),
  );
  const active = useTerminalStore(
    useShallow((s) =>
      terminalIds.map((id) =>
        id ? s.instances.some((candidate) => candidate.id === id && candidate.outputActive) : false,
      ),
    ),
  );
  const unread = useNotificationStore(
    useShallow((s) =>
      terminalIds.map((id) =>
        id ? s.notifications.some((n) => n.terminalId === id && n.readAt === null) : false,
      ),
    ),
  );

  const tabs: TabState[] = layers.map((layer, index) => ({
    title:
      titles[index] ||
      (layer.view.type === "TerminalView" && typeof layer.view.profile === "string"
        ? layer.view.profile
        : viewLabel(layer.view.type)),
    dot: unread[index] ? "unread" : active[index] ? "active" : null,
  }));

  return (
    <div
      className="pane-stack-strip"
      role="tablist"
      aria-label="Pane stack"
      data-testid="pane-stack-strip"
      title={layerKeys ? `Switch layer: ${layerKeys}` : undefined}
    >
      {layers.map((layer, index) => {
        const isActive = layer.id === activeLayerId;
        const number = paneNumbers?.get(layer.id);
        const tab = tabs[index];
        return (
          <div
            key={layer.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={-1}
            className="pane-stack-tab"
            data-active={isActive ? "true" : "false"}
            data-testid={`pane-stack-tab-${layer.id}`}
            title={tab.title}
            onClick={() => onActivate(layer.id)}
            onAuxClick={(e) => {
              if (e.button !== 1 || !onClose) return;
              e.preventDefault();
              onClose(layer.id);
            }}
            onMouseDown={(e) => {
              // Middle-click must not start autoscroll on the strip.
              if (e.button === 1) e.preventDefault();
            }}
          >
            {number != null && <span className="pane-stack-tab-number">{number}</span>}
            {tab.dot && (
              <span
                className="pane-stack-tab-dot"
                data-kind={tab.dot}
                data-testid={`pane-stack-tab-dot-${layer.id}`}
              />
            )}
            <span className="pane-stack-tab-title">{tab.title}</span>
            {onClose && (
              <button
                type="button"
                className="pane-stack-tab-close"
                data-testid={`pane-stack-tab-close-${layer.id}`}
                aria-label={`Close ${tab.title}`}
                title="Close layer"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(layer.id);
                }}
              >
                <XIcon size={10} />
              </button>
            )}
          </div>
        );
      })}
      {onAdd && (
        <button
          type="button"
          className="pane-stack-add"
          data-testid="pane-stack-add"
          aria-label="Stack new layer"
          title={`Stack new layer${stackKeys ? ` (${stackKeys})` : ""}`}
          onClick={onAdd}
        >
          <PlusIcon size={11} />
        </button>
      )}
    </div>
  );
}
