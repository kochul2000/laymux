import { afterEach, describe, expect, it } from "vitest";
import { createScreenTerminal, type ScreenTerminal } from "@/test/screen/xterm-screen";
import { mapSelectionToPathRange } from "./path-link-detect";
import { readLineCells } from "./terminal-cell-map";

/**
 * 한글/CJK 경로의 밑줄 범위(issue #691).
 *
 * 옆의 단위 테스트는 손으로 만든 `CellInfo[]` 로 산술을 증명한다. 정작 증명이
 * 필요한 것은 "실제 xterm 이 이 바이트를 어떤 셀에 놓는가"다 — 폭 판정은
 * xterm 의 Unicode provider 소관이고(ADR-0058), 우리가 가정한 width 2 가 실제와
 * 다르면 밑줄은 그대로 어긋난다. 그래서 진짜 터미널에 텍스트를 흘리고, 그
 * 버퍼의 셀을 읽어 매핑을 검증한다(ADR-0074 의 화면 스위트).
 */

const terminals: ScreenTerminal[] = [];

function screen() {
  const created = createScreenTerminal({ cols: 60, rows: 6, scrollback: 50 });
  terminals.push(created);
  return created;
}

afterEach(() => {
  while (terminals.length > 0) terminals.pop()?.dispose();
});

/**
 * 실제 버퍼 0번 줄의 셀로 토큰 밑줄 범위를 계산한다. 선택은 토큰이 시작하는
 * 셀에서 시작한 것으로 본다(사용자가 그 토큰을 드래그한 상황).
 */
async function underlineFor(text: string, token: string, startCell: number) {
  const s = screen();
  await s.write(text);
  const line = s.terminal.buffer.active.getLine(0);
  expect(line).toBeTruthy();
  const cells = readLineCells(line!);
  const pos = { start: { x: startCell, y: 0 }, end: { x: startCell + token.length, y: 0 } };
  return mapSelectionToPathRange(pos, token, token, cells);
}

describe("path-link 밑줄 범위 (실제 xterm 셀)", () => {
  it("ASCII 경로는 문자 수와 셀 수가 같다", async () => {
    const r = await underlineFor("ui/src/a.ts", "ui/src/a.ts", 0);
    expect(r.startCol).toBe(1);
    expect(r.endCol).toBe(11);
  });

  it("한글 경로는 두 배 폭을 덮는다", async () => {
    // "문서" 는 화면에서 4셀 — 문자 수(2)로 계산하면 밑줄이 절반만 그어진다.
    const r = await underlineFor("문서", "문서", 0);
    expect(r.startCol).toBe(1);
    expect(r.endCol).toBe(4);
  });

  it("한글 디렉터리 + ASCII 파일명을 끝까지 덮는다", async () => {
    const r = await underlineFor("문서/보고서.txt", "문서/보고서.txt", 0);
    // 문서(4) + /(1) + 보고서(6) + .txt(4) = 15셀
    expect(r.startCol).toBe(1);
    expect(r.endCol).toBe(15);
  });

  it("앞선 한글이 시작 컬럼을 밀어낸다", async () => {
    // "메모 ui/src/a.ts" — 메모(4셀) + 공백(1) → 토큰은 셀 6 에서 시작.
    const r = await underlineFor("메모 ui/src/a.ts", "ui/src/a.ts", 5);
    expect(r.startCol).toBe(6);
    expect(r.endCol).toBe(16);
  });

  it("CJK·전각 기호가 섞여도 셀 기준으로 끝난다", async () => {
    const r = await underlineFor("プロジェクト/a.md", "プロジェクト/a.md", 0);
    // プロジェクト(12) + /(1) + a.md(4) = 17셀
    expect(r.startCol).toBe(1);
    expect(r.endCol).toBe(17);
  });
});
