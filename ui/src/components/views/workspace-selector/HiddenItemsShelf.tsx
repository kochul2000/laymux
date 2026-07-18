import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DerivedHiddenItems, HiddenWorkspaceItem } from "@/lib/hidden-items";

interface HiddenItemsShelfProps {
  items: DerivedHiddenItems;
  onClose: () => void;
  onFocusAfterEmpty: () => void;
  onRestoreAll: () => void;
  onRestoreWorkspace: (item: HiddenWorkspaceItem, open: boolean) => void;
}

function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M1 6s2.2-3.5 5-3.5S11 6 11 6 8.8 9.5 6 9.5 1 6 1 6Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/**
 * Workspace-only restore shelf. Hidden panes are intentionally NOT listed here —
 * each pane carries its own hide toggle in the pane control bar (ADR-0035).
 */
export function HiddenItemsShelf({
  items,
  onClose,
  onFocusAfterEmpty,
  onRestoreAll,
  onRestoreWorkspace,
}: HiddenItemsShelfProps) {
  const { t } = useTranslation("workspace");
  const headerRef = useRef<HTMLDivElement>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const rowKeys = items.hiddenWorkspaces.map((item) => `workspace:${item.workspace.id}`);

  useLayoutEffect(() => {
    const pendingIndex = pendingFocusIndexRef.current;
    if (pendingIndex === null) return;
    pendingFocusIndexRef.current = null;
    const rowButtons = document.querySelectorAll<HTMLButtonElement>(
      '#hidden-items-shelf [data-hidden-row-primary="true"]',
    );
    if (pendingIndex < rowButtons.length) rowButtons[pendingIndex]?.focus();
    else headerRef.current?.focus();
  }, [items.hiddenWorkspaces.length]);

  const prepareFocusAfterRemoval = (key: string) => {
    if (items.hiddenWorkspaces.length === 1) {
      onFocusAfterEmpty();
      return;
    }
    pendingFocusIndexRef.current = Math.max(0, rowKeys.indexOf(key));
  };

  return (
    <section
      id="hidden-items-shelf"
      data-testid="hidden-items-shelf"
      aria-label={t("hiddenItems.title")}
      className="hidden-items-shelf flex shrink-0 flex-col"
    >
      <div ref={headerRef} tabIndex={-1} className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">
          {t("hiddenItems.titleCount", { count: items.hiddenWorkspaces.length })}
        </span>
        <button
          type="button"
          data-testid="hidden-items-restore-all"
          className="hidden-shelf-text-button hover-bg"
          onClick={() => {
            onFocusAfterEmpty();
            onRestoreAll();
          }}
        >
          {t("hiddenItems.restoreAll")}
        </button>
        <button
          type="button"
          data-testid="hidden-items-close"
          className="hidden-shelf-icon-button hover-bg"
          aria-label={t("hiddenItems.close")}
          title={t("hiddenItems.close")}
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="empty-view-scroll min-h-0 overflow-y-auto px-1 pb-1">
        {items.hiddenWorkspaces.map((item) => {
          const key = `workspace:${item.workspace.id}`;
          return (
            <div
              key={key}
              data-testid={`hidden-workspace-${item.workspace.id}`}
              className="hidden-shelf-row"
            >
              <button
                type="button"
                data-hidden-row-primary="true"
                data-testid={`hidden-workspace-primary-${item.workspace.id}`}
                className="hidden-shelf-primary hover-bg"
                aria-label={t("hiddenItems.showAndOpenLabel", {
                  name: item.workspace.name,
                })}
                title={t("hiddenItems.showAndOpen")}
                onClick={() => {
                  prepareFocusAfterRemoval(key);
                  onRestoreWorkspace(item, true);
                }}
              >
                <span className="truncate">{item.workspace.name}</span>
              </button>
              <button
                type="button"
                data-testid={`hidden-workspace-show-only-${item.workspace.id}`}
                className="hidden-shelf-icon-button hover-bg"
                aria-label={t("hiddenItems.showOnlyWorkspaceLabel", {
                  name: item.workspace.name,
                })}
                title={t("hiddenItems.showOnly")}
                onClick={() => {
                  prepareFocusAfterRemoval(key);
                  onRestoreWorkspace(item, false);
                }}
              >
                <EyeIcon />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
