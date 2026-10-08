import { describe, it, expect } from "vitest";
import { detectTuiWrap, joinTuiWrappedLines, type WrapStyle } from "./tui-wrap-join";
import { CAPTURE_COLS, CLAUDE, CODEX, type CaptureRow } from "./__fixtures__/tui-wrap-capture";
import { makePaddedLines } from "@/test/cell-lines";

/** xterm `getSelection()` 과 같은 규칙: 행마다 끝 공백 제거, isWrapped 행은 개행 없이 붙인다. */
function selectionLines(rows: CaptureRow[]): string[] {
  const lines: string[] = [];
  rows.forEach((row, i) => {
    const text = row.text.replace(/\s+$/, "");
    if (i > 0 && row.wrapped) lines[lines.length - 1] += text;
    else lines.push(text);
  });
  return lines;
}

function copyJoin(rows: CaptureRow[], style: WrapStyle = "word"): string[] | null {
  return joinTuiWrappedLines(
    selectionLines(rows),
    makePaddedLines(rows, CAPTURE_COLS),
    CAPTURE_COLS,
    style,
  );
}

describe("joinTuiWrappedLines — Claude Code 실측(88 cols)", () => {
  it("한글 문단을 어절 공백으로 잇고 연속 행 내어쓰기를 지운다", () => {
    expect(copyJoin(CLAUDE.koreanParagraph)).toEqual([
      "● 이 변경은 터미널 복사 경로에서 줄바꿈을 제거하는데, 실제로는 Claude Code 가 자체 " +
        "레이아웃으로 줄을 나누기 때문에 xterm 은 이를 소프트 랩으로 보지 못하고 개행으로 " +
        "복사하게 되며, 그 결과 사용자가 붙여넣은 문단이 화면 폭마다 끊겨 버린다.",
    ]);
  });

  it("영어 문단은 행이 정확히 cols 를 채워도 어절 공백으로 잇는다", () => {
    expect(copyJoin(CLAUDE.englishParagraph)).toEqual([
      "  This paragraph is intentionally long English prose so that the terminal user interface " +
        "has to wrap it across several visual rows, which lets us observe whether the wrapped " +
        "rows are stored as soft wraps or hard newlines.",
    ]);
  });

  it("목록 항목마다 한 줄 — 4칸 내어쓰기의 URL 꼬리는 공백 없이, 산문은 공백으로 잇는다", () => {
    expect(copyJoin(CLAUDE.list)).toEqual([
      "  - 목록 항목 문서는 https://github.com/kochul2000/laymux/blob/main/docs/architecture/" +
        "data-flow.md#terminal-view-osc-pipeline-and-renderer-reflow-details 를 참고하세요.",
      "  - PR 링크는 https://github.com/kochul2000/laymux/pull/1146 이고 뒤에 이어지는 설명 " +
        "문장이 충분히 길어서 다음 줄로 넘어가야 한다.",
    ]);
  });

  it("행 끝에서 잘린 URL 뒤에 산문이 이어져도 URL 을 복원한다", () => {
    expect(copyJoin(CLAUDE.urlWithParticle)).toEqual([
      "  자세한 내용은 https://example.com/very/long/path/segment/that/should/wrap/across/the/" +
        "terminal/width/because/it/is/really/long?query=value&another=thing에서 확인하세요.",
    ]);
  });

  it("앞 행이 와이드 문자로 끝나도 다음 첫 글자가 들어갈 자리가 있었으면 어절 경계다", () => {
    expect(copyJoin(CLAUDE.markdownLinks)).toEqual([
      "  마크다운 링크 (https://en.wikipedia.org/wiki/Rust_(programming_language)) 와 " +
        "https://example.com/bold 강조, 그리고 https://example.com/inline-code 코드.",
    ]);
  });

  it("상태 줄·입력 박스 테두리·말줄임 행은 잇지 않는다", () => {
    expect(copyJoin(CLAUDE.chrome)).toEqual(selectionLines(CLAUDE.chrome));
  });

  it("프롬프트 에코의 2칸 연속 행(목록 마커 기준 들여쓰기)도 잇는다", () => {
    expect(copyJoin(CLAUDE.promptEchoList)).toEqual([
      "  - 목록 항목 문서는 https://github.com/kochul2000/laymux/blob/main/docs/architecture/" +
        "data-flow.md#terminal-view-osc-pipeline-and-renderer-reflow-details 를 참고하세요.",
    ]);
  });
});

