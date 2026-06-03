import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PaneNumberBadge } from "./PaneNumberBadge";

const mockClipboardWriteText = vi.fn(() => Promise.resolve());
vi.mock("@/lib/tauri-api", () => ({
  clipboardWriteText: (...args: unknown[]) => mockClipboardWriteText(...args),
}));

describe("PaneNumberBadge", () => {
  beforeEach(() => {
    mockClipboardWriteText.mockClear();
  });

  it("renders the pane number", () => {
    render(<PaneNumberBadge number={3} />);
    const badge = screen.getByTestId("pane-number-badge");
    expect(badge).toHaveTextContent("3");
  });

  it("renders nothing when number is undefined", () => {
    const { container } = render(<PaneNumberBadge number={undefined} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("pane-number-badge")).toBeNull();
  });

  it("renders a non-interactive span (no copy) when workspaceId is missing", () => {
    render(<PaneNumberBadge number={2} />);
    const badge = screen.getByTestId("pane-number-badge");
    expect(badge.tagName).toBe("SPAN");
    fireEvent.click(badge);
    expect(mockClipboardWriteText).not.toHaveBeenCalled();
  });

  it("copies the workspace+pane identifier to the clipboard on click", async () => {
    render(<PaneNumberBadge number={3} workspaceId="ws-a1b2c3d4" workspaceName="Backend" />);
    const badge = screen.getByTestId("pane-number-badge");
    expect(badge.tagName).toBe("BUTTON");
    fireEvent.click(badge);
    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledTimes(1));
    expect(mockClipboardWriteText).toHaveBeenCalledWith("lx:pane:Backend:3");
  });

  it("shows a copied checkmark after a successful copy", async () => {
    render(<PaneNumberBadge number={1} workspaceId="ws-x" workspaceName="Default" />);
    fireEvent.click(screen.getByTestId("pane-number-badge"));
    await waitFor(() => expect(screen.getByTestId("pane-number-badge-copied")).toBeTruthy());
  });

  it("does not enter the copied state when the clipboard write rejects", async () => {
    mockClipboardWriteText.mockRejectedValueOnce(new Error("clipboard denied"));
    render(<PaneNumberBadge number={1} workspaceId="ws-x" workspaceName="Default" />);
    fireEvent.click(screen.getByTestId("pane-number-badge"));
    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledTimes(1));
    // let the rejected promise settle, then assert no checkmark appeared
    await Promise.resolve();
    expect(screen.queryByTestId("pane-number-badge-copied")).toBeNull();
  });

  it("keeps a stable accessible name through the copied feedback", async () => {
    render(<PaneNumberBadge number={4} workspaceId="ws-x" workspaceName="Default" />);
    const badge = screen.getByTestId("pane-number-badge");
    expect(badge).toHaveAttribute("aria-label", "Copy pane 4 identifier");
    fireEvent.click(badge);
    // even while the aria-hidden ✓ replaces the number, the name must persist
    await waitFor(() => expect(screen.getByTestId("pane-number-badge-copied")).toBeTruthy());
    expect(badge).toHaveAttribute("aria-label", "Copy pane 4 identifier");
  });

  it("clears the pending feedback timer on unmount", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(
      <PaneNumberBadge number={1} workspaceId="ws-x" workspaceName="Default" />,
    );
    fireEvent.click(screen.getByTestId("pane-number-badge"));
    await waitFor(() => expect(screen.getByTestId("pane-number-badge-copied")).toBeTruthy());
    clearSpy.mockClear();
    unmount();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    clearSpy.mockRestore();
  });
});
