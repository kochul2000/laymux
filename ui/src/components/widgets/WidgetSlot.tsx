/**
 * Renders one slot's widgets, shedding from the edge-farthest end when the
 * width it was given runs out (ADR-0105).
 *
 * The slot never asks for more room than it was handed: on the top bar the
 * drag region keeps its minimum first, and whatever is left is what arrives
 * here as `size.w`. That is why there is no separate "drag region wins" rule.
 */

import { useMemo, useRef, useState } from "react";
import { useContainerSize } from "@/hooks/useContainerSize";
import { useSettingsStore } from "@/stores/settings-store";
import { fitWidgets, type WidgetInstance, type WidgetSlotId } from "@/lib/widget-placement";
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
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useContainerSize(containerRef);
  const [expanded, setExpanded] = useState(false);
  // Selected one scalar at a time: a selector returning a fresh object would be
  // a new snapshot on every store read and re-render forever.
  const claudeVisibleRows = useSettingsStore((s) => s.usage.claude.visibleRows.length);
  const codexVisibleRows = useSettingsStore((s) => s.usage.codex.visibleRows.length);
  const env: WidgetEnv = useMemo(
    () => ({ claudeVisibleRows, codexVisibleRows }),
    [claudeVisibleRows, codexVisibleRows],
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

  const fit = useMemo(
    () =>
      // Width 0 means "not measured yet", not "no room": collapsing on it would
      // hide every widget for a frame and then pop them back in.
      size.w === 0
        ? { visible: renderable.map(({ instance }) => instance.id), collapsed: [] }
        : fitWidgets(
            renderable.map(({ instance, definition }) => ({
              id: instance.id,
              minWidth: definition.estimateWidth(instance, env),
            })),
            size.w,
            slot.side,
            OVERFLOW_INDICATOR_WIDTH,
          ),
    [renderable, env, size.w, slot.side],
  );

  const collapsed = new Set(fit.collapsed);
  const hasCollapsed = fit.collapsed.length > 0;

  return (
    <div
      ref={containerRef}
      data-testid={`widget-slot-${slot.surface}-${slot.side}`}
      className="relative flex min-w-0 shrink items-center overflow-hidden"
      style={{ height: "100%" }}
    >
      {renderable
        .filter(({ instance }) => !collapsed.has(instance.id))
        .map(({ instance, definition }) => (
          <div
            key={instance.id}
            className="flex h-full items-center"
            // Only a non-interactive widget may double as a window drag handle;
            // on an interactive one this would swallow the click.
            {...(definition.interactive ? {} : { "data-tauri-drag-region": "true" })}
          >
            <definition.Component instance={instance} />
          </div>
        ))}

      {hasCollapsed && (
        <>
          <button
            type="button"
            data-testid={`widget-overflow-${slot.surface}-${slot.side}`}
            className="hover-bg flex h-5 cursor-pointer items-center justify-center px-1"
            style={{
              color: "var(--text-secondary)",
              background: "transparent",
              border: "none",
              fontSize: "var(--fs-2xs)",
            }}
            title={`${fit.collapsed.length} widgets hidden — not enough width`}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            ⋯
          </button>
          {expanded && (
            <div
              data-testid={`widget-overflow-popover-${slot.surface}-${slot.side}`}
              className="absolute z-50 flex flex-col gap-1 rounded p-1"
              style={{
                top: "100%",
                ...(slot.side === "left" ? { left: 0 } : { right: 0 }),
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {renderable
                .filter(({ instance }) => collapsed.has(instance.id))
                .map(({ instance, definition }) => (
                  <definition.Component key={instance.id} instance={instance} />
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
