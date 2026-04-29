import { describe, it, expect } from "vitest";
import {
  smartRemoveIndent,
  smartRemoveLineBreak,
  applySmartTextTransforms,
  transformPasteContent,
  trimSelectionTrailingWhitespace,
  prepareSelectionForCopy,
} from "./smart-text";
import { RAW_XTERM_SELECTION, WRONG_RESULT, CLEAN_URL } from "./__fixtures__/right-pane-fixture";

// ============================================================
// trimSelectionTrailingWhitespace
// ============================================================
describe("trimSelectionTrailingWhitespace", () => {
  it("removes trailing spaces from each line", () => {
    const input = "hello   \nworld   ";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello\nworld");
  });

  it("removes trailing tabs from each line", () => {
    const input = "hello\t\t\nworld\t";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello\nworld");
  });

  it("removes trailing blank lines (empty lines at the end)", () => {
    const input = "hello\nworld\n\n\n";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello\nworld");
  });

  it("removes trailing blank lines that are only whitespace", () => {
    const input = "hello\nworld\n   \n  \n";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello\nworld");
  });

  it("preserves internal blank lines", () => {
    const input = "hello\n\nworld";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello\n\nworld");
  });

  it("preserves leading whitespace (indent)", () => {
    const input = "  hello   \n  world   ";
    expect(trimSelectionTrailingWhitespace(input)).toBe("  hello\n  world");
  });

  it("handles single line with trailing spaces", () => {
    const input = "hello   ";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello");
  });

  it("handles single line with trailing newline", () => {
    const input = "hello\n";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello");
  });

  it("returns empty string for empty input", () => {
    expect(trimSelectionTrailingWhitespace("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(trimSelectionTrailingWhitespace("   \n  \n   ")).toBe("");
  });

  it("does not modify text without trailing whitespace", () => {
    const input = "hello\nworld";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello\nworld");
  });

  it("handles CRLF line endings", () => {
    const input = "hello   \r\nworld   \r\n\r\n";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello\r\nworld");
  });

  it("handles mixed trailing whitespace (spaces and tabs)", () => {
    const input = "hello \t \nworld\t \t";
    expect(trimSelectionTrailingWhitespace(input)).toBe("hello\nworld");
  });
});

// ============================================================
// smartRemoveIndent
// ============================================================
describe("smartRemoveIndent", () => {
  it("removes common leading spaces from all lines", () => {
    const input = "  hello\n  world";
    expect(smartRemoveIndent(input)).toBe("hello\nworld");
  });

  it("removes common leading spaces preserving relative indent", () => {
    const input = "    line1\n      line2\n    line3";
    expect(smartRemoveIndent(input)).toBe("line1\n  line2\nline3");
  });

  it("handles tabs as indent", () => {
    const input = "\t\thello\n\t\tworld";
    expect(smartRemoveIndent(input)).toBe("hello\nworld");
  });

  it("does nothing when there is no common indent", () => {
    const input = "hello\n  world";
    expect(smartRemoveIndent(input)).toBe("hello\n  world");
  });

  it("returns single line unchanged if no indent", () => {
    expect(smartRemoveIndent("hello")).toBe("hello");
  });

  it("removes indent from single line", () => {
    expect(smartRemoveIndent("  hello")).toBe("hello");
  });

  it("skips blank lines when computing common indent", () => {
    const input = "  hello\n\n  world";
    expect(smartRemoveIndent(input)).toBe("hello\n\nworld");
  });

  it("returns empty string for empty input", () => {
    expect(smartRemoveIndent("")).toBe("");
  });

  it("handles all blank lines", () => {
    expect(smartRemoveIndent("\n\n")).toBe("\n\n");
  });

  it("handles mixed space and tab (treats as different chars)", () => {
    // When indent chars are mixed, common prefix stops at first difference
    const input = " \thello\n \tworld";
    expect(smartRemoveIndent(input)).toBe("hello\nworld");
  });

  it("preserves trailing newline", () => {
    const input = "  hello\n  world\n";
    expect(smartRemoveIndent(input)).toBe("hello\nworld\n");
  });
});

// ============================================================
// smartRemoveLineBreak
// ============================================================
describe("smartRemoveLineBreak", () => {
  it("joins URL split across lines", () => {
    const input = "https://example.com/path?foo=bar&ba\nz=qux";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com/path?foo=bar&baz=qux");
  });

  it("joins URL split across multiple lines", () => {
    const input = "https://example.com/pa\nth?foo=bar&ba\nz=qux";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com/path?foo=bar&baz=qux");
  });

  it("does not touch non-URL multi-line text", () => {
    const input = "hello\nworld\nfoo";
    expect(smartRemoveLineBreak(input)).toBe("hello\nworld\nfoo");
  });

  it("does not touch single line URL", () => {
    const input = "https://example.com/path";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com/path");
  });

  it("handles the issue example: indented URL with linebreaks", () => {
    // After indent removal, the URL still has linebreaks that should be joined
    const input =
      "https://mcp.notion.com/authorize?response_type=code&client_id=nmy47PjpHdZy7dgr&code_challenge=1eVfRYoFxEoIOGh0CaAF30mz9UXYTgDXr7tXeGI-I2M&cod\ne_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A52516%2Fcallback&state=AHKfcaYPBT9Ndx-qH1TQKKbbBL7YaCg7tRJ2NeLROFE&resource=htt\nps%3A%2F%2Fmcp.notion.com%2Fmcp";
    const expected =
      "https://mcp.notion.com/authorize?response_type=code&client_id=nmy47PjpHdZy7dgr&code_challenge=1eVfRYoFxEoIOGh0CaAF30mz9UXYTgDXr7tXeGI-I2M&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A52516%2Fcallback&state=AHKfcaYPBT9Ndx-qH1TQKKbbBL7YaCg7tRJ2NeLROFE&resource=https%3A%2F%2Fmcp.notion.com%2Fmcp";
    expect(smartRemoveLineBreak(input)).toBe(expected);
  });

  it("returns empty string for empty input", () => {
    expect(smartRemoveLineBreak("")).toBe("");
  });

  it("handles URL with http:// scheme", () => {
    const input = "http://example.com/pa\nth";
    expect(smartRemoveLineBreak(input)).toBe("http://example.com/path");
  });

  it("does not join lines when text has mixed URL and non-URL content", () => {
    const input = "Check this:\nhttps://example.com/path";
    expect(smartRemoveLineBreak(input)).toBe("Check this:\nhttps://example.com/path");
  });

  it("joins URL that is the only content (all lines form one URL)", () => {
    const input = "https://example.com/very-long-\npath?query=value";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com/very-long-path?query=value");
  });

  it("URL이 한 줄이지만 중간에 공백이 끼어 있어도 모두 제거한다", () => {
    // 외부 앱에서 newline만 strip하고 paste한 URL: 중간에 4-space gap이 존재
    const input =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61    b-44d9-88ed-5944d1962f5e&response_type=code";
    const expected =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code";
    expect(smartRemoveLineBreak(input)).toBe(expected);
  });

  it("URL 한 줄 + 탭 문자 혼합 공백도 제거한다", () => {
    const input = "https://example.com/path?foo=bar&\t baz=qux";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com/path?foo=bar&baz=qux");
  });

  it("URL이 아닌 단일 줄 텍스트는 공백을 제거하지 않는다", () => {
    const input = "hello world how are you";
    expect(smartRemoveLineBreak(input)).toBe("hello world how are you");
  });

  it("URL + 단일 스페이스로 구분된 prose는 보존한다 (자연어 보호)", () => {
    // 외부 앱이 newline을 strip하면 터미널 패딩은 multi-space gap으로 남지만,
    // 자연어에서 URL과 단어 사이는 single space. 이 둘을 구분해서
    // single-space 케이스는 collapse 하지 않아야 한다.
    const input = "https://example.com hello world";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com hello world");
  });

  it("URL 뒤 single-space-separated 문장이 와도 합치지 않는다", () => {
    const input = "https://example.com is a great site";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com is a great site");
  });
});

// ============================================================
// applySmartTextTransforms (composition)
// ============================================================
describe("applySmartTextTransforms", () => {
  it("applies both indent removal and linebreak removal in order", () => {
    // The exact issue scenario: 2-space indented URL with linebreaks
    const input =
      "  https://mcp.notion.com/authorize?response_type=code&client_id=nmy47PjpHdZy7dgr&code_challenge=1eVfRYoFxEoIOGh0CaAF30mz9UXYTgDXr7tXeGI-I2M&cod\n  e_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A52516%2Fcallback&state=AHKfcaYPBT9Ndx-qH1TQKKbbBL7YaCg7tRJ2NeLROFE&resource=htt\n  ps%3A%2F%2Fmcp.notion.com%2Fmcp";
    const expected =
      "https://mcp.notion.com/authorize?response_type=code&client_id=nmy47PjpHdZy7dgr&code_challenge=1eVfRYoFxEoIOGh0CaAF30mz9UXYTgDXr7tXeGI-I2M&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A52516%2Fcallback&state=AHKfcaYPBT9Ndx-qH1TQKKbbBL7YaCg7tRJ2NeLROFE&resource=https%3A%2F%2Fmcp.notion.com%2Fmcp";
    expect(applySmartTextTransforms(input, { removeIndent: true, removeLineBreak: true })).toBe(
      expected,
    );
  });

  it("applies only indent removal when removeLineBreak is false", () => {
    const input = "  hello\n  world";
    expect(applySmartTextTransforms(input, { removeIndent: true, removeLineBreak: false })).toBe(
      "hello\nworld",
    );
  });

  it("applies only linebreak removal when removeIndent is false", () => {
    const input = "https://example.com/pa\nth";
    expect(applySmartTextTransforms(input, { removeIndent: false, removeLineBreak: true })).toBe(
      "https://example.com/path",
    );
  });

  it("applies nothing when both are false", () => {
    const input = "  hello\n  world";
    expect(
      applySmartTextTransforms(input, {
        removeIndent: false,
        removeLineBreak: false,
      }),
    ).toBe("  hello\n  world");
  });

  it("order matters: indent first, then linebreak", () => {
    // If linebreak ran first on indented text, indent spaces would be in the URL
    const input = "  https://example.com/pa\n  th";
    // indent removal: "https://example.com/pa\nth"
    // linebreak removal: "https://example.com/path"
    expect(applySmartTextTransforms(input, { removeIndent: true, removeLineBreak: true })).toBe(
      "https://example.com/path",
    );
  });

  it("normalizes CRLF to LF before processing", () => {
    const input = "  hello\r\n  world";
    expect(applySmartTextTransforms(input, { removeIndent: true, removeLineBreak: false })).toBe(
      "hello\nworld",
    );
  });

  it("normalizes CRLF in URL before joining lines", () => {
    const input = "https://example.com/pa\r\nth";
    expect(applySmartTextTransforms(input, { removeIndent: false, removeLineBreak: true })).toBe(
      "https://example.com/path",
    );
  });

  it("paste 시 URL + single-space prose 단일 라인은 보존된다 (false-positive 가드)", () => {
    // newline이 없고 단일 스페이스로 prose가 이어지는 자연어 입력은
    // smartRemoveLineBreak이 켜져 있어도 합쳐지면 안 된다.
    const input = "https://example.com hello world";
    expect(applySmartTextTransforms(input, { removeIndent: false, removeLineBreak: true })).toBe(
      "https://example.com hello world",
    );
  });
});

// ============================================================
// copy → paste end-to-end pipeline
// (trimSelectionTrailingWhitespace on copy, applySmartTextTransforms on paste)
// ============================================================
describe("copy → paste pipeline", () => {
  const pasteOpts = { removeIndent: true, removeLineBreak: true };

  /** Simulate: xterm getSelection → copy trim → clipboard → paste transform */
  function copyThenPaste(rawSelection: string): string {
    const copied = trimSelectionTrailingWhitespace(rawSelection);
    return applySmartTextTransforms(copied, pasteOpts);
  }

  it("indented URL with trailing spaces and blank lines", () => {
    // xterm pads each line to terminal width with spaces, adds trailing blank lines
    const raw =
      "  https://example.com/path?q=1&foo=bar                    \n" +
      "  &baz=qux                                                \n" +
      "                                                          \n";
    expect(copyThenPaste(raw)).toBe("https://example.com/path?q=1&foo=bar&baz=qux");
  });

  it("indented multi-line URL from terminal (real-world OAuth URL)", () => {
    const raw =
      "  https://mcp.notion.com/authorize?code_challenge=abc&cod   \n" +
      "  e_challenge_method=S256&redirect_uri=http%3A%2F%2Flocal   \n" +
      "  host%3A52516%2Fcallback                                   \n" +
      "                                                            \n";
    expect(copyThenPaste(raw)).toBe(
      "https://mcp.notion.com/authorize?code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A52516%2Fcallback",
    );
  });

  it("plain indented code block from terminal", () => {
    const raw =
      "    function hello() {   \n" +
      "      return 'world';   \n" +
      "    }                   \n" +
      "                        \n";
    // indent removed, but not joined (not a URL)
    expect(copyThenPaste(raw)).toBe("function hello() {\n  return 'world';\n}");
  });

  it("single line with xterm trailing padding", () => {
    const raw = "hello world                              \n";
    expect(copyThenPaste(raw)).toBe("hello world");
  });
});

// ============================================================
// transformPasteContent
// ============================================================
describe("transformPasteContent", () => {
  const opts = { removeIndent: true, removeLineBreak: true };

  it("applies transforms for text paste type", () => {
    const input = "  https://example.com/pa\n  th";
    expect(transformPasteContent(input, "text", opts)).toBe("https://example.com/path");
  });

  it("returns content unchanged for non-text paste type", () => {
    const input = "  some image data";
    expect(transformPasteContent(input, "image", opts)).toBe("  some image data");
  });

  it("text paste 시 URL + single-space prose는 그대로 유지 (false-positive 가드)", () => {
    const input = "https://example.com is a great site";
    expect(transformPasteContent(input, "text", opts)).toBe("https://example.com is a great site");
  });
});

// ============================================================
// Real terminal buffer: Claude Code OAuth URL (75-col padded lines)
// ============================================================
describe("right-pane fixture: terminal-padded multi-line URL", () => {
  const pasteOpts = { removeIndent: true, removeLineBreak: true };

  it("문제 재현: raw xterm selection에서 newline만 제거하면 URL에 공백이 포함됨", () => {
    // 외부 앱(브라우저 URL bar 등)은 붙여넣기 시 newline을 제거
    // trailing space(2) + leading indent(2) = fragment 사이 4-space gap
    expect(WRONG_RESULT).toContain("e61    b-44d9"); // 4 spaces between fragments
    expect(WRONG_RESULT).not.toBe(CLEAN_URL);
  });

  it("smartRemoveLineBreak가 trailing whitespace 있는 입력에서도 URL joining 성공", () => {
    const afterIndentRemoval = smartRemoveIndent(RAW_XTERM_SELECTION.replace(/\r\n/g, "\n"));
    // indent 제거 후에도 trailing space가 남아있지만
    const firstLine = afterIndentRemoval.split("\n")[0];
    expect(firstLine).toMatch(/\s$/); // trailing space 존재
    // smartRemoveLineBreak가 trailing space를 무시하고 URL joining 성공
    const result = smartRemoveLineBreak(afterIndentRemoval);
    expect(result).toBe(CLEAN_URL);
  });

  it("applySmartTextTransforms가 raw input에서도 URL joining 성공", () => {
    // trimSelectionTrailingWhitespace 없이 raw input이 paste pipeline에 진입해도
    const result = applySmartTextTransforms(RAW_XTERM_SELECTION, pasteOpts);
    expect(result).toBe(CLEAN_URL);
  });

  it("copy→paste pipeline은 trim이 선행되면 URL joining 성공", () => {
    // trimSelectionTrailingWhitespace가 먼저 적용된 경우
    const copied = trimSelectionTrailingWhitespace(RAW_XTERM_SELECTION);
    const pasted = applySmartTextTransforms(copied, pasteOpts);
    // trim이 trailing space를 제거하므로 URL joining 성공
    expect(pasted).toBe(CLEAN_URL);
  });
});

// ============================================================
// prepareSelectionForCopy — 복사 시 trailing whitespace + indent 제거
// ============================================================
describe("prepareSelectionForCopy", () => {
  it("smartRemoveIndent 활성 시 복사 시점에 공통 인덴트가 제거된다", () => {
    // 이슈 #183: 터미널에서 인덴트된 텍스트를 복사해서 외부 앱에 붙여넣기하면
    // 인덴트가 그대로 남는 문제
    const raw =
      "  cat > ~/.asoundrc << 'EOF'   \n" +
      "  pcm.default pulse            \n" +
      "  ctl.default pulse            \n" +
      "                               \n" +
      "  pcm.pulse {                  \n" +
      "      type pulse               \n" +
      "  }                            \n" +
      "                               \n" +
      "  ctl.pulse {                  \n" +
      "      type pulse               \n" +
      "  }                            \n" +
      "  EOF                          \n" +
      "                               \n";
    const result = prepareSelectionForCopy(raw, { smartRemoveIndent: true });
    // 공통 2-space 인덴트가 제거되어야 한다
    expect(result).toBe(
      "cat > ~/.asoundrc << 'EOF'\n" +
        "pcm.default pulse\n" +
        "ctl.default pulse\n" +
        "\n" +
        "pcm.pulse {\n" +
        "    type pulse\n" +
        "}\n" +
        "\n" +
        "ctl.pulse {\n" +
        "    type pulse\n" +
        "}\n" +
        "EOF",
    );
  });

  it("smartRemoveIndent 비활성 시 인덴트가 유지된다", () => {
    const raw = "  hello   \n  world   \n";
    const result = prepareSelectionForCopy(raw, { smartRemoveIndent: false });
    expect(result).toBe("  hello\n  world");
  });

  it("인덴트 없는 텍스트는 변경 없이 trailing whitespace만 제거된다", () => {
    const raw = "hello   \nworld   \n";
    const result = prepareSelectionForCopy(raw, { smartRemoveIndent: true });
    expect(result).toBe("hello\nworld");
  });

  it("빈 문자열은 그대로 반환된다", () => {
    expect(prepareSelectionForCopy("", { smartRemoveIndent: true })).toBe("");
  });

  it("CRLF 입력도 올바르게 처리된다", () => {
    const raw = "  hello   \r\n  world   \r\n";
    const result = prepareSelectionForCopy(raw, { smartRemoveIndent: true });
    expect(result).toBe("hello\r\nworld");
  });

  it("smartRemoveLineBreak 활성 시 멀티라인 URL이 한 줄로 합쳐지고 공백이 제거된다", () => {
    // 터미널에서 인덴트된 멀티라인 URL을 복사할 때 외부 앱(브라우저 URL bar 등)에
    // 그대로 붙여넣어도 깨지지 않도록 copy 시점에 정리한다.
    const raw =
      "  https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61   \n" +
      "  b-44d9-88ed-5944d1962f5e&response_type=code                                \n" +
      "                                                                            \n";
    const expected =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code";
    const result = prepareSelectionForCopy(raw, {
      smartRemoveIndent: true,
      smartRemoveLineBreak: true,
    });
    expect(result).toBe(expected);
  });

  it("smartRemoveLineBreak 비활성 시 멀티라인 URL이 그대로 유지된다", () => {
    const raw = "  https://example.com/pa   \n  th?q=1   \n";
    const result = prepareSelectionForCopy(raw, {
      smartRemoveIndent: true,
      smartRemoveLineBreak: false,
    });
    expect(result).toBe("https://example.com/pa\nth?q=1");
  });

  it("URL이 아닌 멀티라인 텍스트는 smartRemoveLineBreak가 켜져 있어도 줄바꿈을 유지한다", () => {
    const raw = "  hello   \n  world   \n";
    const result = prepareSelectionForCopy(raw, {
      smartRemoveIndent: true,
      smartRemoveLineBreak: true,
    });
    expect(result).toBe("hello\nworld");
  });
});

// ============================================================
// smartRemoveIndent와 MemoView Tab indent 상호작용 검증
// PR #185(smartRemoveIndent)와 PR #186(MemoView Tab/Shift+Tab)은
// 서로 다른 인덴트 제거 알고리즘을 사용한다:
//   - smartRemoveIndent: 전역 최소 인덴트를 계산하여 모든 줄에서 동일량 제거
//   - MemoView Shift+Tab: 각 줄에서 독립적으로 최대 indentSize만큼 제거
// 두 알고리즘의 결과가 일치/불일치하는 케이스를 명시적으로 문서화한다.
// ============================================================
describe("smartRemoveIndent vs MemoView Shift+Tab dedent 비교", () => {
  /** MemoView의 Shift+Tab dedent 로직을 시뮬레이션 (PR #186 MemoView.tsx 기반) */
  function memoShiftTabDedent(text: string, indentSize: number): string {
    const regex = new RegExp(`^ {1,${indentSize}}`);
    return text
      .split("\n")
      .map((line) => {
        const spaces = line.match(regex);
        return spaces ? line.slice(spaces[0].length) : line;
      })
      .join("\n");
  }

  it("균일 인덴트: 두 알고리즘 결과가 동일하다", () => {
    const input = "  line1\n  line2\n  line3";
    const expected = "line1\nline2\nline3";
    expect(smartRemoveIndent(input)).toBe(expected);
    expect(memoShiftTabDedent(input, 2)).toBe(expected);
  });

  it("계층 인덴트(2sp+4sp): 둘 다 최소 단위(2sp)만 제거, 상대 구조 보존", () => {
    const input = "  if (true) {\n    return 1;\n  }";
    const expected = "if (true) {\n  return 1;\n}";
    expect(smartRemoveIndent(input)).toBe(expected);
    expect(memoShiftTabDedent(input, 2)).toBe(expected);
  });

  it("인덴트 없는 줄 포함: smartRemoveIndent는 제거 안 함, Shift+Tab은 개별 제거", () => {
    // 첫 줄에 인덴트 없음 → min indent = 0
    const input = "line1\n  line2\n  line3";
    // smartRemoveIndent: min=0 → 변경 없음 (공통 인덴트가 0)
    expect(smartRemoveIndent(input)).toBe("line1\n  line2\n  line3");
    // Shift+Tab: 각 줄 독립 처리 → line2, line3의 인덴트 제거
    expect(memoShiftTabDedent(input, 2)).toBe("line1\nline2\nline3");
  });

  it("indentSize 미만 인덴트: smartRemoveIndent는 최소만, Shift+Tab은 개별 최대", () => {
    // 1sp + 3sp 혼합
    const input = " line1\n   line2";
    // smartRemoveIndent: min=1 → 모든 줄에서 1sp 제거, 상대 구조 보존
    expect(smartRemoveIndent(input)).toBe("line1\n  line2");
    // Shift+Tab(2): line1에서 1sp, line2에서 2sp 독립 제거
    expect(memoShiftTabDedent(input, 2)).toBe("line1\n line2");
  });

  it("round-trip: Tab indent → smartRemoveIndent → 원본 복원", () => {
    const original = "function foo() {\n  return bar;\n}";
    // MemoView Tab(2sp) 시뮬레이션: 모든 줄에 2sp 추가
    const tabIndented = original
      .split("\n")
      .map((l) => "  " + l)
      .join("\n");
    expect(tabIndented).toBe("  function foo() {\n    return bar;\n  }");
    // smartRemoveIndent: 공통 2sp 제거 → 원본 복원
    expect(smartRemoveIndent(tabIndented)).toBe(original);
  });

  it("round-trip: Tab 2회 indent → smartRemoveIndent → 원본 복원", () => {
    const original = "a\n  b\nc";
    const doubleIndented = original
      .split("\n")
      .map((l) => "    " + l)
      .join("\n");
    // smartRemoveIndent: 공통 4sp 제거 → 원본 복원
    expect(smartRemoveIndent(doubleIndented)).toBe(original);
  });

  it("공백만 있는 줄: smartRemoveIndent는 보존, Shift+Tab은 제거", () => {
    // MemoView에서 빈 줄 포함 텍스트를 Tab 인덴트한 경우
    // "  " (2sp)는 trim하면 빈 줄 → smartRemoveIndent가 건드리지 않음
    const input = "  line1\n  \n  line3";
    // smartRemoveIndent: 공백 줄은 그대로 유지 (min 계산에서 제외, slice도 안 함)
    expect(smartRemoveIndent(input)).toBe("line1\n  \nline3");
    // Shift+Tab: 공백 줄의 2sp도 독립적으로 제거
    expect(memoShiftTabDedent(input, 2)).toBe("line1\n\nline3");
  });
});
