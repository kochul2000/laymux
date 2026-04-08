import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { IssueReporterView } from "./IssueReporterView";
import { useSettingsStore } from "@/stores/settings-store";

// Mock fetch for screenshot capture
const mockFetch = vi.fn().mockResolvedValue({
  json: () =>
    Promise.resolve({ path: "/tmp/screenshot.png", dataUrl: "data:image/png;base64,abc" }),
});
global.fetch = mockFetch;

// Mock @tauri-apps/api/core — route get_automation_info, delegate rest to mockSubmitInvoke
const mockSubmitInvoke = vi.fn();
const mockInvoke = vi.fn((cmd: string, ...rest: unknown[]) => {
  if (cmd === "get_automation_info") {
    return Promise.resolve({ port: 19280, key: "mock-key" });
  }
  return mockSubmitInvoke(cmd, ...rest);
});
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
    useSettingsStore.setState(useSettingsStore.getInitialState());
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({ path: "/tmp/screenshot.png", dataUrl: "data:image/png;base64,abc" }),
    });
  });

  it("renders the form", () => {
    render(<IssueReporterView />);
    expect(screen.getByTestId("issue-reporter-view")).toBeInTheDocument();
    expect(screen.getByTestId("issue-title")).toBeInTheDocument();
    expect(screen.getByTestId("issue-body")).toBeInTheDocument();
    expect(screen.getByTestId("issue-submit")).toBeInTheDocument();
  });

  it("applies default padding (8px) from settings", () => {
    render(<IssueReporterView />);
    const body = screen.getByTestId("issue-reporter-body");
    expect(body.style.padding).toBe("8px");
  });

  it("applies custom padding from settings", () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      issueReporter: {
        ...useSettingsStore.getState().issueReporter,
        paddingTop: 20,
        paddingRight: 10,
        paddingBottom: 5,
        paddingLeft: 15,
      },
    });
    render(<IssueReporterView />);
    const body = screen.getByTestId("issue-reporter-body");
    expect(body.style.padding).toBe("20px 10px 5px 15px");
  });

  it("keeps Save button enabled after successful submission", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValue("https://github.com/repo/issues/1");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });
    expect(screen.getByTestId("issue-submit")).not.toBeDisabled();
  });

  it("shows 'New Issue' button after successful submission", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValue("https://github.com/repo/issues/1");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });
  });

  it("resets form when 'New Issue' is clicked", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValue("https://github.com/repo/issues/1");

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
    // Button text should be back to "Save" (not "Edit")
    expect(screen.getByText("Save")).toBeInTheDocument();
    // "New Issue" button should be gone
    expect(screen.queryByTestId("issue-new-report")).not.toBeInTheDocument();
  });

  it("opens issue URL in system browser when clicked", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValue("https://github.com/repo/issues/1");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-link")).toBeInTheDocument();
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
    mockSubmitInvoke.mockImplementation(() => new Promise(() => {}));

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    expect(screen.getByTestId("issue-submit")).toBeDisabled();
    expect(screen.getByText("Saving...")).toBeInTheDocument();
  });

  it("disables submit button after error and allows retry", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockRejectedValueOnce(new Error("Network error"));

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      // After error, submit button should be re-enabled for retry
      expect(screen.getByTestId("issue-submit")).not.toBeDisabled();
    });
  });

  it("shows 'New Issue' button after error for clearing form", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockRejectedValueOnce(new Error("Network error"));

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.type(screen.getByTestId("issue-body"), "Some body");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });

    // Clicking New Issue should clear form
    await user.click(screen.getByTestId("issue-new-report"));
    expect(screen.getByTestId("issue-title")).toHaveValue("");
    expect(screen.getByTestId("issue-body")).toHaveValue("");
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("prevents double submission with rapid clicks", async () => {
    const user = userEvent.setup();
    let resolveSubmit: (value: string) => void;
    mockSubmitInvoke.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");

    // Rapid double-click
    const btn = screen.getByTestId("issue-submit");
    await user.click(btn);
    await user.click(btn);

    // Should only invoke once despite two clicks
    expect(mockSubmitInvoke).toHaveBeenCalledTimes(1);

    // Resolve to clean up pending promise
    await act(async () => {
      resolveSubmit!("https://github.com/repo/issues/1");
    });
  });

  it("focuses title input when isFocused becomes true", async () => {
    const { rerender } = render(<IssueReporterView isFocused={false} />);
    const titleInput = screen.getByTestId("issue-title");
    expect(document.activeElement).not.toBe(titleInput);

    rerender(<IssueReporterView isFocused={true} />);
    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput);
    });
  });

  it("submits issue with Ctrl+Enter from title input", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValue("https://github.com/repo/issues/1");

    render(<IssueReporterView isFocused={true} />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(mockSubmitInvoke).toHaveBeenCalledWith("submit_github_issue", {
        title: "Test issue",
        body: "",
        screenshotPath: "/tmp/screenshot.png",
        issueNumber: null,
      });
    });
  });

  it("submits issue with Ctrl+Enter from body textarea", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValue("https://github.com/repo/issues/1");

    render(<IssueReporterView isFocused={true} />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-body"));
    await user.type(screen.getByTestId("issue-body"), "Some description");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(mockSubmitInvoke).toHaveBeenCalledWith("submit_github_issue", {
        title: "Test issue",
        body: "Some description",
        screenshotPath: "/tmp/screenshot.png",
        issueNumber: null,
      });
    });
  });

  it("does not submit with Ctrl+Enter when title is empty", async () => {
    const user = userEvent.setup();

    render(<IssueReporterView isFocused={true} />);

    await user.click(screen.getByTestId("issue-body"));
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(mockSubmitInvoke).not.toHaveBeenCalled();
  });

  it("awaits shell open and handles errors gracefully", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValue("https://github.com/repo/issues/1");
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

  it("passes issueNumber on re-submit after successful creation (update mode)", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValueOnce("https://github.com/repo/issues/42");

    render(<IssueReporterView />);

    // First submission (create)
    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.type(screen.getByTestId("issue-body"), "Original body");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });

    // Verify first call was create (no issueNumber)
    expect(mockSubmitInvoke).toHaveBeenCalledWith("submit_github_issue", {
      title: "Test issue",
      body: "Original body",
      screenshotPath: "/tmp/screenshot.png",
      issueNumber: null,
    });

    // Form is still editable — modify body and re-submit
    mockSubmitInvoke.mockResolvedValueOnce("https://github.com/repo/issues/42");
    await user.clear(screen.getByTestId("issue-body"));
    await user.type(screen.getByTestId("issue-body"), "Updated body");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(mockSubmitInvoke).toHaveBeenLastCalledWith("submit_github_issue", {
        title: "Test issue",
        body: "Updated body",
        screenshotPath: "/tmp/screenshot.png",
        issueNumber: 42,
      });
    });
  });

  it("extracts issue number from GitHub URL", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValueOnce("https://github.com/owner/repo/issues/123");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });

    // Re-submit (form is still editable, no Edit button needed)
    mockSubmitInvoke.mockResolvedValueOnce("https://github.com/owner/repo/issues/123");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(mockSubmitInvoke).toHaveBeenLastCalledWith("submit_github_issue", {
        title: "Test issue",
        body: "",
        screenshotPath: "/tmp/screenshot.png",
        issueNumber: 123,
      });
    });
  });

  it("resets issueNumber when 'New Issue' is clicked", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValueOnce("https://github.com/repo/issues/42");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });

    // Click New Issue to reset
    await user.click(screen.getByTestId("issue-new-report"));

    // Submit again — should be a new creation (no issueNumber)
    mockSubmitInvoke.mockResolvedValueOnce("https://github.com/repo/issues/99");
    await user.type(screen.getByTestId("issue-title"), "New issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(mockSubmitInvoke).toHaveBeenLastCalledWith("submit_github_issue", {
        title: "New issue",
        body: "",
        screenshotPath: "/tmp/screenshot.png",
        issueNumber: null,
      });
    });
  });

  it("keeps form editable after save so user can re-save", async () => {
    const user = userEvent.setup();
    mockSubmitInvoke.mockResolvedValueOnce("https://github.com/repo/issues/42");

    render(<IssueReporterView />);

    await user.type(screen.getByTestId("issue-title"), "Test issue");
    await user.click(screen.getByTestId("issue-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-new-report")).toBeInTheDocument();
    });

    // Save button is still present and enabled
    const saveBtn = screen.getByTestId("issue-submit");
    expect(saveBtn).toBeInTheDocument();
    expect(saveBtn).not.toBeDisabled();
    // Form fields are editable
    expect(screen.getByTestId("issue-title")).not.toBeDisabled();
    expect(screen.getByTestId("issue-body")).not.toBeDisabled();
  });

  describe("font settings", () => {
    it("applies custom fontFamily from settings to textarea", () => {
      useSettingsStore.setState({
        issueReporter: { ...useSettingsStore.getState().issueReporter, fontFamily: "Monaco" },
      });
      render(<IssueReporterView />);
      const textarea = screen.getByTestId("issue-body") as HTMLTextAreaElement;
      expect(textarea.style.fontFamily).toBe("Monaco");
    });

    it("inherits appFont when fontFamily/fontSize/fontWeight are empty/zero", () => {
      useSettingsStore.setState({
        issueReporter: {
          ...useSettingsStore.getState().issueReporter,
          fontFamily: "",
          fontSize: 0,
          fontWeight: "",
        },
        appFont: { face: "Fira Code", size: 15, weight: "bold" },
      });
      render(<IssueReporterView />);
      const textarea = screen.getByTestId("issue-body") as HTMLTextAreaElement;
      expect(textarea.style.fontFamily).toBe('"Fira Code"');
      expect(textarea.style.fontSize).toBe("15px");
      expect(textarea.style.fontWeight).toBe("bold");
    });

    it("applies custom fontSize from settings to textarea", () => {
      useSettingsStore.setState({
        issueReporter: { ...useSettingsStore.getState().issueReporter, fontSize: 16 },
      });
      render(<IssueReporterView />);
      const textarea = screen.getByTestId("issue-body") as HTMLTextAreaElement;
      expect(textarea.style.fontSize).toBe("16px");
    });

    it("defaults to appFont size when fontSize is 0", () => {
      useSettingsStore.setState({
        issueReporter: { ...useSettingsStore.getState().issueReporter, fontSize: 0 },
        appFont: { face: "Cascadia Mono", size: 13, weight: "normal" },
      });
      render(<IssueReporterView />);
      const textarea = screen.getByTestId("issue-body") as HTMLTextAreaElement;
      expect(textarea.style.fontSize).toBe("13px");
    });
  });
});
