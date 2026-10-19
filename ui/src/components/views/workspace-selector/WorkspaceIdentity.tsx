/** Workspace selector와 이동 대상에서 사용하는 번호·이름 표시. */
export function WorkspaceIdentity({
  index,
  name,
  isActive,
  nameTestId,
  onRename,
}: {
  index: number;
  name: string;
  isActive: boolean;
  nameTestId?: string;
  onRename?: () => void;
}) {
  return (
    <span className="workspace-identity flex min-w-0 items-center gap-1.5 truncate">
      <span
        className="shrink-0 text-[10px] font-medium"
        style={{
          color: isActive ? "var(--accent)" : "var(--text-primary)",
          opacity: isActive ? 0.9 : 0.6,
          minWidth: 10,
        }}
        title={index >= 0 && index < 9 ? `Ctrl+Alt+${index + 1}` : undefined}
      >
        {index >= 0 && index < 9 ? index + 1 : ""}
      </span>
      <span
        data-testid={nameTestId}
        className="truncate text-sm font-medium"
        style={{ color: isActive ? "var(--text-primary)" : "var(--text-secondary)" }}
        onDoubleClick={
          onRename
            ? (event) => {
                event.stopPropagation();
                onRename();
              }
            : undefined
        }
      >
        {name}
      </span>
    </span>
  );
}
