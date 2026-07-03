import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { LocalMobileModeOverlay } from "./LocalMobileModeOverlay";

describe("LocalMobileModeOverlay", () => {
  beforeEach(() => {
    useLocalMobileModeStore.setState(useLocalMobileModeStore.getInitialState());
  });

  it("renders the local remote page in a full-screen frame", () => {
    useLocalMobileModeStore.getState().enter("http://127.0.0.1:19281/remote/?localApp=1");

    render(<LocalMobileModeOverlay />);

    const frame = screen.getByTestId("local-mobile-mode-frame");
    expect(screen.getByTestId("local-mobile-mode-overlay")).toBeInTheDocument();
    expect(frame).toHaveAttribute("src", "http://127.0.0.1:19281/remote/?localApp=1");
  });

  it("exits when the remote page requests desktop mode", async () => {
    useLocalMobileModeStore.getState().enter("http://127.0.0.1:19281/remote/?localApp=1");

    render(<LocalMobileModeOverlay />);

    window.dispatchEvent(new MessageEvent("message", { data: { type: "laymux:desktop-mode" } }));

    await waitFor(() => {
      expect(screen.queryByTestId("local-mobile-mode-overlay")).not.toBeInTheDocument();
    });
    expect(useLocalMobileModeStore.getState().active).toBe(false);
  });
});
