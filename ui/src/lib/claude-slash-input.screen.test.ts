import { expect, it } from "vitest";
import { createScreenTerminal } from "@/test/screen/xterm-screen";
import { completeClaudeSlashInput } from "./claude-slash-input";

const composer = (text: string) =>
  `────────────────────────\r\n>\u00a0${text}\r\n────────────────────────\r\n  auto mode on`;

it.each([
  ["/mo\t", "/model  [model]", "/model\t"],
  ["/cl\t", "/clear", "/clear\t"],
  ["/wat all", "/watch-review all", "/watch-review all"],
  ["/mo sonnet", "/model sonnet", "/model sonnet"],
])("실제 셀에서 %s의 완성된 명령 이름만 보정한다", async (input, visible, expected) => {
  const s = createScreenTerminal({ cols: 96, rows: 12 });
  try {
    await s.write(composer(visible));
    expect(completeClaudeSlashInput(input, s.terminal)).toBe(expected);
  } finally {
    s.dispose();
  }
});

it("빠른 Enter 뒤의 모델 선택창은 현재 제출 echo만 읽는다", async () => {
  const s = createScreenTerminal({ cols: 120, rows: 12 });
  try {
    await s.write(
      "> /model\r\n────────────────────────\r\n  Select model\r\n  > 2. Opus\r\n  Enter to set as default · s to use this session only · Esc to cancel",
    );
    expect(completeClaudeSlashInput("/mo ", s.terminal)).toBe("/model ");
    expect(completeClaudeSlashInput("/cl ", s.terminal)).toBe("/cl ");
  } finally {
    s.dispose();
  }
});

it("과거 명령·일반 본문·접두사 불일치·alternate는 보정하지 않는다", async () => {
  const s = createScreenTerminal({ cols: 96, rows: 12 });
  try {
    for (const frame of [
      composer(""),
      composer("/models"),
      composer("ordinary /model"),
      "assistant says > /model",
    ]) {
      await s.write("\x1b[H\x1b[2J> /model\r\n" + frame);
      expect(completeClaudeSlashInput("/cl ", s.terminal)).toBe("/cl ");
    }
    await s.write("\x1b[?1049h" + composer("/model"));
    expect(completeClaudeSlashInput("/mo ", s.terminal)).toBe("/mo ");
  } finally {
    s.dispose();
  }
});
