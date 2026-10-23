import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { restoreWorkspaceClose } from "@/lib/workspace-close";
import { UndoSnackbar } from "@/components/ui/UndoSnackbar";

/** Deadlines stay host-owned; the selector renders the shared snackbar appearance. */
export function WorkspaceCloseToasts() {
  const { t } = useTranslation("workspace");
  const pending = useWorkspaceStore((s) => s.pendingWorkspaceCloses);
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((item) => (
        <UndoSnackbar
          key={item.id}
          message={t("item.closingWorkspace", { name: item.name })}
          actionLabel={t("item.restoreWorkspace")}
          durationMs={null}
          onDismiss={() => {}}
          onAction={() => restoreWorkspaceClose(item.id)}
        />
      ))}
    </>
  );
}
