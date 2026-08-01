import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubView } from "./GitHubView";
import type { GithubRepoSnapshot } from "@/lib/tauri-api";

const { useGithubRepoSnapshot, useSyncGroupCwd } = vi.hoisted(() => ({
  useGithubRepoSnapshot: vi.fn(),
  useSyncGroupCwd: vi.fn(),
}));

const { clipboardWriteText, openExternal, runGithubItemAction } = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(() => Promise.resolve()),
  openExternal: vi.fn(() => Promise.resolve()),
  runGithubItemAction: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/useGithubRepoSnapshot", () => ({ useGithubRepoSnapshot }));
vi.mock("@/hooks/useSyncGroupCwd", () => ({ useSyncGroupCwd }));
vi.mock("@/lib/tauri-api", () => ({
  clipboardWriteText,
  openExternal,
  runGithubItemAction,
}));

function snapshot(overrides: Partial<GithubRepoSnapshot> = {}): GithubRepoSnapshot {
  return {
    status: { type: "ready" },
    repo: "owner/repo",
    repoUrl: "https://github.com/owner/repo",
    issues: [
      {
        number: 708,
        title: "gh issue/pr list view",
        author: "kochul2000",
        url: "https://github.com/owner/repo/issues/708",
        updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
        labels: ["enhancement"],
        isDraft: false,
      },
    ],
    pulls: [
      {
        number: 12,
        title: "wip pull",
        author: "someone",
        url: "https://github.com/owner/repo/pull/12",
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        labels: [],
        isDraft: true,
      },
    ],
    fetchedAtMs: Date.now(),
    ...overrides,
  };
}

const refresh = vi.fn();

function mockSnapshot(next: GithubRepoSnapshot) {
  useGithubRepoSnapshot.mockReturnValue({ snapshot: next, loading: false, refresh });
}

function renderView() {
  return render(<GitHubView instanceId="github-1" syncGroup="ws-1" paneId="pane-1" />);
}

describe("GitHubView", () => {
  beforeEach(() => {
    useSyncGroupCwd.mockReturnValue("D:/repo");
    mockSnapshot(snapshot());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists the repository's open issues and switches to pull requests", () => {
    renderView();

    expect(screen.getByTestId("github-repo")).toHaveTextContent("owner/repo");
    expect(screen.getByTestId("github-item-708")).toHaveTextContent("gh issue/pr list view");
    expect(screen.getByTestId("github-tab-issues")).toHaveTextContent("Issues 1");

    fireEvent.click(screen.getByTestId("github-tab-pulls"));

    expect(screen.queryByTestId("github-item-708")).not.toBeInTheDocument();
    expect(screen.getByTestId("github-item-12")).toHaveTextContent("wip pull");
    expect(screen.getByTestId("github-draft-12")).toBeInTheDocument();
  });

  it("opens the item in a browser when its row is clicked", () => {
    renderView();

    fireEvent.click(screen.getByTestId("github-item-708"));

    expect(openExternal).toHaveBeenCalledWith("https://github.com/owner/repo/issues/708");
  });

  it("copies a link without opening the browser", () => {
    renderView();

    fireEvent.click(screen.getByTestId("github-copy-708"));

    expect(clipboardWriteText).toHaveBeenCalledWith("https://github.com/owner/repo/issues/708");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("closes an issue as not planned only after the click is confirmed", async () => {
    renderView();

    fireEvent.click(screen.getByTestId("github-menu-708"));
    fireEvent.click(screen.getByTestId("github-action-issue.closeNotPlanned-708"));
    expect(runGithubItemAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("github-confirm-708"));

    await waitFor(() =>
      expect(runGithubItemAction).toHaveBeenCalledWith("D:/repo", "issue.closeNotPlanned", 708),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("offers merge and close on pull requests and reports gh failures", async () => {
    runGithubItemAction.mockRejectedValueOnce("merge conflict");
    renderView();

    fireEvent.click(screen.getByTestId("github-tab-pulls"));
    fireEvent.click(screen.getByTestId("github-menu-12"));
    expect(screen.getByTestId("github-action-pr.close-12")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("github-action-pr.merge-12"));
    fireEvent.click(screen.getByTestId("github-confirm-12"));

    await waitFor(() =>
      expect(runGithubItemAction).toHaveBeenCalledWith("D:/repo", "pr.merge", 12),
    );
    await waitFor(() =>
      expect(screen.getByTestId("github-error")).toHaveTextContent("merge conflict"),
    );
  });

  it("cancels an armed action without touching gh", () => {
    renderView();

    fireEvent.click(screen.getByTestId("github-menu-708"));
    fireEvent.click(screen.getByTestId("github-action-issue.close-708"));
    fireEvent.click(screen.getByTestId("github-cancel-708"));

    expect(runGithubItemAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("github-action-issue.close-708")).toBeInTheDocument();
  });

  it("shows why the list is empty instead of an empty pane", () => {
    mockSnapshot(
      snapshot({ status: { type: "notAGithubRepo" }, repo: null, issues: [], pulls: [] }),
    );
    renderView();

    expect(screen.getByTestId("github-status")).toHaveTextContent("No GitHub repository");
    expect(screen.queryByTestId("github-empty")).not.toBeInTheDocument();
  });

  it("distinguishes an empty repo from a failure", () => {
    mockSnapshot(snapshot({ issues: [], pulls: [] }));
    renderView();

    expect(screen.getByTestId("github-empty")).toHaveTextContent("No open issues");
  });

  it("claims neither empty nor broken while the first read is in flight", () => {
    useGithubRepoSnapshot.mockReturnValue({
      snapshot: snapshot({ status: { type: "notAGithubRepo" }, repo: null, issues: [], pulls: [] }),
      loading: true,
      refresh,
    });
    renderView();

    expect(screen.queryByTestId("github-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("github-empty")).not.toBeInTheDocument();
  });

  it("forces a fresh read when the user refreshes", () => {
    renderView();

    fireEvent.click(screen.getByTestId("github-refresh"));

    expect(refresh).toHaveBeenCalled();
  });
});
