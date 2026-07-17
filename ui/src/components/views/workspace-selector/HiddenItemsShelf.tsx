import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DerivedHiddenItems, HiddenPaneItem, HiddenWorkspaceItem } from "@/lib/hidden-items";

export interface HiddenPaneDetails {
  label?: string;
  cwd?: string;
}

interface HiddenItemsShelfProps {
  items: DerivedHiddenItems;
  paneDetailsById: Map<string, HiddenPaneDetails>;
  onClose: () => void;
  onFocusAfterEmpty: () => void;
  onRestoreAll: () => void;
  onRestoreWorkspace: (item: HiddenWorkspaceItem, open: boolean) => void;
  onRestorePane: (item: HiddenPaneItem, focus: boolean) => void;
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

export function HiddenItemsShelf({
  items,
  paneDetailsById,
  onClose,
  onFocusAfterEmpty,
  onRestoreAll,
  onRestoreWorkspace,
  onRestorePane,
}: HiddenItemsShelfProps) {
  const { t } = useTranslation("workspace");
  const headerRef = useRef<HTMLDivElement>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const rowKeys = [
    ...items.hiddenWorkspaces.map((item) => `workspace:${item.workspace.id}`),
    ...items.hiddenPanes.map((item) => `pane:${item.pane.id}`),
  ];

  useLayoutEffect(() => {
    const pendingIndex = pendingFocusIndexRef.current;
    if (pendingIndex === null) return;
    pendingFocusIndexRef.current = null;
    const rowButtons = document.querySelectorAll<HTMLButtonElement>(
      '#hidden-items-shelf [data-hidden-row-primary="true"]',
    );
    if (pendingIndex < rowButtons.length) rowButtons[pendingIndex]?.focus();
    else headerRef.current?.focus();
  }, [items.count]);

  const prepareFocusAfterRemoval = (key: string) => {
    if (items.count === 1) {
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
          {t("hiddenItems.titleCount", { count: items.count })}
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
        {items.hiddenWorkspaces.length > 0 && (
          <div>
            <div className="hidden-shelf-section-label">{t("hiddenItems.workspaces")}</div>
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
                    {item.hiddenPanes.length > 0 && (
                      <span
                        className="truncate text-[9px]"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {t("hiddenItems.nestedPaneCount", { count: item.hiddenPanes.length })}
                      </span>
                    )}
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
        )}

        {items.hiddenPanes.length > 0 && (
          <div>
            <div className="hidden-shelf-section-label">{t("hiddenItems.panes")}</div>
            {items.hiddenPanes.map((item) => {
              const key = `pane:${item.pane.id}`;
              const details = paneDetailsById.get(item.pane.id);
              const label = details?.label ?? String(item.pane.view.profile ?? item.pane.view.type);
              return (
                <div
                  key={key}
                  data-testid={`hidden-pane-${item.pane.id}`}
                  className="hidden-shelf-row"
                >
                  <button
                    type="button"
                    data-hidden-row-primary="true"
                    data-testid={`hidden-pane-primary-${item.pane.id}`}
                    className="hidden-shelf-primary hover-bg"
                    aria-label={t("hiddenItems.showAndFocusLabel", {
                      workspace: item.workspace.name,
                      pane: item.paneNumber,
                    })}
                    title={t("hiddenItems.showAndFocus")}
                    onClick={() => {
                      prepareFocusAfterRemoval(key);
                      onRestorePane(item, true);
                    }}
                  >
                    <span className="truncate">
                      {item.workspace.name} · #{item.paneNumber} · {label}
                    </span>
                    {details?.cwd && (
                      <span
                        className="truncate text-[9px]"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {details.cwd}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    data-testid={`hidden-pane-show-only-${item.pane.id}`}
                    className="hidden-shelf-icon-button hover-bg"
                    aria-label={t("hiddenItems.showOnlyPaneLabel", {
                      workspace: item.workspace.name,
                      pane: item.paneNumber,
                    })}
                    title={t("hiddenItems.showOnly")}
                    onClick={() => {
                      prepareFocusAfterRemoval(key);
                      onRestorePane(item, false);
                    }}
                  >
                    <EyeIcon />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
