import { afterEach, describe, expect, it } from "vitest";
import { createScreenTerminal, type ScreenTerminal } from "@/test/screen/xterm-screen";
import { findIndentedUrls, readIndentedLine } from "./indented-link-provider";

/**
 * 들여쓰기 하드랩 URL 의 링크 범위(issue #696).
 *
 * 옆의 단위 테스트는 손으로 만든 셀로 오프셋↔컬럼 산술을 증명한다. 정작 증명이
 * 필요한 것은 "실제 xterm 이 이 바이트를 어떤 셀에 놓는가"다 — 폭 판정은 xterm
 * 의 Unicode provider 소관이고(ADR-0058), 우리가 가정한 width 2 가 실제와 다르면
 * 밑줄·클릭 영역은 그대로 어긋난다. 그래서 진짜 터미널에 텍스트를 흘리고 그
 * 버퍼의 셀로 링크 범위를 계산한다(ADR-0074 의 화면 스위트).
 *
 * `path-link-wide-cell.screen.test.ts` 와 같은 형태이고, 다른 점은 이 provider 가
 * **여러 줄을 결합**한다는 것이다 — 그래서 행 번호까지 함께 확인한다.
 */

const terminals: ScreenTerminal[] = [];

function screen(cols = 60) {
  const created = createScreenTerminal({ cols, rows: 8, scrollback: 50 });
  terminals.push(created);
  return created;
}

afterEach(() => {
  while (terminals.length > 0) terminals.pop()?.dispose();
});

/**
 * 하드랩된 줄들을 실제 터미널에 흘린 뒤, 그 버퍼 셀로 결합 URL 의 범위를 구한다.
 * `TerminalView`/provider 와 같은 경로: `buffer.getLine(y-1)` → 셀 → 컬럼 맵.
 */
async function linkRange(lines: string[], queriedLine = 1) {
  const s = screen();
  await s.write(lines.join("\r\n"));
  const buffer = s.terminal.buffer.active;
  const infos = lines.map((_, i) => {
    const bufLine = buffer.getLine(i);
    expect(bufLine).toBeTruthy();
    return readIndentedLine(bufLine!, i + 1);
  });
  // 하드랩이어야 한다 — 소프트랩이면 provider 가 건너뛰므로 전제부터 깨진다.
  expect(infos.some((info) => info.isWrapped)).toBe(false);
  const matches = findIndentedUrls(infos, queriedLine);
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("들여쓰기 하드랩 URL 범위 (실제 xterm 셀)", () => {
  it("ASCII 는 문자 수와 셀 수가 같다", async () => {
    const match = await linkRange([
      "  https://example.com/path?q=1&foo=ba",
      "  r&baz=qux&end=true",
    ]);
    expect(match.text).toBe("https://example.com/path?q=1&foo=bar&baz=qux&end=true");
    expect(match.range.start).toEqual({ x: 3, y: 1 });
    expect(match.range.end).toEqual({ x: 20, y: 2 });
  });

  it("앞선 한글이 시작 컬럼을 밀어낸다", async () => {
    // "메모 " 는 문자 3개지만 화면에서는 5셀 — URL 은 셀 8 에서 시작한다.
    const match = await linkRange([
      "  메모 https://example.com/path?q=1&foo=ba",
      "  r&baz=qux&end=true",
    ]);
    expect(match.text).toBe("https://example.com/path?q=1&foo=bar&baz=qux&end=true");
    expect(match.range.start).toEqual({ x: 8, y: 1 });
    expect(match.range.end).toEqual({ x: 20, y: 2 });
  });

  it("URL 안의 한글도 셀 기준으로 끝난다", async () => {
    const match = await linkRange(["  https://example.com/문서와", "  보고서?q=1"]);
    expect(match.text).toBe("https://example.com/문서와보고서?q=1");
    expect(match.range.start).toEqual({ x: 3, y: 1 });
    // 보(3-4) 고(5-6) 서(7-8) ?(9) q(10) =(11) 1(12)
    expect(match.range.end).toEqual({ x: 12, y: 2 });
  });

  it("와이드 문자로 끝나면 끝 컬럼이 뒷칸까지 덮는다", async () => {
    const match = await linkRange(["  https://example.com/pathpath", "  /문서"]);
    expect(match.text).toBe("https://example.com/pathpath/문서");
    // /(3) 문(4-5) 서(6-7) — 6 이면 밑줄이 마지막 글자의 절반만 덮는다
    expect(match.range.end).toEqual({ x: 7, y: 2 });
  });

  it("이모지가 섞여도 시작·끝 컬럼이 맞는다", async () => {
    const match = await linkRange(["  🔗 https://example.com/pathpath", "  /x😀"]);
    expect(match.text).toBe("https://example.com/pathpath/x😀");
    // 🔗(3-4) 공백(5) → URL 은 셀 6 에서 시작
    expect(match.range.start).toEqual({ x: 6, y: 1 });
    // /(3) x(4) 😀(5-6)
    expect(match.range.end).toEqual({ x: 6, y: 2 });
  });

  it("3줄 결합에서도 중간 줄 질의가 같은 범위를 낸다", async () => {
    const lines = ["  메모 https://example.com/문서?a=1&b=", "  2&c=3&계속=예&d=", "  4&끝=true"];
    const first = await linkRange(lines, 1);
    const middle = await linkRange(lines, 2);
    expect(middle).toEqual(first);
    expect(first.range.start).toEqual({ x: 8, y: 1 });
    // 셋째 줄: 4(3) &(4) 끝(5-6) =(7) t(8) r(9) u(10) e(11)
    expect(first.range.end).toEqual({ x: 11, y: 3 });
  });

  it("끝쪽 패딩 공백이 있어도 끝점이 마지막 줄에 찍힌다", async () => {
    // 실제 버퍼 줄은 폭(60)만큼 공백으로 채워진다. 패딩을 길이로 세면 결합
    // 오프셋이 첫 줄 안에서 소진되어 끝점이 엉뚱한 행·컬럼으로 간다.
    const s = screen();
    await s.write("  https://example.com/path?q=1&foo=ba\r\n  r&baz=qux&end=true");
    const line0 = s.terminal.buffer.active.getLine(0)!;
    expect(line0.translateToString().length).toBe(60); // 패딩 확인

    const match = await linkRange([
      "  https://example.com/path?q=1&foo=ba",
      "  r&baz=qux&end=true",
    ]);
    expect(match.range.end.y).toBe(2);
    expect(match.range.end.x).toBe(20);
  });
});
