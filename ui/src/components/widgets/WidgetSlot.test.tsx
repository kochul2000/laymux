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

  it("keeps the window drag region on a non-interactive widget", () => {
    render(
      <WidgetSlot
        slot={{ surface: "topBar", side: "left" }}
        instances={[instance("w1", "terminalActivity")]}
      />,
    );
    const widget = screen.getByTestId("widget-terminal-activity-w1");
    expect(widget.parentElement).toHaveAttribute("data-tauri-drag-region", "true");
  });

  it("does not make an interactive widget a drag handle", () => {
    // Dragging would swallow the click that opens the notification panel.
    render(
      <WidgetSlot
        slot={{ surface: "topBar", side: "left" }}
        instances={[instance("w1", "notifications")]}
      />,
    );
    const widget = screen.getByTestId("widget-notifications-w1");
    expect(widget.parentElement).not.toHaveAttribute("data-tauri-drag-region");
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

  it("collapses from the tail of a left slot and offers the rest behind an indicator", async () => {
    const restore = withSlotWidth(70);
    try {
      const user = userEvent.setup();
      render(
        <WidgetSlot
          slot={{ surface: "topBar", side: "left" }}
          instances={[instance("w1", "notifications"), instance("w2", "terminalActivity")]}
        />,
      );

      expect(screen.getByTestId("widget-notifications-w1")).toBeInTheDocument();
      expect(screen.queryByTestId("widget-terminal-activity-w2")).not.toBeInTheDocument();

      // The collapsed widget must stay reachable — hidden, never silently gone.
      await user.click(screen.getByTestId("widget-overflow-topBar-left"));
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
      expect(screen.queryByTestId("widget-notifications-w1")).not.toBeInTheDocument();
      expect(screen.getByTestId("widget-terminal-activity-w2")).toBeInTheDocument();
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
});
