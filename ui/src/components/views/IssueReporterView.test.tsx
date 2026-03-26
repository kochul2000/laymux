import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @tauri-apps/api/core — must be before component import
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock global fetch for screenshot capture
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

import { IssueReporterView } from "./IssueReporterView";

describe("IssueReporterView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: screenshot capture returns no data
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({}),
    });
    // Default: submit succeeds
    mockInvoke.mockResolvedValue("https://github.com/user/repo/issues/42");
  });

  it("renders the issue reporter form", () => {
    render(<IssueReporterView />);
    expect(screen.getByTestId("issue-reporter-view")).toBeInTheDocument();
    expect(screen.getByTestId("issue-title")).toBeInTheDocument();
    expect(screen.getByTestId("issue-body")).toBeInTheDocument();
    expect(screen.getByTestId("issue-submit")).toBeInTheDocument();
  });

  it("submit button is disabled when title is empty", () => {
    render(<IssueReporterView />);
    const submitBtn = screen.getByTestId("issue-submit");
    expect(submitBtn).toBeDisabled();
  });

  it("submit button is enabled when title has content", async () => {
    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    expect(screen.getByTestId("issue-submit")).toBeEnabled();
  });

  it("disables submit button after successful submission", async () => {
    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-submit")).toBeDisabled();
    });
  });

  it("shows 'Submitted!' text after successful submission", async () => {
    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-submit")).toHaveTextContent("Submitted!");
    });
  });

  it("shows 'New Report' button after successful submission", async () => {
    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });
  });

  it("'New Report' button resets the form", async () => {
    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.type(screen.getByTestId("issue-body"), "Some description");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("issue-new-report"));

    // Form should be reset
    expect((screen.getByTestId("issue-title") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("issue-body") as HTMLTextAreaElement).value).toBe("");
    // Submit button should show "Submit Issue" and be disabled (empty title)
    expect(screen.getByTestId("issue-submit")).toHaveTextContent("Submit Issue");
    expect(screen.getByTestId("issue-submit")).toBeDisabled();
    // "New Report" button should be gone
    expect(screen.queryByTestId("issue-new-report")).not.toBeInTheDocument();
  });

  it("disables submit button while submitting", async () => {
    // Make invoke hang to test the submitting state
    mockInvoke.mockReturnValue(new Promise(() => {}));

    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-submit")).toBeDisabled();
      expect(screen.getByTestId("issue-submit")).toHaveTextContent("Submitting...");
    });
  });

  it("shows error message on submission failure", async () => {
    mockInvoke.mockRejectedValue("gh CLI not found");

    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByText("gh CLI not found")).toBeInTheDocument();
    });
  });

  it("submit button is re-enabled after error so user can retry", async () => {
    mockInvoke.mockRejectedValue("Network error");

    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-submit")).toBeEnabled();
      expect(screen.getByTestId("issue-submit")).toHaveTextContent("Submit Issue");
    });
  });

  it("submits using Tauri invoke, not window.open", async () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-submit")).toHaveTextContent("Submitted!");
    });

    // Verify invoke was called with the right command
    expect(mockInvoke).toHaveBeenCalledWith("submit_github_issue", {
      title: "Bug report",
      body: "",
      screenshotPath: null,
    });

    // Verify window.open was NOT called
    expect(windowOpenSpy).not.toHaveBeenCalled();
    windowOpenSpy.mockRestore();
  });

  it("does not show 'New Report' button before submission", () => {
    render(<IssueReporterView />);
    expect(screen.queryByTestId("issue-new-report")).not.toBeInTheDocument();
  });

  it("does not show 'New Report' button during submission", async () => {
    mockInvoke.mockReturnValue(new Promise(() => {}));

    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-submit")).toHaveTextContent("Submitting...");
    });

    expect(screen.queryByTestId("issue-new-report")).not.toBeInTheDocument();
  });

  it("shows issue URL link after successful submission", async () => {
    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      const link = screen.getByTestId("issue-result-link");
      expect(link).toBeInTheDocument();
      expect(link).toHaveTextContent("https://github.com/user/repo/issues/42");
    });
  });

  it("title and body inputs are disabled after successful submission", async () => {
    const user = userEvent.setup();
    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Bug report");
    await user.type(screen.getByTestId("issue-body"), "Description");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-title")).toBeDisabled();
      expect(screen.getByTestId("issue-body")).toBeDisabled();
    });
  });
});
