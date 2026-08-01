/**
 * JSON → node tree for the structured file-viewer preview (ADR-0109).
 *
 * Pure data in, pure data out: no DOM, no React, no HTML strings. The renderer
 * only walks the returned nodes, which is what lets the structured family skip
 * the sanitizer/CSP machinery the document family needs.
 */

export type JsonNodeKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonNode {
  /** Stable identity for expand/collapse state, e.g. "$.items[3].name". */
  id: string;
  kind: JsonNodeKind;
  /** Property name under an object parent, array index under an array parent; absent at the root. */
  key?: string;
  /** Scalar payload; absent for containers. */
  value?: string | number | boolean | null;
  /** Children in source order; absent for scalars. */
  children?: JsonNode[];
  /** Direct child count, preserved even when the node cap drops some children. */
  childCount?: number;
}

export interface JsonTreeResult {
  root: JsonNode;
  truncated: boolean;
  nodeCount: number;
}

export interface JsonTreeError {
  error: string;
  line?: number;
  column?: number;
}

export const MAX_JSON_NODES = 20_000;

/** Keys matching this go into an id as `.key`; anything else gets bracketed. */
const SIMPLE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** V8 embeds a byte offset as `... at position 42`; the `(line n column n)` tail is not always there. */
const POSITION_IN_MESSAGE = /position (\d+)/;

interface BuildState {
  nodeCount: number;
  truncated: boolean;
}

export function parseJsonTree(
  text: string,
  options?: { maxNodes?: number; allowComments?: boolean },
): JsonTreeResult | JsonTreeError {
  // A cap below 1 would leave no root to return, so the root is always allowed.
  const maxNodes = Math.max(1, options?.maxNodes ?? MAX_JSON_NODES);
  const source = options?.allowComments ? relaxJsonSyntax(text) : text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    return toTreeError(cause, text);
  }

  const state: BuildState = { nodeCount: 0, truncated: false };
  const root = buildNode("$", undefined, parsed, state, maxNodes);
  return { root, truncated: state.truncated, nodeCount: state.nodeCount };
}

export function isJsonTreeError(result: JsonTreeResult | JsonTreeError): result is JsonTreeError {
  return "error" in result;
}

/** Collapsed one-line label for a node, e.g. `{3}`, `[12]`, `"abc"`, `42`. */
export function summarizeJsonNode(node: JsonNode): string {
  switch (node.kind) {
    case "object":
      return `{${directChildCount(node)}}`;
    case "array":
      return `[${directChildCount(node)}]`;
    case "null":
      return "null";
    case "string":
      // JSON.stringify escapes newlines and quotes, so the label stays on one
      // line no matter what the string holds.
      return JSON.stringify(node.value ?? "");
    default:
      return String(node.value);
  }
}

function directChildCount(node: JsonNode): number {
  // Prefer childCount: it survives the node cap, children.length does not.
  return node.childCount ?? node.children?.length ?? 0;
}

function buildNode(
  id: string,
  key: string | undefined,
  value: unknown,
  state: BuildState,
  maxNodes: number,
): JsonNode {
  state.nodeCount += 1;

  if (Array.isArray(value)) {
    const children: JsonNode[] = [];
    const node: JsonNode = { id, kind: "array", children, childCount: value.length };
    if (key !== undefined) node.key = key;
    for (let index = 0; index < value.length; index++) {
      if (state.nodeCount >= maxNodes) {
        state.truncated = true;
        break;
      }
      children.push(buildNode(`${id}[${index}]`, String(index), value[index], state, maxNodes));
    }
    return node;
  }

  if (value !== null && typeof value === "object") {
    // Object.keys is source order for ordinary keys. Numeric-looking keys
    // ("2", "10") are integer indices to the engine and get hoisted ahead of
    // the rest in ascending order — the viewer accepts that reordering rather
    // than re-parsing the text just to recover the literal key order.
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const children: JsonNode[] = [];
    const node: JsonNode = { id, kind: "object", children, childCount: keys.length };
    if (key !== undefined) node.key = key;
    for (const childKey of keys) {
      if (state.nodeCount >= maxNodes) {
        state.truncated = true;
        break;
      }
      children.push(buildNode(childId(id, childKey), childKey, record[childKey], state, maxNodes));
    }
    return node;
  }

  // JSON.parse only ever yields string/number/boolean/null down here.
  const scalar = value as string | number | boolean | null;
  const node: JsonNode = { id, kind: scalarKind(scalar), value: scalar };
  if (key !== undefined) node.key = key;
  return node;
}

function scalarKind(value: string | number | boolean | null): JsonNodeKind {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function childId(parentId: string, key: string): string {
  // JSON-quote the bracketed form so a key containing `"` or `]` still yields a
  // unique, unambiguous id — ids are the expand/collapse identity, a collision
  // would make two nodes share one toggle.
  return SIMPLE_KEY.test(key) ? `${parentId}.${key}` : `${parentId}[${JSON.stringify(key)}]`;
}

function toTreeError(cause: unknown, text: string): JsonTreeError {
  const error = cause instanceof Error ? cause.message : String(cause);
  const match = POSITION_IN_MESSAGE.exec(error);
  // The message format is engine-specific and V8 drops the position entirely
  // for short inputs ("Unexpected token 'o', \"nope\" is not valid JSON"), so
  // line/column are computed from the offset here instead of being read out of
  // the message text. No offset means no location — better than a wrong one.
  if (!match) return { error };

  const offset = Math.min(Number(match[1]), text.length);
  return { error, ...lineColumnAt(text, offset) };
}

function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Make `.jsonc` input digestible by JSON.parse: comments and trailing commas
 * are overwritten with spaces rather than deleted.
 *
 * Blanking keeps every remaining character at its original offset, so the byte
 * position V8 reports for a syntax error still points at the right spot in the
 * text the user is looking at. Deleting would shift every later offset and the
 * reported line/column would drift.
 */
function relaxJsonSyntax(text: string): string {
  return blankTrailingCommas(blankComments(text));
}

function blankComments(text: string): string {
  const out = text.split("");
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === '"') {
      index = skipString(text, index);
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        out[index] = " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      out[index] = " ";
      out[index + 1] = " ";
      index += 2;
      while (index < text.length) {
        if (text[index] === "*" && text[index + 1] === "/") {
          out[index] = " ";
          out[index + 1] = " ";
          index += 2;
          break;
        }
        // Newlines inside a block comment survive: they carry the line numbers.
        if (text[index] !== "\n") out[index] = " ";
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return out.join("");
}

function blankTrailingCommas(text: string): string {
  const out = text.split("");
  let index = 0;

  while (index < text.length) {
    if (text[index] === '"') {
      index = skipString(text, index);
      continue;
    }

    if (text[index] === ",") {
      // Comments are already spaces at this point, so plain whitespace skipping
      // is enough to see the `}`/`]` behind `, // note`.
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] === "}" || text[next] === "]") out[index] = " ";
    }

    index += 1;
  }

  return out.join("");
}

/** Index just past the string literal that opens at `start`, honoring `\"` escapes. */
function skipString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index += 1;
  }
  return index;
}
