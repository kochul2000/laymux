import { describe, it, expect } from "vitest";
import { TERMINAL_URL_REGEX, matchTerminalUrls } from "./terminal-url";

const urls = (text: string) => matchTerminalUrls(text).map((m) => m.text);

describe("TERMINAL_URL_REGEX", () => {
  it("URL 에 바로 붙은 한글 조사·어미는 URL 이 아니다", () => {
    expect(urls("https://example.com/a에서 확인")).toEqual(["https://example.com/a"]);
    expect(urls("자세한 내용: https://github.com/a/b/pull/12를 참고")).toEqual([
      "https://github.com/a/b/pull/12",
    ]);
  });

  it("전각 구두점에서 끝난다", () => {
    expect(urls("https://example.com/a。")).toEqual(["https://example.com/a"]);
    expect(urls("「https://example.com/a」")).toEqual(["https://example.com/a"]);
  });

  it("짝이 맞는 괄호는 URL 에 포함하고, 감싸는 괄호는 뺀다", () => {
    expect(urls("https://en.wikipedia.org/wiki/Rust_(programming_language)")).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
    ]);
    expect(urls("링크 (https://en.wikipedia.org/wiki/Rust_(programming_language)) 와")).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
    ]);
    expect(urls("(https://example.com/a)")).toEqual(["https://example.com/a"]);
  });

  it("마크다운 강조·코드·꺾쇠·따옴표 경계를 뺀다", () => {
    expect(urls("**https://example.com/bold** 강조")).toEqual(["https://example.com/bold"]);
    expect(urls("`https://example.com/code`")).toEqual(["https://example.com/code"]);
    expect(urls("<https://example.com/a>")).toEqual(["https://example.com/a"]);
    expect(urls('"https://example.com/a"')).toEqual(["https://example.com/a"]);
    expect(urls("[https://example.com/a]")).toEqual(["https://example.com/a"]);
  });

  it("문장 끝 구두점을 뺀다", () => {
    expect(urls("See https://example.com/a.")).toEqual(["https://example.com/a"]);
    expect(urls("https://example.com/a, https://example.com/b;")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(urls("Is it https://example.com/a?")).toEqual(["https://example.com/a"]);
  });

  it("URL 안의 구조 문자는 유지한다", () => {
    const url =
      "https://claude.com/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fx.com%2Fcb&scope=a+b#frag";
    expect(urls(url)).toEqual([url]);
    expect(urls("http://localhost:52516/callback")).toEqual(["http://localhost:52516/callback"]);
    expect(urls("https://example.com/a-b_c~d/e.f")).toEqual(["https://example.com/a-b_c~d/e.f"]);
  });

  it("대문자 스킴도 찾는다", () => {
    expect(urls("HTTPS://EXAMPLE.COM/A")).toEqual(["HTTPS://EXAMPLE.COM/A"]);
  });

  it("오프셋을 함께 돌려준다", () => {
    expect(matchTerminalUrls("x https://a.com/b.")).toEqual([
      { text: "https://a.com/b", index: 2 },
    ]);
  });

  it("전역 플래그 없이 정의돼 WebLinksAddon 이 g 를 덧붙여 쓸 수 있다", () => {
    expect(TERMINAL_URL_REGEX.flags).not.toContain("g");
  });
});
