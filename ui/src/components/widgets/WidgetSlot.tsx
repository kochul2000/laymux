/**
 * Renders one slot's widgets, shedding from the edge-farthest end when the
 * width it was given runs out (ADR-0105).
 *
 * Three rules make this stable. The slot asks for exactly the width its
 * placement wants (`flex-basis` = sum of the estimates) and never for what it
 * currently draws — sizing to rendered content would feed back into the fit
 * decision and collapse would never undo itself. What it actually receives is
 * already net of the top bar's reserved drag region, so the drag minimum
 * outranks widget display without a second rule. And a collapsed widget is
 * repositioned, never unmounted, so crossing the collapse threshold cannot
 * churn a probe subscription (ADR-0102 counts mounted views as demand).
 */

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useContainerSize } from "@/hooks/useContainerSize";
import { useSettingsStore } from "@/stores/settings-store";
import {
  fitWidgets,
  readWidgetFontSize,
  type WidgetInstance,
  type WidgetSlotId,
} from "@/lib/widget-placement";
import { findWidgetDefinition } from "./registry";
import type { WidgetEnv } from "./types";

/** Width reserved for the "more" affordance while anything is still collapsed. */
const OVERFLOW_INDICATOR_WIDTH = 18;

export function WidgetSlot({
  slot,
  instances,
}: {
  slot: WidgetSlotId;
  instances: WidgetInstance[];
}) {
  const { t } = useTranslation("settings");
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useContainerSize(containerRef);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // Selected one scalar at a time: a selector returning a fresh object would be
  // a new snapshot on every store read and re-render forever.
  const claudeVisibleRows = useSettingsStore((s) => s.usage.claude.visibleRows.length);
  const codexVisibleRows = useSettingsStore((s) => s.usage.codex.visibleRows.length);
  const grokVisibleRows = useSettingsStore((s) => s.usage.grok.visibleRows.length);
  const fontFamily = useSettingsStore((s) => s.widgets.fontFamily);
  const fontSize = useSettingsStore((s) => readWidgetFontSize(s.widgets.fontSize));
  const env: WidgetEnv = useMemo(
    () => ({ claudeVisibleRows, codexVisibleRows, grokVisibleRows, fontSize }),
    [claudeVisibleRows, codexVisibleRows, grokVisibleRows, fontSize],
  );

  // An unknown type has no definition and therefore no width and no component;
  // it stays in settings and simply does not render.
  const renderable = useMemo(
    () =>
      instances.flatMap((instance) => {
        const definition = findWidgetDefinition(instance.type);
        return definition ? [{ instance, definition }] : [];
      }),
    [instances],
  );

  const candidates = useMemo(
    () =>
      renderable.map(({ instance, definition }) => ({
        id: instance.id,
        minWidth: definition.estimateWidth(instance, env),
      })),
    [renderable, env],
  );
  const requestedWidth = candidates.reduce((total, candidate) => total + candidate.minWidth, 0);

  // Height is the discriminator for "measured at all": the slot is `h-full`, so
  // a real measurement always has height even when the row left it no width.
  const measured = size.h > 0;
  const fit = useMemo(
    () =>
      measured
        ? fitWidgets(candidates, size.w, slot.side, OVERFLOW_INDICATOR_WIDTH)
        : { visible: candidates.map((candidate) => candidate.id), collapsed: [] },
    [measured, candidates, size.w, slot.side],
  );

  const collapsedOrder = new Map(fit.collapsed.map((id, index) => [id, index]));
  const hasCollapsed = fit.collapsed.length > 0;

  // Open state is remembered *for a particular collapsed set*, not as a bare
  // flag: when the window widens and the set changes, the panel closes by
  // derivation. A boolean would survive the change and pop open again the next
  // time the row got tight, without the user asking.
  const collapsedSignature = fit.collapsed.join("\0");
  const expanded = hasCollapsed && openedFor === collapsedSignature;

  const overflowButton = hasCollapsed && (
    <button
      type="button"
      data-testid={`widget-overflow-${slot.surface}-${slot.side}`}
      className="hover-bg flex h-5 shrink-0 cursor-pointer items-center justify-center px-1"
      style={{
        color: "var(--text-secondary)",
        background: "transparent",
        border: "none",
        fontSize: "var(--fs-2xs)",
      }}
      title={t("widgets.collapsed", { num: fit.collapsed.length })}
      aria-expanded={expanded}
      onClick={() => setOpenedFor(expanded ? null : collapsedSignature)}
    >
      ⋯
    </button>
  );

  /**
   * Where a collapsed widget goes.
   *
   * Hidden it keeps its place in the tree (so its subscription lives on) but
   * leaves the row. Shown it stacks away from its own surface — downward from
   * the top bar, upward from the status line — one row height per entry.
   */
  const collapsedStyle = (order: number): React.CSSProperties => {
    const offset = `calc(100% + ${order} * var(--bar-h))`;
    return expanded
      ? {
          position: "absolute",
          height: "var(--bar-h)",
          zIndex: 50,
          ...(slot.surface === "statusLine" ? { bottom: offset } : { top: offset }),
          ...(slot.side === "left" ? { left: 0 } : { right: 0 }),
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
        }
      : { display: "none" };
  };

  return (
    <div
      ref={containerRef}
      data-testid={`widget-slot-${slot.surface}-${slot.side}`}
      className={`relative flex h-full min-w-0 items-center ${
        slot.side === "left" ? "justify-start" : "justify-end"
      }`}
      // Only asks for what the placement wants; the drag region absorbs the rest.
      style={{
        flex: `0 1 ${requestedWidth}px`,
        fontFamily: fontFamily || "var(--ui-font)",
        fontSize,
      }}
      // The empty part of a top bar slot stays a window drag handle; widgets
      // that need clicks opt out individually.
      {...(slot.surface === "topBar" ? { "data-tauri-drag-region": "true" } : {})}
    >
      {/* The indicator sits on the side the slot sheds from, so collapsed
          widgets read as continuing off that edge. */}
      {slot.side === "right" && overflowButton}

      {renderable.map(({ instance, definition }) => {
        const order = collapsedOrder.get(instance.id);
        return (
          <div
            key={instance.id}
            className="flex h-full min-w-0 items-center"
            style={order === undefined ? undefined : collapsedStyle(order)}
          >
            <definition.Component
              instance={instance}
              dragRegion={
                slot.surface === "topBar" && !definition.interactive && order === undefined
              }
            />
          </div>
        );
      })}

      {slot.side === "left" && overflowButton}
    </div>
  );
}
