import { beforeEach, expect, it, vi } from "vitest";
import { requestCloseConfirmation, useCloseConfirmationStore } from "./close-confirmation-store";
import { useSettingsStore } from "./settings-store";
import { collectSettingsSnapshot, saveAndApplySettingsSnapshot } from "@/lib/settings-snapshot";

vi.mock("@/lib/settings-snapshot", () => ({
  collectSettingsSnapshot: vi.fn(),
  saveAndApplySettingsSnapshot: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState(useSettingsStore.getInitialState());
  useCloseConfirmationStore.setState(useCloseConfirmationStore.getInitialState());
  vi.mocked(collectSettingsSnapshot).mockResolvedValue({
    exit: { ...useSettingsStore.getState().exit },
  } as Awaited<ReturnType<typeof collectSettingsSnapshot>>);
});

it("기본은 확인하며 취소는 설정을 변경하거나 저장하지 않는다", async () => {
  expect(useSettingsStore.getState().exit.confirmBeforeExit).toBe(true);
  const decision = requestCloseConfirmation();
  expect(useCloseConfirmationStore.getState().open).toBe(true);
  useCloseConfirmationStore.setState({ dontShowAgain: true });
  useCloseConfirmationStore.getState().cancel();
  expect(await decision).toBe(false);
  expect(useSettingsStore.getState().exit.confirmBeforeExit).toBe(true);
  expect(saveAndApplySettingsSnapshot).not.toHaveBeenCalled();
  const retry = requestCloseConfirmation();
  expect(useCloseConfirmationStore.getState().dontShowAgain).toBe(false);
  await useCloseConfirmationStore.getState().confirm();
  expect(await retry).toBe(true);
  expect(saveAndApplySettingsSnapshot).not.toHaveBeenCalled();
});

it("확인 해제 상태에서는 확인 창 없이 진행한다", async () => {
  useSettingsStore.getState().setExit({ confirmBeforeExit: false });
  expect(await requestCloseConfirmation()).toBe(true);
  expect(useCloseConfirmationStore.getState().open).toBe(false);
});

it("다시 보지 않기는 저장 성공 후에만 종료를 승인한다", async () => {
  const decision = requestCloseConfirmation();
  useCloseConfirmationStore.setState({ dontShowAgain: true });
  let saved!: () => void;
  vi.mocked(saveAndApplySettingsSnapshot).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  const confirming = useCloseConfirmationStore.getState().confirm();
  await vi.waitFor(() => expect(saveAndApplySettingsSnapshot).toHaveBeenCalled());
  expect(useCloseConfirmationStore.getState().open).toBe(true);
  expect(saveAndApplySettingsSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ exit: expect.objectContaining({ confirmBeforeExit: false }) }),
    expect.objectContaining({ includeStructural: false, expectedSettings: expect.any(Object) }),
  );
  saved();
  await confirming;
  expect(await decision).toBe(true);
});

it("저장 실패는 설정과 확인 창을 유지하며 취소할 수 있다", async () => {
  const decision = requestCloseConfirmation();
  useCloseConfirmationStore.setState({ dontShowAgain: true });
  vi.mocked(saveAndApplySettingsSnapshot).mockRejectedValueOnce(new Error("disk full"));
  await useCloseConfirmationStore.getState().confirm();
  expect(useCloseConfirmationStore.getState()).toMatchObject({
    open: true,
    saving: false,
    error: "Error: disk full",
  });
  expect(useSettingsStore.getState().exit.confirmBeforeExit).toBe(true);
  useCloseConfirmationStore.getState().cancel();
  expect(await decision).toBe(false);
});
