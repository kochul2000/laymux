import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToggleSwitch } from "./ToggleSwitch";

function ToggleHarness() {
  const [checked, setChecked] = useState(false);
  return <ToggleSwitch aria-label="Runtime access" checked={checked} onChange={setChecked} />;
}

describe("ToggleSwitch", () => {
  it("exposes switch semantics and aria-checked", async () => {
    const user = userEvent.setup();
    render(<ToggleHarness />);

    const toggle = screen.getByRole("switch", { name: "Runtime access" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveClass("ui-switch-input");
    expect(toggle.nextElementSibling).toHaveClass("ui-switch-track");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("toggles with Enter and Space", async () => {
    const user = userEvent.setup();
    render(<ToggleHarness />);

    const toggle = screen.getByRole("switch", { name: "Runtime access" });
    toggle.focus();

    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
