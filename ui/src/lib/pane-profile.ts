import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import type { PaneLayer, ViewInstanceConfig } from "@/stores/types";
import { toTerminalId } from "./pane-ids";

/** 분할·stack은 원본 터미널의 프로필만 선택하고 세션·view override는 복사하지 않는다. */
export function resolveNewPaneView(
  source: PaneLayer,
  requested?: ViewInstanceConfig,
): ViewInstanceConfig {
  if (requested && (requested.type !== "TerminalView" || requested.profile)) return requested;
  if (
    !useSettingsStore.getState().terminal.inheritProfileOnSplit ||
    source.view.type !== "TerminalView"
  ) {
    return requested ?? { type: "EmptyView" };
  }
  const profile =
    useTerminalStore
      .getState()
      .instances.find((instance) => instance.id === toTerminalId(source.id))?.profile ??
    source.view.profile;
  return {
    ...(requested ?? { type: "TerminalView" }),
    ...(typeof profile === "string" && profile ? { profile } : {}),
  };
}