describe("joinTuiWrappedLines — Codex 실측(88 cols)", () => {
  it("anywhere: 음절 사이에서 잘린 한글은 공백 없이 잇는다", () => {
    // `레이|아웃으로` 는 단어 중간, `복사하게| 되며` 는 원래 공백이 있었지만 버퍼에
    // 남지 않는다. 음절 경계가 더 흔하므로 둘 다 공백 없이 잇는 쪽을 택한다.
    expect(copyJoin(CODEX.koreanParagraph, "anywhere")).toEqual([
      "• 이 변경은 터미널 복사 경로에서 줄바꿈을 제거하는데, 실제로는 Claude Code 가 자체 " +
        "레이아웃으로 줄을 나누기 때문에 xterm 은 이를 소프트 랩으로 보지 못하고 개행으로 " +
        "복사하게되며, 그 결과 사용자가 붙여넣은 문단이 화면 폭마다 끊겨 버린다.",
    ]);
  });

  it("word: 같은 행도 어절 경계로 보고 공백을 넣는다(Claude 식 줄바꿈 가정)", () => {
    expect(copyJoin(CODEX.koreanParagraph, "word")?.[0]).toContain("자체 레이 아웃으로");
  });

  it("영어 문단은 스타일과 무관하게 공백으로 잇는다", () => {
    const expected = [
      "  This paragraph is intentionally long English prose so that the terminal user interface " +
        "has to wrap it across several visual rows, which lets us observe whether the wrapped " +
        "rows are stored as soft wraps or hard newlines.",
    ];
    expect(copyJoin(CODEX.englishParagraph, "anywhere")).toEqual(expected);
  });

  it("목록 산문을 공백으로 잇는다", () => {
    expect(copyJoin(CODEX.list, "anywhere")).toEqual([
      "  • PR 링크는 https://github.com/kochul2000/laymux/pull/1146 이고 뒤에 이어지는 설명 " +
        "문장이 충분히 길어서 다음 줄로 넘어가야 한다.",
    ]);
  });

  it("빈 행·짧은 행 다음은 잇지 않고, soft-wrap 된 URL 은 xterm 결합 그대로 둔다", () => {
    expect(copyJoin(CODEX.listUrlOwnRow, "anywhere")).toEqual([
      "  • 목록 항목 문서는",
      "",
      "    https://github.com/kochul2000/laymux/blob/main/docs/architecture/data-flow.md#termin" +
        "al-view-osc-pipeline-and-renderer-reflow-details",
      "    를 참고하세요.",
    ]);
  });

  it("URL 을 다음 행으로 넘긴 짧은 앞 행은 공백으로 잇는다", () => {
    expect(copyJoin(CODEX.urlSoftWrapped, "anywhere")).toEqual([
      "  자세한 내용은 https://example.com/very/long/path/segment/that/should/wrap/across/the/terminal/width/" +
        "because/it/is/really/long?query=value&another=thing에서",
      "  확인하세요.",
    ]);
  });

  it("입력창(폭 cols-1)에서 글자 단위로 잘린 URL 을 공백 없이 잇는다", () => {
    expect(copyJoin(CODEX.promptEchoUrl, "anywhere")).toEqual([
      "  - 목록 항목 문서는 https://github.com/kochul2000/laymux/blob/main/docs/architecture/" +
        "data-flow.md#terminal-view-osc-pipeline-and-renderer-reflow-details",
      "  를 참고하세요.",
    ]);
  });
});

describe("detectTuiWrap — 경계 조건", () => {
  const lines = (rows: string[], cols: number) => makePaddedLines(rows, cols);

  it("다음 첫 토큰이 앞 행 남은 칸에 들어갔다면 원래 개행이다", () => {
    const [a, b] = lines(["  short line", "  next"], 20);
    expect(detectTuiWrap(a, b, 20)).toBeNull();
  });

  it("남은 칸이 정확히 공백+토큰이면 들어갔을 것이므로 잇지 않는다", () => {
    // 'aaaaaaaaaaaaa'(15셀) + ' ' + 'bbbb'(4셀) = 20 → 줄바꿈기가 앞 행에 놓았을 것이다.
    const [a, b] = lines(["  aaaaaaaaaaaaa", "  bbbb"], 20);
    expect(detectTuiWrap(a, b, 20)).toBeNull();
    const [c, d] = lines(["  aaaaaaaaaaaaa", "  bbbbb"], 20);
    expect(detectTuiWrap(c, d, 20)).toEqual({ separator: " ", contentOffset: 2 });
  });

  it("목록 마커로 시작하는 다음 행은 새 항목이다", () => {
    const [a, b] = lines(["  - aaaaaaaaaaaaaaaa", "  - bbbbbbbbbbbbbbbb"], 20);
    expect(detectTuiWrap(a, b, 20)).toBeNull();
  });

  it("내어쓰기에 정렬되지 않은 행(코드 블록 등)은 잇지 않는다", () => {
    const [a, b] = lines(["  aaaaaaaaaaaaaaaaaa", "      bbbbbbbbbbbbbb"], 20);
    expect(detectTuiWrap(a, b, 20)).toBeNull();
  });

  it("빈 행 앞뒤는 잇지 않는다", () => {
    const [a, b] = lines(["  aaaaaaaaaaaaaaaaaa", ""], 20);
    expect(detectTuiWrap(a, b, 20)).toBeNull();
    expect(detectTuiWrap(b, a, 20)).toBeNull();
  });
});

describe("joinTuiWrappedLines — 매핑 검증", () => {
  it("논리 줄 수가 선택 문자열과 다르면(열 선택 등) null", () => {
    const rows = makePaddedLines(CLAUDE.koreanParagraph, CAPTURE_COLS);
    expect(joinTuiWrappedLines(["only one"], rows, CAPTURE_COLS)).toBeNull();
  });

  it("연속 줄의 내어쓰기 자리에 공백이 아닌 글자가 있으면 그 줄은 잇지 않는다", () => {
    const rows = makePaddedLines(CLAUDE.englishParagraph, CAPTURE_COLS);
    const lines = selectionLines(CLAUDE.englishParagraph).map((l, i) =>
      i === 1 ? "xx" + l.slice(2) : l,
    );
    expect(joinTuiWrappedLines(lines, rows, CAPTURE_COLS)?.length).toBe(2);
  });
});
