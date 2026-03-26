import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  sendOsNotification: vi.fn().mockResolvedValue(undefined),
  createTerminalSession: vi.fn().mockResolvedValue({}),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  getSyncGroupTerminals: vi.fn().mockResolvedValue([]),
  handleLxMessage: vi.fn().mockResolvedValue({}),
  loadSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onSyncCwd: vi.fn().mockResolvedValue(() => {}),
  onSyncBranch: vi.fn().mockResolvedValue(() => {}),
  onLxNotify: vi.fn().mockResolvedValue(() => {}),
  onSetTabTitle: vi.fn().mockResolvedValue(() => {}),
  getListeningPorts: vi.fn().mockResolvedValue([]),
  getGitBranch: vi.fn().mockResolvedValue(null),
}));

import { sendDesktopNotification } from "./useOsNotification";
import { sendOsNotification } from "@/lib/tauri-api";

describe("useOsNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends notification via tauri API", async () => {
    await sendDesktopNotification("Test Title", "Test body");
    expect(sendOsNotification).toHaveBeenCalledWith("Test Title", "Test body");
  });

  it("handles errors gracefully", async () => {
    (sendOsNotification as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Not available"),
    );
    // Should not throw
    await sendDesktopNotification("Title", "Body");
  });
});
