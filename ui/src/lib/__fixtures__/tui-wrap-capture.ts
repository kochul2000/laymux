/**
 * dev(88 cols) 실측 버퍼 — Claude Code v2.1.294 · Codex v0.160.1 이 같은 마크다운
 * 답변을 그린 결과다. `GET /api/v1/terminals/:id/buffer` 덤프에서 행 텍스트(끝쪽
 * 패딩 제거)와 `isWrapped` 만 옮겼다.
 *
 * 두 TUI 모두 문단을 **자체 레이아웃으로** 나눠 행마다 진짜 개행을 쓴다
 * (`isWrapped=false`). 첫 행은 `● `/`• ` 마커, 연속 행은 내어쓰기(2칸, 목록은
 * 4칸)다. Claude 는 긴 URL 을 화면 끝 셀에서 그대로 자르고, Codex 는 URL 을 자기
 * 행으로 빼서 터미널 soft-wrap(`isWrapped=true`)에 맡긴다. 한글 문단은 Claude 가
 * 어절 단위, Codex 가 글자 단위(`레이`/`아웃으로`)로 나눈다.
 */

export const CAPTURE_COLS = 88;

/** 버퍼 행 — `wrapped` 는 xterm `isWrapped`(터미널 soft-wrap 의 연속 행). */
export interface CaptureRow {
  text: string;
  wrapped?: boolean;
}

const rows = (...texts: (string | CaptureRow)[]): CaptureRow[] =>
  texts.map((t) => (typeof t === "string" ? { text: t } : t));
const soft = (text: string): CaptureRow => ({ text, wrapped: true });

export const CLAUDE = {
  koreanParagraph: rows(
    "● 이 변경은 터미널 복사 경로에서 줄바꿈을 제거하는데, 실제로는 Claude Code 가 자체",
    "  레이아웃으로 줄을 나누기 때문에 xterm 은 이를 소프트 랩으로 보지 못하고 개행으로",
    "  복사하게 되며, 그 결과 사용자가 붙여넣은 문단이 화면 폭마다 끊겨 버린다.",
  ),
  englishParagraph: rows(
    "  This paragraph is intentionally long English prose so that the terminal user interface",
    "  has to wrap it across several visual rows, which lets us observe whether the wrapped",
    "  rows are stored as soft wraps or hard newlines.",
  ),
  list: rows(
    "  - 목록 항목 문서는 https://github.com/kochul2000/laymux/blob/main/docs/architecture/da",
    "    ta-flow.md#terminal-view-osc-pipeline-and-renderer-reflow-details 를 참고하세요.",
    "  - PR 링크는 https://github.com/kochul2000/laymux/pull/1146 이고 뒤에 이어지는 설명",
    "    문장이 충분히 길어서 다음 줄로 넘어가야 한다.",
  ),
  urlWithParticle: rows(
    "  자세한 내용은 https://example.com/very/long/path/segment/that/should/wrap/across/the/t",
    "  erminal/width/because/it/is/really/long?query=value&another=thing에서 확인하세요.",
  ),
  markdownLinks: rows(
    "  마크다운 링크 (https://en.wikipedia.org/wiki/Rust_(programming_language)) 와",
    "  https://example.com/bold 강조, 그리고 https://example.com/inline-code 코드.",
  ),
  /** 답변 뒤 상태 줄·입력 박스·하단 바 — 어떤 행도 이어 붙으면 안 된다. */
  chrome: rows(
    "  curl -H Authorization:",
    "",
    "✻ Worked for 6s · done 오후 9:32",
    "",
    "────────────────────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────────────────────",
    "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart w…",
    "  ⏵⏵ auto mode on (shift+tab to cycle)                                             /rc",
  ),
  /** 사용자 프롬프트 에코 — 목록이어도 연속 행이 2칸이다. */
  promptEchoList: rows(
    "  - 목록 항목 문서는 https://github.com/kochul2000/laymux/blob/main/docs/architecture/d",
    "  ata-flow.md#terminal-view-osc-pipeline-and-renderer-reflow-details 를 참고하세요.",
  ),
};

export const CODEX = {
  koreanParagraph: rows(
    "• 이 변경은 터미널 복사 경로에서 줄바꿈을 제거하는데, 실제로는 Claude Code 가 자체 레이",
    "  아웃으로 줄을 나누기 때문에 xterm 은 이를 소프트 랩으로 보지 못하고 개행으로 복사하게",
    "  되며, 그 결과 사용자가 붙여넣은 문단이 화면 폭마다 끊겨 버린다.",
  ),
  englishParagraph: rows(
    "  This paragraph is intentionally long English prose so that the terminal user interface",
    "  has to wrap it across several visual rows, which lets us observe whether the wrapped",
    "  rows are stored as soft wraps or hard newlines.",
  ),
  listUrlOwnRow: rows(
    "  • 목록 항목 문서는",
    "",
    "    https://github.com/kochul2000/laymux/blob/main/docs/architecture/data-flow.md#termin",
    soft("al-view-osc-pipeline-and-renderer-reflow-details"),
    "    를 참고하세요.",
  ),
  list: rows(
    "  • PR 링크는 https://github.com/kochul2000/laymux/pull/1146 이고 뒤에 이어지는 설명",
    "    문장이 충분히 길어서 다음 줄로 넘어가야 한다.",
  ),
  urlSoftWrapped: rows(
    "  자세한 내용은",
    "  https://example.com/very/long/path/segment/that/should/wrap/across/the/terminal/width/",
    soft("because/it/is/really/long?query=value&another=thing에서"),
    "  확인하세요.",
  ),
  /** 입력창 프롬프트 에코 — 입력창 폭이 cols-1 이라 URL 이 87칸에서 잘렸다. */
  promptEchoUrl: rows(
    "  - 목록 항목 문서는",
    "  https://github.com/kochul2000/laymux/blob/main/docs/architecture/data-flow.md#termina",
    "  l-view-osc-pipeline-and-renderer-reflow-details",
    "  를 참고하세요.",
  ),
};
