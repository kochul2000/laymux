import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const persistSession = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/persist-session", () => ({
  persistSession: () => persistSession(),
}));

import { SleepPreventionToggle } from "./SleepPreventionToggle";
import { useSettingsStore } from "@/stores/settings-store";
import { useSleepInhibitStore } from "@/stores/sleep-inhibit-store";

const mode = () => useSettingsStore.getState().power.sleepPrevention;

describe("SleepPreventionToggle", () => {
  beforeEach(() => {
    persistSession.mockClear();
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useSleepInhibitStore.setState(useSleepInhibitStore.getInitialState());
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

  it("reports what the backend confirmed, not what the mode asked for", () => {
    // The mode says "always", so a mode-derived icon would claim the machine is
    // being kept awake — but nothing has been acquired yet.
    useSettingsStore.getState().setPower({ sleepPrevention: "always" });
    render(<SleepPreventionToggle />);

    expect(screen.getByTestId("sleep-prevention-btn")).toHaveAttribute("data-inhibiting", "false");
  });

  it("lights up once an inhibitor is actually held", () => {
    useSettingsStore.getState().setPower({ sleepPrevention: "always" });
    useSleepInhibitStore.getState().reportSuccess(true);
    render(<SleepPreventionToggle />);

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-inhibiting", "true");
    expect(button).toHaveAttribute("data-failed", "false");
  });

  it("in whenBusy, separates the selected mode from what is happening now", () => {
    useSettingsStore.getState().setPower({ sleepPrevention: "whenBusy" });
    const { rerender } = render(<SleepPreventionToggle />);

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-mode", "whenBusy");
    expect(button).toHaveAttribute("data-inhibiting", "false");

    useSleepInhibitStore.getState().reportSuccess(true);
    rerender(<SleepPreventionToggle />);

    expect(screen.getByTestId("sleep-prevention-btn")).toHaveAttribute("data-inhibiting", "true");
  });

  it("flags a request the machine refused instead of claiming success", () => {
    // Without this the user is told they are protected while the machine sleeps
    // through their build.
    useSettingsStore.getState().setPower({ sleepPrevention: "always" });
    useSleepInhibitStore.getState().reportFailure();
    render(<SleepPreventionToggle />);

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-failed", "true");
    expect(button).toHaveAttribute("data-inhibiting", "false");
    expect(button.getAttribute("title")).toContain("failed");
  });
});
