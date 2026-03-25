import { useState, useRef, useCallback, useEffect } from "react";

interface BrowserPreviewViewProps {
  url?: string;
}

export function BrowserPreviewView({
  url: initialUrl = "about:blank",
}: BrowserPreviewViewProps) {
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Sync state when the url prop changes externally
  useEffect(() => {
    setCurrentUrl(initialUrl);
    setInputUrl(initialUrl);
  }, [initialUrl]);

  const navigate = useCallback((raw: string) => {
    let normalized = raw.trim();
    if (!normalized) return;
    // Auto-add protocol for bare hostnames
    if (!/^https?:\/\//.test(normalized) && normalized !== "about:blank") {
      normalized = `http://${normalized}`;
    }
    setError(null);
    setLoading(true);
    setCurrentUrl(normalized);
    setInputUrl(normalized);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        navigate(inputUrl);
      }
    },
    [inputUrl, navigate],
  );

  const handleReload = useCallback(() => {
    if (iframeRef.current) {
      setLoading(true);
      iframeRef.current.src = currentUrl;
    }
  }, [currentUrl]);

  const btnClass =
    "flex h-7 w-7 cursor-pointer items-center justify-center rounded text-sm";
  const btnStyle = {
    color: "var(--text-secondary)",
    background: "transparent",
    border: "none",
  };

  return (
    <div data-testid="browser-preview" className="flex h-full flex-col">
      {/* Toolbar */}
      <div
        className="flex shrink-0 items-center gap-1 px-2 py-1"
        style={{
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-surface)",
        }}
      >
        <button
          data-testid="browser-back-btn"
          onClick={() => iframeRef.current?.contentWindow?.history.back()}
          className={btnClass}
          style={btnStyle}
          title="Back"
        >
          &#9664;
        </button>
        <button
          data-testid="browser-forward-btn"
          onClick={() => iframeRef.current?.contentWindow?.history.forward()}
          className={btnClass}
          style={btnStyle}
          title="Forward"
        >
          &#9654;
        </button>
        <button
          data-testid="browser-reload-btn"
          onClick={handleReload}
          className={btnClass}
          style={btnStyle}
          title="Reload"
        >
          &#8635;
        </button>
        <input
          data-testid="browser-url-input"
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL (e.g. localhost:3000)"
          className="min-w-0 flex-1 rounded px-2 py-1 text-xs"
          style={{
            border: "1px solid var(--border)",
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            outline: "none",
          }}
        />
      </div>

      {/* Content area */}
      <div className="relative min-h-0 flex-1">
        {currentUrl === "about:blank" ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2"
            style={{ color: "var(--text-secondary)" }}
          >
            <p className="text-sm">Enter a URL to preview</p>
            <p className="text-xs" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
              e.g. localhost:3000, localhost:8080
            </p>
          </div>
        ) : (
          <>
            <iframe
              data-testid="browser-iframe"
              ref={iframeRef}
              src={currentUrl}
              className="h-full w-full border-0"
              style={{ background: "#fff" }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              title="Browser Preview"
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setError("Failed to load page");
              }}
            />
            {/* Loading indicator */}
            {loading && (
              <div
                className="absolute left-0 top-0 h-0.5 w-full"
                style={{ background: "var(--accent)" }}
              />
            )}
            {/* Error overlay */}
            {error && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{ background: "var(--bg-base)", color: "var(--text-secondary)" }}
              >
                <p className="text-sm">{error}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
