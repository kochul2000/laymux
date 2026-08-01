/**
 * The banner every structured preview uses to admit what it is not showing.
 *
 * ADR-0109 forbids silent truncation: a renderer that caps rows, records or
 * highlighting has to say so, because a capped view is indistinguishable from a
 * complete one and reads as "you are seeing everything".
 */
export type PreviewNoticeTone = "info" | "warning" | "error";

const TONE_BACKGROUND: Record<PreviewNoticeTone, string> = {
  info: "var(--accent-08)",
  warning: "var(--yellow-08)",
  error: "var(--red-08)",
};

const TONE_TEXT: Record<PreviewNoticeTone, string> = {
  info: "var(--text-secondary)",
  warning: "var(--yellow)",
  error: "var(--red)",
};

export function PreviewNotice({
  tone = "warning",
  children,
  testId,
}: {
  tone?: PreviewNoticeTone;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="px-3 py-1"
      style={{
        background: TONE_BACKGROUND[tone],
        color: TONE_TEXT[tone],
        borderBottom: "1px solid var(--border)",
        fontSize: "var(--fs-sm)",
        flex: "0 0 auto",
      }}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
