import { reportFrontendHealth } from "./tauri-api";
import { allTerminalOutputPipelineCounters } from "./terminal-output-pipeline-metrics";
import {
  allTerminalOutputV3ControlTrace,
  allTerminalOutputV3Diagnostics,
} from "./terminal-output-v3-diagnostics";
import { allTerminalInputDeliveryCounters } from "./terminal-input-delivery-metrics";

/**
 * Out-of-band frontend responsiveness probe (issue #606).
 *
 * Every `automation-request` endpoint answers through the WebView main thread,
 * so when that thread is saturated the Automation API can only report
 * `Frontend response timeout` — the one number it cannot produce is *how* stalled
 * the frontend is, or what it is stalled on. `/api/v1/health` stays instant
 * because it never leaves Rust; this reporter gives the same property to the
 * frontend's own vitals by pushing them into Rust state, where
 * `GET /api/v1/diagnostics/frontend` serves them without a bridge round-trip.
 *
 * The probe is a self-rescheduling timer. Main-thread blocking is read off its
 * own lateness: a tick that was due 250 ms after the previous one but ran 30 s
 * late means the thread was unavailable for ~30 s. The *absence* of reports is
 * itself the signal — Rust reports `lastReportAgeMs`, so a stall is visible
 * while it is happening, not only afterwards.
 */

/** How often the probe wants to run. Its lateness is the blocking measurement. */
const PROBE_PERIOD_MS = 250;
/** Report at least this often, so `lastReportAgeMs` stays meaningful when idle. */
const REPORT_INTERVAL_MS = 1_000;
/** A tick this late means a real stall: report it the moment the thread frees. */
const STALL_REPORT_THRESHOLD_MS = 500;

export interface FrontendBridgeCounters {
  /** `automation-request` events the frontend received. */
  requestsReceived: number;
  /** Responses the frontend sent back. */
  responsesSent: number;
  /** Response IPC calls that rejected before Rust accepted the response. */
  responsesFailed: number;
  /** Query requests skipped because their Rust deadline had already passed. */
  queriesDroppedExpired: number;
  /** Action requests run late — their HTTP caller already got a 504. */
  actionsRunAfterDeadline: number;
  /** Worst emit→handler delay observed, in ms. The bridge queue's real depth. */
  maxDeliveryLagMs: number;
}

const bridgeCounters: FrontendBridgeCounters = {
  requestsReceived: 0,
  responsesSent: 0,
  responsesFailed: 0,
  queriesDroppedExpired: 0,
  actionsRunAfterDeadline: 0,
  maxDeliveryLagMs: 0,
};

export function recordBridgeCounter(
  counter: Exclude<keyof FrontendBridgeCounters, "maxDeliveryLagMs">,
  value = 1,
): void {
  bridgeCounters[counter] += value;
}

/** Raise the emit→handler delay high-water mark. */
export function recordBridgeDeliveryLag(lagMs: number): void {
  if (lagMs > bridgeCounters.maxDeliveryLagMs) bridgeCounters.maxDeliveryLagMs = lagMs;
}

export function frontendBridgeCounters(): FrontendBridgeCounters {
  return { ...bridgeCounters };
}

export function resetFrontendHealthForTest(): void {
  bridgeCounters.requestsReceived = 0;
  bridgeCounters.responsesSent = 0;
  bridgeCounters.responsesFailed = 0;
  bridgeCounters.queriesDroppedExpired = 0;
  bridgeCounters.actionsRunAfterDeadline = 0;
  bridgeCounters.maxDeliveryLagMs = 0;
}

export interface FrontendHealthReport {
  /** `Date.now()` when the report was produced. */
  sentAtMs: number;
  /** Lateness of the probe tick that produced this report. */
  probeLagMs: number;
  /** Worst probe lateness since the reporter started. */
  probeLagMaxMs: number;
  /** Probe ticks that were at least {@link STALL_REPORT_THRESHOLD_MS} late. */
  stalls: number;
  bridge: FrontendBridgeCounters;
  pipeline: Record<string, unknown>;
  inputDelivery: Record<string, unknown>;
  terminalOutputV3: ReturnType<typeof allTerminalOutputV3Diagnostics>;
  /** Recent hold/close controls per terminal; identity and sequence only. */
  terminalOutputV3ControlTrace: ReturnType<typeof allTerminalOutputV3ControlTrace>;
}

/**
 * Start the probe. Returns a stop function.
 *
 * Idempotent per call site: the caller owns the handle, and a second start
 * without stopping the first would only double the report rate, so the App-level
 * bridge hook is the single owner.
 */
export function startFrontendHealthReporter(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probeLagMaxMs = 0;
  let stalls = 0;
  const startedAtMs = Date.now();
  let lastReportAtMs = startedAtMs;
  let dueAtMs = startedAtMs + PROBE_PERIOD_MS;
  let retryReport = false;
  let latestReportAttempt = 0;

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    const probeLagMs = Math.max(0, now - dueAtMs);
    if (probeLagMs > probeLagMaxMs) probeLagMaxMs = probeLagMs;
    if (probeLagMs >= STALL_REPORT_THRESHOLD_MS) stalls += 1;

    if (
      retryReport ||
      probeLagMs >= STALL_REPORT_THRESHOLD_MS ||
      now - lastReportAtMs >= REPORT_INTERVAL_MS
    ) {
      retryReport = false;
      lastReportAtMs = now;
      const attempt = ++latestReportAttempt;
      // Fire-and-forget: awaiting would make the probe's own period depend on
      // IPC latency, which is exactly the thing being measured.
      void reportFrontendHealth({
        sentAtMs: now,
        probeLagMs,
        probeLagMaxMs,
        stalls,
        bridge: frontendBridgeCounters(),
        pipeline: allTerminalOutputPipelineCounters(),
        inputDelivery: allTerminalInputDeliveryCounters(),
        terminalOutputV3: allTerminalOutputV3Diagnostics(),
        terminalOutputV3ControlTrace: allTerminalOutputV3ControlTrace(),
      }).catch(() => {
        // Retry a current failed attempt on the next probe tick. Ignore a late
        // rejection from an older attempt after a newer snapshot was sent.
        if (!stopped && attempt === latestReportAttempt) retryReport = true;
      });
    }

    // Re-anchor from now rather than from `dueAtMs`: after a 30 s stall,
    // catching up on 120 missed ticks would report 120 useless samples.
    dueAtMs = Date.now() + PROBE_PERIOD_MS;
    timer = setTimeout(tick, PROBE_PERIOD_MS);
  };

  timer = setTimeout(tick, PROBE_PERIOD_MS);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
