import { useCallback, useEffect, useRef, useState } from "react";
import { clipboardWriteText } from "@/lib/tauri-api";
import { formatPaneIdentifier } from "@/lib/pane-numbers";

/**
 * Small badge showing a pane's spatial reading-order number (issue #256).
 *
 * Rendered as the leading element of a control bar's left section so humans can
 * glance at a pane and tell an AI "send to pane N". The number is the spatial
 * `paneNumber` (see `lib/pane-numbers.ts`), NOT the array `paneIndex`.
 *
 * Clicking the badge copies a self-describing identifier of the pane to the
 * clipboard (issue #276) so it can be pasted into an LLM prompt. The copied
 * string is `formatPaneIdentifier({ workspaceName, paneNumber })`, e.g.
 * `lx:pane:Backend:3`, which MCP accepts directly as `terminal_id` or `pane_ref`.
 *
 * Renders nothing when `number` is undefined (e.g. dock panes, previews). When
 * `workspaceId` is omitted it falls back to a non-interactive label (no copy).
 */
const COPIED_FEEDBACK_MS = 1200;

export function PaneNumberBadge({
  number,
  workspaceId,
  workspaceName,
}: {
  number?: number;
  workspaceId?: string;
  workspaceName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    // `formatPaneIdentifier` throws on un-normalized (whitespace) names. There's no
    // migration, so a legacy workspace name can still contain whitespace until its next
    // rename — bail here rather than let the throw escape `void handleCopy()` as an
    // unhandled rejection (the same reason the clipboard reject below is swallowed).
    if (number == null || !workspaceId || !workspaceName || /\s/.test(workspaceName)) return;
    const text = formatPaneIdentifier({ paneNumber: number, workspaceName });
    try {
      await clipboardWriteText(text);
    } catch {
      // Clipboard can reject (permission denied, Tauri bridge error). There's no useful
      // recovery for a badge click, so fail silently — but we must swallow it here so the
      // caller's `void handleCopy()` doesn't surface an unhandled promise rejection.
      return;
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }, [number, workspaceId, workspaceName]);

  // Clear any pending feedback-reset timer on unmount so it can't fire after the badge
  // is gone (e.g. pane closed / layout changed within COPIED_FEEDBACK_MS of a copy).
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  if (number == null) return null;

  const baseStyle: React.CSSProperties = {
    minWidth: "16px",
    height: "16px",
    padding: "0 4px",
    fontSize: "var(--fs-xs)",
    lineHeight: 1,
    color: copied ? "var(--green)" : "var(--accent)",
    background: "var(--accent-20)",
    borderRadius: "var(--radius-sm)",
    border: "none",
  };

  const content = copied ? (
    <span data-testid="pane-number-badge-copied" aria-hidden>
      ✓
    </span>
  ) : (
    number
  );

  // Non-interactive fallback when there is no addressable workspace (dock previews etc.).
  if (!workspaceId) {
    return (
      <span
        data-testid="pane-number-badge"
        className="mr-1.5 flex shrink-0 items-center justify-center font-medium tabular-nums"
        style={baseStyle}
        title={`Pane ${number}`}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="pane-number-badge"
      className="hover-bg-accent mr-1.5 flex shrink-0 cursor-pointer items-center justify-center font-medium tabular-nums"
      style={baseStyle}
      // Explicit name: during the copied feedback the child becomes an aria-hidden ✓, which
      // would otherwise leave the button with no accessible name for COPIED_FEEDBACK_MS.
      aria-label={`Copy pane ${number} identifier`}
      title={copied ? "Pane identifier copied" : `Click to copy pane ${number} identifier`}
      onClick={(e) => {
        // Badge lives inside focusable/clickable bars; don't bubble into pane focus/select.
        e.stopPropagation();
        void handleCopy();
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {content}
    </button>
  );
}
