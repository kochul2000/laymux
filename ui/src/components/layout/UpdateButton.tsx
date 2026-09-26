import { DownloadIcon } from "@/components/ui/icons";
import { useLifecycleStore } from "@/stores/lifecycle-store";
import { useTranslation } from "react-i18next";

export function UpdateButton() {
  const status = useLifecycleStore((s) => s.status);
  const { i18n } = useTranslation();
  if (!status?.enabled || !status.availableVersion) return null;
  const busy = status.operation !== "idle";
  const title = i18n.language.startsWith("ko") ? "Laymux ???? ??" : "Open Laymux update";
  return (
    <button
      data-testid="app-update-btn"
      data-operation={status.operation}
      onClick={() => useLifecycleStore.getState().openUpdate()}
      className="flex h-6 shrink-0 cursor-pointer items-center justify-center gap-1 border-0 bg-transparent px-1 text-[10px]"
      style={{ color: busy ? "var(--accent)" : "var(--yellow)" }}
      title={title}
      aria-label={title}
    >
      <DownloadIcon />
      {busy && <span>?</span>}
    </button>
  );
}
