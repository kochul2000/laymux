/**
 * Extract the first http(s) URL from a notification message.
 *
 * Codex (and other tools) emit notifications whose body carries a URL —
 * e.g. an auth/login link. The notification UI surfaces that URL as a
 * clickable link so the user can open it in their default browser via the
 * Tauri opener/shell plugin (issue #345: plain `window.open` does not work
 * inside the Tauri webview, so the click must route through `openExternal`).
 *
 * Returns the first match, or `null` when the message has no URL. Trailing
 * punctuation that is unlikely to be part of the URL (e.g. a sentence-ending
 * period, or an unbalanced closing bracket) is trimmed.
 */
export function extractNotificationUrl(message: string): string | null {
  // Match an http(s) URL. The character class is permissive on purpose —
  // we trim trailing punctuation afterwards rather than trying to model
  // every edge case in the regex.
  const match = message.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;

  let url = match[0];
  // Strip trailing sentence punctuation that commonly hugs a URL in prose
  // but is not part of it.
  url = url.replace(/[.,;:!?]+$/, "");
  // Strip a single unbalanced trailing closer (e.g. "(see https://x)" ).
  const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (;;) {
    const last = url[url.length - 1];
    const opener = closers[last];
    if (!opener) break;
    const opens = url.split(opener).length - 1;
    const closes = url.split(last).length - 1;
    if (closes > opens) {
      url = url.slice(0, -1);
    } else {
      break;
    }
  }

  return url.length > 0 ? url : null;
}
