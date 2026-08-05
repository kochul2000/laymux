import { useCallback, useEffect, useRef, useState } from "react";
import { ViewShell } from "@/components/ui/ViewShell";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ViewBody } from "@/components/ui/ViewBody";
import { useSyncGroupCwd } from "@/hooks/useSyncGroupCwd";
import { useOverridesStore } from "@/stores/overrides-store";
import { useGithubRepoSnapshot } from "@/hooks/useGithubRepoSnapshot";
import { useNowTick } from "@/hooks/useUsageSnapshot";
import { relativeTime, shouldOpenUpward, statusMessage } from "@/lib/github-list-format";
import {
  clipboardWriteText,
  openExternal,
  runGithubItemAction,
  type GithubItem,
  type GithubItemAction,
  type GithubNumberColor,
} from "@/lib/tauri-api";
import {
  numberColorVar,
  readGithubFontSize,
  readGithubLabelMaxCount,
  readGithubLabelMaxWidth,
  rowFontFamily,
  secondaryFontSize,
} from "@/lib/github-display";

export interface GitHubViewProps {
  instanceId: string;
  paneId?: string;
  syncGroup: string;
  cwdReceive?: boolean;
  workspaceId?: string;
  isFocused?: boolean;
  defaultTab?: "issues" | "pulls";
  refreshSeconds?: number;
  hideDraftPulls?: boolean;
  /** Row typeface; "" (the default) means the app UI font. */
  fontFamily?: string;
  /** Row size in px for the number and title; the rest of the row derives from it. */
  fontSize?: number;
  numberColor?: GithubNumberColor;
  showAuthor?: boolean;
  showUpdated?: boolean;
  showDraftBadge?: boolean;
  /** Labels per row; `0` hides the column. */
  labelMaxCount?: number;
  labelMaxWidth?: number;
}

type Tab = "issues" | "pulls";

/** The two per-row copy buttons: the item's URL, and a PR's source branch. */
type CopyKind = "link" | "branch";

function isCopied(
  copied: { number: number; kind: CopyKind } | null,
  number: number,
  kind: CopyKind,
): boolean {
  return copied?.number === number && copied.kind === kind;
}

interface MenuAction {
  action: GithubItemAction;
  label: string;
  /** Shown while the click is waiting for confirmation. */
  confirmLabel: string;
  danger?: boolean;
}

const ISSUE_ACTIONS: MenuAction[] = [
  { action: "issue.close", label: "Close as completed", confirmLabel: "Close as completed" },
  {
    action: "issue.closeNotPlanned",
    label: "Close as not planned",
    confirmLabel: "Close as not planned",
  },
];

const PULL_ACTIONS: MenuAction[] = [
  { action: "pr.merge", label: "Merge", confirmLabel: "Merge (merge commit)", danger: true },
  {
    action: "pr.squash",
    label: "Squash and merge",
    confirmLabel: "Squash and merge",
    danger: true,
  },
  {
    action: "pr.rebase",
    label: "Rebase and merge",
    confirmLabel: "Rebase and merge",
    danger: true,
  },
  { action: "pr.close", label: "Close", confirmLabel: "Close" },
];

/** Rows show ages, not clocks — a coarse tick is enough to keep them honest. */
const RELATIVE_TIME_TICK_MS = 30_000;

/**
 * Tallest the row menu gets — now the unarmed pull-request list (Merge,
 * Squash, Rebase, Close: 4 rows), taller than the armed state's 3 rows
 * (prompt + Confirm + Cancel). Used to decide which way it opens, so it is a
 * deliberate over-estimate — opening upward with room to spare is harmless,
 * opening downward without it is not.
 */
const MENU_MAX_H = 128;

const ROW_BTN: React.CSSProperties = {
  width: "var(--btn-min-w)",
  height: "var(--btn-min-w)",
  border: "none",
  background: "transparent",
  color: "var(--text-secondary)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
};

