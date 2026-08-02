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

const power = () => useSettingsStore.getState().power;

describe("SleepPreventionToggle", () => {
  beforeEach(() => {
    persistSession.mockClear();
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useSleepInhibitStore.setState(useSleepInhibitStore.getInitialState());
  });

  it("toggles the manual switch on and off", async () => {
    const user = userEvent.setup();
    render(<SleepPreventionToggle />);
    const button = screen.getByTestId("sleep-prevention-btn");

    expect(power().keepAwake).toBe(false);
    await user.click(button);
    expect(power().keepAwake).toBe(true);
    await user.click(button);
    expect(power().keepAwake).toBe(false);
  });

  it("leaves the standing policy alone", async () => {
    // The button owns one axis. Clicking it must not reach into the policy the
    // user set once in Settings (ADR-0116).
    useSettingsStore.getState().setPower({ keepAwakeWhenBusy: true });
    const user = userEvent.setup();
    render(<SleepPreventionToggle />);

    await user.click(screen.getByTestId("sleep-prevention-btn"));

    expect(power().keepAwakeWhenBusy).toBe(true);
  });

  it("persists the switch so it survives a restart", async () => {
    const user = userEvent.setup();
    render(<SleepPreventionToggle />);

    await user.click(screen.getByTestId("sleep-prevention-btn"));
    expect(persistSession).toHaveBeenCalled();
  });

  it("draws the manual switch, not what the backend happens to hold", () => {
    // The policy is keeping the machine awake, but the user's switch is off.
    // Drawing the inhibitor here would show a state they never asked for and
    // then not change when they click.
    useSettingsStore.getState().setPower({ keepAwakeWhenBusy: true });
    render(<SleepPreventionToggle />);
    const button = screen.getByTestId("sleep-prevention-btn");

    act(() => useSleepInhibitStore.getState().reportResult(true, true));

    expect(button).toHaveAttribute("data-keep-awake", "false");
    expect(button.style.color).toBe("var(--text-secondary)");
  });

  it("shows the switch as on without waiting for the backend", () => {
    useSettingsStore.getState().setPower({ keepAwake: true });
    render(<SleepPreventionToggle />);

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-keep-awake", "true");
    expect(button.style.color).toBe("var(--accent)");
    expect(button.style.opacity).toBe("1");
  });

  it("flags a request the machine refused instead of staying silent", () => {
    // Without this the user is told they are protected while the machine sleeps
    // through their build.
    useSettingsStore.getState().setPower({ keepAwake: true });
    render(<SleepPreventionToggle />);

    act(() => useSleepInhibitStore.getState().reportFailure());

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-failed", "true");
    expect(button.style.color).toBe("var(--claude)");
    expect(button.getAttribute("title")).toContain("failed");
  });

  it("flags a failure that the policy caused, not only the switch", () => {
    // Failure is a fault, not a value on either axis: a machine with no
    // systemd-inhibit would otherwise fail silently forever (ADR-0116).
    useSettingsStore.getState().setPower({ keepAwakeWhenBusy: true });
    render(<SleepPreventionToggle />);

    act(() => useSleepInhibitStore.getState().reportResult(false, false));

    const button = screen.getByTestId("sleep-prevention-btn");
    expect(button).toHaveAttribute("data-keep-awake", "false");
    expect(button).toHaveAttribute("data-failed", "true");
    expect(button.style.color).toBe("var(--claude)");
  });

  it("follows the store without being re-rendered by its parent", () => {
    // No forced rerender: a broken subscription has to show up here.
    render(<SleepPreventionToggle />);
    const button = screen.getByTestId("sleep-prevention-btn");

    act(() => useSettingsStore.getState().setPower({ keepAwake: true }));

    expect(button).toHaveAttribute("data-keep-awake", "true");
  });
});
