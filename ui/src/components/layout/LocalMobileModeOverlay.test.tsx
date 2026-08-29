import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { LocalMobileModeOverlay } from "./LocalMobileModeOverlay";

const FRAME_URL = "http://127.0.0.1:19281/remote/?localApp=1";
const FRAME_ORIGIN = "http://127.0.0.1:19281";

function postFromFrame(type: string, origin = FRAME_ORIGIN): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type }, origin }));
  });
}

describe("LocalMobileModeOverlay", () => {
  beforeEach(() => {
    useLocalMobileModeStore.setState(useLocalMobileModeStore.getInitialState());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the local remote page in a full-screen frame", () => {
    useLocalMobileModeStore.getState().enter(FRAME_URL);

    render(<LocalMobileModeOverlay />);

    const frame = screen.getByTestId("local-mobile-mode-frame");
    expect(screen.getByTestId("local-mobile-mode-overlay")).toBeInTheDocument();
    expect(frame).toHaveAttribute("src", FRAME_URL);
    expect(frame).toHaveAttribute("allow", "clipboard-write");
  });

  it("exits when the remote page requests desktop mode", async () => {
    useLocalMobileModeStore.getState().enter(FRAME_URL);

    render(<LocalMobileModeOverlay />);

    postFromFrame("laymux:desktop-mode");

    await waitFor(() => {
      expect(screen.queryByTestId("local-mobile-mode-overlay")).not.toBeInTheDocument();
    });
    expect(useLocalMobileModeStore.getState().active).toBe(false);
  });

  it("ignores a desktop-mode message from another origin", async () => {
    useLocalMobileModeStore.getState().enter(FRAME_URL);

    render(<LocalMobileModeOverlay />);

    // The Remote page renders host files in sandboxed iframes of its own; one of
    // them must not be able to reach past its parent and close the overlay.
    postFromFrame("laymux:desktop-mode", "https://evil.example");

    await Promise.resolve();
    expect(screen.getByTestId("local-mobile-mode-overlay")).toBeInTheDocument();
    expect(useLocalMobileModeStore.getState().active).toBe(true);
  });

  /**
   * Issue #955: the embed was refused (the served CSP framed nobody) and the
   * only exit lived inside the page that never loaded, so the app had to be
   * killed. A frame that never greets the host now gets a host-drawn exit.
   */
  it("offers a host-drawn exit when the frame never announces itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useLocalMobileModeStore.getState().enter(FRAME_URL);

    render(<LocalMobileModeOverlay />);
    expect(screen.queryByTestId("local-mobile-mode-fallback")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(4000));

    const exitButton = await screen.findByTestId("local-mobile-mode-exit");
    await userEvent.click(exitButton);

    expect(useLocalMobileModeStore.getState().active).toBe(false);
  });

  it("ignores a ready message from another origin", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useLocalMobileModeStore.getState().enter(FRAME_URL);

    render(<LocalMobileModeOverlay />);
    postFromFrame("laymux:mobile-mode-ready", "https://evil.example");

    await act(() => vi.advanceTimersByTimeAsync(4000));

    // A greeting the embed did not send must not suppress the host's exit.
    expect(screen.getByTestId("local-mobile-mode-fallback")).toBeInTheDocument();
  });

  /**
   * The overlay never unmounts (App renders it unconditionally) and the same
   * port and token rebuild the identical URL, so a re-entry must not inherit
   * the previous entry's verdict — in either direction.
   */
  it("starts its verdict over on every entry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { enter, exit } = useLocalMobileModeStore.getState();

    enter(FRAME_URL);
    render(<LocalMobileModeOverlay />);
    postFromFrame("laymux:mobile-mode-ready");
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(screen.queryByTestId("local-mobile-mode-fallback")).not.toBeInTheDocument();

    act(() => exit());
    act(() => enter(FRAME_URL));
    // Same URL, second entry — this time the frame stays silent.
    expect(screen.queryByTestId("local-mobile-mode-fallback")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getByTestId("local-mobile-mode-fallback")).toBeInTheDocument();
  });

  it("stays out of the way once the frame announces itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useLocalMobileModeStore.getState().enter(FRAME_URL);

    render(<LocalMobileModeOverlay />);
    postFromFrame("laymux:mobile-mode-ready");

    await act(() => vi.advanceTimersByTimeAsync(4000));

    expect(screen.queryByTestId("local-mobile-mode-fallback")).not.toBeInTheDocument();
    expect(useLocalMobileModeStore.getState().active).toBe(true);
  });

  it("exits on Escape while the frame has not announced itself", async () => {
    useLocalMobileModeStore.getState().enter(FRAME_URL);

    render(<LocalMobileModeOverlay />);

    await userEvent.keyboard("{Escape}");

    expect(useLocalMobileModeStore.getState().active).toBe(false);
  });

  it("hands Escape back to the frame once it announces itself", async () => {
    useLocalMobileModeStore.getState().enter(FRAME_URL);

    render(<LocalMobileModeOverlay />);
    postFromFrame("laymux:mobile-mode-ready");

    await userEvent.keyboard("{Escape}");

    // A live mobile view owns Escape for its own drawers and overlays.
    expect(useLocalMobileModeStore.getState().active).toBe(true);
  });
});
