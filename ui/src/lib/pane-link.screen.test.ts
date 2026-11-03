import { afterEach, expect, it, vi } from "vitest";
import type { ILink } from "@xterm/xterm";
import { createScreenTerminal, type ScreenTerminal } from "@/test/screen/xterm-screen";
import { createPaneLinkProvider } from "./pane-link-provider";

const screens: ScreenTerminal[] = [];
afterEach(() => screens.splice(0).forEach((screen) => screen.dispose()));

async function setup(text: string, cols = 80) {
  const s = createScreenTerminal({ cols, rows: 12 });
  screens.push(s);
  await s.write(text);
  let enabled = true;
  let exists = true;
  const navigate = vi.fn();
  const provider = createPaneLinkProvider(s.terminal, {
    enabled: () => enabled,
    resolve: () =>
      exists
        ? { paneId: "pane-1b7d7a95", terminalId: "terminal-pane-1b7d7a95", workspaceId: "ws-1" }
        : null,
    navigate,
  });
  const links = (row: number) => {
    let result: ILink[] = [];
    provider.provideLinks(row, (value) => {
      result = value ?? [];
    });
    return result;
  };
  return {
    s,
    links,
    navigate,
    disable: () => {
      enabled = false;
    },
    remove: () => {
      exists = false;
    },
  };
}

it("한글 표·ANSI 출력 뒤의 ID에 정확한 셀 범위를 준다", async () => {
  const { links } = await setup("│ 한글 \x1b[32mterminal-pane-1b7d7a95\x1b[0m │");
  expect(links(1)[0].range).toEqual({ start: { x: 8, y: 1 }, end: { x: 29, y: 1 } });
});
it("자동 줄바꿈된 ID를 모든 해당 행에서 찾는다", async () => {
  const { links } = await setup("  terminal-pane-1b7d7a95", 16);
  expect(links(1)[0].range).toEqual({ start: { x: 3, y: 1 }, end: { x: 8, y: 2 } });
  expect(links(2)[0].range).toEqual(links(1)[0].range);
});
it("실제 개행으로 잘린 ID는 합치지 않는다", async () => {
  const { links } = await setup("terminal-pane-1b7d\r\n7a95");
  expect(links(1)).toEqual([]);
  expect(links(2)).toEqual([]);
});
it("locator 안 한글 이름도 와이드 셀 전체에 밑줄 범위를 준다", async () => {
  const { links } = await setup("│ lx:pane:한글:1 │");
  expect(links(1)[0].range).toEqual({ start: { x: 3, y: 1 }, end: { x: 16, y: 1 } });
});
it("TUI alternate buffer에서도 pane 링크를 찾는다", async () => {
  const { links } = await setup("\x1b[?1049hpane-1b7d7a95");
  expect(links(1)[0].text).toBe("pane-1b7d7a95");
});
it("OSC 8 영역과 URL 안 ID를 pane 링크로 바꾸지 않는다", async () => {
  const { links } = await setup(
    "\x1b]8;;https://example.com\x07pane-1b7d7a95\x1b]8;;\x07\r\nhttps://example.com/pane-1b7d7a95",
  );
  expect(links(1)).toEqual([]);
  expect(links(2)).toEqual([]);
});
it.each(["disable", "remove", "rewrite"])(
  "링크 생성 뒤 %s이면 과거 클릭을 무시한다",
  async (change) => {
    const state = await setup("terminal-pane-1b7d7a95");
    const link = state.links(1)[0];
    if (change === "disable") state.disable();
    if (change === "remove") state.remove();
    if (change === "rewrite") await state.s.write("\r\x1b[2Kchanged");
    link.activate(new MouseEvent("click"), link.text);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.links(1)).toEqual([]);
  },
);
it("살아 있는 링크의 클릭은 해석한 pane을 탐색한다", async () => {
  const { links, navigate } = await setup("lx:pane:laymux-0:1");
  const link = links(1)[0];
  link.activate(new MouseEvent("click"), link.text);
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ terminalId: "terminal-pane-1b7d7a95" }),
    link.text,
    expect.any(Function),
  );
});
