import { act, render, screen } from "@testing-library/react";
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

  it("follows the backend without being re-rendered by its parent", () => {
    // No forced rerender: a broken subscription has to show up here.
    useSettingsStore.getState().setPower({ sleepPrevention: "whenBusy" });
    render(<SleepPreventionToggle />);

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-mode", "whenBusy");
    expect(button.style.color).toBe("var(--text-secondary)");

    act(() => useSleepInhibitStore.getState().reportResult(true, true));

    expect(button).toHaveAttribute("data-inhibiting", "true");
    expect(button.style.color).toBe("var(--accent)");
    expect(button.style.opacity).toBe("1");
  });

  it("flags a request the machine refused instead of claiming success", () => {
    // Without this the user is told they are protected while the machine sleeps
    // through their build.
    useSettingsStore.getState().setPower({ sleepPrevention: "always" });
    render(<SleepPreventionToggle />);

    act(() => useSleepInhibitStore.getState().reportFailure());

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-failed", "true");
    expect(button).toHaveAttribute("data-inhibiting", "false");
    expect(button.style.color).toBe("var(--claude)");
    expect(button.getAttribute("title")).toContain("failed");
  });

  it("flags a request the backend answered with a different state", () => {
    useSettingsStore.getState().setPower({ sleepPrevention: "always" });
    render(<SleepPreventionToggle />);

    // Asked to inhibit; the backend reports it is not inhibiting.
    act(() => useSleepInhibitStore.getState().reportResult(false, false));

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-failed", "true");
    expect(button).toHaveAttribute("data-inhibiting", "false");
  });
});
