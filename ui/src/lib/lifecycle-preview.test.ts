import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri-api", () => ({
  getAppUpdateStatus: vi.fn().mockResolvedValue({ operation: "idle", currentVersion: "1.0.0" }),
}));

import { previewLifecycle } from "./lifecycle-preview";
import { useLifecycleStore } from "@/stores/lifecycle-store";

beforeEach(() => {
  useLifecycleStore.setState({ open: false, preview: false, kind: "update", cleanup: false });
});

describe("previewLifecycle", () => {
  // Only an explicit close interrupts terminals (ADR-0314).
  it.each([{ stage: "interrupting" }, { stage: "settling" }, { stage: "caching", cleanup: true }])(
    "rejects a terminal cleanup preview for an update: %o",
    async (params) => {
      await expect(previewLifecycle({ kind: "update", ...params })).rejects.toThrow(
        "An update has no terminal cleanup stage",
      );
      expect(useLifecycleStore.getState().open).toBe(false);
    },
  );

  it("previews the cleanup step of an explicit close", async () => {
    await previewLifecycle({ kind: "close", stage: "interrupting", cleanup: true });
    expect(useLifecycleStore.getState()).toMatchObject({
      open: true,
      kind: "close",
      cleanup: true,
    });
  });
});
