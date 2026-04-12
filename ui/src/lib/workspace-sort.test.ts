import { describe, it, expect } from "vitest";
import { sortWorkspaces, filterVisibleWorkspaces } from "./workspace-sort";
import type { Workspace } from "@/stores/types";

function ws(id: string): Workspace {
  return { id, name: id, panes: [] };
}

describe("sortWorkspaces", () => {
  const workspaces = [ws("a"), ws("b"), ws("c")];

  describe("manual sort", () => {
    it("returns original order when displayOrder is empty", () => {
      const result = sortWorkspaces(workspaces, "manual", [], []);
      expect(result.map((w) => w.id)).toEqual(["a", "b", "c"]);
    });

    it("sorts by displayOrder", () => {
      const result = sortWorkspaces(workspaces, "manual", ["c", "a", "b"], []);
      expect(result.map((w) => w.id)).toEqual(["c", "a", "b"]);
    });

    it("puts workspaces missing from displayOrder at the end", () => {
      const result = sortWorkspaces(workspaces, "manual", ["b"], []);
      expect(result[0].id).toBe("b");
    });
  });

  describe("notification sort", () => {
    it("sorts by most recent unread notification first", () => {
      const notifications = [
        { workspaceId: "c", createdAt: 100, readAt: null },
        { workspaceId: "a", createdAt: 200, readAt: null },
      ];
      const result = sortWorkspaces(workspaces, "notification", [], notifications);
      expect(result.map((w) => w.id)).toEqual(["a", "c", "b"]);
    });

    it("ignores read notifications", () => {
      const notifications = [
        { workspaceId: "c", createdAt: 300, readAt: 301 },
        { workspaceId: "a", createdAt: 200, readAt: null },
      ];
      const result = sortWorkspaces(workspaces, "notification", [], notifications);
      expect(result.map((w) => w.id)).toEqual(["a", "b", "c"]);
    });

    it("falls back to original array order for equal notification weight", () => {
      const result = sortWorkspaces(workspaces, "notification", [], []);
      expect(result.map((w) => w.id)).toEqual(["a", "b", "c"]);
    });

    it("ignores displayOrder in notification mode", () => {
      const result = sortWorkspaces(workspaces, "notification", ["c", "a", "b"], []);
      expect(result.map((w) => w.id)).toEqual(["a", "b", "c"]);
    });
  });
});

describe("filterVisibleWorkspaces", () => {
  const workspaces = [ws("a"), ws("b"), ws("c")];

  it("returns all workspaces when hiddenIds is empty", () => {
    const result = filterVisibleWorkspaces(workspaces, new Set());
    expect(result).toHaveLength(3);
    expect(result.map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes hidden workspace", () => {
    const result = filterVisibleWorkspaces(workspaces, new Set(["b"]));
    expect(result.map((w) => w.id)).toEqual(["a", "c"]);
  });

  it("excludes multiple hidden workspaces", () => {
    const result = filterVisibleWorkspaces(workspaces, new Set(["a", "c"]));
    expect(result.map((w) => w.id)).toEqual(["b"]);
  });

  it("preserves sort order from input", () => {
    const sorted = [ws("c"), ws("a"), ws("b")];
    const result = filterVisibleWorkspaces(sorted, new Set(["a"]));
    expect(result.map((w) => w.id)).toEqual(["c", "b"]);
  });
});
