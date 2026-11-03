import { describe, expect, it } from "vitest";
import { findPaneTokens, resolvePaneLink, type PaneLinkWorkspace } from "./pane-link";

const workspaces: PaneLinkWorkspace[] = [
  {
    id: "ws-1",
    name: "laymux-0",
    panes: [
      { id: "pane-1b7d7a95", terminalId: "terminal-pane-1b7d7a95", paneNumber: 1 },
      { id: "pane-43b1b5af", terminalId: "terminal-pane-43b1b5af", paneNumber: 2 },
    ],
  },
];

describe("pane 링크", () => {
  it("실제 이름 목록으로 인접 locator를 각각 인식하고 정규식 문자를 이스케이프한다", () => {
    const refs = ["lx:pane:API(v2):1", "lx:pane:API,v2:2", "lx:pane:API[v2]:3"];
    expect(
      findPaneTokens(refs.join(","), ["API(v2)", "API,v2", "API[v2]"]).map((token) => token.text),
    ).toEqual(refs);
    expect(findPaneTokens("lx:pane:APIv2:1", ["API(v2)"])).toEqual([]);
  });
  it.each(["API(v2)", "API[v2]", "API,v2", "API;v2", "API|v2", "API`v2"])(
    "복사 가능한 workspace 이름 %s를 탐지한다",
    (name) => {
      const reference = `lx:pane:${name}:1`;
      expect(findPaneTokens(`(${reference})`)).toEqual([
        { text: reference, start: 1, end: reference.length + 1 },
      ]);
    },
  );
  it("표·백틱·괄호 안 세 형식을 토큰 전체로 추출한다", () => {
    const text = "│ 리뷰어 `terminal-pane-1b7d7a95` │ (pane-43b1b5af), lx:pane:laymux-0:1. │";
    expect(findPaneTokens(text).map((t) => text.slice(t.start, t.end))).toEqual([
      "terminal-pane-1b7d7a95",
      "pane-43b1b5af",
      "lx:pane:laymux-0:1",
    ]);
  });
  it.each([
    "1b7d7a95",
    "1",
    "terminal-pane-1b7d7a950",
    "xterminal-pane-1b7d7a95",
    "https://host/path/terminal-pane-1b7d7a95",
    "https://host/?id=pane-1b7d7a95",
    "/tmp/pane-1b7d7a95",
    "C:\\tmp\\pane-1b7d7a95",
    "pane-1b7d7a95.txt",
    "lx:pane:laymux-0:0",
    "lx:pane:laymux-0:1extra",
    "prefix-lx:pane:laymux-0:1",
  ])("다른 토큰이나 URL·경로의 일부는 제외한다: %s", (text) => {
    expect(findPaneTokens(text)).toEqual([]);
  });
  it.each(["terminal-pane-1b7d7a95", "pane-1b7d7a95", "lx:pane:laymux-0:1"])(
    "%s를 같은 실제 터미널로 해석한다",
    (text) => {
      expect(resolvePaneLink(text, workspaces)?.terminalId).toBe("terminal-pane-1b7d7a95");
    },
  );
  it("이름의 콜론·한글을 유지하고 번호는 최신 snapshot에서 해석한다", () => {
    const current = [
      {
        ...workspaces[0],
        name: "한글:API:v2",
        panes: [...workspaces[0].panes].reverse().map((p, i) => ({ ...p, paneNumber: i + 1 })),
      },
    ];
    expect(resolvePaneLink("lx:pane:한글:API:v2:1", current)?.terminalId).toBe(
      "terminal-pane-43b1b5af",
    );
  });
  it("없는 대상·동명이름·터미널 아닌 pane은 해석하지 않는다", () => {
    expect(resolvePaneLink("pane-ffffffff", workspaces)).toBeNull();
    expect(
      resolvePaneLink("lx:pane:laymux-0:1", [...workspaces, { ...workspaces[0], id: "ws-2" }]),
    ).toBeNull();
    expect(
      resolvePaneLink("pane-1b7d7a95", [
        { ...workspaces[0], panes: [{ ...workspaces[0].panes[0], terminalId: null }] },
      ]),
    ).toBeNull();
  });
});
