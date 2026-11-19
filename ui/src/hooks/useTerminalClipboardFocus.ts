import { useEffect } from "react";
import { setTerminalClipboardFocus } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

/** Mirrors the local xterm input's owner. Rust independently checks the native window. */
export function useTerminalClipboardFocus(loaded: boolean) {
  useEffect(() => {
    if (!navigator.userAgent.includes("Windows")) return;

    let publishedId: string | null | undefined;
    let publishedGeneration: number | null | undefined;
    const publish = (id: string | null, generation: number | null) => {
      if (publishedId === id && publishedGeneration === generation) return;
      publishedId = id;
      publishedGeneration = generation;
      void setTerminalClipboardFocus(id, generation).catch((error) =>
        console.warn("Unable to publish terminal clipboard focus", error),
      );
    };
    const sync = (element: EventTarget | null) => {
      const id =
        loaded &&
        useSettingsStore.getState().terminal.allowOsc52ClipboardWrite &&
        document.hasFocus() &&
        element instanceof HTMLElement &&
        element.matches("textarea.xterm-helper-textarea")
          ? element.closest<HTMLElement>("[data-clipboard-terminal-id]")?.dataset
              .clipboardTerminalId
          : undefined;
      const instance = id
        ? useTerminalStore.getState().instances.find((i) => i.id === id)
        : undefined;
      if (instance?.sessionReady && instance.generation !== undefined) {
        publish(instance.id, instance.generation);
      } else {
        publish(null, null);
      }
    };
    const syncActive = () => sync(document.activeElement);
    const onFocusIn = (event: FocusEvent) => sync(event.target);
    const onFocusOut = (event: FocusEvent) => sync(event.relatedTarget);
    const onWindowBlur = () => publish(null, null);

    const unsubscribeSettings = useSettingsStore.subscribe((next, previous) => {
      if (next.terminal.allowOsc52ClipboardWrite !== previous.terminal.allowOsc52ClipboardWrite) {
        syncActive();
      }
    });
    const unsubscribeTerminals = useTerminalStore.subscribe(syncActive);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("focus", syncActive);
    window.addEventListener("blur", onWindowBlur);
    syncActive();

    return () => {
      unsubscribeSettings();
      unsubscribeTerminals();
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("focus", syncActive);
      window.removeEventListener("blur", onWindowBlur);
      publish(null, null);
    };
  }, [loaded]);
}
