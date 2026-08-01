import { describe, expect, it } from "vitest";
import {
  MAX_JSON_NODES,
  isJsonTreeError,
  parseJsonTree,
  summarizeJsonNode,
  type JsonNode,
  type JsonTreeResult,
} from "./json-tree";

/** Narrow to the success shape so the assertions below stay readable. */
function parseOk(text: string, options?: Parameters<typeof parseJsonTree>[1]): JsonTreeResult {
  const result = parseJsonTree(text, options);
  if (isJsonTreeError(result)) throw new Error(`expected a tree, got ${result.error}`);
  return result;
}

/** Depth-first list of every id in the tree, in source order. */
function ids(node: JsonNode): string[] {
  return [node.id, ...(node.children ?? []).flatMap(ids)];
}

function childAt(node: JsonNode, index: number): JsonNode {
  const child = node.children?.[index];
  if (!child) throw new Error(`no child at ${index} of ${node.id}`);
  return child;
}

describe("parseJsonTree", () => {
  it("builds a nested tree with dotted and bracketed ids", () => {
    const result = parseOk('{"items":[{"name":"a"},2],"meta":{"count":1}}');

    expect(result.truncated).toBe(false);
    expect(result.nodeCount).toBe(7);
    expect(result.root.kind).toBe("object");
    expect(result.root.id).toBe("$");
    expect(result.root.key).toBeUndefined();
    expect(result.root.childCount).toBe(2);
    expect(ids(result.root)).toEqual([
      "$",
      "$.items",
      "$.items[0]",
      "$.items[0].name",
      "$.items[1]",
      "$.meta",
      "$.meta.count",
    ]);
  });

  it("labels array children with their index and object children with their key", () => {
    const items = childAt(parseOk('{"items":["a","b"]}').root, 0);

    expect(items.kind).toBe("array");
    expect(items.key).toBe("items");
    expect(childAt(items, 1).key).toBe("1");
    expect(childAt(items, 1).value).toBe("b");
  });

  it('separates the null literal from the string "null"', () => {
    const root = parseOk('{"a":null,"b":"null","c":0,"d":false}').root;

    expect(childAt(root, 0).kind).toBe("null");
    expect(childAt(root, 0).value).toBeNull();
    expect(childAt(root, 1).kind).toBe("string");
    expect(childAt(root, 1).value).toBe("null");
    expect(childAt(root, 2).kind).toBe("number");
    expect(childAt(root, 2).value).toBe(0);
    expect(childAt(root, 3).kind).toBe("boolean");
    expect(childAt(root, 3).value).toBe(false);
  });

  it("leaves scalars without children and containers without a value", () => {
    const root = parseOk('{"a":1}').root;

    expect(root.value).toBeUndefined();
    expect(childAt(root, 0).children).toBeUndefined();
    expect(childAt(root, 0).childCount).toBeUndefined();
  });

  it("keeps empty objects and arrays as containers", () => {
    const root = parseOk('{"o":{},"a":[]}').root;

    expect(childAt(root, 0).kind).toBe("object");
    expect(childAt(root, 0).children).toEqual([]);
    expect(childAt(root, 0).childCount).toBe(0);
    expect(childAt(root, 1).kind).toBe("array");
    expect(childAt(root, 1).children).toEqual([]);
    expect(childAt(root, 1).childCount).toBe(0);
  });

  it("accepts a bare scalar document as the root", () => {
    const result = parseOk('"hi"');

    expect(result.root).toEqual({ id: "$", kind: "string", value: "hi" });
    expect(result.nodeCount).toBe(1);
  });

  it("keeps unicode and escapes in keys and values", () => {
    const root = parseOk('{"키 ✅":"첫 줄\\n둘째 \\"인용\\" ✅"}').root;
    const child = childAt(root, 0);

    expect(child.key).toBe("키 ✅");
    expect(child.value).toBe('첫 줄\n둘째 "인용" ✅');
    expect(child.id).toBe('$["키 ✅"]');
  });

  it("brackets keys that are not simple identifiers", () => {
    const root = parseOk('{"$ok":1,"_ok":2,"odd key":3,"a.b":4,"9bad":5,"":6}').root;

    expect(ids(root)).toEqual([
      "$",
      "$.$ok",
      "$._ok",
      '$["odd key"]',
      '$["a.b"]',
      '$["9bad"]',
      '$[""]',
    ]);
  });

  it("keeps object keys in source order", () => {
    const root = parseOk('{"zulu":1,"alpha":2,"mike":3}').root;

    expect(root.children?.map((child) => child.key)).toEqual(["zulu", "alpha", "mike"]);
  });

  it("derives line and column from the position in the parser message", () => {
    const result = parseJsonTree('{\n  "a": 1,\n  "b" 2\n}');

    if (!isJsonTreeError(result)) throw new Error("expected a parse error");
    expect(result.error).toMatch(/JSON/);
    expect(result.line).toBe(3);
    expect(result.column).toBe(7);
  });

  it("reports column 1 for a failure on the very first character", () => {
    const result = parseJsonTree('{"a": 1} trailing garbage that makes the message long enough');

    if (!isJsonTreeError(result)) throw new Error("expected a parse error");
    expect(result.line).toBe(1);
    expect(result.column).toBe(10);
  });

  it("omits line and column when the message carries no position", () => {
    const result = parseJsonTree("nope");

    if (!isJsonTreeError(result)) throw new Error("expected a parse error");
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.line).toBeUndefined();
    expect(result.column).toBeUndefined();
  });

  it("rejects comments and trailing commas unless allowComments is set", () => {
    const text = '{\n  // note\n  "a": 1,\n}';

    expect(isJsonTreeError(parseJsonTree(text))).toBe(true);
    expect(isJsonTreeError(parseJsonTree(text, { allowComments: true }))).toBe(false);
  });

  it("strips line comments, block comments, and trailing commas", () => {
    const result = parseOk(
      [
        "{",
        "  // leading note",
        '  "a": 1, // trailing note',
        "  /* block",
        "     spanning lines */",
        '  "list": [1, 2, ],',
        '  "b": { "c": 3, },',
        "}",
      ].join("\n"),
      { allowComments: true },
    );

    expect(childAt(result.root, 0).value).toBe(1);
    expect(childAt(result.root, 1).childCount).toBe(2);
    expect(childAt(childAt(result.root, 2), 0).value).toBe(3);
  });

  it("does not strip comment syntax that lives inside a string", () => {
    const root = parseOk(
      '{"url":"http://example.com","block":"/* not a comment */","note":"say \\"hi\\" // ok"}',
      { allowComments: true },
    ).root;

    expect(childAt(root, 0).value).toBe("http://example.com");
    expect(childAt(root, 1).value).toBe("/* not a comment */");
    expect(childAt(root, 2).value).toBe('say "hi" // ok');
  });

  it("does not strip a comma that only looks trailing from inside a string", () => {
    const root = parseOk('{"a":"x, ]","b":"y, }"}', { allowComments: true }).root;

    expect(childAt(root, 0).value).toBe("x, ]");
    expect(childAt(root, 1).value).toBe("y, }");
  });

  it("keeps line and column meaningful when comments were stripped", () => {
    const result = parseJsonTree('{\n  // note\n  "a" 1\n}', { allowComments: true });

    if (!isJsonTreeError(result)) throw new Error("expected a parse error");
    expect(result.line).toBe(3);
    expect(result.column).toBe(7);
  });

  it("keeps the lines of a multi-line block comment so later errors stay put", () => {
    const result = parseJsonTree('{\n  /* a\n     b */\n  "a" 1\n}', { allowComments: true });

    if (!isJsonTreeError(result)) throw new Error("expected a parse error");
    expect(result.line).toBe(4);
    expect(result.column).toBe(7);
  });

  it("stops at the node cap but keeps the real child count", () => {
    const result = parseOk('{"list":[1,2,3,4,5]}', { maxNodes: 3 });

    expect(result.truncated).toBe(true);
    expect(result.nodeCount).toBe(3);
    expect(childAt(result.root, 0).childCount).toBe(5);
    expect(childAt(result.root, 0).children).toHaveLength(1);
    expect(result.root.childCount).toBe(1);
  });

  it("does not flag truncation when the document fits the cap exactly", () => {
    const result = parseOk('{"list":[1,2]}', { maxNodes: 4 });

    expect(result.truncated).toBe(false);
    expect(result.nodeCount).toBe(4);
  });

  it("defaults the cap to MAX_JSON_NODES", () => {
    const result = parseOk(JSON.stringify(Array.from({ length: MAX_JSON_NODES + 10 }, () => 0)));

    expect(result.truncated).toBe(true);
    expect(result.nodeCount).toBe(MAX_JSON_NODES);
    expect(result.root.childCount).toBe(MAX_JSON_NODES + 10);
  });
});

