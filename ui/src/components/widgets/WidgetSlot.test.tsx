import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { WidgetSlot } from "./WidgetSlot";
import { useSettingsStore } from "@/stores/settings-store";
import type { WidgetInstance } from "@/lib/widget-placement";

/** Make the slot report a fixed width so overflow decisions are deterministic. */
function withSlotWidth(width: number) {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width, height: 28 } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = original;
  };
}

const instance = (id: string, type: string): WidgetInstance => ({ id, type, options: {} });

describe("WidgetSlot", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  it("makes a non-interactive top bar widget itself the window drag target", () => {
    // Tauri checks the event target, not its ancestors, so the attribute has to
    // be on the element the pointer lands on.
    render(
      <WidgetSlot
        slot={{ surface: "topBar", side: "left" }}
        instances={[instance("w1", "terminalActivity")]}
      />,
    );
    expect(screen.getByTestId("widget-terminal-activity-w1")).toHaveAttribute(
      "data-tauri-drag-region",
      "true",
    );
  });

  it("does not make an interactive widget a drag handle", () => {
    // Dragging would swallow the click that opens the notification panel.
    render(
      <WidgetSlot
        slot={{ surface: "topBar", side: "left" }}
        instances={[instance("w1", "notifications")]}
      />,
    );
    expect(screen.getByTestId("widget-notifications-w1")).not.toHaveAttribute(
      "data-tauri-drag-region",
    );
  });

  it("does not turn status line widgets into drag handles", () => {
    render(
      <WidgetSlot
        slot={{ surface: "statusLine", side: "left" }}
        instances={[instance("w1", "terminalActivity")]}
      />,
    );
    expect(screen.getByTestId("widget-terminal-activity-w1")).not.toHaveAttribute(
      "data-tauri-drag-region",
    );
  });

  it("skips a widget type this build does not know", () => {
    render(
      <WidgetSlot
        slot={{ surface: "topBar", side: "left" }}
        instances={[instance("w1", "fromTheFuture"), instance("w2", "notifications")]}
      />,
    );
    expect(screen.getByTestId("widget-notifications-w2")).toBeInTheDocument();
    expect(screen.queryByTestId("widget-slot-topBar-left")?.textContent).not.toContain(
      "fromTheFuture",
    );
  });

  it("collapses from the tail of a left slot and reveals the rest on demand", async () => {
    const restore = withSlotWidth(70);
    try {
      const user = userEvent.setup();
      render(
        <WidgetSlot
          slot={{ surface: "topBar", side: "left" }}
          instances={[instance("w1", "notifications"), instance("w2", "terminalActivity")]}
        />,
      );

      expect(screen.getByTestId("widget-notifications-w1")).toBeVisible();
      expect(screen.getByTestId("widget-terminal-activity-w2")).not.toBeVisible();

      await user.click(screen.getByTestId("widget-overflow-topBar-left"));
      expect(screen.getByTestId("widget-terminal-activity-w2")).toBeVisible();
    } finally {
      restore();
    }
  });

  it("keeps a collapsed widget mounted so its probe subscription survives", () => {
    // Unmounting would drop demand to zero and retire the probe, so dragging the
    // window across the threshold would restart `claude` every time.
    const restore = withSlotWidth(70);
    try {
      render(
        <WidgetSlot
          slot={{ surface: "topBar", side: "left" }}
          instances={[instance("w1", "notifications"), instance("w2", "terminalActivity")]}
        />,
      );
      expect(screen.getByTestId("widget-terminal-activity-w2")).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("collapses from the head of a right slot so the window edge keeps its widgets", () => {
    const restore = withSlotWidth(80);
    try {
      render(
        <WidgetSlot
          slot={{ surface: "topBar", side: "right" }}
          instances={[instance("w1", "notifications"), instance("w2", "terminalActivity")]}
        />,
      );
      expect(screen.getByTestId("widget-notifications-w1")).not.toBeVisible();
      expect(screen.getByTestId("widget-terminal-activity-w2")).toBeVisible();
    } finally {
      restore();
    }
  });

  it("still reports the collapse when the slot was squeezed to no width at all", () => {
    // Zero width after measurement is real pressure, not "not measured yet" —
    // silently clipping every widget would hide that anything was dropped.
    const restore = withSlotWidth(0);
    try {
      render(
        <WidgetSlot
          slot={{ surface: "topBar", side: "left" }}
          instances={[instance("w1", "notifications")]}
        />,
      );
      expect(screen.getByTestId("widget-overflow-topBar-left")).toBeInTheDocument();
      expect(screen.getByTestId("widget-notifications-w1")).not.toBeVisible();
    } finally {
      restore();
    }
  });

  it("shows no overflow indicator when everything fits", () => {
    render(
      <WidgetSlot
        slot={{ surface: "topBar", side: "left" }}
        instances={[instance("w1", "notifications")]}
      />,
    );
    expect(screen.queryByTestId("widget-overflow-topBar-left")).not.toBeInTheDocument();
  });

  it("asks only for the width its placement wants", () => {
    render(
      <WidgetSlot
        slot={{ surface: "topBar", side: "left" }}
        instances={[instance("w1", "notifications")]}
      />,
    );
    // 0 1 <requested> — never `1 1 0`, which would claim an equal share of the
    // row regardless of what is placed.
    expect(screen.getByTestId("widget-slot-topBar-left")).toHaveStyle({ flexBasis: "46px" });
  });

  it("applies the shared widget font family and size", () => {
    useSettingsStore.setState((state) => ({
      widgets: { ...state.widgets, fontFamily: "JetBrains Mono", fontSize: 13 },
    }));
    render(
      <WidgetSlot
        slot={{ surface: "topBar", side: "left" }}
        instances={[instance("w1", "notifications")]}
      />,
    );
    expect(screen.getByTestId("widget-slot-topBar-left")).toHaveStyle({
      fontFamily: "JetBrains Mono",
      fontSize: "13px",
      flexBasis: "66px",
    });
  });
});
