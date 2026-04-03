import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock @tauri-apps/api/event
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createTerminalSession,
  writeToTerminal,
  resizeTerminal,
  closeTerminalSession,
  getSyncGroupTerminals,
  handleLxMessage,
  loadSettings,
  saveSettings,
  onTerminalOutput,
  onOpenFile,
} from "./tauri-api";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tauri-api", () => {
  describe("createTerminalSession", () => {
    it("invokes create_terminal_session with correct params", async () => {
      const mockResult = {
        id: "t1",
        title: "Terminal",
        config: {
          profile: "PowerShell",
          cols: 80,
          rows: 24,
          sync_group: "default",
          env: [],
        },
      };
      mockInvoke.mockResolvedValue(mockResult);

      const result = await createTerminalSession("t1", "PowerShell", 80, 24, "default");
      expect(mockInvoke).toHaveBeenCalledWith("create_terminal_session", {
        id: "t1",
        profile: "PowerShell",
        cols: 80,
        rows: 24,
        syncGroup: "default",
        cwdReceive: true,
        cwd: null,
        startupCommandOverride: null,
      });
      expect(result).toEqual(mockResult);
    });

    it("passes cwdReceive=false to backend", async () => {
      mockInvoke.mockResolvedValue({
        id: "t1",
        title: "Terminal",
        config: { profile: "WSL", cols: 80, rows: 24, sync_group: "", env: [] },
      });
      await createTerminalSession("t1", "WSL", 80, 24, "", false);
      expect(mockInvoke).toHaveBeenCalledWith("create_terminal_session", {
        id: "t1",
        profile: "WSL",
        cols: 80,
        rows: 24,
        syncGroup: "",
        cwdReceive: false,
        cwd: null,
        startupCommandOverride: null,
      });
    });
  });

  describe("writeToTerminal", () => {
    it("invokes write_to_terminal", async () => {
      mockInvoke.mockResolvedValue(undefined);
      await writeToTerminal("t1", "ls\n");
      expect(mockInvoke).toHaveBeenCalledWith("write_to_terminal", {
        id: "t1",
        data: "ls\n",
      });
    });
  });

  describe("resizeTerminal", () => {
    it("invokes resize_terminal", async () => {
      mockInvoke.mockResolvedValue(undefined);
      await resizeTerminal("t1", 120, 40);
      expect(mockInvoke).toHaveBeenCalledWith("resize_terminal", {
        id: "t1",
        cols: 120,
        rows: 40,
      });
    });
  });

  describe("closeTerminalSession", () => {
    it("invokes close_terminal_session", async () => {
      mockInvoke.mockResolvedValue(undefined);
      await closeTerminalSession("t1");
      expect(mockInvoke).toHaveBeenCalledWith("close_terminal_session", {
        id: "t1",
      });
    });
  });

  describe("getSyncGroupTerminals", () => {
    it("returns terminal IDs for group", async () => {
      mockInvoke.mockResolvedValue(["t1", "t2"]);
      const result = await getSyncGroupTerminals("project-a");
      expect(mockInvoke).toHaveBeenCalledWith("get_sync_group_terminals", {
        groupName: "project-a",
      });
      expect(result).toEqual(["t1", "t2"]);
    });
  });

  describe("handleLxMessage", () => {
    it("sends lx message and gets response", async () => {
      const resp = { success: true, data: "ok", error: null };
      mockInvoke.mockResolvedValue(resp);

      const result = await handleLxMessage('{"action":"notify","message":"hi","terminal_id":"t1"}');
      expect(mockInvoke).toHaveBeenCalledWith("handle_lx_message", {
        messageJson: '{"action":"notify","message":"hi","terminal_id":"t1"}',
      });
      expect(result.success).toBe(true);
    });
  });

  describe("loadSettings", () => {
    it("invokes load_settings", async () => {
      const settings = { defaultProfile: "PowerShell", profiles: [] };
      mockInvoke.mockResolvedValue(settings);
      const result = await loadSettings();
      expect(mockInvoke).toHaveBeenCalledWith("load_settings");
      expect(result).toEqual(settings);
    });
  });

  describe("saveSettings", () => {
    it("invokes save_settings with settings", async () => {
      mockInvoke.mockResolvedValue(undefined);
      const settings = { defaultProfile: "PowerShell", profiles: [] } as any;
      await saveSettings(settings);
      expect(mockInvoke).toHaveBeenCalledWith("save_settings", {
        settings,
      });
    });
  });

  describe("onTerminalOutput", () => {
    it("listens for terminal output events", async () => {
      const unlisten = vi.fn();
      mockListen.mockResolvedValue(unlisten);

      const callback = vi.fn();
      await onTerminalOutput("t1", callback);

      expect(mockListen).toHaveBeenCalledWith("terminal-output-t1", expect.any(Function));
    });
  });

  describe("onOpenFile", () => {
    it("listens for open-file events", async () => {
      const unlisten = vi.fn();
      mockListen.mockResolvedValue(unlisten);

      const callback = vi.fn();
      await onOpenFile(callback);

      expect(mockListen).toHaveBeenCalledWith("open-file", expect.any(Function));
    });
  });
});
