import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { GithubRepoSnapshot } from "@/lib/tauri-api";

const getGithubRepoSnapshot = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri-api", () => ({ getGithubRepoSnapshot }));

import { GITHUB_POLL_MS, useGithubRepoSnapshot } from "./useGithubRepoSnapshot";

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
});
