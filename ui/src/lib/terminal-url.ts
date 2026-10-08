/**
 * 터미널 평문 URL 경계 — `WebLinksAddon`(`urlRegex`), 여러 줄 URL provider, TUI
 * 마우스 트래킹 우회 클릭이 같은 경계를 쓴다.
 *
 * `@xterm/addon-web-links` 기본 정규식은 공백·일부 기호만 제외해서, 한국어 출력의
 * 흔한 모양인 `https://…/a에서`·`…/pull/12를` 에 조사까지 링크하고, 마크다운
 * `**url**` 의 `*` 하나를 남기며, 위키백과식 `…_(언어)` 괄호는 잘라 버린다.
 *
 * - URL 문자는 RFC 3986 의 ASCII 집합만 허용한다(Windows Terminal·VS Code 와 같은
 *   선택). 한글·전각 문자가 나오면 URL 이 끝난다. 퍼센트 인코딩되지 않은 한글
 *   경로(IRI)는 그 앞까지만 링크된다 — 조사 오탐보다 드문 쪽을 포기한다.
 * - 괄호는 **짝이 맞을 때만** 포함한다. 감싸는 `(url)` 의 닫는 괄호는 빠진다.
 * - 끝 문자는 문장 구두점(`. , ; : ! ? ' *`)이 될 수 없다. 백트래킹으로 그 앞에서
 *   끝난다. `[` `]` 는 IPv6 호스트 외에는 경계 쪽이 흔해 URL 문자에서 뺀다.
 */

/** 괄호 밖 URL 문자(괄호·대괄호 제외). */
const BODY = "A-Za-z0-9\\-._~:/?#@!$&'*+,;=%";
/** URL 의 마지막 문자가 될 수 있는 문자 — 문장 구두점 제외. */
const END = "A-Za-z0-9\\-_~/#@$&+=%";
const BALANCED = `\\([${BODY}]*\\)`;

export const TERMINAL_URL_REGEX = new RegExp(
  `(?:https?|HTTPS?)://(?:[${BODY}]|${BALANCED})*(?:[${END}]|${BALANCED})`,
);

/** 문자열의 모든 URL 과 UTF-16 오프셋. */
export function matchTerminalUrls(text: string): { text: string; index: number }[] {
  const re = new RegExp(TERMINAL_URL_REGEX.source, "g");
  return [...text.matchAll(re)].map((m) => ({ text: m[0], index: m.index }));
}
