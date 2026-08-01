import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const persistSession = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/persist-session", () => ({
  persistSession: () => persistSession(),
}));

import { SleepPreventionToggle } from "./SleepPreventionToggle";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

const mode = () => useSettingsStore.getState().power.sleepPrevention;

describe("SleepPreventionToggle", () => {
  beforeEach(() => {
    persistSession.mockClear();
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
  });

  it("cycles off → always → whenBusy → off", async () => {
    const user = userEvent.setup();
    render(<SleepPreventionToggle />);
    const button = screen.getByTestId("sleep-prevention-btn");

    expect(mode()).toBe("off");
    await user.click(button);
    expect(mode()).toBe("always");
    await user.click(button);
    expect(mode()).toBe("whenBusy");
    await user.click(button);
    expect(mode()).toBe("off");
  });

  it("persists the mode so it survives a restart", async () => {
    const user = userEvent.setup();
    render(<SleepPreventionToggle />);

    await user.click(screen.getByTestId("sleep-prevention-btn"));
    expect(persistSession).toHaveBeenCalled();
  });

  it("reports it is inhibiting whenever the mode is always", () => {
    useSettingsStore.getState().setPower({ sleepPrevention: "always" });
    render(<SleepPreventionToggle />);

    expect(screen.getByTestId("sleep-prevention-btn")).toHaveAttribute("data-inhibiting", "true");
  });

  it("in whenBusy, separates the selected mode from what is happening now", () => {
    useSettingsStore.getState().setPower({ sleepPrevention: "whenBusy" });
    const { rerender } = render(<SleepPreventionToggle />);

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-mode", "whenBusy");
    expect(button).toHaveAttribute("data-inhibiting", "false");

    const terminals = useTerminalStore.getState();
    terminals.registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-1",
    });
    terminals.updateInstanceInfo("t1", { outputActive: true });
    rerender(<SleepPreventionToggle />);

    expect(screen.getByTestId("sleep-prevention-btn")).toHaveAttribute("data-inhibiting", "true");
  });
});
