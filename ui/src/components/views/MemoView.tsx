import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { loadMemo, saveMemo, clipboardWriteText } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { splitParagraphs } from "@/lib/memo-paragraphs";
import { ViewShell } from "@/components/ui/ViewShell";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ViewBody } from "@/components/ui/ViewBody";

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
  const appFont = useSettingsStore((s) => s.appFont);

  // Paragraph copy feature
  const paragraphs = useMemo(() => {
    if (!memo.paragraphCopy.enabled) return [];
    return splitParagraphs(text, memo.paragraphCopy.minBlankLines);
  }, [text, memo.paragraphCopy.enabled, memo.paragraphCopy.minBlankLines]);

  const showParagraphOverlay = memo.paragraphCopy.enabled && paragraphs.length > 1;

  // Paragraph hover detection via textarea mouse position
  const [hoveredParagraph, setHoveredParagraph] = useState<number | null>(null);
  const effectiveFontSize = memo.fontSize || appFont.size;
  const effectiveFontFamily = memo.fontFamily || appFont.face;
  const effectiveFontWeight = memo.fontWeight || appFont.weight;
  const lineHeight = effectiveFontSize * 1.6; // fontSize * lineHeight

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      if (!showParagraphOverlay) return;
      const textarea = textareaRef.current;
      if (!textarea) return;
      const rect = textarea.getBoundingClientRect();
      const y = e.clientY - rect.top + textarea.scrollTop - memo.paddingTop;
      const line = Math.floor(y / lineHeight);
      const idx = paragraphs.findIndex((p) => line >= p.startLine && line <= p.endLine);
      setHoveredParagraph(idx >= 0 ? idx : null);
    },
    [showParagraphOverlay, paragraphs, memo.paddingTop, lineHeight],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredParagraph(null);
  }, []);

  // Copy on select feature
  const handleMouseUp = useCallback(() => {
    if (!memo.copyOnSelect) return;
    const selection = window.getSelection();
    const selectedText = selection?.toString() ?? "";
    if (selectedText) {
      clipboardWriteText(selectedText).catch(() => {});
    }
  }, [memo.copyOnSelect]);

  // Double-click to select paragraph
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      if (!showParagraphOverlay || !memo.dblClickParagraphSelect) return;
      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorPos = textarea.selectionStart;
      const lines = text.split("\n");

      // Map cursor position to line number
      let charCount = 0;
      let cursorLine = 0;
      for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1; // +1 for \n
        if (charCount > cursorPos) {
          cursorLine = i;
          break;
        }
      }

      // Find which paragraph this line belongs to
      const paraIdx = paragraphs.findIndex(
        (p) => cursorLine >= p.startLine && cursorLine <= p.endLine,
      );
      if (paraIdx < 0) return;

      const para = paragraphs[paraIdx];

      // Calculate character offsets for this paragraph
      let startOffset = 0;
      for (let i = 0; i < para.startLine; i++) {
        startOffset += lines[i].length + 1;
      }
      let endOffset = startOffset;
      for (let i = para.startLine; i <= para.endLine; i++) {
        endOffset += lines[i].length + (i < para.endLine ? 1 : 0);
      }

      // Prevent default word selection and select paragraph instead
      e.preventDefault();
      textarea.setSelectionRange(startOffset, endOffset);

      // Copy if copyOnSelect is enabled
      if (memo.copyOnSelect) {
        clipboardWriteText(para.text).catch(() => {});
      }
    },
    [showParagraphOverlay, memo.dblClickParagraphSelect, text, paragraphs, memo.copyOnSelect],
  );

  return (
    <ViewShell testId="memo-view">
      <ViewHeader testId="memo-header" title="Memo" />
      <ViewBody variant="full" onMouseLeave={handleMouseLeave}>
        <textarea
          ref={textareaRef}
          data-testid="memo-textarea"
          value={text}
          onChange={handleChange}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          onDoubleClick={handleDoubleClick}
          className="h-full w-full resize-none border-none outline-none"
          style={{
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            fontFamily: effectiveFontFamily,
            fontSize: `${effectiveFontSize}px`,
            fontWeight: effectiveFontWeight,
            lineHeight: "1.6",
            padding: `${memo.paddingTop}px ${memo.paddingRight}px ${memo.paddingBottom}px ${memo.paddingLeft}px`,
          }}
          spellCheck={false}
        />
        {showParagraphOverlay && (
          <ParagraphOverlay
            paragraphs={paragraphs}
            paddingTop={memo.paddingTop}
            paddingRight={memo.paddingRight}
            hoveredIndex={hoveredParagraph}
            textareaRef={textareaRef}
            fontSize={effectiveFontSize}
          />
        )}
      </ViewBody>
    </ViewShell>
  );
}

// --- Paragraph overlay ---

interface ParagraphOverlayProps {
  paragraphs: { text: string; startLine: number; endLine: number }[];
  paddingTop: number;
  paddingRight: number;
  hoveredIndex: number | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fontSize?: number;
}

function ParagraphOverlay({
  paragraphs,
  paddingTop,
  paddingRight,
  hoveredIndex,
  textareaRef,
  fontSize = 13,
}: ParagraphOverlayProps) {
  const [copied, setCopied] = useState<number | null>(null);
  const lineHeight = fontSize * 1.6; // fontSize * lineHeight

  const handleCopy = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    const para = paragraphs[index];
    clipboardWriteText(para.text).catch(() => {});
    setCopied(index);
    setTimeout(() => setCopied(null), 1500);
    // Return focus to textarea after copy
    textareaRef.current?.focus();
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

        return (
          <div
            key={i}
            data-testid={`paragraph-region-${i}`}
            className="absolute"
            style={{ top, right: 0 }}
          >
            {hoveredIndex === i && (
              <button
                data-testid={`paragraph-copy-btn-${i}`}
                className="pointer-events-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  marginRight: paddingRight + 4,
                  background: "var(--bg-overlay)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  zIndex: 10,
                  opacity: 0.9,
                }}
                onMouseDown={(e) => handleCopy(e, i)}
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
