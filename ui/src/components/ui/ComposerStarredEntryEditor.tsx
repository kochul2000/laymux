import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { FocusInput } from "@/components/ui/FormControls";
import { inputCls, inputStyle } from "@/components/ui/form-control-styles";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { XIcon } from "@/components/ui/icons";
import type { ComposerStarredEntry } from "@/lib/terminal-input-composer-state";

export type ComposerStarredEntryEditorLabels = {
  label: string;
  value: string;
  send: string;
  sendDesc: string;
  save: string;
  cancel: string;
};

export function ComposerStarredEntryEditor({
  title,
  initial,
  error,
  labels,
  testIdPrefix = "composer-starred-editor",
  onClose,
  onSave,
}: {
  title: string;
  initial: ComposerStarredEntry;
  error?: string;
  labels: ComposerStarredEntryEditorLabels;
  testIdPrefix?: string;
  onClose: () => void;
  onSave: (entry: ComposerStarredEntry) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const labelRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      labelRef.current?.focus();
      labelRef.current?.select();
    });
    return () => {
      cancelAnimationFrame(raf);
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, []);

  const save = () => {
    const value = draft.value;
    if (!value) return;
    onSave({
      value,
      label: draft.label.trim(),
      send: draft.send,
    });
  };

  return createPortal(
    <div
      data-testid={testIdPrefix}
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 9998 }}
    >
      <div
        data-testid={`${testIdPrefix}-backdrop`}
        className="absolute inset-0"
        style={{ background: "var(--backdrop-heavy)" }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testIdPrefix}-title`}
        className="relative z-10 flex w-[min(420px,calc(100%-24px))] flex-col gap-3 rounded-lg p-4 shadow-2xl"
        style={{
          background: "var(--bg-surface, #181825)",
          border: "1px solid var(--border, #333)",
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div
            id={`${testIdPrefix}-title`}
            className="text-sm font-medium"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </div>
          <button
            type="button"
            data-testid={`${testIdPrefix}-close`}
            className="hover-bg-strong flex h-6 w-6 items-center justify-center rounded"
            style={{ color: "var(--text-secondary)", border: "none", cursor: "pointer" }}
            title={labels.cancel}
            onClick={onClose}
          >
            <XIcon />
          </button>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
            {labels.label}
          </span>
          <FocusInput
            ref={labelRef}
            data-testid={`${testIdPrefix}-label`}
            value={draft.label}
            onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
            {labels.value}
          </span>
          <textarea
            data-testid={`${testIdPrefix}-value`}
            className={`${inputCls} min-h-20 resize-y`}
            style={inputStyle}
            value={draft.value}
            onChange={(event) => setDraft((prev) => ({ ...prev, value: event.target.value }))}
            spellCheck={false}
          />
        </label>
        <label className="flex items-start gap-2">
          <ToggleSwitch
            data-testid={`${testIdPrefix}-send`}
            aria-label={labels.send}
            checked={draft.send}
            onChange={(send) => setDraft((prev) => ({ ...prev, send }))}
          />
          <span className="min-w-0">
            <span className="block text-[13px]" style={{ color: "var(--text-primary)" }}>
              {labels.send}
            </span>
            <span
              className="block text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {labels.sendDesc}
            </span>
          </span>
        </label>
        {error ? (
          <p role="alert" className="text-xs" style={{ color: "var(--red)" }}>
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button data-testid={`${testIdPrefix}-cancel`} onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button
            data-testid={`${testIdPrefix}-save`}
            variant="primary"
            disabled={!draft.value}
            onClick={save}
          >
            {labels.save}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
