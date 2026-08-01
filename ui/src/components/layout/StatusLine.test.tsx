import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { StatusLine } from "./StatusLine";
import { useSettingsStore } from "@/stores/settings-store";
import { defaultWidgets } from "@/lib/widget-placement";

describe("StatusLine", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  it("is absent until the user turns it on", () => {
    render(<StatusLine />);
    expect(screen.queryByTestId("status-line")).not.toBeInTheDocument();
  });

  it("renders both slots once enabled", () => {
    useSettingsStore.setState({
      widgets: {
        ...defaultWidgets(),
        statusLine: {
          enabled: true,
          left: [{ id: "w1", type: "cwd", options: {} }],
          right: [{ id: "w2", type: "notifications", options: {} }],
        },
      },
    });
    render(<StatusLine />);

    expect(screen.getByTestId("status-line")).toBeInTheDocument();
    expect(screen.getByTestId("widget-cwd-w1")).toBeInTheDocument();
    expect(screen.getByTestId("widget-notifications-w2")).toBeInTheDocument();
  });

  it("keeps the placement when it is turned off again", () => {
    // Off is not delete: the user's arrangement has to survive a toggle.
    const placed = {
      ...defaultWidgets(),
      statusLine: { enabled: false, left: [{ id: "w1", type: "cwd", options: {} }], right: [] },
    };
    useSettingsStore.setState({ widgets: placed });
    render(<StatusLine />);

    expect(screen.queryByTestId("status-line")).not.toBeInTheDocument();
    expect(useSettingsStore.getState().widgets.statusLine.left).toHaveLength(1);
  });
});
