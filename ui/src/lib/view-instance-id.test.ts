import { describe, it, expect } from "vitest";
import { getInstanceId, getInstanceIdPrefix, getPaneInstanceId } from "./view-instance-id";

describe("getInstanceId", () => {
  it("TerminalView 는 terminal- prefix 를 쓴다", () => {
    expect(getInstanceId("TerminalView", "pane-1")).toBe("terminal-pane-1");
  });

  it("FileExplorerView 는 file-explorer- prefix 를 쓴다", () => {
    expect(getInstanceId("FileExplorerView", "pane-2")).toBe("file-explorer-pane-2");
  });

  it("ViewRenderer 와 PaneGrid 가 같은 paneId 로 동일한 id 를 만든다 (회귀: issue #293)", () => {
    // ViewRenderer 렌더링 측과 PaneGrid 전파 버튼 측이 같은 헬퍼를 쓰므로
    // 항상 동일한 instanceId 가 나와야 백엔드 terminal_id 와 일치한다.
    const paneId = "abc123";
    const fromRenderer = getInstanceId("TerminalView", paneId);
    const fromPaneGrid = getInstanceId("TerminalView", paneId);
    expect(fromRenderer).toBe(fromPaneGrid);
    expect(fromRenderer).toBe("terminal-abc123");
  });

  it("cwd 비대상 view 타입은 throw 한다 (암묵적 fallback prefix 없음)", () => {
    expect(() => getInstanceId("MemoView", "pane-3")).toThrow();
    expect(() => getInstanceId("EmptyView", "pane-4")).toThrow();
    expect(() => getInstanceId("SettingsView", "pane-5")).toThrow();
  });
});

describe("getInstanceIdPrefix", () => {
  it("cwd-bearing 타입은 prefix 를, 그 외는 undefined 를 반환한다", () => {
    expect(getInstanceIdPrefix("TerminalView")).toBe("terminal");
    expect(getInstanceIdPrefix("FileExplorerView")).toBe("file-explorer");
    expect(getInstanceIdPrefix("MemoView")).toBeUndefined();
    expect(getInstanceIdPrefix("EmptyView")).toBeUndefined();
  });
});

describe("getPaneInstanceId", () => {
  it("instanceId 대상 view 는 getInstanceId 와 동일한 id 를 만든다", () => {
    const pane = { id: "abc123", view: { type: "TerminalView" as const } };
    expect(getPaneInstanceId(pane)).toBe("terminal-abc123");
    expect(getPaneInstanceId(pane)).toBe(getInstanceId("TerminalView", "abc123"));
  });

  it("instanceId 개념이 없는 view 는 throw 가 아니라 null 을 반환한다", () => {
    expect(getPaneInstanceId({ id: "p1", view: { type: "MemoView" } })).toBeNull();
    expect(getPaneInstanceId({ id: "p2", view: { type: "EmptyView" } })).toBeNull();
  });
});
