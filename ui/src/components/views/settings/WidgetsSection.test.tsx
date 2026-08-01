import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WidgetsSectionBody } from "./WidgetsSection";
import { defaultWidgets, type WidgetsSettings } from "@/lib/widget-placement";

function setup(initial: WidgetsSettings = defaultWidgets()) {
  const onChange = vi.fn();
  render(
    <WidgetsSectionBody widgets={initial} onChange={onChange} claudeConfigDirs={["", "/alt"]} />,
  );
  return onChange;
}

const placed = (): WidgetsSettings => ({
  ...defaultWidgets(),
  topBar: {
    left: [
      { id: "w1", type: "claudeUsage", options: { display: "both", configDir: "" } },
      { id: "w2", type: "cwd", options: {} },
    ],
    right: [],
  },
});

describe("WidgetsSectionBody", () => {
  it("offers all four slots", () => {
    setup();
    for (const key of ["topBar.left", "topBar.right", "statusLine.left", "statusLine.right"]) {
      expect(screen.getByTestId(`widgets-slot-title-${key}`)).toBeInTheDocument();
    }
  });

  it("adds a widget with its default options", async () => {
    const user = userEvent.setup();
    const onChange = setup();

    await user.selectOptions(screen.getByTestId("widgets-add-topBar.left"), "codexUsage");

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left).toHaveLength(1);
    expect(next.topBar.left[0].type).toBe("codexUsage");
    expect(next.topBar.left[0].options).toEqual({ display: "both" });
  });

  it("reorders within a slot", async () => {
    const user = userEvent.setup();
    const onChange = setup(placed());

    await user.click(screen.getByTestId("widgets-down-w1"));

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left.map((w) => w.id)).toEqual(["w2", "w1"]);
  });

  it("moves a widget to another slot keeping its id", async () => {
    const user = userEvent.setup();
    const onChange = setup(placed());

    await user.selectOptions(screen.getByTestId("widgets-move-w1"), "statusLine.right");

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left.map((w) => w.id)).toEqual(["w2"]);
    expect(next.statusLine.right.map((w) => w.id)).toEqual(["w1"]);
  });

  it("edits an option without touching the others", async () => {
    const user = userEvent.setup();
    const onChange = setup(placed());

    await user.selectOptions(screen.getByTestId("widgets-option-w1-display"), "bar");

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left[0].options).toEqual({ display: "bar", configDir: "" });
  });

  it("removes a widget", async () => {
    const user = userEvent.setup();
    const onChange = setup(placed());

    await user.click(screen.getByTestId("widgets-remove-w2"));

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left.map((w) => w.id)).toEqual(["w1"]);
  });

  it("toggles the status line without discarding what is placed on it", async () => {
    const user = userEvent.setup();
    const withStatusLine: WidgetsSettings = {
      ...defaultWidgets(),
      statusLine: { enabled: false, left: [{ id: "w9", type: "cwd", options: {} }], right: [] },
    };
    const onChange = setup(withStatusLine);

    await user.click(screen.getByTestId("widgets-status-line-toggle"));

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.statusLine.enabled).toBe(true);
    expect(next.statusLine.left).toHaveLength(1);
  });

  it("still lists a widget type this build does not know", () => {
    // It cannot be rendered, but it must remain visible and removable here.
    setup({
      ...defaultWidgets(),
      topBar: { left: [{ id: "w1", type: "fromTheFuture", options: {} }], right: [] },
    });
    expect(screen.getByTestId("widgets-row-w1")).toBeInTheDocument();
    expect(screen.getByTestId("widgets-remove-w1")).toBeInTheDocument();
  });
});
