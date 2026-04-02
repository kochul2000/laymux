import { useState, useRef, useEffect } from "react";
import { useSettingsStore } from "@/stores/settings-store";

type SubmitState = "idle" | "capturing" | "submitting" | "success" | "error";

interface IssueReporterViewProps {
  isFocused?: boolean;
}

export function IssueReporterView({ isFocused }: IssueReporterViewProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [state, setState] = useState<SubmitState>("idle");
  const [resultMsg, setResultMsg] = useState("");
  const [showPreview, setShowPreview] = useState(true);
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
    if (!title.trim() || submittingRef.current || state === "success") return;
    submittingRef.current = true;
    setState("submitting");
    setResultMsg("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const url = await invoke<string>("submit_github_issue", {
        title: title.trim(),
        body,
        screenshotPath,
      });
      setState("success");
      setResultMsg(url);
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
  };

  const ir = useSettingsStore((s) => s.issueReporter);

  const fieldStyle: React.CSSProperties = {
    background: "var(--bg-base)",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
    borderRadius: 3,
    outline: "none",
    colorScheme: "dark",
  };

  return (
    <div
      data-testid="issue-reporter-view"
      className="flex h-full flex-col"
      onKeyDown={handleKeyDown}
      style={{
        color: "var(--text-primary)",
        background: "var(--bg-base)",
        padding: `${ir.paddingTop}px ${ir.paddingRight}px ${ir.paddingBottom}px ${ir.paddingLeft}px`,
      }}
    >
      {/* Header */}
      <div className="mb-4 flex items-center gap-2.5">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" stroke="var(--accent)" strokeWidth="1.5" />
          <path d="M8 4v5" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11.5" r="0.8" fill="var(--accent)" />
        </svg>
        <div>
          <span className="text-sm font-semibold">Report Issue</span>
          <span
            className="ml-2 text-[10px]"
            style={{ color: "var(--text-secondary)", opacity: 0.5 }}
          >
            via gh CLI
          </span>
        </div>
      </div>

      {/* Screenshot status */}
      <div
        className="mb-4 flex items-center gap-2.5 rounded px-3.5 py-2.5"
        style={{
          background: "var(--bg-overlay)",
          border: "1px solid var(--border)",
          borderRadius: 3,
        }}
      >
        {screenshotPath ? (
          <button
            onClick={() => setShowPreview((v) => !v)}
            className="flex flex-1 cursor-pointer items-center gap-2.5 text-left"
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
          className="shrink-0 cursor-pointer rounded px-2.5 py-1 text-[10px] font-medium"
          style={{
            background: "transparent",
            color: "var(--accent)",
            border: "1px solid rgba(137,180,250,0.2)",
            borderRadius: 3,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(137,180,250,0.08)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
        >
          Recapture
        </button>
      </div>

      {/* Screenshot preview */}
      {showPreview && screenshotDataUrl && (
        <div
          className="mb-4 overflow-hidden rounded"
          style={{ border: "1px solid var(--border)", borderRadius: 3 }}
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
        placeholder="Issue title"
        className="mb-3 w-full rounded px-3 py-2 text-xs"
        style={fieldStyle}
      />

      {/* Body */}
      <textarea
        ref={textareaRef}
        data-testid="issue-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Describe the issue..."
        className="mb-4 min-h-0 w-full flex-1 resize-none rounded px-3 py-2 text-xs leading-relaxed"
        style={{ ...fieldStyle, minHeight: 80 }}
      />

      {/* Submit bar */}
      <div
        className="flex items-center gap-3 rounded px-3.5 py-3"
        style={{
          background: "var(--bg-overlay)",
          border: "1px solid var(--border)",
          borderRadius: 3,
        }}
      >
        <button
          data-testid="issue-submit"
          onClick={handleSubmit}
          disabled={!title.trim() || state === "submitting" || state === "success"}
          className="cursor-pointer px-5 py-1.5 text-xs font-medium"
          style={{
            background: state === "success" ? "var(--green)" : "var(--accent)",
            color: "var(--bg-base)",
            border: "none",
            borderRadius: 3,
            opacity: !title.trim() || state === "submitting" || state === "success" ? 0.4 : 1,
            transition: "opacity 0.15s",
          }}
        >
          {state === "submitting"
            ? "Submitting..."
            : state === "success"
              ? "Submitted!"
              : "Submit Issue"}
          {state !== "submitting" && state !== "success" && (
            <span className="ml-2 text-[10px] opacity-50" style={{ fontWeight: "normal" }}>
              Ctrl+Enter
            </span>
          )}
        </button>

        {(state === "success" || state === "error") && (
          <button
            data-testid="issue-new-report"
            onClick={handleNewReport}
            className="cursor-pointer px-4 py-1.5 text-xs font-medium"
            style={{
              background: "transparent",
              color: "var(--accent)",
              border: "1px solid rgba(137,180,250,0.2)",
              borderRadius: 3,
            }}
          >
            New Report
          </button>
        )}

        {state === "success" && resultMsg && (
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
      {state === "success" && resultMsg && (
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
          className="mt-2 truncate text-[11px] underline"
          style={{ color: "var(--accent)", cursor: "pointer" }}
          title={resultMsg}
        >
          {resultMsg}
        </a>
      )}
    </div>
  );
}
