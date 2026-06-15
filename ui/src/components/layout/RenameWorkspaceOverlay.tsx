import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRenameWorkspaceStore } from "@/stores/rename-workspace-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { FocusInput } from "@/components/ui/FormControls";

/**
 * Inline workspace-rename overlay (#339). Rendered once at the app root and
 * shown whenever `useRenameWorkspaceStore.targetId` is set — from the
 * `workspace.rename` shortcut or the in-app rename buttons. It replaces the
 * native `window.prompt`, which does not work on Windows/WebView2 (the #283
 * root cause), so rename works on every platform and is driveable via the
 * Automation API.
 *
 * The input is uncontrolled (read via ref on submit) and keyed by `targetId`,
 * so opening the overlay for a different workspace remounts it with that
 * workspace's current name.
 */
export function RenameWorkspaceOverlay() {
  const targetId = useRenameWorkspaceStore((s) => s.targetId);
  const currentName = useRenameWorkspaceStore((s) => s.currentName);
  const closeRename = useRenameWorkspaceStore((s) => s.closeRename);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);

  const inputRef = useRef<HTMLInputElement>(null);
  // Element that had focus when the overlay opened (e.g. the terminal that owned
  // the keyboard when the rename shortcut fired). Restored on close so the next
  // keystrokes don't fall through to <body>/the wrong pane (#354 review).
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // On open: capture the currently focused element first, then focus + select the
  // field so the user can immediately type or overwrite the existing name. A
  // layout effect (not autoFocus) drives the focus so the capture provably runs
  // before focus moves — autoFocus fires during mount, which would record the
  // overlay input itself instead of the terminal/button to return to. On close,
  // restore focus to the captured element.
  useLayoutEffect(() => {
    if (targetId === null) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, [targetId]);

  if (targetId === null) return null;

  const submit = () => {
    const name = inputRef.current?.value.trim() ?? "";
    if (name !== "") renameWorkspace(targetId, name);
    closeRename();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      // Consume Escape so global handlers don't also act on it.
      e.preventDefault();
      e.stopPropagation();
      closeRename();
    }
  };

  return createPortal(
    <div
      data-testid="rename-workspace-overlay"
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 9998 }}
    >
      <div
        data-testid="rename-workspace-overlay-backdrop"
        className="absolute inset-0"
        style={{ background: "var(--backdrop-heavy)" }}
        onClick={closeRename}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-workspace-overlay-title"
        className="relative z-10 flex w-[360px] flex-col gap-3 rounded-lg p-4 shadow-2xl"
        style={{
          background: "var(--bg-surface, #181825)",
          border: "1px solid var(--border, #333)",
        }}
      >
        <div
          id="rename-workspace-overlay-title"
          className="text-sm font-medium"
          style={{ color: "var(--text-primary)" }}
        >
          Rename workspace
        </div>
        <FocusInput
          key={`rename-workspace-input:${targetId}`}
          ref={inputRef}
          defaultValue={currentName}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          aria-label="Workspace name"
          data-testid="rename-workspace-overlay-input"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeRename}
            className="hover-bg-strong rounded px-3 py-1 text-xs"
            style={{
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
              cursor: "pointer",
            }}
            data-testid="rename-workspace-overlay-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="hover-bg-strong rounded px-3 py-1 text-xs"
            style={{
              color: "var(--text-primary)",
              border: "1px solid var(--border)",
              cursor: "pointer",
            }}
            data-testid="rename-workspace-overlay-submit"
          >
            Rename
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
