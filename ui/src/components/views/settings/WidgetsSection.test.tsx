import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WidgetsSectionBody } from "./WidgetsSection";
import { defaultWidgets, type WidgetsSettings } from "@/lib/widget-placement";

function setup(initial: WidgetsSettings = defaultWidgets()) {
  const onChange = vi.fn();
  const view = render(
    <WidgetsSectionBody widgets={initial} onChange={onChange} claudeConfigDirs={["", "/alt"]} />,
  );
  return { onChange, view };
}

const placed = (): WidgetsSettings => ({
  ...defaultWidgets(),
  topBar: {
    left: [
      { id: "w1", type: "claudeUsage", options: { display: "both", configDir: "", barHeight: 4 } },
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

  it("edits the shared widget font family and size", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      <WidgetsSectionBody
        widgets={defaultWidgets()}
        onChange={onChange}
        claudeConfigDirs={[""]}
        fontFamilies={["JetBrains Mono"]}
      />,
    );

    expect(screen.getByTestId("widgets-font-family")).toBeInTheDocument();
    expect(screen.getByTestId("widgets-font-size")).toHaveValue(9);
    expect(screen.getByTestId("widgets-font-size")).toHaveStyle({ width: "60px" });
    await user.selectOptions(screen.getByTestId("widgets-font-family"), "JetBrains Mono");
    const withFamily = onChange.mock.calls.at(-1)?.[0] as WidgetsSettings;
    expect(withFamily.fontFamily).toBe("JetBrains Mono");
    expect(screen.getByTestId("widgets-preview-topBar")).toHaveStyle({ fontSize: "9px" });

    view.rerender(
      <WidgetsSectionBody
        widgets={withFamily}
        onChange={onChange}
        claudeConfigDirs={[""]}
        fontFamilies={["JetBrains Mono"]}
      />,
    );
    fireEvent.change(screen.getByTestId("widgets-font-size"), { target: { value: "13" } });
    const withSize = onChange.mock.calls.at(-1)?.[0] as WidgetsSettings;
    expect(withSize.fontSize).toBe(13);
  });

  it("previews both surfaces with the real widgets", () => {
    // A mock preview would drift from the bar it depicts.
    setup(placed());
    expect(screen.getByTestId("widgets-preview-topBar")).toBeInTheDocument();
    expect(screen.getByTestId("widgets-preview-statusLine")).toBeInTheDocument();
    expect(screen.getByTestId("widgets-preview-item-w2")).toBeInTheDocument();
    expect(screen.getByTestId("widget-cwd-w2")).toBeInTheDocument();
  });

  it("shows no options until a widget is picked", () => {
    setup(placed());
    expect(screen.getByTestId("widgets-select-hint")).toBeInTheDocument();
    expect(screen.queryByTestId("widgets-detail-w1")).not.toBeInTheDocument();
  });

  it("opens the detail panel for the widget picked in the list", async () => {
    const user = userEvent.setup();
    setup(placed());

    await user.click(screen.getByTestId("widgets-chip-w1"));

    expect(screen.getByTestId("widgets-detail-w1")).toBeInTheDocument();
    expect(screen.getByTestId("widgets-option-w1-display")).toBeInTheDocument();
    expect(screen.getByTestId("widgets-option-w1-barHeight")).toBeInTheDocument();
    expect(screen.getByTestId("widgets-option-w1-barWidth")).toBeInTheDocument();
    expect(screen.getByTestId("widgets-option-w1-barWidth")).toHaveValue(26);
    expect(screen.getByTestId("widgets-option-w1-barWidth")).toHaveStyle({ width: "60px" });
    // Only the picked one.
    expect(screen.queryByTestId("widgets-detail-w2")).not.toBeInTheDocument();
  });

  it("opens the detail panel for the widget picked in the preview", async () => {
    const user = userEvent.setup();
    setup(placed());

    await user.click(screen.getByTestId("widgets-preview-item-w2"));

    expect(screen.getByTestId("widgets-detail-w2")).toBeInTheDocument();
  });

  it("adds a widget with its default options and selects it", async () => {
    const user = userEvent.setup();
    const { onChange, view } = setup();

    await user.selectOptions(screen.getByTestId("widgets-add-topBar.left"), "codexUsage");

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left).toHaveLength(1);
    expect(next.topBar.left[0].type).toBe("codexUsage");
    expect(next.topBar.left[0].options).toEqual({
      display: "both",
      barHeight: 4,
      elapsedHeight: 2,
      barWidth: 26,
    });

    // The next thing wanted is its options, so it opens straight away.
    view.rerender(
      <WidgetsSectionBody widgets={next} onChange={onChange} claudeConfigDirs={[""]} />,
    );
    expect(screen.getByTestId(`widgets-detail-${next.topBar.left[0].id}`)).toBeInTheDocument();
  });

  it("reorders within a slot from the detail panel", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(placed());

    await user.click(screen.getByTestId("widgets-chip-w1"));
    await user.click(screen.getByTestId("widgets-down-w1"));

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left.map((w) => w.id)).toEqual(["w2", "w1"]);
  });

  it("moves a widget to another slot keeping its id", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(placed());

    await user.click(screen.getByTestId("widgets-chip-w1"));
    await user.selectOptions(screen.getByTestId("widgets-move-w1"), "statusLine.right");

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left.map((w) => w.id)).toEqual(["w2"]);
    expect(next.statusLine.right.map((w) => w.id)).toEqual(["w1"]);
  });

  it("edits an option without touching the others", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(placed());

    await user.click(screen.getByTestId("widgets-chip-w1"));
    await user.selectOptions(screen.getByTestId("widgets-option-w1-display"), "bar");

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left[0].options).toEqual({ display: "bar", configDir: "", barHeight: 4 });
  });

  it("clamps a bar thickness typed outside the allowed range", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(placed());

    await user.click(screen.getByTestId("widgets-chip-w1"));
    await user.clear(screen.getByTestId("widgets-option-w1-barHeight"));
    await user.type(screen.getByTestId("widgets-option-w1-barHeight"), "40");

    const last = onChange.mock.calls.at(-1)?.[0] as WidgetsSettings;
    expect(last.topBar.left[0].options.barHeight).toBe(10);
  });

  it("removes a widget and closes its detail panel", async () => {
    const user = userEvent.setup();
    const { onChange, view } = setup(placed());

    await user.click(screen.getByTestId("widgets-chip-w2"));
    await user.click(screen.getByTestId("widgets-remove-w2"));

    const next = onChange.mock.calls[0][0] as WidgetsSettings;
    expect(next.topBar.left.map((w) => w.id)).toEqual(["w1"]);

    view.rerender(
      <WidgetsSectionBody widgets={next} onChange={onChange} claudeConfigDirs={[""]} />,
    );
    expect(screen.queryByTestId("widgets-detail-w2")).not.toBeInTheDocument();
    expect(screen.getByTestId("widgets-select-hint")).toBeInTheDocument();
  });

  it("toggles the status line without discarding what is placed on it", async () => {
    const user = userEvent.setup();
    const withStatusLine: WidgetsSettings = {
      ...defaultWidgets(),
      statusLine: { enabled: false, left: [{ id: "w9", type: "cwd", options: {} }], right: [] },
    };
    const { onChange } = setup(withStatusLine);

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
    expect(screen.getByTestId("widgets-chip-w1")).toBeInTheDocument();
  });
});
