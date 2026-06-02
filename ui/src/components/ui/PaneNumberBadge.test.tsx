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
    expect(mockClipboardWriteText).toHaveBeenCalledWith(
      '[laymux pane] workspace=ws-a1b2c3d4 ("Backend") pane=3',
    );
  });

  it("shows a copied checkmark after a successful copy", async () => {
    render(<PaneNumberBadge number={1} workspaceId="ws-x" />);
    fireEvent.click(screen.getByTestId("pane-number-badge"));
    await waitFor(() => expect(screen.getByTestId("pane-number-badge-copied")).toBeTruthy());
  });
});
