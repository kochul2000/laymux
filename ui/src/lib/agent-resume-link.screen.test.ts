import { afterEach, expect, it, vi } from "vitest";
import type { ILink } from "@xterm/xterm";
import { createScreenTerminal, type ScreenTerminal } from "@/test/screen/xterm-screen";
import { createAgentResumeLinkProvider } from "./agent-resume-link";

const id = "ed8cbb69-9497-4b6c-89ed-b42a48f1197d";
const screens: ScreenTerminal[] = [];
afterEach(() => screens.splice(0).forEach((s) => s.dispose()));

async function setup(text: string, cols = 80) {
  const s = createScreenTerminal({ cols, rows: 20 });
  screens.push(s);
  await s.write(text);
  const activate = vi.fn();
  const provider = createAgentResumeLinkProvider(s.terminal, activate);
  const links = (row: number) => {
    let result: ILink[] = [];
    provider.provideLinks(row, (value) => {
      result = value ?? [];
    });
    return result;
  };
  return { s, activate, links };
}

it.each(["codex resume", "claude --resume", "grok --resume"])(
  "ANSI를 포함한 %s 안내가 링크가 된다",
  async (command) => {
    const { links, activate } = await setup(
      `Resume this session with:\r\n\x1b[32m  ${command} ${id}\x1b[0m\r\n`,
    );
    const link = links(2)[0];
    expect(link.text).toBe(`${command} ${id}`);
    expect(link.range.start).toEqual({ x: 3, y: 2 });
    link.activate(new MouseEvent("click"), link.text);
    expect(activate).toHaveBeenCalledWith(
      { provider: command.split(" ")[0], sessionId: id },
      expect.any(Function),
    );
  },
);

it("비동기 작업 뒤에도 클릭 당시 셀의 유효성을 확인할 수 있다", async () => {
  const { s, links, activate } = await setup(`codex resume ${id}`);
  links(1)[0].activate(new MouseEvent("click"), "");
  const isCurrent = activate.mock.calls[0][1];
  expect(isCurrent()).toBe(true);
  await s.write("\r\x1b[2Kchanged");
  expect(isCurrent()).toBe(false);
});

it("좁은 pane에서 ID가 자동 줄바꿈되면 모든 물리 줄에서 같은 링크를 찾는다", async () => {
  const { links } = await setup(`  claude --resume ${id}`, 24);
  for (const row of [1, 2, 3]) {
    expect(links(row)).toHaveLength(1);
    expect(links(row)[0].range).toEqual({ start: { x: 3, y: 1 }, end: { x: 6, y: 3 } });
  }
});

it("개행으로 잘린 ID를 다른 줄과 붙여 실행하지 않는다", async () => {
  const { links } = await setup(`codex resume ${id.slice(0, 20)}\r\n${id.slice(20)}`);
  expect(links(1)).toEqual([]);
  expect(links(2)).toEqual([]);
});

it("화면에 추가 옵션이나 셸 구문이 있으면 복원 링크를 만들지 않는다", async () => {
  const { links } = await setup(
    `codex resume ${id}; whoami\r\nclaude --resume ${id} --dangerously-skip-permissions`,
  );
  expect(links(1)).toEqual([]);
  expect(links(2)).toEqual([]);
});

it("alternate buffer의 복원 문구는 셸 실행 링크가 아니다", async () => {
  const { links } = await setup(`\x1b[?1049hcodex resume ${id}`);
  expect(links(1)).toEqual([]);
});

it("링크 생성 뒤 화면이 바뀌면 과거 ID를 실행하지 않는다", async () => {
  const { s, links, activate } = await setup(`codex resume ${id}`);
  const link = links(1)[0];
  await s.write("\r\x1b[2Kwhoami");
  link.activate(new MouseEvent("click"), link.text);
  expect(activate).not.toHaveBeenCalled();
});

it("리사이즈로 reflow되면 옛 좌표의 링크를 폐기하고 새 좌표를 계산한다", async () => {
  const { s, links, activate } = await setup(`claude --resume ${id}\r\n`, 80);
  const old = links(1)[0];
  s.terminal.resize(24, 20);
  old.activate(new MouseEvent("click"), old.text);
  expect(activate).not.toHaveBeenCalled();
  expect(links(2)[0].range.end.y).toBe(3);
});
