/**
 * Normalization for the configurable Claude/Codex launch commands.
 *
 * `claude.command` / `codex.command` are typed into a fresh shell verbatim, so
 * only an executable name/path and flags are allowed — no shell metacharacter
 * can start a second command, a substitution, or a redirection. This mirrors
 * `src-tauri/src/settings/agent_command.rs`: the backend re-derives the expected
 * restore command from settings on disk and rejects anything else, so both sides
 * must normalize a given setting to the exact same string.
 */

export const DEFAULT_CLAUDE_COMMAND = "claude";
export const DEFAULT_CODEX_COMMAND = "codex";

/** Alphanumerics plus the punctuation an executable path and its flags need. */
const SAFE_AGENT_COMMAND_PATTERN = /^[A-Za-z0-9 \-_./\\:=,]+$/;

/**
 * Collapse surrounding and repeated spaces, matching the Rust side. Only the
 * space character is collapsed — a newline or tab must survive to be rejected
 * instead of silently welding two lines into one command.
 */
function collapseWhitespace(raw: string): string {
  return raw.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ");
}

/**
 * Whether a configured command may be executed as typed. A value starting with
 * `-` is rejected too: the first token is the executable, not a flag.
 */
export function isSafeAgentCommand(raw: string): boolean {
  const normalized = collapseWhitespace(raw);
  return !normalized.startsWith("-") && SAFE_AGENT_COMMAND_PATTERN.test(normalized);
}

/**
 * Normalized command to launch, falling back to `fallback` when the configured
 * value is empty or unsafe. Never returns a string that fails `isSafeAgentCommand`.
 */
export function resolveAgentCommand(raw: string | undefined | null, fallback: string): string {
  const normalized = collapseWhitespace(raw ?? "");
  return isSafeAgentCommand(normalized) ? normalized : fallback;
}
