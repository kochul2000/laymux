import { describe, it, expect } from "vitest";
import {
  WEB_LINK_REGEX,
  findPlainUrlAtCol,
  resolveLinkAtCell,
  isModifierLinkClick,
} from "./terminal-link-click";
import type { IndentedLineInfo } from "./indented-link-provider";

function makeLines(texts: string[], wrappedIndices: number[] = []): IndentedLineInfo[] {
  return texts.map((text, i) => ({
    text,
    isWrapped: wrappedIndices.includes(i),
    lineNumber: i + 1,
  }));
}

describe("WEB_LINK_REGEX", () => {
  it("WebLinksAddon 과 동일한 경계로 URL 을 매칭한다", () => {
    const m = "• https://example.com/path?q=1.".match(WEB_LINK_REGEX);
    expect(m?.[0]).toBe("https://example.com/path?q=1");
  });
});

describe("findPlainUrlAtCol", () => {
  const line = "  • https://example.com/foo bar";
  // 인덱스:  0123456789...  URL 은 컬럼 5(0-based 4)에서 시작
  it("URL 위 컬럼을 클릭하면 URL 을 반환한다", () => {
    // 'h' 위치는 0-based 4 → 1-based 5
    expect(findPlainUrlAtCol(line, 5)).toBe("https://example.com/foo");
    // URL 중간
    expect(findPlainUrlAtCol(line, 15)).toBe("https://example.com/foo");
  });

  it("URL 바깥 컬럼을 클릭하면 null 을 반환한다", () => {
    expect(findPlainUrlAtCol(line, 1)).toBeNull(); // 들여쓰기 공백
    expect(findPlainUrlAtCol(line, 30)).toBeNull(); // "bar" 위
  });

  it("URL 이 없는 줄은 null 을 반환한다", () => {
    expect(findPlainUrlAtCol("plain text only", 3)).toBeNull();
  });
});

describe("resolveLinkAtCell", () => {
  it("OSC 8 hyperlink 가 있으면 최우선으로 반환한다", () => {
    const url = resolveLinkAtCell({
      oscLinkUri: "https://codex.example/osc8",
      lines: makeLines(["  clickable label here"]),
      clickedLineNumber: 1,
      col: 5,
      enableIndentedJoin: true,
    });
    expect(url).toBe("https://codex.example/osc8");
  });

  it("OSC 8 이 없으면 같은 줄의 평문 URL 을 반환한다", () => {
    const url = resolveLinkAtCell({
      lines: makeLines(["• https://plain.example/path"]),
      clickedLineNumber: 1,
      col: 10,
      enableIndentedJoin: true,
    });
    expect(url).toBe("https://plain.example/path");
  });

  it("평문 URL 바깥을 클릭하면 들여쓰기 결합 URL 로 폴백한다", () => {
    const lines = makeLines([
      "  https://claude.com/authorize?client_id=abc&redirect_uri",
      "  =https%3A%2F%2Fcallback&scope=org",
    ]);
    const url = resolveLinkAtCell({
      lines,
      clickedLineNumber: 1,
      col: 5,
      enableIndentedJoin: true,
    });
    expect(url).toBe(
      "https://claude.com/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fcallback&scope=org",
    );
  });

  it("들여쓰기 결합이 꺼져 있으면 멀티라인 URL 을 무시한다", () => {
    const lines = makeLines([
      "  https://claude.com/authorize?client_id=abc&redirect_uri",
      "  =https%3A%2F%2Fcallback&scope=org",
    ]);
    // col 5 는 'h'(URL 시작) 위치 → 그 줄만 보면 평문 URL 로도 잡힌다.
    // 들여쓰기 결합만 막혀야 하므로, URL 이 단독 줄로는 완성되지 않는
    // 케이스를 검증하기 위해 클릭 위치를 결합으로만 닿는 두 번째 줄로 둔다.
    const url = resolveLinkAtCell({
      lines,
      clickedLineNumber: 2,
      col: 5,
      enableIndentedJoin: false,
    });
    // 두 번째 줄 자체는 https:// 로 시작하지 않으므로 평문 매칭도 없음
    expect(url).toBeNull();
  });

  it("링크가 전혀 없으면 null 을 반환한다", () => {
    const url = resolveLinkAtCell({
      lines: makeLines(["just some text"]),
      clickedLineNumber: 1,
      col: 3,
      enableIndentedJoin: true,
    });
    expect(url).toBeNull();
  });

  // Issue #439: 평문 `#123` 을 클릭하면 repoBase 가 있을 때 issues URL 로 연다.
  it("repoBase 가 있으면 클릭한 #번호를 issues URL 로 변환한다", () => {
    const url = resolveLinkAtCell({
      lines: makeLines(["fix done, see #123 thanks"]),
      clickedLineNumber: 1,
      col: 16, // '1' 위 (0-based 15)
      enableIndentedJoin: true,
      repoBase: "https://github.com/owner/repo",
    });
    expect(url).toBe("https://github.com/owner/repo/issues/123");
  });

  it("repoBase 가 없으면 #번호를 무시한다", () => {
    const url = resolveLinkAtCell({
      lines: makeLines(["see #123"]),
      clickedLineNumber: 1,
      col: 6,
      enableIndentedJoin: true,
    });
    expect(url).toBeNull();
  });

  it("#번호 바깥을 클릭하면 null (repoBase 있어도)", () => {
    const url = resolveLinkAtCell({
      lines: makeLines(["see #123 now"]),
      clickedLineNumber: 1,
      col: 2, // 's' 위 — 토큰 바깥
      enableIndentedJoin: true,
      repoBase: "https://github.com/owner/repo",
    });
    expect(url).toBeNull();
  });

  it("OSC 8 은 #번호보다 우선한다", () => {
    const url = resolveLinkAtCell({
      oscLinkUri: "https://github.com/owner/repo/pull/123",
      lines: makeLines(["#123"]),
      clickedLineNumber: 1,
      col: 2,
      enableIndentedJoin: true,
      repoBase: "https://github.com/owner/repo",
    });
    expect(url).toBe("https://github.com/owner/repo/pull/123");
  });
});

describe("isModifierLinkClick", () => {
  it("Shift+좌클릭은 true", () => {
    expect(isModifierLinkClick({ button: 0, shiftKey: true, altKey: false })).toBe(true);
  });
  it("Alt+좌클릭은 true", () => {
    expect(isModifierLinkClick({ button: 0, shiftKey: false, altKey: true })).toBe(true);
  });
  it("수정자키 없는 좌클릭은 false", () => {
    expect(isModifierLinkClick({ button: 0, shiftKey: false, altKey: false })).toBe(false);
  });
  it("우클릭은 수정자키가 있어도 false", () => {
    expect(isModifierLinkClick({ button: 2, shiftKey: true, altKey: false })).toBe(false);
  });
});
