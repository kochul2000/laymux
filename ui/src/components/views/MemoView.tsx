import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { loadMemo, saveMemo } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { splitParagraphs } from "@/lib/memo-paragraphs";

const DEBOUNCE_MS = 300;

interface MemoViewProps {
  memoKey: string;
  isFocused?: boolean;
}

export function MemoView({ memoKey, isFocused }: MemoViewProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestTextRef = useRef(text);
  const flushedRef = useRef(true);

  // Load content from memo.json on mount
  useEffect(() => {
    loadMemo(memoKey)
      .then((content) => {
        setText(content);
        latestTextRef.current = content;
      })
      .catch(() => {});
  }, [memoKey]);

  // Focus when isFocused becomes true
  useEffect(() => {
    if (isFocused) {
      textareaRef.current?.focus();
    }
  }, [isFocused]);

  const flush = useCallback(() => {
    if (!flushedRef.current) {
      saveMemo(memoKey, latestTextRef.current).catch(() => {});
      flushedRef.current = true;
    }
  }, [memoKey]);

  // Flush pending content on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      flush();
    };
  }, [flush]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    latestTextRef.current = val;
    flushedRef.current = false;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      saveMemo(memoKey, val).catch(() => {});
      flushedRef.current = true;
    }, DEBOUNCE_MS);
  };

  const memo = useSettingsStore((s) => s.memo);

  // Paragraph copy feature
  const paragraphs = useMemo(() => {
    if (!memo.paragraphCopy.enabled) return [];
    return splitParagraphs(text, memo.paragraphCopy.minBlankLines);
  }, [text, memo.paragraphCopy.enabled, memo.paragraphCopy.minBlankLines]);

  const showParagraphOverlay = memo.paragraphCopy.enabled && paragraphs.length > 1;

  // Copy on select feature
  const handleMouseUp = useCallback(() => {
    if (!memo.copyOnSelect) return;
    const selection = window.getSelection();
    const selectedText = selection?.toString() ?? "";
    if (selectedText) {
      navigator.clipboard.writeText(selectedText).catch(() => {});
    }
  }, [memo.copyOnSelect]);

  return (
    <div data-testid="memo-view" className="flex h-full w-full flex-col">
      <div
        className="flex shrink-0 items-center px-3"
        style={{
          height: 28,
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-secondary)",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        Memo
      </div>
      <div className="relative flex-1">
        <textarea
          ref={textareaRef}
          data-testid="memo-textarea"
          value={text}
          onChange={handleChange}
          onMouseUp={handleMouseUp}
          className="h-full w-full resize-none border-none outline-none"
          style={{
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            fontFamily: "inherit",
            fontSize: "13px",
            lineHeight: "1.6",
            padding: `${memo.paddingTop}px ${memo.paddingRight}px ${memo.paddingBottom}px ${memo.paddingLeft}px`,
          }}
          spellCheck={false}
        />
        {showParagraphOverlay && (
          <ParagraphOverlay
            paragraphs={paragraphs}
            paddingTop={memo.paddingTop}
            paddingLeft={memo.paddingLeft}
            paddingRight={memo.paddingRight}
            textareaRef={textareaRef}
          />
        )}
      </div>
    </div>
  );
}

// --- Paragraph overlay ---

interface ParagraphOverlayProps {
  paragraphs: { text: string; startLine: number; endLine: number }[];
  paddingTop: number;
  paddingLeft: number;
  paddingRight: number;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

function ParagraphOverlay({
  paragraphs,
  paddingTop,
  paddingLeft,
  paddingRight,
  textareaRef,
}: ParagraphOverlayProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const lineHeight = 13 * 1.6; // fontSize * lineHeight

  const handleCopy = (index: number) => {
    const para = paragraphs[index];
    navigator.clipboard.writeText(para.text).catch(() => {});
    setCopied(index);
    setTimeout(() => setCopied(null), 1500);
  };

  // Calculate scroll offset
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const onScroll = () => setScrollTop(textarea.scrollTop);
    textarea.addEventListener("scroll", onScroll);
    return () => textarea.removeEventListener("scroll", onScroll);
  }, [textareaRef]);

  return (
    <div
      data-testid="paragraph-overlay"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {paragraphs.map((para, i) => {
        const top = paddingTop + para.startLine * lineHeight - scrollTop;
        const height = (para.endLine - para.startLine + 1) * lineHeight;

        return (
          <div
            key={i}
            data-testid={`paragraph-region-${i}`}
            className="pointer-events-auto absolute"
            style={{
              top,
              left: 0,
              right: 0,
              height,
              paddingLeft,
              paddingRight,
            }}
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            {hoveredIndex === i && (
              <button
                data-testid={`paragraph-copy-btn-${i}`}
                className="absolute flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  top: 0,
                  right: paddingRight + 4,
                  background: "var(--bg-overlay)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  zIndex: 10,
                  opacity: 0.9,
                }}
                onClick={() => handleCopy(i)}
                title="단락 복사"
              >
                {copied === i ? "Copied!" : "Copy"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
