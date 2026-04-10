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

  // Lazy copy on select: remember selected text, copy on deselect / blur / Ctrl+C
  const pendingCopyRef = useRef<string | null>(null);
  const flushedGuardRef = useRef(false);

  const flushPendingCopy = useCallback(() => {
    if (pendingCopyRef.current) {
      clipboardWriteText(pendingCopyRef.current).catch(() => {});
      pendingCopyRef.current = null;
      // Prevent selectionchange from re-storing the same text right after flush
      flushedGuardRef.current = true;
      requestAnimationFrame(() => {
        flushedGuardRef.current = false;
      });
    }
  }, []);

  const discardPendingCopy = useCallback(() => {
    pendingCopyRef.current = null;
    flushedGuardRef.current = true;
    requestAnimationFrame(() => {
      flushedGuardRef.current = false;
    });
  }, []);

  // Track selection changes (covers drag, double-click, triple-click, keyboard select)
  useEffect(() => {
    if (!memo.copyOnSelect) return;
    const onSelectionChange = () => {
      if (flushedGuardRef.current) return;
      const textarea = textareaRef.current;
      if (!textarea) return;
      const isFocused = document.activeElement === textarea;
      if (!isFocused) {
        // Focus left textarea → flush whatever was pending
        if (pendingCopyRef.current) flushPendingCopy();
        return;
      }
      const selectedText = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      if (selectedText) {
        pendingCopyRef.current = selectedText;
      } else if (pendingCopyRef.current) {
        // Selection cleared within textarea → flush
        flushPendingCopy();
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [memo.copyOnSelect, flushPendingCopy]);

  // Rule 3: paste event discards pending (user is replacing content with clipboard)
  const handlePaste = useCallback(() => {
    discardPendingCopy();
  }, [discardPendingCopy]);

  // Flush pending copy when focus leaves memo: window blur (external app)
  // or click outside textarea (dock/sidebar/other pane)
  useEffect(() => {
    const onWindowBlur = () => flushPendingCopy();
    const onDocumentMouseDown = (e: MouseEvent) => {
      if (!pendingCopyRef.current) return;
      if (textareaRef.current && !textareaRef.current.contains(e.target as Node)) {
        flushPendingCopy();
      }
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("mousedown", onDocumentMouseDown, true);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("mousedown", onDocumentMouseDown, true);
    };
  }, [flushPendingCopy]);

  // Triple-click to select paragraph (changed from double-click)
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      if (e.detail !== 3) return; // Only handle triple-click
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

      // Prevent default line selection and select paragraph instead
      e.preventDefault();
      textarea.setSelectionRange(startOffset, endOffset);

      if (memo.copyOnSelect) {
        pendingCopyRef.current = text.slice(startOffset, endOffset);
      }
    },
    [showParagraphOverlay, memo.dblClickParagraphSelect, memo.copyOnSelect, text, paragraphs],
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
          onPaste={handlePaste}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
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
  const [copyBtnHoveredIdx, setCopyBtnHoveredIdx] = useState<number | null>(null);
  const lineHeight = fontSize * 1.6; // fontSize * lineHeight
  const [containerHeight, setContainerHeight] = useState(0);

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

  // Track overlay container height via callback ref + ResizeObserver
  const roRef = useRef<ResizeObserver | null>(null);
  const overlayCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!node) return;
    setContainerHeight(node.clientHeight);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);

  // Calculate scroll offset
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const onScroll = () => setScrollTop(textarea.scrollTop);
    textarea.addEventListener("scroll", onScroll);
    return () => textarea.removeEventListener("scroll", onScroll);
  }, [textareaRef]);

  // Pre-compute clamped positions outside of JSX render
  const clampedTops = useMemo(() => {
    const btnHeight = 22;
    const minTop = 4;
    const maxTop = containerHeight - btnHeight - 4;
    return paragraphs.map((para) => {
      const rawTop = paddingTop + para.startLine * lineHeight - scrollTop;
      return containerHeight > 0 ? Math.max(minTop, Math.min(rawTop, maxTop)) : rawTop;
    });
  }, [paragraphs, paddingTop, lineHeight, scrollTop, containerHeight]);

  return (
    <div
      ref={overlayCallbackRef}
      data-testid="paragraph-overlay"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* Highlight overlay when copy button is hovered */}
      {copyBtnHoveredIdx !== null && paragraphs[copyBtnHoveredIdx] && (
        <div
          data-testid={`paragraph-highlight-${copyBtnHoveredIdx}`}
          className="absolute left-0 right-0"
          style={{
            top: paddingTop + paragraphs[copyBtnHoveredIdx].startLine * lineHeight - scrollTop,
            height:
              (paragraphs[copyBtnHoveredIdx].endLine -
                paragraphs[copyBtnHoveredIdx].startLine +
                1) *
              lineHeight,
            background: "var(--accent-12)",
            borderRadius: "var(--radius-sm, 4px)",
            pointerEvents: "none",
          }}
        />
      )}
      {paragraphs.map((_para, i) => {
        return (
          <div
            key={i}
            data-testid={`paragraph-region-${i}`}
            className="absolute"
            style={{ top: clampedTops[i], right: 0 }}
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
                onMouseEnter={() => setCopyBtnHoveredIdx(i)}
                onMouseLeave={() => setCopyBtnHoveredIdx(null)}
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
