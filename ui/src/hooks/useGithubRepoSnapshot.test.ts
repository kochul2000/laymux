import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { GithubRepoSnapshot } from "@/lib/tauri-api";

const getGithubRepoSnapshot = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri-api", () => ({ getGithubRepoSnapshot }));

import {
  GITHUB_PENDING_RETRY_MS,
  GITHUB_POLL_MS,
  useGithubRepoSnapshot,
} from "./useGithubRepoSnapshot";

function ready(repo: string): GithubRepoSnapshot {
  return {
    status: { type: "ready" },
    repo,
    repoUrl: `https://github.com/${repo}`,
    issues: [],
    pulls: [],
    fetchedAtMs: 1,
  };
}

describe("useGithubRepoSnapshot", () => {
  beforeEach(() => {
    getGithubRepoSnapshot.mockResolvedValue(ready("owner/repo"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reads on mount and then on the poll interval", async () => {
    vi.useFakeTimers();
    renderHook(() => useGithubRepoSnapshot("/repo"));

    expect(getGithubRepoSnapshot).toHaveBeenCalledWith("/repo", false);

    await act(async () => {
      vi.advanceTimersByTime(GITHUB_POLL_MS);
    });

    expect(getGithubRepoSnapshot).toHaveBeenCalledTimes(2);
  });

  it("never calls the backend without a CWD", () => {
    const { result } = renderHook(() => useGithubRepoSnapshot(""));

    expect(getGithubRepoSnapshot).not.toHaveBeenCalled();
    expect(result.current.snapshot.status).toEqual({ type: "notAGithubRepo" });
  });

  it("forces a read past the backend refresh window on explicit refresh", async () => {
    const { result } = renderHook(() => useGithubRepoSnapshot("/repo"));
    await waitFor(() => expect(result.current.snapshot.repo).toBe("owner/repo"));

    await act(async () => {
      result.current.refresh();
    });

    expect(getGithubRepoSnapshot).toHaveBeenLastCalledWith("/repo", true);
  });

  it("drops a slow read from the previous repository", async () => {
    let resolveFirst: ((snapshot: GithubRepoSnapshot) => void) | undefined;
    getGithubRepoSnapshot.mockImplementationOnce(
      () =>
        new Promise<GithubRepoSnapshot>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    getGithubRepoSnapshot.mockResolvedValue(ready("owner/second"));

    const { result, rerender } = renderHook(({ cwd }) => useGithubRepoSnapshot(cwd), {
      initialProps: { cwd: "/first" },
    });
    rerender({ cwd: "/second" });
    await waitFor(() => expect(result.current.snapshot.repo).toBe("owner/second"));

    await act(async () => {
      resolveFirst?.(ready("owner/first"));
    });

    expect(result.current.snapshot.repo).toBe("owner/second");
  });

  it("ignores a refresh left over from the previous repository", async () => {
    const { result, rerender } = renderHook(({ cwd }) => useGithubRepoSnapshot(cwd), {
      initialProps: { cwd: "/first" },
    });
    await waitFor(() => expect(result.current.snapshot.repo).toBe("owner/repo"));
    // Captured while the view was on /first — the action it belongs to is
    // still running when the sync group moves the pane to /second.
    const staleRefresh = result.current.refresh;

    getGithubRepoSnapshot.mockResolvedValue(ready("owner/second"));
    rerender({ cwd: "/second" });
    await waitFor(() => expect(result.current.snapshot.repo).toBe("owner/second"));
    const callsBefore = getGithubRepoSnapshot.mock.calls.length;

    await act(async () => {
      staleRefresh();
    });

    // It neither re-reads the abandoned repository nor cancels the current one.
    expect(getGithubRepoSnapshot).toHaveBeenCalledTimes(callsBefore);
    expect(result.current.snapshot.repo).toBe("owner/second");
    expect(result.current.loading).toBe(false);
  });

  it("keeps a pending reply out of the view and retries sooner than a poll", async () => {
    const pending: GithubRepoSnapshot = {
      ...ready("owner/repo"),
      status: { type: "pending" },
    };
    getGithubRepoSnapshot.mockResolvedValueOnce(pending);
    getGithubRepoSnapshot.mockResolvedValue(ready("owner/repo"));

    const { result } = renderHook(() => useGithubRepoSnapshot("/repo"));

    // Pending carries empty lists; publishing it would read as "no issues".
    await waitFor(() => expect(getGithubRepoSnapshot).toHaveBeenCalledTimes(1));
    expect(result.current.loading).toBe(true);
    expect(result.current.snapshot.status).toEqual({ type: "notAGithubRepo" });

    await waitFor(() => expect(result.current.snapshot.repo).toBe("owner/repo"), {
      timeout: GITHUB_PENDING_RETRY_MS + 1_000,
    });
    // The retry beat the poll interval it would otherwise have waited for.
    expect(GITHUB_PENDING_RETRY_MS).toBeLessThan(GITHUB_POLL_MS);
  });
});
