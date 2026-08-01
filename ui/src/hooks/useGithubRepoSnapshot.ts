import { useCallback, useEffect, useRef, useState } from "react";
import { getGithubRepoSnapshot, type GithubRepoSnapshot } from "@/lib/tauri-api";

/**
 * Poll cadence. The backend registry serves one `gh` result per repository per
 * refresh window, so several panes on the same repo cost one process per
 * window no matter how many of them poll.
 */
export const GITHUB_POLL_MS = 10_000;

const idle: GithubRepoSnapshot = {
  status: { type: "notAGithubRepo" },
  repo: null,
  repoUrl: null,
  issues: [],
  pulls: [],
  fetchedAtMs: null,
};

function failed(message: string): GithubRepoSnapshot {
  return { ...idle, status: { type: "failed", message } };
}

/**
 * Track the open issues and PRs of whichever repository `workingDir` is in.
 * Polls only while a view is mounted; a CWD change re-reads immediately.
 */
export function useGithubRepoSnapshot(workingDir: string) {
  // The result carries the CWD it belongs to, so a repository switch shows the
  // loading state instead of the previous repository's list, and no effect has
  // to reset anything on the way.
  const [result, setResult] = useState<{ cwd: string; snapshot: GithubRepoSnapshot } | null>(null);
  // Only the newest read may publish: a CWD change during an in-flight poll
  // would otherwise let the previous repository's list land afterwards.
  const requestSeq = useRef(0);

  const read = useCallback(
    (force: boolean) => {
      if (!workingDir) {
        requestSeq.current += 1;
        return;
      }
      const seq = ++requestSeq.current;
      getGithubRepoSnapshot(workingDir, force)
        .then((next) => {
          if (seq === requestSeq.current) setResult({ cwd: workingDir, snapshot: next });
        })
        .catch((error: unknown) => {
          if (seq === requestSeq.current)
            setResult({ cwd: workingDir, snapshot: failed(String(error)) });
        });
    },
    [workingDir],
  );

  useEffect(() => {
    read(false);
    const timer = setInterval(() => read(false), GITHUB_POLL_MS);
    return () => clearInterval(timer);
  }, [read]);

  const refresh = useCallback(() => read(true), [read]);
  const matches = result?.cwd === workingDir;
  return {
    snapshot: matches && result ? result.snapshot : idle,
    /** No result for the current CWD yet — the view must not call it empty. */
    loading: workingDir !== "" && !matches,
    refresh,
  };
}
