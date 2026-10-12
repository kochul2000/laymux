import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "@/lib/tauri-api";

const api = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@/lib/tauri-api", () => ({ checkAppUpdate: api.check }));
import { useLifecycleStore, waitForCloseDecision } from "./lifecycle-store";

beforeEach(() => {
  vi.clearAllMocks();
  useLifecycleStore.setState(useLifecycleStore.getInitialState());
});

describe("close cancellation", () => {
  it("allows explicit force while the pane check never settles", async () => {
    const pending = new Promise<void>(() => {});
    const decision = waitForCloseDecision("timeout", pending);
    expect(useLifecycleStore.getState().cancelClose).toBeNull();
    useLifecycleStore.getState().forceClose?.();
    await expect(decision).resolves.toBe(true);
    expect(useLifecycleStore.getState().forceClose).toBeNull();
  });
  it("waits for failed preparation to settle before offering cancellation", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const decision = waitForCloseDecision("timeout", pending);
    expect(useLifecycleStore.getState().cancelClose).toBeNull();
    reject(new Error("status could not be verified"));
    await vi.waitFor(() => expect(useLifecycleStore.getState().cancelClose).not.toBeNull());
    useLifecycleStore.getState().cancelClose?.();
    await expect(decision).resolves.toBe(false);
    expect(useLifecycleStore.getState().forceClose).toBeNull();
    expect(useLifecycleStore.getState().cancelClose).toBeNull();
  });

  it("allows a successful pending save to finish closing", async () => {
    await expect(waitForCloseDecision("timeout", Promise.resolve())).resolves.toBe(true);
    expect(useLifecycleStore.getState().cancelClose).toBeNull();
  });
});

describe("update check on open", () => {
  const idle: AppUpdateStatus = {
    enabled: true,
    channel: "stable",
    currentVersion: "1.0.0",
    availableVersion: null,
    notes: null,
    publishedAt: null,
    operation: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    checkedAtMs: 1,
    lastError: null,
  };

  it("checks once when the user opens the update dialog", async () => {
    api.check.mockResolvedValue({ ...idle, availableVersion: "1.1.0", checkedAtMs: 2 });
    useLifecycleStore.setState({ status: idle });
    useLifecycleStore.getState().openUpdate({ check: true });
    expect(useLifecycleStore.getState().open).toBe(true);
    expect(api.check).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(useLifecycleStore.getState().status?.availableVersion).toBe("1.1.0"),
    );
  });

  it("does not check for opens that only surface an existing operation", () => {
    useLifecycleStore.setState({ status: idle });
    useLifecycleStore.getState().openUpdate();
    expect(api.check).not.toHaveBeenCalled();
  });

  it.each([
    ["an operation is already running", { ...idle, operation: "downloading" as const }],
    ["the updater is disabled", { ...idle, enabled: false }],
    [
      "a failed install still offers the loss override",
      { ...idle, canForceInstall: true, lastError: "x" },
    ],
  ])("does not check when %s", (_, status) => {
    useLifecycleStore.setState({ status });
    useLifecycleStore.getState().openUpdate({ check: true });
    expect(api.check).not.toHaveBeenCalled();
  });

  it("surfaces a failed check in the dialog", async () => {
    api.check.mockResolvedValue({ ...idle, lastError: "network down" });
    useLifecycleStore.setState({ status: idle });
    useLifecycleStore.getState().openUpdate({ check: true });
    await vi.waitFor(() => expect(useLifecycleStore.getState().error).toBe("network down"));
  });
});
