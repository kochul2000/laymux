import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { ChevronDownIcon } from "@/components/ui/icons";
import { useWorktreeTerminalTargets } from "@/hooks/useWorktreeTerminalTargets";
import { worktreeFolderName } from "@/lib/worktree-display";
import { worktreeBranchLabel } from "@/lib/worktree-presentation";
import type { WorktreeEntry, WorktreeUsage } from "@/lib/worktree-api";

import { WorktreeTerminalTarget } from "./WorktreeTerminalTarget";

export function WorktreeRow({
  entry,
  usage,
  summary,
  selected,
  candidate,
  creating,
  onDetail,
  onTerminal,
  onMove,
}: {
  entry: WorktreeEntry;
  usage: WorktreeUsage[];
  summary: string;
  selected: boolean;
  candidate: boolean;
  creating: boolean;
  onDetail: () => void;
  onTerminal: () => void;
  onMove: (usage: WorktreeUsage) => void;
}) {
  const items = useWorktreeTerminalTargets(usage);
  const usageKey = usage
    .map((value) => `${value.kind}:${value.terminalId}:${value.paneId}`)
    .join("|");
  const [menu, setMenu] = useState<{ anchor: HTMLButtonElement; usageKey: string } | null>(null);
  if (menu && menu.usageKey !== usageKey) setMenu(null);
  const anchor = menu?.usageKey === usageKey ? menu.anchor : null;
  const close = useCallback(() => setMenu(null), []);
  return (
    <article
      className={`worktree-list-row ${selected ? "worktree-list-row-selected" : ""}`}
      data-worktree-path={entry.path}
      title={`${entry.path}\n${summary}`}
    >
      <span className="worktree-row-heading">
        <strong className="truncate" title={entry.path}>
          {worktreeFolderName(entry.path)}
        </strong>
        {entry.isMain && <span className="worktree-main-badge">기본</span>}
        <span
          className={`worktree-branch ml-auto truncate ${entry.branch ? "" : "worktree-branch-empty"}`}
          title={worktreeBranchLabel(entry.branch)}
        >
          {worktreeBranchLabel(entry.branch)}
        </span>
      </span>
      <div
        className={`worktree-directory-status ${candidate ? "worktree-candidate" : ""}`}
        title={summary}
      >
        <span className="truncate">
          {creating ? "터미널 시작 중" : `${items.length ? "" : "터미널 없음 · "}${summary}`}
        </span>
      </div>
      <div className="worktree-row-actions">
        {items.length > 0 ? (
          <>
            <Button
              className="worktree-terminal-button"
              aria-label="터미널로 이동"
              aria-current={items[0].isFocusedPane ? "true" : undefined}
              disabled={!items[0].value.paneId}
              title={items[0].title}
              onClick={() => {
                close();
                onMove(items[0].value);
              }}
            >
              <WorktreeTerminalTarget target={items[0]} />
            </Button>
            {items.length > 1 && (
              <Button
                className="worktree-terminal-picker"
                aria-label={`터미널 ${items.length}개`}
                title={`터미널 ${items.length}개 중 이동할 터미널 선택`}
                aria-haspopup="menu"
                aria-expanded={!!anchor}
                onClick={(event) =>
                  setMenu(anchor ? null : { anchor: event.currentTarget, usageKey })
                }
              >
                <ChevronDownIcon size={12} />
              </Button>
            )}
          </>
        ) : !entry.bare && !entry.prunable ? (
          <Button disabled={creating} onClick={onTerminal}>
            새 터미널
          </Button>
        ) : null}
        <Button
          className="worktree-detail-button"
          data-worktree-detail
          aria-expanded={selected}
          onClick={onDetail}
        >
          상세
        </Button>
      </div>
      {anchor && (
        <ActionMenu anchor={anchor} label="터미널 선택" onClose={close}>
          {items.map((item, index) => (
            <Button
              role="menuitem"
              aria-current={item.isFocusedPane ? "true" : undefined}
              key={`${item.value.terminalId}-${index}`}
              disabled={!item.value.paneId}
              title={item.title}
              onClick={() => {
                close();
                onMove(item.value);
              }}
            >
              <WorktreeTerminalTarget target={item} />
            </Button>
          ))}
        </ActionMenu>
      )}
    </article>
  );
}