export function GitHubView({
  instanceId,
  paneId,
  syncGroup,
  cwdReceive = true,
  isFocused,
  defaultTab = "issues",
  refreshSeconds = 10,
  hideDraftPulls = false,
  fontFamily = "",
  fontSize,
  numberColor = "yellow",
  showAuthor = true,
  showUpdated = true,
  showDraftBadge = true,
  labelMaxCount,
  labelMaxWidth,
}: GitHubViewProps) {
  const cwd = useSyncGroupCwd({ syncGroup, instanceId, cwdReceive });
  // A hand-edited settings.json can set refreshSeconds to 0 or negative,
  // bypassing the settings UI's min=10 clamp; floor it so the poll interval
  // never degenerates into a tight loop.
  const { snapshot, loading, refresh } = useGithubRepoSnapshot(
    cwd,
    Math.max(1000, refreshSeconds * 1000),
  );
  // The chosen tab is per-pane UI state, not configuration: it survives a
  // restart in `viewOverrides` while `defaultTab` only seeds a pane that has
  // never been touched (ADR-0115). Panes rendered without a `paneId` have
  // nowhere to persist, so they keep the choice in component state instead.
  const persistedTab = useOverridesStore((s) =>
    paneId ? s.viewOverrides[paneId]?.githubTab : undefined,
  );
  const setViewOverride = useOverridesStore((s) => s.setViewOverride);
  const [unpersistedTab, setUnpersistedTab] = useState<Tab | null>(null);
  const tab: Tab = persistedTab ?? unpersistedTab ?? defaultTab;
  const selectTab = useCallback(
    (next: Tab) => {
      if (paneId) setViewOverride(paneId, { githubTab: next });
      else setUnpersistedTab(next);
    },
    [paneId, setViewOverride],
  );
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<{ number: number; action: MenuAction } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which row's copy button just fired, and which of the two it was — the two
  // buttons sit side by side, so a bare row number would flash both check marks.
  const [copied, setCopied] = useState<{ number: number; kind: CopyKind } | null>(null);
  // Which way the open menu points. Decided from the anchor's position inside
  // the scrolling list at the moment it opens.
  const [menuUp, setMenuUp] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items =
    tab === "issues"
      ? snapshot.issues
      : hideDraftPulls
        ? snapshot.pulls.filter((item) => !item.isDraft)
        : snapshot.pulls;
  const actions = tab === "issues" ? ISSUE_ACTIONS : PULL_ACTIONS;
  // While the first read for a CWD is in flight the pane is neither empty nor
  // broken, so neither explanation is shown yet.
  const message = loading ? null : statusMessage(snapshot.status);
  const nowMs = useNowTick(RELATIVE_TIME_TICK_MS).getTime();

  // Display knobs read through their clamps: settings.json can be hand-edited,
  // so the row never renders a raw value from it.
  const rowFont = rowFontFamily(fontFamily);
  const titleSize = readGithubFontSize(fontSize);
  const metaSize = secondaryFontSize(titleSize);
  const numberCss = numberColorVar(numberColor);
  const labelCount = readGithubLabelMaxCount(labelMaxCount);
  const labelWidth = readGithubLabelMaxWidth(labelMaxWidth);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const closeMenus = useCallback(() => {
    setOpenMenu(null);
    setConfirming(null);
  }, []);

  // A repo or tab switch must not leave a menu open over unrelated rows.
  // Adjusting during render (not in an effect) means the stale menu never
  // reaches the screen for a frame.
  const menuScope = `${snapshot.repo ?? ""}|${tab}`;
  const [lastMenuScope, setLastMenuScope] = useState(menuScope);
  if (lastMenuScope !== menuScope) {
    setLastMenuScope(menuScope);
    setOpenMenu(null);
    setConfirming(null);
  }

  useEffect(() => {
    if (openMenu === null) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closeMenus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu, closeMenus]);

  const copyValue = useCallback((item: GithubItem, kind: CopyKind, text: string) => {
    clipboardWriteText(text).catch(() => {});
    setCopied({ number: item.number, kind });
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1_200);
  }, []);

  // Close/merge is irreversible from this surface, so the menu entry only arms
  // the action; the second, explicit click is what reaches `gh`.
  const applyAction = useCallback(
    (number: number, action: GithubItemAction) => {
      if (!cwd) return;
      setRunning(true);
      setError(null);
      runGithubItemAction(cwd, action, number)
        .then(() => {
          closeMenus();
          refresh();
        })
        .catch((e: unknown) => setError(String(e)))
        .finally(() => setRunning(false));
    },
    [cwd, closeMenus, refresh],
  );

  return (
    <ViewShell testId="view-github" ref={containerRef}>
      <ViewHeader title="GitHub">
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-1">
          {(["issues", "pulls"] as Tab[]).map((key) => {
            const active = tab === key;
            const count =
              key === "issues"
                ? snapshot.issues.length
                : hideDraftPulls
                  ? snapshot.pulls.filter((item) => !item.isDraft).length
                  : snapshot.pulls.length;
            return (
              // The pane control bar appears on hover and takes width from this
              // row, so the tabs must not shrink: without nowrap the label and
              // its count split onto two lines inside a fixed-height bar.
              <button
                key={key}
                data-testid={`github-tab-${key}`}
                onClick={() => selectTab(key)}
                className="shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5"
                style={{
                  height: "var(--btn-h)",
                  fontSize: "var(--fs-sm)",
                  border: `1px solid ${active ? "var(--accent-50)" : "transparent"}`,
                  background: active ? "var(--accent-12)" : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {key === "issues" ? "Issues" : "PRs"} {count}
              </button>
            );
          })}
          <span
            data-testid="github-repo"
            className="ui-toolbar-title min-w-0 truncate pl-1"
            style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}
            title={snapshot.repo ?? ""}
          >
            {snapshot.repo ?? ""}
          </span>
          <button
            data-testid="github-refresh"
            onClick={() => refresh()}
            title="Refresh now"
            style={{ ...ROW_BTN, opacity: loading ? 0.5 : 1 }}
            className="hover-bg shrink-0"
          >
            ⟳
          </button>
        </div>
      </ViewHeader>
      <ViewBody
        ref={listRef}
        testId="github-list"
        tabIndex={-1}
        data-focused={isFocused ? "true" : undefined}
      >
        {message && (
          <div
            data-testid="github-status"
            className="px-2 py-2"
            style={{ color: "var(--text-secondary)", fontSize: "var(--fs-sm)" }}
          >
            {message}
          </div>
        )}
        {error && (
          <div
            data-testid="github-error"
            className="px-2 py-1"
            style={{ color: "var(--red)", fontSize: "var(--fs-sm)" }}
          >
            {error}
          </div>
        )}
        {!message && !loading && items.length === 0 && (
          <div
            data-testid="github-empty"
            className="px-2 py-2"
            style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}
          >
            {tab === "issues" ? "No open issues" : "No open pull requests"}
          </div>
        )}
        {items.map((item) => (
          <div
            key={item.number}
            data-testid={`github-item-${item.number}`}
            className="hover-bg group flex items-center gap-1 px-2"
            style={{
              minHeight: "var(--pane-row-max-h)",
              cursor: "pointer",
              fontFamily: rowFont,
            }}
            onClick={() => openExternal(item.url)}
            title={item.title}
          >
            {/* The number is what a developer actually scans for, so it gets
                the title's size and an accent color instead of muted small. */}
            <span
              data-testid={`github-number-${item.number}`}
              className="shrink-0"
              style={{ color: numberCss, fontSize: titleSize }}
            >
              #{item.number}
            </span>
            {showDraftBadge && item.isDraft && (
              <span
                data-testid={`github-draft-${item.number}`}
                className="shrink-0"
                style={{ color: "var(--yellow)", fontSize: metaSize }}
              >
                DRAFT
              </span>
            )}
            <span
              className="min-w-0 flex-1 truncate"
              style={{ color: "var(--text-primary)", fontSize: titleSize }}
            >
              {item.title}
            </span>
            {labelCount > 0 &&
              item.labels.slice(0, labelCount).map((label) => (
                <span
                  key={label}
                  data-testid={`github-label-${item.number}-${label}`}
                  className="shrink-0 truncate rounded px-1"
                  style={{
                    maxWidth: labelWidth,
                    background: "var(--accent-10)",
                    color: "var(--text-secondary)",
                    fontSize: metaSize,
                  }}
                >
                  {label}
                </span>
              ))}
            {showAuthor && (
              <span
                data-testid={`github-author-${item.number}`}
                className="shrink-0"
                style={{ color: "var(--text-muted)", fontSize: metaSize }}
              >
                {item.author}
              </span>
            )}
            {showUpdated && (
              <span
                data-testid={`github-updated-${item.number}`}
                className="shrink-0"
                style={{ color: "var(--text-muted)", fontSize: metaSize }}
              >
                {relativeTime(item.updatedAt, nowMs)}
              </span>
            )}
            {/* Copy branch sits beside copy link and only on rows that have a
                branch — issues never do, and a PR from a deleted head reports
                an empty one. */}
            {item.headRefName !== "" && (
              <button
                data-testid={`github-copy-branch-${item.number}`}
                onClick={(e) => {
                  e.stopPropagation();
                  copyValue(item, "branch", item.headRefName);
                }}
                title={
                  isCopied(copied, item.number, "branch")
                    ? "Copied"
                    : `Copy branch (${item.headRefName})`
                }
                style={{
                  ...ROW_BTN,
                  color: isCopied(copied, item.number, "branch")
                    ? "var(--green)"
                    : "var(--text-secondary)",
                }}
                className="hover-bg shrink-0"
              >
                {isCopied(copied, item.number, "branch") ? "✓" : "⎇"}
              </button>
            )}
            {/* Copy link stays visible at all times (issue #708) — it is the
                one action that is safe to hit by accident. */}
            <button
              data-testid={`github-copy-${item.number}`}
              onClick={(e) => {
                e.stopPropagation();
                copyValue(item, "link", item.url);
              }}
              title={isCopied(copied, item.number, "link") ? "Copied" : "Copy link"}
              style={{
                ...ROW_BTN,
                color: isCopied(copied, item.number, "link")
                  ? "var(--green)"
                  : "var(--text-secondary)",
              }}
              className="hover-bg shrink-0"
            >
              {isCopied(copied, item.number, "link") ? "✓" : "⧉"}
            </button>
            <div className="relative shrink-0">
              <button
                data-testid={`github-menu-${item.number}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const next = openMenu === item.number ? null : item.number;
                  setConfirming(null);
                  if (next !== null && listRef.current) {
                    setMenuUp(
                      shouldOpenUpward(
                        e.currentTarget.getBoundingClientRect(),
                        listRef.current.getBoundingClientRect(),
                        MENU_MAX_H,
                      ),
                    );
                  }
                  setOpenMenu(next);
                }}
                title="More actions"
                style={ROW_BTN}
                className="hover-bg"
              >
                ⋯
              </button>
              {openMenu === item.number && (
                <div
                  data-testid={`github-menu-panel-${item.number}`}
                  data-placement={menuUp ? "up" : "down"}
                  className="absolute right-0 z-30 flex flex-col"
                  style={{
                    ...(menuUp ? { bottom: "100%" } : { top: "100%" }),
                    minWidth: 160,
                    background: "var(--bg-overlay)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-md)",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {confirming?.number === item.number ? (
                    <>
                      <span
                        className="px-2 py-1"
                        style={{ color: "var(--text-secondary)", fontSize: "var(--fs-2xs)" }}
                      >
                        {confirming.action.confirmLabel} #{item.number}?
                      </span>
                      <button
                        data-testid={`github-confirm-${item.number}`}
                        disabled={running}
                        onClick={() => applyAction(item.number, confirming.action.action)}
                        className="hover-bg cursor-pointer px-2 py-1 text-left"
                        style={{
                          border: "none",
                          background: "transparent",
                          color: confirming.action.danger ? "var(--red)" : "var(--text-primary)",
                          fontSize: "var(--fs-sm)",
                        }}
                      >
                        {running ? "Running…" : "Confirm"}
                      </button>
                      <button
                        data-testid={`github-cancel-${item.number}`}
                        onClick={() => setConfirming(null)}
                        className="hover-bg cursor-pointer px-2 py-1 text-left"
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "var(--text-secondary)",
                          fontSize: "var(--fs-sm)",
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    actions.map((entry) => (
                      <button
                        key={entry.action}
                        data-testid={`github-action-${entry.action}-${item.number}`}
                        onClick={() => setConfirming({ number: item.number, action: entry })}
                        className="hover-bg cursor-pointer px-2 py-1 text-left"
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "var(--text-primary)",
                          fontSize: "var(--fs-sm)",
                        }}
                      >
                        {entry.label}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </ViewBody>
    </ViewShell>
  );
}
