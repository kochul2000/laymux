import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { useCloseConfirmationStore } from "@/stores/close-confirmation-store";

export function CloseConfirmationModal() {
  const state = useCloseConfirmationStore();
  const { t } = useTranslation("settings");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (state.open && element && !element.open) {
      element.showModal();
      // React autoFocus runs at mount while this persistent dialog is hidden.
      // Each opening should start on Cancel so Enter cannot approve by accident.
      element.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (!state.open && element?.open) element.close();
  }, [state.open]);

  const savingTitle = state.saving ? t("terminal.exitConfirmationSaving") : undefined;
  return (
    <>
      {state.open && <div className="lifecycle-backdrop" aria-hidden="true" />}
      <dialog
        ref={dialog}
        className="lifecycle-dialog"
        data-testid="close-confirmation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-confirmation-title"
        aria-describedby="close-confirmation-description"
        onKeyDown={(event) => event.stopPropagation()}
        onCancel={(event) => {
          event.preventDefault();
          state.cancel();
        }}
      >
        <div className="lifecycle-content">
          <h2 id="close-confirmation-title" className="lifecycle-title">
            {t("terminal.exitConfirmationTitle")}
          </h2>
          <p id="close-confirmation-description" className="lifecycle-subtitle">
            {t("terminal.exitConfirmationDescription")}
          </p>
          <label className="close-confirmation-checkbox">
            <input
              type="checkbox"
              checked={state.dontShowAgain}
              disabled={state.saving}
              title={savingTitle}
              onChange={(event) =>
                useCloseConfirmationStore.setState({ dontShowAgain: event.target.checked })
              }
            />
            {t("terminal.exitConfirmationDontShowAgain")}
          </label>
          {state.error && (
            <div className="lifecycle-error" role="alert">
              {t("terminal.exitConfirmationSaveFailed")}
              <br />
              {state.error}
            </div>
          )}
        </div>
        <div className="lifecycle-actions">
          <Button disabled={state.saving} title={savingTitle} onClick={state.cancel}>
            {t("terminal.exitConfirmationCancel")}
          </Button>
          <Button
            variant="primary"
            disabled={state.saving}
            title={savingTitle}
            onClick={() => void state.confirm()}
          >
            {state.saving
              ? t("terminal.exitConfirmationSaving")
              : t("terminal.exitConfirmationConfirm")}
          </Button>
        </div>
      </dialog>
    </>
  );
}
