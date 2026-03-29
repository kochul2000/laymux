import { useState, useEffect, useRef, useCallback } from "react";
import { loadMemo, saveMemo } from "@/lib/tauri-api";

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

  return (
    <div data-testid="memo-view" className="flex h-full w-full flex-col">
      <textarea
        ref={textareaRef}
        data-testid="memo-textarea"
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
