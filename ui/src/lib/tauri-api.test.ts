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
  type TerminalSessionResult,
  createTerminalSession,
  attachTerminalOutput,
  writeTerminalInput,
  writeToTerminal,
  resizeTerminal,
  closeTerminalSession,
  getSyncGroupTerminals,
  handleLxMessage,
  loadSettings,
  saveSettings,
  getRemoteAccessStatus,
  getRemoteHostCandidates,
  getCloudStatus,
  cloudConnectStart,
  cloudDisconnect,
  setRemoteRuntimeAccess,
  onTerminalOutput,
  onTerminalOutputV2,
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
          advertise_true_color: true,
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
        cwdSend: true,
        cwdReceive: true,
        cwd: null,
        startupCommandOverride: null,
        viewer: null,
      });
      expect(result).toEqual(mockResult);
    });

    it("passes cwdSend=false and cwdReceive=false to backend", async () => {
      mockInvoke.mockResolvedValue({
        id: "t1",
        title: "Terminal",
        config: {
          profile: "WSL",
          cols: 80,
          rows: 24,
          sync_group: "",
          env: [],
          advertise_true_color: true,
        },
      });
      await createTerminalSession("t1", "WSL", 80, 24, "", false, false);
      expect(mockInvoke).toHaveBeenCalledWith("create_terminal_session", {
        id: "t1",
        profile: "WSL",
        cols: 80,
        rows: 24,
        syncGroup: "",
        cwdSend: false,
        cwdReceive: false,
        cwd: null,
        startupCommandOverride: null,
        viewer: null,
      });
    });

    it("passes a structured external viewer request without building a shell string", async () => {
      mockInvoke.mockResolvedValue({
        id: "viewer-1",
        title: "Terminal",
        config: {
          profile: "Ubuntu",
          cols: 80,
          rows: 24,
          sync_group: "",
          env: [],
          advertise_true_color: true,
        },
      });

      await createTerminalSession("viewer-1", "Ubuntu", 80, 24, "", false, false, undefined, {
        command: "vi",
        path: "C:\\Users\\me\\README.md",
      });

      expect(mockInvoke).toHaveBeenCalledWith("create_terminal_session", {
        id: "viewer-1",
        profile: "Ubuntu",
        cols: 80,
        rows: 24,
        syncGroup: "",
        cwdSend: false,
        cwdReceive: false,
        cwd: null,
        startupCommandOverride: null,
        viewer: { command: "vi", path: "C:\\Users\\me\\README.md" },
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

  describe("structured terminal input", () => {
    it("invokes write_terminal_input with text and submit intent", async () => {
      mockInvoke.mockResolvedValue(undefined);
      await writeTerminalInput("t1", "한글\nline", true);
      expect(mockInvoke).toHaveBeenCalledWith("write_terminal_input", {
        id: "t1",
        text: "한글\nline",
        submit: true,
      });
    });

    it("requests one atomic output attachment", async () => {
      const attachment = {
        state: {
          version: 1,
          snapshotStartSeq: 3,
          snapshotSeq: 5,
          protocolRevision: 2,
          modes: { bracketedPaste: true },
        },
        snapshot: [65, 66],
      };
      mockInvoke.mockResolvedValue(attachment);
      await expect(attachTerminalOutput("t1")).resolves.toEqual(attachment);
      expect(mockInvoke).toHaveBeenCalledWith("attach_terminal_output", { id: "t1" });
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

    it("serializes create, unmount close, and immediate remount create per terminal id", async () => {
      const calls: string[] = [];
      let resolveFirstCreate!: (value: TerminalSessionResult) => void;
      let resolveClose!: () => void;
      const session: TerminalSessionResult = {
        id: "lifecycle-1",
        title: "Terminal",
        config: {
          profile: "PowerShell",
          cols: 80,
          rows: 24,
          sync_group: "",
          env: [],
          advertise_true_color: true,
        },
      };
      mockInvoke.mockImplementation((command) => {
        calls.push(command);
        if (calls.length === 1) {
          return new Promise((resolve) => {
            resolveFirstCreate = resolve as (value: TerminalSessionResult) => void;
          });
        }
        if (command === "close_terminal_session") {
          return new Promise<void>((resolve) => {
            resolveClose = resolve;
          });
        }
        return Promise.resolve(session);
      });

      const firstCreate = createTerminalSession("lifecycle-1", "PowerShell", 80, 24, "");
      await vi.waitFor(() => expect(calls).toEqual(["create_terminal_session"]));
      const close = closeTerminalSession("lifecycle-1");
      const replacement = createTerminalSession("lifecycle-1", "PowerShell", 80, 24, "");
      await Promise.resolve();
      expect(calls).toEqual(["create_terminal_session"]);

      resolveFirstCreate(session);
      await firstCreate;
      await vi.waitFor(() =>
        expect(calls).toEqual(["create_terminal_session", "close_terminal_session"]),
      );
      resolveClose();
      await close;
      await expect(replacement).resolves.toEqual(session);
      expect(calls).toEqual([
        "create_terminal_session",
        "close_terminal_session",
        "create_terminal_session",
      ]);
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

  describe("remote access", () => {
    it("invokes get_remote_access_status", async () => {
      const status = {
        effectiveEnabled: true,
        persistentEnabled: false,
        runtimeEnabled: true,
        authTokenConfigured: true,
        effectiveAuthToken: "secret",
      };
      mockInvoke.mockResolvedValue(status);

      await expect(getRemoteAccessStatus()).resolves.toEqual(status);
      expect(mockInvoke).toHaveBeenCalledWith("get_remote_access_status");
    });

    it("invokes set_remote_runtime_access", async () => {
      mockInvoke.mockResolvedValue({
        effectiveEnabled: true,
        persistentEnabled: false,
        runtimeEnabled: true,
        authTokenConfigured: true,
        effectiveAuthToken: "secret",
      });

      await setRemoteRuntimeAccess(true, "secret");

      expect(mockInvoke).toHaveBeenCalledWith("set_remote_runtime_access", {
        enabled: true,
        authToken: "secret",
      });
    });

    it("invokes get_remote_host_candidates", async () => {
      const candidates = [{ kind: "loopback", host: "127.0.0.1", label: "Localhost 127.0.0.1" }];
      mockInvoke.mockResolvedValue(candidates);

      await expect(getRemoteHostCandidates()).resolves.toEqual(candidates);
      expect(mockInvoke).toHaveBeenCalledWith("get_remote_host_candidates");
    });

    it("invokes get_cloud_status", async () => {
      const status = { connected: true, instanceId: "instance-1", lastError: null };
      mockInvoke.mockResolvedValue(status);

      await expect(getCloudStatus()).resolves.toEqual(status);
      expect(mockInvoke).toHaveBeenCalledWith("get_cloud_status");
    });

    it("invokes cloud_connect_start", async () => {
      const status = { connected: false, instanceId: "instance-1", lastError: null };
      mockInvoke.mockResolvedValue(status);

      await expect(cloudConnectStart()).resolves.toEqual(status);
      expect(mockInvoke).toHaveBeenCalledWith("cloud_connect_start");
    });

    it("invokes cloud_disconnect", async () => {
      const status = { connected: false, instanceId: null, lastError: null };
      mockInvoke.mockResolvedValue(status);

      await expect(cloudDisconnect()).resolves.toEqual(status);
      expect(mockInvoke).toHaveBeenCalledWith("cloud_disconnect");
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

    it("listens for versioned sequenced output events", async () => {
      mockListen.mockResolvedValue(vi.fn());
      const callback = vi.fn();
      await onTerminalOutputV2("t1", callback);

      expect(mockListen).toHaveBeenCalledWith("terminal-output-v2-t1", expect.any(Function));
      const handler = mockListen.mock.calls.at(-1)?.[1] as
        | ((event: { payload: unknown }) => void)
        | undefined;
      const payload = { seqStart: 4, seqEnd: 6, data: [65, 66] };
      handler?.({ payload });
      expect(callback).toHaveBeenCalledWith(payload);
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
