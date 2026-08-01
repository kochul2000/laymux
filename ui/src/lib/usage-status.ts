/**
 * Human-readable reasons a usage snapshot carries no usable numbers.
 *
 * Shared by the full views and the one-line widgets: a surface that cannot spare
 * room for the sentence still has to say *something* rather than show the last
 * good number as if it were current (ADR-0102, ADR-0105).
 */

import type { CodexUsageStatus, UsageProbeStatus } from "@/lib/tauri-api";

/**
 * Exhaustive on purpose: the `never` binding makes a new `UsageProbeStatus`
 * variant a compile error instead of a silent generic message.
 */
export function claudeUsageStatusMessage(status: UsageProbeStatus): string | null {
  switch (status.type) {
    case "ready":
      return null;
    case "idle":
      return "Probe stopped";
    case "starting":
      return "Starting Claude Code…";
    case "claudeMissing":
      return "`claude` not found in this profile's shell";
    case "startupTimeout":
      return "Claude Code did not become ready";
    case "parseFailed":
      return "Could not read the /usage panel";
    case "upstreamError":
    case "failed":
      return status.message;
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

export function codexUsageStatusMessage(status: CodexUsageStatus): string | null {
  if (status.type === "ready") return null;
  if (status.type === "codexMissing") return "`codex` not found on PATH";
  if (status.type === "unauthorized") return "Sign in to Codex CLI to read usage";
  return status.message;
}

/** Short stand-in for a percentage the probe has not produced yet. */
export const USAGE_UNAVAILABLE_TEXT = "--";
