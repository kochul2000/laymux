import { afterEach, describe, expect, it } from "vitest";
import { createScreenTerminal, type ScreenTerminal } from "@/test/screen/xterm-screen";
import { joinTuiWrappedSelection } from "./tui-wrap-join";
import { CAPTURE_COLS, CLAUDE, CODEX, type CaptureRow } from "./__fixtures__/tui-wrap-capture";

/**
 * 화면 폭 줄바꿈 판정을 **실제 xterm 셀**로 확인한다(ADR-0074).
 *
 * 단위 테스트는 근사 폭 표(`@/test/cell-lines`)로 행이 찼는지를 계산한다. 판정이
 * 셀 하나 차이로 갈리므로 `●`·`⚠`·`⏵`·한글이 실제 Unicode provider(ADR-0058)에서
 * 몇 칸인지가 결과를 바꾼다. 그래서 dev 실측 행을 진짜 터미널에 다시 흘리고 그
 * 버퍼로 판정한다. 렌더러 없는 터미널에는 선택 서비스가 없으므로 선택 문자열은
 * xterm `selectionText` 와 같은 규칙(행마다 trimRight, isWrapped 는 개행 없이)으로
 * 버퍼에서 만든다.
 */

const terminals: ScreenTerminal[] = [];

afterEach(() => {
  while (terminals.length > 0) terminals.pop()?.dispose();
});

async function copyFromScreen(rows: CaptureRow[], style: "word" | "anywhere" = "word") {
  const s = createScreenTerminal({ cols: CAPTURE_COLS, rows: 12, scrollback: 50 });
  terminals.push(s);
  // soft-wrap 행은 앞 행에 이어 써서 xterm 이 직접 auto-wrap 하게 한다.
  let data = "";
  rows.forEach((row, i) => {
    if (i > 0 && !row.wrapped) data += "\r\n";
    data += row.text;
  });
  await s.write(data);
  const buffer = s.terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y++) {
    const line = buffer.getLine(y)!;
    expect(line.isWrapped).toBe(rows[y].wrapped ?? false);
    const text = line.translateToString(true);
    if (y > 0 && line.isWrapped) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const source = {
    cols: s.terminal.cols,
    getSelectionPosition: () => ({ start: { y: 0 }, end: { y: rows.length - 1 } }),
    buffer: { active: { getLine: (y: number) => buffer.getLine(y) } },
  };
  return joinTuiWrappedSelection(source, lines.join("\n"), style);
}

describe("joinTuiWrappedSelection — 실제 xterm 셀", () => {
  it("Claude 한글 문단(● 마커)을 한 줄로 잇는다", async () => {
    expect(await copyFromScreen(CLAUDE.koreanParagraph)).toBe(
      "● 이 변경은 터미널 복사 경로에서 줄바꿈을 제거하는데, 실제로는 Claude Code 가 자체 " +
        "레이아웃으로 줄을 나누기 때문에 xterm 은 이를 소프트 랩으로 보지 못하고 개행으로 " +
        "복사하게 되며, 그 결과 사용자가 붙여넣은 문단이 화면 폭마다 끊겨 버린다.",
    );
  });

  it("Claude 목록 안 URL 을 복원하고 항목 경계는 유지한다", async () => {
    expect(await copyFromScreen(CLAUDE.list)).toBe(
      "  - 목록 항목 문서는 https://github.com/kochul2000/laymux/blob/main/docs/architecture/" +
        "data-flow.md#terminal-view-osc-pipeline-and-renderer-reflow-details 를 참고하세요.\n" +
        "  - PR 링크는 https://github.com/kochul2000/laymux/pull/1146 이고 뒤에 이어지는 설명 " +
        "문장이 충분히 길어서 다음 줄로 넘어가야 한다.",
    );
  });

  it("Claude 상태 줄·입력 박스는 그대로 둔다", async () => {
    const copied = await copyFromScreen(CLAUDE.chrome);
    expect(copied.split("\n")).toHaveLength(CLAUDE.chrome.length);
  });

  it("Codex 글자 단위 한글 줄바꿈을 공백 없이 잇는다", async () => {
    expect(await copyFromScreen(CODEX.koreanParagraph, "anywhere")).toContain(
      "자체 레이아웃으로 줄을",
    );
  });

  it("Codex soft-wrap URL 은 xterm 결합 그대로, 다음 짧은 행은 분리한다", async () => {
    expect(await copyFromScreen(CODEX.urlSoftWrapped, "anywhere")).toBe(
      "  자세한 내용은 https://example.com/very/long/path/segment/that/should/wrap/across/the/terminal/width/" +
        "because/it/is/really/long?query=value&another=thing에서\n  확인하세요.",
    );
  });
});
