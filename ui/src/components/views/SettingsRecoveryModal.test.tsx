import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/tauri-api", () => ({
  resetSettings: vi.fn().mockResolvedValue(undefined),
  getSettingsPath: vi.fn().mockResolvedValue("C:\\fallback\\settings.json"),
}));

vi.mock("@/lib/persist-session", () => ({
  setBlockPersist: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  // Render the key (and any interpolated numbers) so assertions pin the branch
  // and the counts, not the copy.
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}(${JSON.stringify(vars)})` : key,
  }),
}));

import { SettingsRecoveryModal } from "./SettingsRecoveryModal";
import type { SettingsLoadResult } from "@/lib/tauri-api";

const RECOVERED: SettingsLoadResult = {
  status: "recovered",
  settings: {} as never,
  settingsPath: "C:\\config\\settings.json",
  dropped: [
    {
      path: "terminal.parserAdmission.hiddenShare",
      message: "값의 타입이 올바르지 않아 항목을 제거하고 기본값을 사용합니다",
      repaired: true,
    },
    {
      path: "workspaces[3].panes[1]",
      message: "값의 타입이 올바르지 않아 항목을 제거하고 기본값을 사용합니다",
      repaired: true,
    },
  ],
  // A structural repair rides along: it must be listed but never counted as a
  // dropped value.
  warnings: [
    { path: "docks[0].size", message: "독 크기를 기본값으로 수정했습니다.", repaired: true },
  ],
};

describe("SettingsRecoveryModal — recovered status (issue #701, ADR-0119)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists every dropped path so the user can see exactly what was lost", async () => {
    render(<SettingsRecoveryModal loadResult={RECOVERED} onDismiss={vi.fn()} onReset={vi.fn()} />);

    expect(screen.getByText("recovery.recoveredTitle")).toBeInTheDocument();
    expect(screen.getByText("recovery.recoveredDescription")).toBeInTheDocument();
    // The write-blocked promise must be stated, not just implied.
    expect(screen.getByText("recovery.recoveredWriteBlocked")).toBeInTheDocument();
    // A count alone would not tell the user which values are gone.
    expect(screen.getByText("terminal.parserAdmission.hiddenShare")).toBeInTheDocument();
    expect(screen.getByText("workspaces[3].panes[1]")).toBeInTheDocument();
    // Structural repairs are listed too, but under their own label.
    expect(screen.getByText("docks[0].size")).toBeInTheDocument();
  });

  it("counts only dropped values as removed, not structural repairs", () => {
    render(<SettingsRecoveryModal loadResult={RECOVERED} onDismiss={vi.fn()} onReset={vi.fn()} />);

    // 2 dropped + 1 structural repair. "Removed" must read 2, not 3 — the
    // repair is reported under its own count.
    const summary = screen.getByText(/recovery\.droppedCount/);
    expect(summary.textContent).toContain('recovery.droppedCount({"num":2})');
    expect(summary.textContent).toContain('recovery.repairedCount({"num":1})');
  });

  it("labels the dismiss button as an acknowledgement, not a plain OK", () => {
    render(<SettingsRecoveryModal loadResult={RECOVERED} onDismiss={vi.fn()} onReset={vi.fn()} />);

    expect(screen.getByTestId("settings-recovery-dismiss")).toHaveTextContent(
      "recovery.recoveredConfirm",
    );
  });

  it("shows the path the backend reported without a second round trip", async () => {
    const { getSettingsPath } = await import("@/lib/tauri-api");
    render(<SettingsRecoveryModal loadResult={RECOVERED} onDismiss={vi.fn()} onReset={vi.fn()} />);

    await userEvent.click(screen.getByTestId("settings-recovery-show-path"));

    expect(screen.getByText("C:\\config\\settings.json")).toBeInTheDocument();
    expect(getSettingsPath).not.toHaveBeenCalled();
  });

  it("hands the acknowledgement back to the caller, which releases the write block", async () => {
    const onDismiss = vi.fn();
    render(
      <SettingsRecoveryModal loadResult={RECOVERED} onDismiss={onDismiss} onReset={vi.fn()} />,
    );

    await userEvent.click(screen.getByTestId("settings-recovery-dismiss"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the repaired status on its own copy", () => {
    render(
      <SettingsRecoveryModal
        loadResult={{
          status: "repaired",
          settings: {} as never,
          warnings: [{ path: "docks[0].size", message: "수정됨", repaired: true }],
        }}
        onDismiss={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByText("recovery.validationTitle")).toBeInTheDocument();
    expect(screen.queryByText("recovery.recoveredWriteBlocked")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-recovery-dismiss")).toHaveTextContent("recovery.confirm");
  });
});
