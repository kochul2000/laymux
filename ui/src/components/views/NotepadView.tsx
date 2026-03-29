import { useState, useEffect, useRef, useCallback } from "react";

const DEBOUNCE_MS = 300;

interface NotepadViewProps {
  content?: string;
  onContentChange?: (content: string) => void;
  isFocused?: boolean;
}

export function NotepadView({ content = "", onContentChange, isFocused }: NotepadViewProps) {
  const [text, setText] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestTextRef = useRef(text);
  const flushedRef = useRef(true);

  // Sync from external content prop changes
  useEffect(() => {
    setText(content);
    latestTextRef.current = content;
    flushedRef.current = true;
  }, [content]);

  // Focus when isFocused becomes true
  useEffect(() => {
    if (isFocused) {
      textareaRef.current?.focus();
    }
  }, [isFocused]);

  const flush = useCallback(() => {
    if (!flushedRef.current) {
      onContentChange?.(latestTextRef.current);
      flushedRef.current = true;
    }
  }, [onContentChange]);

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
      onContentChange?.(val);
      flushedRef.current = true;
    }, DEBOUNCE_MS);
  };

  return (
    <div data-testid="notepad-view" className="flex h-full w-full flex-col">
      <textarea
        ref={textareaRef}
        data-testid="notepad-textarea"
        value={text}
        onChange={handleChange}
        className="h-full w-full flex-1 resize-none border-none p-3 outline-none"
        style={{
          background: "var(--bg-base)",
          color: "var(--text-primary)",
          fontFamily: "inherit",
          fontSize: "13px",
          lineHeight: "1.6",
        }}
        spellCheck={false}
      />
    </div>
  );
}
