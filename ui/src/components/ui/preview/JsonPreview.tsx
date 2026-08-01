import { useCallback, useMemo, useState } from "react";
import {
  isJsonTreeError,
  parseJsonTree,
  summarizeJsonNode,
  type JsonNode,
} from "@/lib/preview/json-tree";
import { PreviewNotice } from "./PreviewNotice";

/** Depth expanded on open — enough to see a config file's shape at a glance. */
const DEFAULT_EXPAND_DEPTH = 2;

const KIND_COLOR: Record<string, string> = {
  string: "var(--green)",
  number: "var(--claude)",
  boolean: "var(--yellow)",
  null: "var(--text-muted)",
};

/**
 * Collapsible JSON tree. Renders parser output as React nodes only — no HTML
 * string is built anywhere on this path (ADR-0109).
 *
 * A parse failure is not a viewer failure: the caller keeps the Source toggle,
 * so this reports where the JSON broke and lets the reader switch to the raw
 * text rather than showing nothing.
 */
export function JsonPreview({
  content,
  allowComments,
  sourceTruncated,
  bodyStyle,
  embedded,
}: {
  content: string;
  /** `.jsonc` tolerates comments and trailing commas. */
  allowComments?: boolean;
  /**
   * The backend cut the file at its read limit. A truncated JSON document
   * always fails to parse, so the error has to say so — otherwise the viewer
   * accuses a perfectly valid file of a syntax error it does not have.
   */
  sourceTruncated?: boolean;
  bodyStyle?: React.CSSProperties;
  /**
   * Render inside another scroll container (the JSONL row expander) instead of
   * owning the pane. A nested `h-full` flex column collapses to zero height.
   */
  embedded?: boolean;
}) {
  const parsed = useMemo(() => parseJsonTree(content, { allowComments }), [content, allowComments]);
  const failed = isJsonTreeError(parsed);

  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setToggled((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const shellClass = embedded ? "flex flex-col" : "flex h-full min-h-0 flex-1 flex-col";

  if (failed) {
    const at =
      parsed.line !== undefined
        ? ` at line ${parsed.line}${parsed.column !== undefined ? `, column ${parsed.column}` : ""}`
        : "";
    const message = sourceTruncated
      ? `Could not parse the part of this file that was loaded${at}: ${parsed.error}. The file was cut at the viewer's read limit, so this is most likely not a real syntax error.`
      : `Invalid JSON${at}: ${parsed.error}. Switch to Source to read the file as text.`;
    return (
      <div className={shellClass}>
        <PreviewNotice tone="error" testId="json-preview-error">
          {message}
        </PreviewNotice>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      {parsed.truncated && (
        <PreviewNotice testId="json-preview-truncated">
          {`Tree capped at ${parsed.nodeCount.toLocaleString()} nodes. Deeper values are not shown.`}
        </PreviewNotice>
      )}
      <div
        className={embedded ? "" : "empty-view-scroll min-h-0 flex-1 overflow-auto"}
        style={{ ...bodyStyle }}
        data-testid="json-preview"
      >
        <JsonNodeRow node={parsed.root} depth={0} toggled={toggled} onToggle={toggle} />
      </div>
    </div>
  );
}

function JsonNodeRow({
  node,
  depth,
  toggled,
  onToggle,
}: {
  node: JsonNode;
  depth: number;
  /** Ids whose open state is the opposite of their depth default. */
  toggled: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const isContainer = node.kind === "object" || node.kind === "array";
  // The set records *overrides*, not open state. Storing open state directly
  // would mean seeding it for every node up front, and a depth rule alone would
  // make a node below the default depth impossible to expand.
  const openByDefault = depth < DEFAULT_EXPAND_DEPTH;
  const isOpen = isContainer && (toggled.has(node.id) ? !openByDefault : openByDefault);
  const children = node.children ?? [];

  return (
    <div>
      <div
        className={isContainer ? "hover-bg flex items-start" : "flex items-start"}
        style={{ paddingLeft: `${depth * 14 + 8}px`, cursor: isContainer ? "pointer" : "default" }}
        onClick={isContainer ? () => onToggle(node.id) : undefined}
        data-testid={isContainer ? "json-preview-container" : "json-preview-scalar"}
      >
        <span
          style={{ color: "var(--text-muted)", width: 12, flex: "0 0 auto", userSelect: "none" }}
        >
          {isContainer && children.length > 0 ? (isOpen ? "▾" : "▸") : ""}
        </span>
        {node.key !== undefined && (
          <span style={{ color: "var(--accent)" }}>{`${node.key}: `}</span>
        )}
        {isContainer ? (
          <span style={{ color: "var(--text-secondary)" }}>{summarizeJsonNode(node)}</span>
        ) : (
          <span style={{ color: KIND_COLOR[node.kind] ?? "var(--text-primary)" }}>
            {summarizeJsonNode(node)}
          </span>
        )}
      </div>
      {isOpen &&
        children.map((child) => (
          <JsonNodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            toggled={toggled}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}