describe("isJsonTreeError", () => {
  it("tells the two result shapes apart", () => {
    expect(isJsonTreeError(parseJsonTree("{}"))).toBe(false);
    expect(isJsonTreeError(parseJsonTree("{"))).toBe(true);
  });
});

describe("summarizeJsonNode", () => {
  it("counts container children", () => {
    const root = parseOk('{"o":{"a":1,"b":2,"c":3},"list":[1,2,3,4,5,6,7,8,9,10,11,12]}').root;

    expect(summarizeJsonNode(childAt(root, 0))).toBe("{3}");
    expect(summarizeJsonNode(childAt(root, 1))).toBe("[12]");
  });

  it("reports the real child count for a truncated container", () => {
    const result = parseOk('{"list":[1,2,3,4,5]}', { maxNodes: 2 });

    expect(summarizeJsonNode(childAt(result.root, 0))).toBe("[5]");
  });

  it("quotes strings and prints other scalars bare", () => {
    const root = parseOk('{"s":"abc","n":42,"t":true,"z":null}').root;

    expect(summarizeJsonNode(childAt(root, 0))).toBe('"abc"');
    expect(summarizeJsonNode(childAt(root, 1))).toBe("42");
    expect(summarizeJsonNode(childAt(root, 2))).toBe("true");
    expect(summarizeJsonNode(childAt(root, 3))).toBe("null");
  });

  it("keeps a multi-line string on one line", () => {
    const root = parseOk('{"s":"a\\nb"}').root;

    expect(summarizeJsonNode(childAt(root, 0))).toBe('"a\\nb"');
  });
});
