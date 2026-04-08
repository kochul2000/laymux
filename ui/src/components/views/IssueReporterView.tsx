import { useState, useRef, useEffect } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { inputStyle } from "@/components/ui/FormControls";
import { ViewShell } from "@/components/ui/ViewShell";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ViewBody } from "@/components/ui/ViewBody";

type SubmitState = "idle" | "capturing" | "submitting" | "success" | "error";

interface IssueReporterViewProps {
  isFocused?: boolean;
}

/** Extract issue number from a GitHub issue URL like https://github.com/owner/repo/issues/123 */
function extractIssueNumber(url: string): number | null {
  const match = url.match(/\/issues\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function IssueReporterView({ isFocused }: IssueReporterViewProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [state, setState] = useState<SubmitState>("idle");
  const [resultMsg, setResultMsg] = useState("");
  const [showPreview, setShowPreview] = useState(true);
  const [issueNumber, setIssueNumber] = useState<number | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    captureScreenshot();
  }, []);

  // Auto-focus title input when view receives focus
  useEffect(() => {
    if (isFocused) {
      titleRef.current?.focus();
    }
  }, [isFocused]);

  const captureScreenshot = async () => {
    setState("capturing");
    try {
      const res = await fetch("http://127.0.0.1:19280/api/v1/screenshot", { method: "POST" });
      const data = await res.json();
      if (data.path) setScreenshotPath(data.path);
      if (data.dataUrl) setScreenshotDataUrl(data.dataUrl);
    } catch {
      /* optional */
    }
    setState("idle");
  };

  const handleSubmit = async () => {
    if (!title.trim() || submittingRef.current) return;
    submittingRef.current = true;
    setState("submitting");
    setResultMsg("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const url = await invoke<string>("submit_github_issue", {
        title: title.trim(),
        body,
        screenshotPath,
        issueNumber,
      });
      setState("idle");
      setResultMsg(url);
      const num = extractIssueNumber(url);
      if (num !== null) setIssueNumber(num);
    } catch (e) {
      setState("error");
      setResultMsg(String(e));
    } finally {
      submittingRef.current = false;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleNewReport = () => {
    setTitle("");
    setBody("");
    setResultMsg("");
    setState("idle");
    setIssueNumber(null);
  };

  const ir = useSettingsStore((s) => s.issueReporter);
  const appFont = useSettingsStore((s) => s.appFont);

  return (
    <ViewShell
      testId="issue-reporter-view"
      onKeyDown={handleKeyDown}
      style={{ color: "var(--text-primary)", background: "var(--bg-base)" }}
    >
      <ViewHeader testId="issue-reporter-header" title="Report Issue" />
      <ViewBody
        testId="issue-reporter-body"
        className="flex flex-col"
        style={{
          padding: `${ir.paddingTop}px ${ir.paddingRight}px ${ir.paddingBottom}px ${ir.paddingLeft}px`,
        }}
      >
        {/* Screenshot status */}
        <div
          className="mb-1 flex items-center gap-1 rounded px-1 py-1"
          style={{
            background: "var(--bg-overlay)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
          }}
        >
          {screenshotPath ? (
            <button
              onClick={() => setShowPreview((v) => !v)}
              className="flex flex-1 cursor-pointer items-center gap-1 text-left"
              style={{ background: "transparent", border: "none" }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect
                  x="1"
                  y="2"
                  width="12"
                  height="10"
                  rx="1.5"
                  stroke="var(--green)"
                  strokeWidth="1.2"
                />
                <circle cx="5" cy="6" r="1.5" stroke="var(--green)" strokeWidth="1" />
                <path
                  d="M3 11l3-3 2 1.5 3-4"
                  stroke="var(--green)"
                  strokeWidth="1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="truncate text-[11px]" style={{ color: "var(--green)" }}>
                Screenshot captured
              </span>
              <span className="text-[9px]" style={{ color: "var(--text-secondary)", opacity: 0.5 }}>
                {showPreview ? "hide" : "preview"}
              </span>
            </button>
          ) : (
            <span className="flex-1 text-[11px]" style={{ color: "var(--text-secondary)" }}>
              {state === "capturing" ? "Capturing..." : "No screenshot"}
            </span>
          )}
          <button
            onClick={captureScreenshot}
            className="hover-bg shrink-0 cursor-pointer rounded px-1 py-0.5 text-[10px] font-medium"
            style={{
              color: "var(--accent)",
              border: "1px solid var(--accent-20)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <span style={{ fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'" }}>
              {"\uE722"}
            </span>{" "}
            Capture
          </button>
        </div>

        {/* Screenshot preview */}
        {showPreview && screenshotDataUrl && (
          <div
            className="mb-1 overflow-hidden rounded"
            style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)" }}
          >
            <img
              src={screenshotDataUrl}
              alt="Screenshot preview"
              className="w-full"
              style={{ maxHeight: 200, objectFit: "contain", background: "#000" }}
            />
          </div>
        )}

        {/* Title */}
        <input
          ref={titleRef}
          data-testid="issue-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={state === "submitting"}
          placeholder="Issue title"
          className="mb-1 w-full rounded px-1 py-1 ui-focus-ring"
          style={{
            ...inputStyle,
            fontFamily: ir.fontFamily || appFont.face,
            fontSize: `${ir.fontSize || appFont.size}px`,
            fontWeight: ir.fontWeight || appFont.weight,
          }}
        />

        {/* Body */}
        <textarea
          ref={textareaRef}
          data-testid="issue-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={state === "submitting"}
          placeholder="Describe the issue..."
          className="mb-1 min-h-0 w-full flex-1 resize-none rounded px-1 py-1 leading-relaxed"
          style={{
            ...inputStyle,
            minHeight: 80,
            fontFamily: ir.fontFamily || appFont.face,
            fontSize: `${ir.fontSize || appFont.size}px`,
            fontWeight: ir.fontWeight || appFont.weight,
          }}
        />

        {/* Submit bar */}
        <div
          className="flex items-center gap-1 rounded px-1 py-1"
          style={{
            background: "var(--bg-overlay)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <button
            data-testid="issue-submit"
            onClick={handleSubmit}
            disabled={!title.trim() || state === "submitting"}
            className="cursor-pointer px-1 py-1 text-xs font-medium"
            style={{
              background: "var(--accent)",
              color: "var(--bg-base)",
              border: "none",
              borderRadius: "var(--radius-md)",
              opacity: !title.trim() || state === "submitting" ? 0.4 : 1,
              transition: "opacity 0.15s",
            }}
            title="Ctrl+Enter"
          >
            {state === "submitting" ? "Saving..." : "Save"}
          </button>

          {(issueNumber !== null || state === "error") && (
            <button
              data-testid="issue-new-report"
              onClick={handleNewReport}
              className="cursor-pointer px-1 py-1 text-xs font-medium"
              style={{
                background: "transparent",
                color: "var(--accent)",
                border: "1px solid var(--accent-20)",
                borderRadius: "var(--radius-md)",
              }}
            >
              New Issue
            </button>
          )}

          {issueNumber !== null && resultMsg && state === "idle" && (
            <span className="truncate text-[11px]" style={{ color: "var(--green)" }}>
              ✓
            </span>
          )}
          {state === "error" && (
            <span className="truncate text-[11px]" style={{ color: "var(--red)" }}>
              {resultMsg}
            </span>
          )}
        </div>

        {/* Issue link */}
        {issueNumber !== null && resultMsg && (
          <a
            data-testid="issue-link"
            href={resultMsg}
            onClick={async (e) => {
              e.preventDefault();
              try {
                const { open } = await import("@tauri-apps/plugin-shell");
                await open(resultMsg);
              } catch (e) {
                console.warn("shell.open failed, falling back to window.open:", e);
                window.open(resultMsg, "_blank");
              }
            }}
            className="mt-1 truncate text-[11px] underline"
            style={{ color: "var(--accent)", cursor: "pointer" }}
            title={resultMsg}
          >
            {resultMsg}
          </a>
        )}
      </ViewBody>
    </ViewShell>
  );
}
