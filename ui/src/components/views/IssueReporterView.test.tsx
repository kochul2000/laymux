import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { IssueReporterView } from "./IssueReporterView";

// Mock fetch for screenshot capture
const mockFetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ path: "/tmp/screenshot.png", dataUrl: "data:image/png;base64,abc" }),
});
global.fetch = mockFetch;

// Mock @tauri-apps/api/core
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock @tauri-apps/plugin-shell
const mockShellOpen = vi.fn();
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (...args: unknown[]) => mockShellOpen(...args),
}));

describe("IssueReporterView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ path: "/tmp/screenshot.png", dataUrl: "data:image/png;base64,abc" }),
    });
  });

  it("renders the form", () => {
    render(<IssueReporterView />);
    expect(screen.getByTestId("issue-reporter-view")).toBeInTheDocument();
    expect(screen.getByTestId("issue-title")).toBeInTheDocument();
    expect(screen.getByTestId("issue-body")).toBeInTheDocument();
    expect(screen.getByTestId("issue-submit")).toBeInTheDocument();
  });

  it("disables submit button after successful submission", async () => {
    const user = userEvent.setup();
    mockInvoke.mockResolvedValue("https://github.com/repo/issues/1");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-submit")).toBeDisabled();
    });
  });

  it("shows 'New Report' button after successful submission", async () => {
    const user = userEvent.setup();
    mockInvoke.mockResolvedValue("https://github.com/repo/issues/1");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });
  });

  it("resets form when 'New Report' is clicked", async () => {
    const user = userEvent.setup();
    mockInvoke.mockResolvedValue("https://github.com/repo/issues/1");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.type(screen.getByTestId("issue-body"), "Some body");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("issue-new-report"));

    expect(screen.getByTestId("issue-title")).toHaveValue("");
    expect(screen.getByTestId("issue-body")).toHaveValue("");
    // Button text should be back to "Submit Issue" (not "Submitted!")
    expect(screen.getByText("Submit Issue")).toBeInTheDocument();
    // "New Report" button should be gone
    expect(screen.queryByTestId("issue-new-report")).not.toBeInTheDocument();
  });

  it("opens issue URL in system browser when clicked", async () => {
    const user = userEvent.setup();
    mockInvoke.mockResolvedValue("https://github.com/repo/issues/1");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByText("Submitted!")).toBeInTheDocument();
    });

    const link = screen.getByTestId("issue-link");
    expect(link).toBeInTheDocument();

    mockShellOpen.mockClear();
    await user.click(link);

    expect(mockShellOpen).toHaveBeenCalledWith("https://github.com/repo/issues/1");
  });

  it("disables submit button during submission", async () => {
    const user = userEvent.setup();
    // Make invoke hang to test the submitting state
    mockInvoke.mockImplementation(() => new Promise(() => {}));

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    expect(screen.getByTestId("issue-submit")).toBeDisabled();
    expect(screen.getByText("Submitting...")).toBeInTheDocument();
  });

  it("disables submit button after error and allows retry", async () => {
    const user = userEvent.setup();
    mockInvoke.mockRejectedValueOnce(new Error("Network error"));

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      // After error, submit button should be re-enabled for retry
      expect(screen.getByTestId("issue-submit")).not.toBeDisabled();
    });
  });

  it("shows 'New Report' button after error for clearing form", async () => {
    const user = userEvent.setup();
    mockInvoke.mockRejectedValueOnce(new Error("Network error"));

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.type(screen.getByTestId("issue-body"), "Some body");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });

    // Clicking New Report should clear form
    await user.click(screen.getByTestId("issue-new-report"));
    expect(screen.getByTestId("issue-title")).toHaveValue("");
    expect(screen.getByTestId("issue-body")).toHaveValue("");
    expect(screen.getByText("Submit Issue")).toBeInTheDocument();
  });

  it("prevents double submission with rapid clicks", async () => {
    const user = userEvent.setup();
    let resolveSubmit: (value: string) => void;
    mockInvoke.mockImplementation(
      () => new Promise<string>((resolve) => { resolveSubmit = resolve; }),
    );

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");

    // Rapid double-click
    const btn = screen.getByTestId("issue-submit");
    await user.click(btn);
    await user.click(btn);

    // Should only invoke once despite two clicks
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Resolve to clean up
    resolveSubmit!("https://github.com/repo/issues/1");
  });

  it("awaits shell open and handles errors gracefully", async () => {
    const user = userEvent.setup();
    mockInvoke.mockResolvedValue("https://github.com/repo/issues/1");
    mockShellOpen.mockRejectedValueOnce(new Error("shell open failed"));

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-link")).toBeInTheDocument();
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    // Click the link — should not throw even if shell open fails
    await user.click(screen.getByTestId("issue-link"));

    expect(mockShellOpen).toHaveBeenCalledWith("https://github.com/repo/issues/1");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("shell.open failed"),
      expect.any(Error),
    );
    expect(windowOpenSpy).toHaveBeenCalledWith("https://github.com/repo/issues/1", "_blank");

    warnSpy.mockRestore();
    windowOpenSpy.mockRestore();
  });
});
