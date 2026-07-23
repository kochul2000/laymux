import { render, screen, within, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { SettingsView } from "./SettingsView";
import { useSettingsStore } from "@/stores/settings-store";
import { useRemoteAccessStore } from "@/stores/remote-access-store";
import { persistSession } from "@/lib/persist-session";

/** Helper: click a profile in the sidebar by name */
async function navigateToProfile(user: ReturnType<typeof userEvent.setup>, name: string) {
  const sidebar = screen.getByTestId("settings-view");
  const psNav = Array.from(sidebar.querySelectorAll("button")).find(
    (btn) => btn.textContent === name && !btn.dataset.testid,
  );
  if (!psNav) throw new Error(`Profile "${name}" not found in sidebar`);
  await user.click(psNav);
}

function remoteAccessStatus(runtimeEnabled = false, runtimeToken = "") {
  const remote = useSettingsStore.getState().remote;
  const token = remote.authToken || runtimeToken;
  return {
    effectiveEnabled: remote.enabled || runtimeEnabled,
    persistentEnabled: remote.enabled,
    runtimeEnabled,
    authTokenConfigured: token.length > 0,
    effectiveAuthToken: token,
  };
}

let mockCloudStatus = {
  connected: false,
  instanceId: null as string | null,
  lastError: null as string | null,
};

describe("SettingsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudStatus = { connected: false, instanceId: null, lastError: null };
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_system_monospace_fonts") {
        return Promise.resolve(["Cascadia Mono", "Fira Code", "Consolas"]);
      }
      if (cmd === "get_remote_host_candidates") {
        return Promise.resolve([
          { kind: "loopback", host: "127.0.0.1", label: "Localhost 127.0.0.1" },
          { kind: "tailscale", host: "100.64.0.2", label: "Tailscale 100.64.0.2" },
          { kind: "lan", host: "192.168.0.44", label: "LAN 192.168.0.44" },
        ]);
      }
      if (cmd === "get_remote_access_status") {
        return Promise.resolve(remoteAccessStatus());
      }
      if (cmd === "set_remote_runtime_access") {
        const runtimeEnabled = Boolean(args?.enabled);
        const runtimeToken = typeof args?.authToken === "string" ? args.authToken : "";
        return Promise.resolve(remoteAccessStatus(runtimeEnabled, runtimeToken));
      }
      if (cmd === "get_cloud_status") {
        return Promise.resolve(mockCloudStatus);
      }
      if (cmd === "cloud_connect_start") {
        mockCloudStatus = { connected: false, instanceId: "instance-2", lastError: null };
        return Promise.resolve(mockCloudStatus);
      }
      if (cmd === "load_settings") {
        return Promise.resolve({
          remote: {
            ...useSettingsStore.getState().remote,
            cloudEnabled: Boolean(mockCloudStatus.instanceId),
            cloudInstanceId: mockCloudStatus.instanceId,
            cloudTunnelUrl: mockCloudStatus.instanceId
              ? `wss://relay.example.test/tunnel/${mockCloudStatus.instanceId}`
              : null,
            cloudServerBaseUrl: mockCloudStatus.instanceId ? "https://relay.example.test" : null,
          },
        });
      }
      if (cmd === "cloud_disconnect") {
        mockCloudStatus = { connected: false, instanceId: null, lastError: null };
        return Promise.resolve(mockCloudStatus);
      }
      return Promise.resolve(undefined);
    });
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useRemoteAccessStore.setState(useRemoteAccessStore.getInitialState());
  });

  it("renders settings panel", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("settings-view")).toBeInTheDocument();
  });

  it("requires an explicit terminal profile for each extension viewer", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".md"], command: "vi", profile: "" }],
      },
    });
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-fileExplorer"));
    const profileSelect = screen.getByTestId("fe-ext-viewer-profile-0") as HTMLSelectElement;
    expect(profileSelect.value).toBe("");
    expect(screen.getByTestId("fe-ext-viewer-profile-error-0")).toHaveTextContent(
      "Select a terminal profile.",
    );

    await user.selectOptions(profileSelect, "WSL");
    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().fileExplorer.extensionViewers[0].profile).toBe("WSL");
  });

  it("shows an explicit error for a viewer profile that no longer exists", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".md"], command: "vi", profile: "Deleted" }],
      },
    });
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-fileExplorer"));
    expect(screen.getByTestId("fe-ext-viewer-profile-error-0")).toHaveTextContent(
      "Selected terminal profile does not exist.",
    );
  });

  // -- Startup section (renamed from General) --

  it("displays Startup section", () => {
    render(<SettingsView />);
    expect(screen.getAllByText("Startup").length).toBeGreaterThanOrEqual(1);
  });

  it("shows font settings in Profile Defaults", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));
    // "Font" appears in both nav sidebar and profile defaults section
    expect(screen.getAllByText("Font").length).toBeGreaterThanOrEqual(1);
    const input = screen.getByTestId("font-face-input") as HTMLInputElement;
    expect(input.value).toBe("Cascadia Mono");
  });

  it("shows font size in Profile Defaults", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));
    const input = screen.getByTestId("font-size-input") as HTMLInputElement;
    expect(input.value).toBe("14");
  });

  it("shows font weight selector in Profile Defaults", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));
    const select = screen.getByTestId("font-weight-select") as HTMLSelectElement;
    expect(select.value).toBe("normal");
  });

  it("does NOT update font face in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));

    const select = screen.getByTestId("font-face-input") as HTMLSelectElement;
    await user.selectOptions(select, "Fira Code");

    // Store should still have original value (draft only in local state)
    expect(useSettingsStore.getState().profileDefaults.font.face).toBe("Cascadia Mono");
    // But the UI select should show the new value
    expect(select.value).toBe("Fira Code");
  });

  it("updates font face in store only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));

    const select = screen.getByTestId("font-face-input") as HTMLSelectElement;
    await user.selectOptions(select, "Fira Code");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().profileDefaults.font.face).toBe("Fira Code");
  });

  it("does NOT update font size in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));

    const input = screen.getByTestId("font-size-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "16" } });

    // Store should still have original value
    expect(useSettingsStore.getState().profileDefaults.font.size).toBe(14);
    // But the UI input should show the new value
    expect(input.value).toBe("16");
  });

  it("updates font size in store only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));

    const input = screen.getByTestId("font-size-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "16" } });

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().profileDefaults.font.size).toBe(16);
  });

  it("does NOT update font weight in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));

    const select = screen.getByTestId("font-weight-select");
    await user.selectOptions(select, "bold");

    // Store should still have original value
    expect(useSettingsStore.getState().profileDefaults.font.weight).toBe("normal");
  });

  it("updates font weight in store only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));

    const select = screen.getByTestId("font-weight-select");
    await user.selectOptions(select, "bold");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().profileDefaults.font.weight).toBe("bold");
  });

  // -- CWD propagation (syncCwd) in Profile Defaults --

  it("shows CWD propagation select defaulting to inherit in Profile Defaults", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));

    const select = screen.getByTestId("sync-cwd-profile-select") as HTMLSelectElement;
    // defaultProfileDefaults.syncCwd === "default" → token "default"
    expect(select.value).toBe("default");
  });

  it("updates profileDefaults.syncCwd to a concrete pair only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));

    const select = screen.getByTestId("sync-cwd-profile-select");
    await user.selectOptions(select, "send");

    // Not persisted until Save
    expect(useSettingsStore.getState().profileDefaults.syncCwd).toBe("default");

    await user.click(screen.getByTestId("save-settings-btn"));

    expect(useSettingsStore.getState().profileDefaults.syncCwd).toEqual({
      send: true,
      receive: false,
    });
  });

  // -- App Theme draft --

  it("does NOT update appTheme in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
    await user.selectOptions(select, "dracula");

    expect(useSettingsStore.getState().appearance.themeId).toBe("catppuccin-mocha");
    expect(select.value).toBe("dracula");
  });

  it("updates appTheme in store only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
    await user.selectOptions(select, "dracula");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().appearance.themeId).toBe("dracula");
  });

  // -- Default Profile draft --

  it("does NOT update defaultProfile in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("default-profile-select") as HTMLSelectElement;
    await user.selectOptions(select, "WSL");

    expect(useSettingsStore.getState().defaultProfile).toBe("PowerShell");
    expect(select.value).toBe("WSL");
  });

  it("updates defaultProfile in store only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("default-profile-select") as HTMLSelectElement;
    await user.selectOptions(select, "WSL");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().defaultProfile).toBe("WSL");
  });

  it("shows default profile dropdown", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("default-profile-select")).toBeInTheDocument();
  });

  // -- Sidebar / profiles --

  it("displays profile names in sidebar", () => {
    render(<SettingsView />);
    expect(screen.getAllByText("PowerShell").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("WSL").length).toBeGreaterThanOrEqual(1);
  });

  it("has a remove button for profiles", () => {
    render(<SettingsView />);
    const removeButtons = screen.getAllByTestId(/^remove-profile-/);
    expect(removeButtons.length).toBe(2);
  });

  it("removes a profile when remove button is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const removeBtn = screen.getByTestId("remove-profile-1");
    await user.click(removeBtn);

    expect(useSettingsStore.getState().profiles).toHaveLength(1);
  });

  it("shows add profile button", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("add-profile-btn")).toBeInTheDocument();
  });

  // -- Profile sub-tabs --

  it("shows profile sub-tabs (General, Additional Settings)", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await navigateToProfile(user, "PowerShell");

    const tabBar = screen.getByTestId("profile-tabs");
    expect(within(tabBar).getByText("General")).toBeInTheDocument();
    expect(within(tabBar).getByText("Additional Settings")).toBeInTheDocument();
  });

  it("profile General tab shows Name, Command Line, Tab Title, Hidden", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await navigateToProfile(user, "PowerShell");

    expect(screen.getByTestId("profile-name-input")).toBeInTheDocument();
    expect(screen.getByText("Command Line")).toBeInTheDocument();
    expect(screen.getByText("Tab Title")).toBeInTheDocument();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
  });

  it("profile Additional Settings tab shows Font, Appearance, Cursor and Advanced fields", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await navigateToProfile(user, "PowerShell");

    const tabBar = screen.getByTestId("profile-tabs");
    await user.click(within(tabBar).getByText("Additional Settings"));

    // Font fields (multiple "Font" text: nav sidebar + profile section)
    expect(screen.getAllByText("Font").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("font-face-input")).toBeInTheDocument();
    // Appearance fields
    expect(screen.getAllByText("Appearance").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Color Scheme")).toBeInTheDocument();
    expect(screen.getByText("Opacity")).toBeInTheDocument();
    expect(screen.getByText("Padding")).toBeInTheDocument();
    // Cursor fields
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Cursor Shape")).toBeInTheDocument();
    expect(screen.getByText("Cursor Blink")).toBeInTheDocument();
    expect(screen.getByText("Interactive Cursor Stability")).toBeInTheDocument();
    expect(screen.getByText("Cursor changes apply to new terminals.")).toBeInTheDocument();
    // Advanced fields
    expect(screen.getByText("Scrollback Lines")).toBeInTheDocument();
    expect(screen.getByText("Bell Style")).toBeInTheDocument();
    expect(screen.getByText("Close on Exit")).toBeInTheDocument();
    expect(screen.getByText("Text Antialiasing")).toBeInTheDocument();
  });

  it("profile Additional Settings tab has all cursor shape options", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await navigateToProfile(user, "PowerShell");

    const tabBar = screen.getByTestId("profile-tabs");
    await user.click(within(tabBar).getByText("Additional Settings"));

    const cursorSelect = screen.getByTestId("cursor-shape-select") as HTMLSelectElement;
    const options = Array.from(cursorSelect.options).map((o) => o.value);
    expect(options).toContain("bar");
    expect(options).toContain("underscore");
    expect(options).toContain("filledBox");
    expect(options).not.toContain("emptyBox");
    expect(options).not.toContain("doubleUnderscore");
    expect(options).not.toContain("vintage");
  });

  it("updates profile padding", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await navigateToProfile(user, "PowerShell");

    const tabBar = screen.getByTestId("profile-tabs");
    await user.click(within(tabBar).getByText("Additional Settings"));

    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.padding.top).toBe(8);
    expect(profile.padding.right).toBe(8);
    expect(profile.padding.bottom).toBe(8);
    expect(profile.padding.left).toBe(8);
  });

  it("resets profile sub-tab to General when switching profiles", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    // Go to PowerShell > Additional Settings tab
    await navigateToProfile(user, "PowerShell");
    const tabBar = screen.getByTestId("profile-tabs");
    await user.click(within(tabBar).getByText("Additional Settings"));
    expect(screen.getByText("Scrollback Lines")).toBeInTheDocument();

    // Switch to WSL — should reset to General tab
    await navigateToProfile(user, "WSL");
    screen.getByTestId("profile-tabs");
    // General tab content should be visible, not Advanced
    expect(screen.getByTestId("profile-name-input")).toBeInTheDocument();
    // Verify Advanced content is NOT showing
    expect(screen.queryByText("Scrollback Lines")).not.toBeInTheDocument();
  });

  // -- Keybindings --

  it("shows add keybinding button when keybindings section is active", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Keybindings"));
    expect(screen.getByTestId("add-keybinding-btn")).toBeInTheDocument();
  });

  it("displays default keybindings reference table", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Keybindings"));
    expect(screen.getByTestId("default-keybindings")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Shift+B")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Alt+1")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+,")).toBeInTheDocument();
  });

  it("adds a keybinding to draft (not store) until Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Keybindings"));
    await user.click(screen.getByTestId("add-keybinding-btn"));

    // Draft should show the new binding but store should not have it yet
    expect(useSettingsStore.getState().keybindings).toHaveLength(0);

    // After Save, store should have the new binding
    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().keybindings).toHaveLength(1);
  });

  it("does NOT update keybindings in store until Save (remove)", async () => {
    // Pre-populate store with a custom keybinding
    useSettingsStore.setState({
      keybindings: [{ keys: "Ctrl+K", command: "custom.action" }],
    });
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Keybindings"));
    // Remove the custom keybinding
    await user.click(screen.getByTestId("remove-keybinding-0"));

    // Store should still have it
    expect(useSettingsStore.getState().keybindings).toHaveLength(1);

    // After Save
    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().keybindings).toHaveLength(0);
  });

  it("Discard reverts keybindings draft to store value", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Keybindings"));
    await user.click(screen.getByTestId("add-keybinding-btn"));

    // Discard
    await user.click(screen.getByTestId("discard-settings-btn"));

    // Store should still be empty
    expect(useSettingsStore.getState().keybindings).toHaveLength(0);
  });

  it("keybindings draft survives navigation away and back", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Keybindings"));
    await user.click(screen.getByTestId("add-keybinding-btn"));

    // Navigate away
    await user.click(screen.getByText("Startup"));

    // Navigate back
    await user.click(screen.getByText("Keybindings"));

    // Save should flush the added keybinding
    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().keybindings).toHaveLength(1);
  });

  // PR #338 리뷰 P2: 와일드카드 액션(pane.focus)은 화살표 캡처만 허용해야 한다.
  // 비화살표 콤보가 저장되면 핸들러가 방향을 도출할 수 없어 영구 no-op이 된다.
  it("rejects a non-arrow capture for wildcard actions and accepts arrows (PR #338 review P2)", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Keybindings"));
    // pane.focus 기본값 kbd를 클릭해 캡처 시작
    await user.click(screen.getByText("Alt+Arrow"));
    const captureBox = screen.getByText("Press keys...");

    // 비화살표 콤보는 거부 — 캡처 박스가 placeholder 그대로여야 한다
    fireEvent.keyDown(captureBox, { key: "G", ctrlKey: true, shiftKey: true });
    expect(screen.getByText("Press keys...")).toBeInTheDocument();

    // 화살표 콤보는 Arrow 와일드카드로 수용
    fireEvent.keyDown(captureBox, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(screen.getByText("Ctrl+Shift+Arrow")).toBeInTheDocument();

    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().keybindings).toEqual([
      { keys: "Ctrl+Shift+Arrow", command: "pane.focus" },
    ]);
  });

  // -- Color Schemes --

  it("shows color schemes section", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Color Schemes"));
    expect(screen.getByTestId("add-color-scheme-btn")).toBeInTheDocument();
  });

  it("does NOT add color scheme to store until Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const initialCount = useSettingsStore.getState().colorSchemes.length;

    await user.click(screen.getByText("Color Schemes"));
    await user.click(screen.getByTestId("add-color-scheme-btn"));

    // Store should be unchanged
    expect(useSettingsStore.getState().colorSchemes.length).toBe(initialCount);

    // After Save
    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().colorSchemes.length).toBe(initialCount + 1);
  });

  it("does NOT remove color scheme from store until Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const initialCount = useSettingsStore.getState().colorSchemes.length;

    await user.click(screen.getByText("Color Schemes"));
    // Delete the first scheme
    await user.click(screen.getByText("Delete"));

    // Store unchanged
    expect(useSettingsStore.getState().colorSchemes.length).toBe(initialCount);

    // After Save
    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().colorSchemes.length).toBe(initialCount - 1);
  });

  it("does NOT update color scheme name in store until Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const originalName = useSettingsStore.getState().colorSchemes[0].name;

    await user.click(screen.getByText("Color Schemes"));
    // The name input is a text input, not the select dropdown
    const nameInput = screen
      .getAllByDisplayValue(originalName)
      .find((el) => el.tagName === "INPUT") as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    await user.clear(nameInput);
    await user.type(nameInput, "New Name");

    // Store unchanged
    expect(useSettingsStore.getState().colorSchemes[0].name).toBe(originalName);

    // After Save
    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().colorSchemes[0].name).toBe("New Name");
  });

  it("Discard reverts color scheme changes", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const initialCount = useSettingsStore.getState().colorSchemes.length;

    await user.click(screen.getByText("Color Schemes"));
    await user.click(screen.getByTestId("add-color-scheme-btn"));

    // Discard
    await user.click(screen.getByTestId("discard-settings-btn"));

    // Store unchanged
    expect(useSettingsStore.getState().colorSchemes.length).toBe(initialCount);
  });

  it("color scheme draft survives navigation away and back", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const initialCount = useSettingsStore.getState().colorSchemes.length;

    await user.click(screen.getByText("Color Schemes"));
    await user.click(screen.getByTestId("add-color-scheme-btn"));

    // Navigate away
    await user.click(screen.getByText("Startup"));

    // Navigate back
    await user.click(screen.getByText("Color Schemes"));

    // Save should flush the added scheme
    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().colorSchemes.length).toBe(initialCount + 1);
  });

  it("color scheme preview renders from draft, not store", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Color Schemes"));
    // The preview should exist and show draft values
    const preview = document.querySelector("[class*='font-mono']") as HTMLElement;
    expect(preview).toBeTruthy();
    // Preview background should be set (it's the draft value, which initially matches store)
    expect(preview.style.background).toBeTruthy();
  });

  // -- Save --

  it("has a save button that triggers persistSession", async () => {
    vi.mocked(persistSession).mockClear();
    const user = userEvent.setup();
    render(<SettingsView />);

    // Make a change to enable the Save button (dirty state)
    const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
    await user.selectOptions(select, "dracula");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(persistSession).toHaveBeenCalledTimes(1);
  });

  // -- Defaults page --

  it("shows Defaults page with Appearance, Cursor and Advanced sections", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    expect(screen.getByText("Profile Defaults")).toBeInTheDocument();
    expect(screen.getAllByText("Appearance").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Cursor Shape")).toBeInTheDocument();
    expect(screen.getByText("Scrollback Lines")).toBeInTheDocument();
  });

  // -- Session Restore settings in Advanced --

  it("shows session restore checkboxes in Profile Defaults Advanced section", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    expect(screen.getByText("Restore Working Directory")).toBeInTheDocument();
    expect(screen.getByText("Restore Terminal Output")).toBeInTheDocument();
  });

  it("session restore checkboxes are checked by default", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    const restoreCwd = screen.getByTestId("restore-cwd-checkbox") as HTMLInputElement;
    const restoreOutput = screen.getByTestId("restore-output-checkbox") as HTMLInputElement;
    expect(restoreCwd.checked).toBe(true);
    expect(restoreOutput.checked).toBe(true);
  });

  it("updates profileDefaults restoreOutput after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    const checkbox = screen.getByTestId("restore-output-checkbox") as HTMLInputElement;
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
    // Not saved yet
    expect(useSettingsStore.getState().profileDefaults.restoreOutput).toBe(true);

    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().profileDefaults.restoreOutput).toBe(false);
  });

  it("shows session restore checkboxes in profile Additional Settings", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await navigateToProfile(user, "PowerShell");
    const tabBar = screen.getByTestId("profile-tabs");
    await user.click(within(tabBar).getByText("Additional Settings"));

    expect(screen.getByText("Restore Working Directory")).toBeInTheDocument();
    expect(screen.getByText("Restore Terminal Output")).toBeInTheDocument();
  });

  it("does NOT update profileDefaults cursor shape until Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    const select = screen.getByTestId("cursor-shape-select") as HTMLSelectElement;
    await user.selectOptions(select, "filledBox");

    expect(useSettingsStore.getState().profileDefaults.cursorShape).toBe("bar");
    expect(select.value).toBe("filledBox");
  });

  it("updates profileDefaults cursor shape after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    const select = screen.getByTestId("cursor-shape-select") as HTMLSelectElement;
    await user.selectOptions(select, "filledBox");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().profileDefaults.cursorShape).toBe("filledBox");
  });

  it("updates profileDefaults cursor blink after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    const toggle = screen.getByTestId("cursor-blink-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await user.click(toggle);

    await user.click(screen.getByTestId("save-settings-btn"));

    expect(useSettingsStore.getState().profileDefaults.cursorBlink).toBe(false);
  });

  it("updates profileDefaults interactive cursor stability after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    const toggle = screen.getByTestId("stabilize-interactive-cursor-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await user.click(toggle);

    await user.click(screen.getByTestId("save-settings-btn"));

    expect(useSettingsStore.getState().profileDefaults.stabilizeInteractiveCursor).toBe(false);
  });

  it("shows settings.json shortcut in sidebar", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("sidebar-open-json")).toBeInTheDocument();
  });

  // -- Keybindings grouping --

  it("shows keybinding group headers", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Keybindings"));
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Pane")).toBeInTheDocument();
    expect(screen.getByText("UI")).toBeInTheDocument();
  });

  // -- Paste section --

  it("shows Paste nav button", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("nav-paste")).toBeInTheDocument();
  });

  it("renders Paste section with smart paste toggle", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    // "Paste" appears in both nav button and section title
    expect(screen.getAllByText("Paste").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("smart-paste-toggle")).toBeInTheDocument();
  });

  it("smart paste toggle is checked by default", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("does NOT update smart paste in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    const toggle = screen.getByTestId("smart-paste-toggle");
    await user.click(toggle);

    // Store unchanged
    expect(useSettingsStore.getState().paste.smart).toBe(true);
  });

  it("toggling smart paste updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    const toggle = screen.getByTestId("smart-paste-toggle");
    await user.click(toggle);

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().paste.smart).toBe(false);
  });

  it("renders multi-file paste separator select and quote toggle (#325)", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    const select = screen.getByTestId("paste-path-separator-select") as HTMLSelectElement;
    expect(select.value).toBe("space"); // 기본값
    const quoteToggle = screen.getByTestId("paste-path-quote-toggle") as HTMLInputElement;
    expect(quoteToggle.checked).toBe(false); // 기본값
  });

  it("changing paste path separator updates store after Save (#325)", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    const select = screen.getByTestId("paste-path-separator-select") as HTMLSelectElement;
    await user.selectOptions(select, "newline");

    // Store unchanged until Save
    expect(useSettingsStore.getState().paste.pathSeparator).toBe("space");

    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().paste.pathSeparator).toBe("newline");
  });

  it("toggling paste path quote updates store after Save (#325)", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    await user.click(screen.getByTestId("paste-path-quote-toggle"));

    expect(useSettingsStore.getState().paste.pathQuote).toBe(false);

    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().paste.pathQuote).toBe(true);
  });

  it("shows paste image dir input", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    expect(screen.getByTestId("paste-image-dir-input")).toBeInTheDocument();
  });

  it("does NOT update paste image dir in store until Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    const input = screen.getByTestId("paste-image-dir-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "C:\\my\\dir");

    expect(useSettingsStore.getState().paste.imageDir).toBe("");
  });

  it("paste image dir input updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    const input = screen.getByTestId("paste-image-dir-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "C:\\my\\dir");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().paste.imageDir).toBe("C:\\my\\dir");
  });

  // -- Terminal section: copy on select --

  it("does NOT update copy on select in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-terminal"));
    const toggle = screen.getByTestId("copy-on-select-toggle");
    await user.click(toggle);

    expect(useSettingsStore.getState().terminal.copyOnSelect).toBe(true);
  });

  it("toggling copy on select updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-terminal"));
    const toggle = screen.getByTestId("copy-on-select-toggle");
    await user.click(toggle);

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().terminal.copyOnSelect).toBe(false);
  });

  // -- Terminal section: kill-on-exit (issue #451) --

  it("interrupt-on-exit is off by default and its inputs are hidden", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-terminal"));
    const toggle = screen.getByTestId("interrupt-on-exit-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByTestId("interrupt-rounds-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("interrupt-settle-input")).not.toBeInTheDocument();
  });

  it("does NOT update interrupt-on-exit in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-terminal"));
    await user.click(screen.getByTestId("interrupt-on-exit-toggle"));

    expect(useSettingsStore.getState().exit.interruptTerminals).toBe(false);
  });

  it("enabling interrupt-on-exit reveals rounds/settle inputs and persists on Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-terminal"));
    await user.click(screen.getByTestId("interrupt-on-exit-toggle"));

    // Inputs appear once enabled (draft state), before Save.
    const rounds = screen.getByTestId("interrupt-rounds-input") as HTMLInputElement;
    const settle = screen.getByTestId("interrupt-settle-input") as HTMLInputElement;
    fireEvent.change(rounds, { target: { value: "5" } });
    fireEvent.change(settle, { target: { value: "1200" } });

    await user.click(screen.getByTestId("save-settings-btn"));

    const exit = useSettingsStore.getState().exit;
    expect(exit.interruptTerminals).toBe(true);
    expect(exit.interruptRounds).toBe(5);
    expect(exit.settleMs).toBe(1200);
  });

  // -- Terminal section: scrollbar style --

  it("shows scrollbar style select in terminal section", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-terminal"));
    expect(screen.getByTestId("scrollbar-style-select")).toBeInTheDocument();
  });

  it("scrollbar style select updates store", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-terminal"));
    const select = screen.getByTestId("scrollbar-style-select") as HTMLSelectElement;
    await user.selectOptions(select, "separate");

    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().terminal.scrollbarStyle).toBe("separate");
  });

  // -- Hidden terminal auto-close (issue #269) --

  it("shows hidden auto-close input in workspaces section", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-workspaceDisplay"));
    expect(screen.getByTestId("hidden-auto-close-seconds-input")).toBeInTheDocument();
  });

  it("does NOT update hidden auto-close in store until Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-workspaceDisplay"));
    const input = screen.getByTestId("hidden-auto-close-seconds-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "600");

    expect(useSettingsStore.getState().workspaceSelector.hiddenAutoCloseSeconds).toBe(0);
  });

  it("hidden auto-close input updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-workspaceDisplay"));
    const input = screen.getByTestId("hidden-auto-close-seconds-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "600");

    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().workspaceSelector.hiddenAutoCloseSeconds).toBe(600);
  });

  // -- Claude Code section --

  it("shows Claude Code nav button", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("nav-claude")).toBeInTheDocument();
  });

  it("renders Claude Code section with sync cwd dropdown", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-claude"));
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("claude-sync-cwd-select")).toBeInTheDocument();
  });

  it("claude sync cwd defaults to skip", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-claude"));
    const select = screen.getByTestId("claude-sync-cwd-select") as HTMLSelectElement;
    expect(select.value).toBe("skip");
  });

  it("does NOT update claude sync cwd in store until Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-claude"));
    const select = screen.getByTestId("claude-sync-cwd-select");
    await user.selectOptions(select, "command");

    expect(useSettingsStore.getState().claude.syncCwd).toBe("skip");
  });

  it("changing claude sync cwd updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-claude"));
    const select = screen.getByTestId("claude-sync-cwd-select");
    await user.selectOptions(select, "command");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().claude.syncCwd).toBe("command");
  });

  it("renders claude session-limit auto-resume controls with defaults", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-claude"));
    const toggle = screen.getByTestId(
      "claude-session-limit-auto-resume-toggle",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(
      (screen.getByTestId("claude-session-limit-resume-delay-input") as HTMLInputElement).value,
    ).toBe("60");
    expect(
      (screen.getByTestId("claude-session-limit-resume-message-input") as HTMLInputElement).value,
    ).toBe("go on");
  });

  it("changing claude session-limit resume settings updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-claude"));
    const messageInput = screen.getByTestId("claude-session-limit-resume-message-input");
    await user.clear(messageInput);
    await user.type(messageInput, "continue");
    const delayInput = screen.getByTestId("claude-session-limit-resume-delay-input");
    // user.clear() on the number input briefly yields "" which the onChange
    // handler coerces back to the default 60; replace the value atomically.
    fireEvent.change(delayInput, { target: { value: "120" } });

    await user.click(screen.getByTestId("save-settings-btn"));

    expect(useSettingsStore.getState().claude.sessionLimitResumeMessage).toBe("continue");
    expect(useSettingsStore.getState().claude.sessionLimitResumeDelaySeconds).toBe(120);
  });

  it("disabling claude session-limit auto-resume hides delay/message inputs", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-claude"));
    await user.click(screen.getByTestId("claude-session-limit-auto-resume-toggle"));

    expect(screen.queryByTestId("claude-session-limit-resume-delay-input")).toBeNull();
    expect(screen.queryByTestId("claude-session-limit-resume-message-input")).toBeNull();

    await user.click(screen.getByTestId("save-settings-btn"));
    expect(useSettingsStore.getState().claude.sessionLimitAutoResume).toBe(false);
  });

  it("shows Codex nav button", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("nav-codex")).toBeInTheDocument();
  });

  it("renders Codex section with status message mode", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-codex"));
    expect(screen.getAllByText("Codex").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("codex-status-message-mode-select")).toBeInTheDocument();
  });

  it("changing codex status message mode updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-codex"));
    const select = screen.getByTestId("codex-status-message-mode-select");
    await user.selectOptions(select, "bullet-title");

    await user.click(screen.getByTestId("save-settings-btn"));

    expect(useSettingsStore.getState().codex.statusMessageMode).toBe("bullet-title");
  });

  // -- Discard --

  it("has a discard button", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("discard-settings-btn")).toBeInTheDocument();
  });

  it("discard reverts font draft to store value", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));

    const select = screen.getByTestId("font-face-input") as HTMLSelectElement;
    await user.selectOptions(select, "Fira Code");
    expect(select.value).toBe("Fira Code");

    const discardBtn = screen.getByTestId("discard-settings-btn");
    await user.click(discardBtn);

    expect(select.value).toBe("Cascadia Mono");
    expect(useSettingsStore.getState().profileDefaults.font.face).toBe("Cascadia Mono");
  });

  it("discard reverts appTheme draft to store value", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
    await user.selectOptions(select, "dracula");
    expect(select.value).toBe("dracula");

    const discardBtn = screen.getByTestId("discard-settings-btn");
    await user.click(discardBtn);

    expect(select.value).toBe("catppuccin-mocha");
    expect(useSettingsStore.getState().appearance.themeId).toBe("catppuccin-mocha");
  });

  it("discard reverts convenience draft to store value", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-paste"));
    const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
    await user.click(toggle);
    expect(toggle.checked).toBe(false);

    const discardBtn = screen.getByTestId("discard-settings-btn");
    await user.click(discardBtn);

    // Need to navigate back to convenience since discard may re-render
    await user.click(screen.getByTestId("nav-paste"));
    const toggleAfter = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
    expect(toggleAfter.checked).toBe(true);
    expect(useSettingsStore.getState().paste.smart).toBe(true);
  });

  // -- Dirty state (Save/Discard button enabled/disabled) --

  it("save and discard buttons are disabled when no changes", () => {
    render(<SettingsView />);

    const saveBtn = screen.getByTestId("save-settings-btn") as HTMLButtonElement;
    const discardBtn = screen.getByTestId("discard-settings-btn") as HTMLButtonElement;

    expect(saveBtn.disabled).toBe(true);
    expect(discardBtn.disabled).toBe(true);
  });

  it("save and discard buttons become enabled after a change", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
    await user.selectOptions(select, "dracula");

    const saveBtn = screen.getByTestId("save-settings-btn") as HTMLButtonElement;
    const discardBtn = screen.getByTestId("discard-settings-btn") as HTMLButtonElement;

    expect(saveBtn.disabled).toBe(false);
    expect(discardBtn.disabled).toBe(false);
  });

  it("buttons become disabled again after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
    await user.selectOptions(select, "dracula");

    const saveBtn = screen.getByTestId("save-settings-btn") as HTMLButtonElement;
    await user.click(saveBtn);

    expect(saveBtn.disabled).toBe(true);
    expect((screen.getByTestId("discard-settings-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("buttons become disabled again after Discard", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
    await user.selectOptions(select, "dracula");

    const discardBtn = screen.getByTestId("discard-settings-btn") as HTMLButtonElement;
    await user.click(discardBtn);

    expect(discardBtn.disabled).toBe(true);
    expect((screen.getByTestId("save-settings-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  // -- storeSetter 참조 불안정 유발 테스트 --
  // DefaultsSection, ConvenienceSection, ClaudeSection은 useDraft에
  // 인라인 화살표 함수를 storeSetter로 전달한다. 매 렌더마다 새 참조가
  // 생성되어 useEffect가 불필요하게 재실행된다.
  // 아래 테스트는 "외부 store 변경 → 재렌더 → Save/Discard" 시나리오에서
  // flush/reset 콜백이 여전히 올바르게 동작하는지 검증한다.

  describe("storeSetter 참조 불안정 유발 — DefaultsSection", () => {
    it("draft 변경 → 외부 store 변경으로 재렌더 → Save 시 flush 정상 동작", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-profile-defaults"));
      const select = screen.getByTestId("cursor-shape-select") as HTMLSelectElement;
      await user.selectOptions(select, "filledBox");
      expect(select.value).toBe("filledBox");

      // colorSchemes 변경으로 DefaultsSection 재렌더 유발
      // → 인라인 storeSetter 새 참조 생성 → useEffect 재실행
      act(() => {
        const state = useSettingsStore.getState();
        useSettingsStore.setState({
          colorSchemes: [...state.colorSchemes],
        });
      });

      // draft가 재렌더 후에도 보존되어야 함
      expect(select.value).toBe("filledBox");
      // store는 아직 미변경
      expect(useSettingsStore.getState().profileDefaults.cursorShape).toBe("bar");

      // Save → flush 콜백이 올바른 draft 값을 사용해야 함
      await user.click(screen.getByTestId("save-settings-btn"));
      expect(useSettingsStore.getState().profileDefaults.cursorShape).toBe("filledBox");
    });

    it("draft 변경 → 외부 store 변경으로 재렌더 → Discard 시 reset 정상 동작", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-profile-defaults"));
      const select = screen.getByTestId("cursor-shape-select") as HTMLSelectElement;
      await user.selectOptions(select, "filledBox");

      // 재렌더 유발
      act(() => {
        const state = useSettingsStore.getState();
        useSettingsStore.setState({
          colorSchemes: [...state.colorSchemes],
        });
      });

      // Discard → reset 콜백이 원래 store 값으로 복원해야 함
      await user.click(screen.getByTestId("discard-settings-btn"));
      await user.click(screen.getByTestId("nav-profile-defaults"));
      const selectAfter = screen.getByTestId("cursor-shape-select") as HTMLSelectElement;
      expect(selectAfter.value).toBe("bar");
    });

    it("다중 재렌더 후에도 flush 정상 동작", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-profile-defaults"));
      const select = screen.getByTestId("cursor-shape-select") as HTMLSelectElement;
      await user.selectOptions(select, "filledBox");

      // 5회 연속 재렌더 유발 — 매번 새 storeSetter → useEffect 재실행
      for (let i = 0; i < 5; i++) {
        act(() => {
          const state = useSettingsStore.getState();
          useSettingsStore.setState({
            colorSchemes: [...state.colorSchemes],
          });
        });
      }

      expect(select.value).toBe("filledBox");
      await user.click(screen.getByTestId("save-settings-btn"));
      expect(useSettingsStore.getState().profileDefaults.cursorShape).toBe("filledBox");
    });
  });

  describe("storeSetter 참조 불안정 유발 — ConvenienceSection", () => {
    it("draft 변경 → 외부 store 변경으로 재렌더 → Save 시 flush 정상 동작", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-paste"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      await user.click(toggle);
      expect(toggle.checked).toBe(false);

      // PasteSection이 구독하는 store 상태 변경으로 재렌더 유발
      act(() => {
        const state = useSettingsStore.getState();
        useSettingsStore.setState({
          paste: { ...state.paste },
        });
      });

      // 재렌더 후 draft 보존 + Save 정상 동작
      await user.click(screen.getByTestId("save-settings-btn"));
      expect(useSettingsStore.getState().paste.smart).toBe(false);
    });
  });

  describe("storeSetter 참조 불안정 유발 — ClaudeSection", () => {
    it("draft 변경 → 외부 store 변경으로 재렌더 → Save 시 flush 정상 동작", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-claude"));
      const select = screen.getByTestId("claude-sync-cwd-select") as HTMLSelectElement;
      await user.selectOptions(select, "command");

      // ClaudeSection이 구독하는 store 상태 변경으로 재렌더 유발
      act(() => {
        const state = useSettingsStore.getState();
        useSettingsStore.setState({
          claude: { ...state.claude },
        });
      });

      await user.click(screen.getByTestId("save-settings-btn"));
      expect(useSettingsStore.getState().claude.syncCwd).toBe("command");
    });
  });

  // -- 섹션 언마운트 시 flush 콜백 유실 버그 유발 테스트 --
  // activeNav 조건부 렌더링에 의해 섹션 이동 시 이전 섹션이 언마운트되면
  // useDraft의 useEffect cleanup이 flush/reset 콜백을 Map에서 삭제한다.
  // 이후 Save를 누르면 언마운트된 섹션의 변경사항이 유실된다.

  describe("섹션 네비게이션 시 draft 유실 버그", () => {
    it("DefaultsSection에서 변경 → 다른 섹션 이동 → Save 시 변경 유실", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // DefaultsSection에서 font face 변경
      await user.click(screen.getByTestId("nav-profile-defaults"));
      const fontSelect = screen.getByTestId("font-face-input") as HTMLSelectElement;
      await user.selectOptions(fontSelect, "Fira Code");
      expect(fontSelect.value).toBe("Fira Code");

      // Convenience로 이동 → DefaultsSection 언마운트
      await user.click(screen.getByTestId("nav-paste"));

      // Save → DefaultsSection의 flush 콜백이 cleanup으로 삭제됨
      await user.click(screen.getByTestId("save-settings-btn"));

      // BUG: font face 변경이 유실됨
      expect(useSettingsStore.getState().profileDefaults.font.face).toBe("Fira Code");
    });

    it("ConvenienceSection에서 변경 → 다른 섹션 이동 → Save 시 변경 유실", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // ConvenienceSection으로 이동 후 smart paste 토글
      await user.click(screen.getByTestId("nav-paste"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      await user.click(toggle);
      expect(toggle.checked).toBe(false);

      // Claude 섹션으로 이동 → ConvenienceSection 언마운트
      await user.click(screen.getByTestId("nav-claude"));

      // Save
      await user.click(screen.getByTestId("save-settings-btn"));

      // BUG: smart paste 변경이 유실됨
      expect(useSettingsStore.getState().paste.smart).toBe(false);
    });

    it("여러 섹션에서 순차 변경 → Save 시 마지막 섹션만 반영됨", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // 1. DefaultsSection: font 변경
      await user.click(screen.getByTestId("nav-profile-defaults"));
      const fontSelect = screen.getByTestId("font-face-input") as HTMLSelectElement;
      await user.selectOptions(fontSelect, "Fira Code");

      // 2. ConvenienceSection: smart paste 변경
      await user.click(screen.getByTestId("nav-paste"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      await user.click(toggle);

      // 3. ClaudeSection: sync cwd 변경
      await user.click(screen.getByTestId("nav-claude"));
      const claudeSelect = screen.getByTestId("claude-sync-cwd-select") as HTMLSelectElement;
      await user.selectOptions(claudeSelect, "command");

      // Save → 마지막에 마운트된 ClaudeSection만 flush 가능
      await user.click(screen.getByTestId("save-settings-btn"));

      const state = useSettingsStore.getState();
      // BUG: DefaultsSection 변경 유실
      expect(state.profileDefaults.font.face).toBe("Fira Code");
      // BUG: ConvenienceSection 변경 유실
      expect(state.paste.smart).toBe(false);
      // ClaudeSection은 마운트 상태이므로 정상 반영
      expect(state.claude.syncCwd).toBe("command");
    });
  });

  // -- Profile fields draft (startupCommand, commandLine 등) --

  describe("Profile field changes use draft (not direct store update)", () => {
    it("does NOT update startupCommand in store until Save is clicked", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await navigateToProfile(user, "PowerShell");
      const input = screen.getByPlaceholderText(
        "cd ~/project && conda activate myenv",
      ) as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "echo hello");

      // Store should still have original value
      expect(useSettingsStore.getState().profiles[0].startupCommand).toBe("");
      // UI should show draft value
      expect(input.value).toBe("echo hello");
    });

    it("updates startupCommand in store after Save", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await navigateToProfile(user, "PowerShell");
      const input = screen.getByPlaceholderText(
        "cd ~/project && conda activate myenv",
      ) as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "echo hello");

      await user.click(screen.getByTestId("save-settings-btn"));
      expect(useSettingsStore.getState().profiles[0].startupCommand).toBe("echo hello");
    });

    it("Save button becomes enabled when profile field is changed", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await navigateToProfile(user, "PowerShell");
      const saveBtn = screen.getByTestId("save-settings-btn");
      expect(saveBtn).toBeDisabled();

      const input = screen.getByPlaceholderText(
        "cd ~/project && conda activate myenv",
      ) as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "echo hello");

      expect(saveBtn).not.toBeDisabled();
    });

    it("Discard restores profile field to last saved value", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await navigateToProfile(user, "PowerShell");
      const input = screen.getByPlaceholderText(
        "cd ~/project && conda activate myenv",
      ) as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "echo hello");

      await user.click(screen.getByTestId("discard-settings-btn"));
      expect(input.value).toBe("");
      expect(useSettingsStore.getState().profiles[0].startupCommand).toBe("");
    });

    it("profile draft survives navigation away and back", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // Change startupCommand in PowerShell profile
      await navigateToProfile(user, "PowerShell");
      const input = screen.getByPlaceholderText(
        "cd ~/project && conda activate myenv",
      ) as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "echo hello");

      // Navigate away to Convenience
      await user.click(screen.getByTestId("nav-paste"));

      // Navigate back
      await navigateToProfile(user, "PowerShell");
      const inputAfter = screen.getByPlaceholderText(
        "cd ~/project && conda activate myenv",
      ) as HTMLInputElement;
      expect(inputAfter.value).toBe("echo hello");

      // Save should still work
      await user.click(screen.getByTestId("save-settings-btn"));
      expect(useSettingsStore.getState().profiles[0].startupCommand).toBe("echo hello");
    });
  });

  // -- #51: 외부 store 변경 시 draft 자동 리셋 --
  describe("외부 store 변경 시 draft 자동 리셋 (#51)", () => {
    it("Settings UI 열림 + draft 미수정 상태에서 store 변경 → draft가 새 store 값으로 리셋", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // Convenience 섹션으로 이동
      await user.click(screen.getByTestId("nav-paste"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      expect(toggle.checked).toBe(true); // 기본값

      // 외부에서 store 변경 (settings.json 핫 리로드 시뮬레이션)
      act(() => {
        useSettingsStore.setState({
          paste: { ...useSettingsStore.getState().paste, smart: false },
        });
      });

      // draft가 새 store 값으로 자동 리셋되어야 함
      expect(toggle.checked).toBe(false);
    });

    it("Settings UI 열림 + draft 수정 중 상태에서 store 변경 → draft가 store 값으로 리셋 (Windows Terminal 방식)", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-profile-defaults"));
      const fontInput = screen.getByTestId("font-face-input") as HTMLSelectElement;
      // draft를 수정
      await user.selectOptions(fontInput, "Fira Code");
      expect(fontInput.value).toBe("Fira Code");

      // 외부에서 store의 font.face 변경
      act(() => {
        const state = useSettingsStore.getState();
        useSettingsStore.setState({
          profileDefaults: {
            ...state.profileDefaults,
            font: { ...state.profileDefaults.font, face: "Consolas" },
          },
        });
      });

      // Windows Terminal 방식: 외부 변경이 draft를 덮어씀
      expect(fontInput.value).toBe("Consolas");
    });

    it("외부 store 변경 후 Save 시 외부 변경 값이 유지됨 (stale draft가 덮어쓰지 않음)", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-claude"));
      const select = screen.getByTestId("claude-sync-cwd-select") as HTMLSelectElement;
      expect(select.value).toBe("skip");

      // 외부에서 store 변경
      act(() => {
        useSettingsStore.setState({
          claude: { ...useSettingsStore.getState().claude, syncCwd: "command" },
        });
      });

      // draft가 리셋되어야 함
      expect(select.value).toBe("command");

      // Save 시 외부 변경 값이 그대로 유지됨
      await user.click(screen.getByTestId("save-settings-btn"));
      expect(useSettingsStore.getState().claude.syncCwd).toBe("command");
    });

    it("외부 store 변경 후 dirty 플래그가 클리어됨", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // draft 수정 → dirty 상태
      await user.click(screen.getByTestId("nav-paste"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      await user.click(toggle);
      const saveBtn = screen.getByTestId("save-settings-btn");
      expect(saveBtn).not.toBeDisabled(); // dirty 상태

      // 외부에서 store 변경 → draft 리셋 → dirty 클리어
      act(() => {
        useSettingsStore.setState({
          paste: { ...useSettingsStore.getState().paste, smart: false },
        });
      });

      // Save 버튼이 비활성화되어야 함 (dirty 클리어)
      expect(saveBtn).toBeDisabled();
    });

    it("사용자가 A 필드 수정 중 + B 필드만 외부 변경 → A의 dirty 상태 유지", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // A 필드 수정: convenience 섹션의 smartPaste 토글
      await user.click(screen.getByTestId("nav-paste"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      await user.click(toggle);
      const saveBtn = screen.getByTestId("save-settings-btn");
      expect(saveBtn).not.toBeDisabled(); // dirty 상태

      // B 필드만 외부 변경: claude.syncCwd
      act(() => {
        useSettingsStore.setState({
          claude: { ...useSettingsStore.getState().claude, syncCwd: "command" },
        });
      });

      // A 필드의 사용자 수정이 살아 있으므로 dirty 상태 유지
      expect(saveBtn).not.toBeDisabled();
    });

    it("Startup 섹션에서 appTheme 외부 변경 시 draft 리셋", async () => {
      render(<SettingsView />);

      const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
      expect(select.value).toBe("catppuccin-mocha");

      // 외부에서 store 변경
      act(() => {
        useSettingsStore.setState((s) => ({
          appearance: { ...s.appearance, themeId: "dracula" },
        }));
      });

      expect(select.value).toBe("dracula");
    });

    it("Startup 섹션에서 defaultProfile 외부 변경 시 draft 리셋", async () => {
      render(<SettingsView />);

      const select = screen.getByTestId("default-profile-select") as HTMLSelectElement;

      // 외부에서 profiles에 새 프로파일 추가 후 defaultProfile 변경
      act(() => {
        const state = useSettingsStore.getState();
        useSettingsStore.setState({
          profiles: [...state.profiles, { name: "TestProfile", commandLine: "test.exe" }],
          defaultProfile: "TestProfile",
        });
      });

      expect(select.value).toBe("TestProfile");
    });
  });

  describe("RemoteSection", () => {
    it("renders the Remote nav section", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));

      expect(await screen.findByTestId("remote-settings-enabled-toggle")).toBeInTheDocument();
      expect(screen.getAllByText("Remote").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId("remote-settings-allowed-ips-input")).toBeInTheDocument();
    });

    it("enables startup remote access with a generated token only after Save", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      await user.click(await screen.findByTestId("remote-settings-enabled-toggle"));

      expect(useSettingsStore.getState().remote.enabled).toBe(false);
      expect(useSettingsStore.getState().remote.authToken).toBe("");

      await user.click(screen.getByTestId("save-settings-btn"));

      expect(useSettingsStore.getState().remote.enabled).toBe(true);
      expect(useSettingsStore.getState().remote.authToken).toHaveLength(48);
    });

    it("saves allowed IPs from the Remote settings section", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      const input = (await screen.findByTestId(
        "remote-settings-allowed-ips-input",
      )) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "127.0.0.1/32\n100.64.0.0/10" } });

      expect(useSettingsStore.getState().remote.allowedIps).toEqual(["127.0.0.1/32", "::1/128"]);

      await user.click(screen.getByTestId("save-settings-btn"));

      expect(useSettingsStore.getState().remote.allowedIps).toEqual([
        "127.0.0.1/32",
        "100.64.0.0/10",
      ]);
    });

    it("adds the Tailscale allowlist preset and saves automatic mobile width", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      await user.click(await screen.findByTestId("remote-settings-add-tailscale"));
      const width = screen.getByTestId(
        "remote-settings-auto-mobile-width-input",
      ) as HTMLInputElement;
      fireEvent.change(width, { target: { value: "0" } });
      await user.click(screen.getByTestId("save-settings-btn"));

      expect(useSettingsStore.getState().remote.allowedIps).toEqual([
        "127.0.0.1/32",
        "::1/128",
        "100.64.0.0/10",
        "fd7a:115c:a1e0::/48",
      ]);
      expect(useSettingsStore.getState().remote.autoMobileModeMinWidth).toBe(0);
    });

    it("adds custom hosts and saves the preferred host", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      const input = (await screen.findByTestId(
        "remote-settings-custom-host-input",
      )) as HTMLInputElement;
      await user.type(input, "devbox.tailnet.ts.net");
      await user.click(screen.getByTestId("remote-settings-custom-host-add"));

      const select = screen.getByTestId(
        "remote-settings-preferred-host-select",
      ) as HTMLSelectElement;
      await user.selectOptions(select, "devbox.tailnet.ts.net");

      expect(useSettingsStore.getState().remote.customHosts).toEqual([]);
      expect(useSettingsStore.getState().remote.preferredHost).toBe("");

      await user.click(screen.getByTestId("save-settings-btn"));

      expect(useSettingsStore.getState().remote.customHosts).toEqual(["devbox.tailnet.ts.net"]);
      expect(useSettingsStore.getState().remote.preferredHost).toBe("devbox.tailnet.ts.net");
    });

    it("removes a custom host and clears it as preferred host", async () => {
      useSettingsStore.getState().setRemote({
        customHosts: ["devbox.tailnet.ts.net"],
        preferredHost: "devbox.tailnet.ts.net",
      });
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      await user.click(
        await screen.findByTestId("remote-settings-custom-host-remove-devbox.tailnet.ts.net"),
      );
      await user.click(screen.getByTestId("save-settings-btn"));

      expect(useSettingsStore.getState().remote.customHosts).toEqual([]);
      expect(useSettingsStore.getState().remote.preferredHost).toBe("");
    });

    it("reconciles backend access status after disabling startup remote access", async () => {
      useSettingsStore.getState().setRemote({ enabled: true, authToken: "secret" });
      useRemoteAccessStore.getState().setStatus(remoteAccessStatus(false));
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      await user.click(await screen.findByTestId("remote-settings-enabled-toggle"));
      await user.click(screen.getByTestId("save-settings-btn"));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("set_remote_runtime_access", {
          enabled: false,
          authToken: null,
        });
      });
      expect(useRemoteAccessStore.getState().status).toMatchObject({
        effectiveEnabled: false,
        persistentEnabled: false,
        runtimeEnabled: false,
        effectiveAuthToken: "secret",
      });
    });

    it("renders cloud connection status and saves the relay override", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));

      expect(await screen.findByText("Cloud Connection")).toBeInTheDocument();
      expect(await screen.findByTestId("remote-settings-cloud-status")).toHaveTextContent(
        "Disconnected",
      );
      const input = screen.getByTestId(
        "remote-settings-cloud-relay-base-url-input",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: " https://relay.example.test " } });

      expect(useSettingsStore.getState().remote.relayBaseUrl).toBe("https://app.laymux.com");

      await user.click(screen.getByTestId("save-settings-btn"));

      expect(useSettingsStore.getState().remote.relayBaseUrl).toBe("https://relay.example.test");
    });

    it("disconnects cloud status and mirrors persisted cloud fields in the store", async () => {
      mockCloudStatus = { connected: true, instanceId: "instance-1", lastError: null };
      useSettingsStore.getState().setRemote({
        cloudEnabled: true,
        cloudInstanceId: "instance-1",
      });
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      expect(await screen.findByTestId("remote-settings-cloud-status")).toHaveTextContent(
        "Connected",
      );
      await user.click(await screen.findByTestId("remote-settings-cloud-disconnect"));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("cloud_disconnect");
      });
      expect(screen.getByTestId("remote-settings-cloud-status")).toHaveTextContent("Disconnected");
      expect(useSettingsStore.getState().remote.cloudEnabled).toBe(false);
      expect(useSettingsStore.getState().remote.cloudInstanceId).toBeNull();
    });

    it("shows cloud disconnect when persisted cloud settings remain but runtime is disconnected", async () => {
      mockCloudStatus = { connected: false, instanceId: null, lastError: null };
      useSettingsStore.getState().setRemote({
        cloudEnabled: true,
        cloudInstanceId: "instance-1",
      });
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));

      expect(await screen.findByTestId("remote-settings-cloud-status")).toHaveTextContent(
        "Paired (waiting to connect)",
      );
      expect(screen.getByTestId("remote-settings-cloud-disconnect")).toBeInTheDocument();
    });

    it("starts cloud pairing, shows pending text, and mirrors the paired status", async () => {
      let resolveConnect: (value: typeof mockCloudStatus) => void = () => {};
      mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_system_monospace_fonts") {
          return Promise.resolve(["Cascadia Mono", "Fira Code", "Consolas"]);
        }
        if (cmd === "get_remote_host_candidates") {
          return Promise.resolve([
            { kind: "loopback", host: "127.0.0.1", label: "Localhost 127.0.0.1" },
          ]);
        }
        if (cmd === "get_remote_access_status") {
          return Promise.resolve(remoteAccessStatus());
        }
        if (cmd === "set_remote_runtime_access") {
          return Promise.resolve(remoteAccessStatus(Boolean(args?.enabled)));
        }
        if (cmd === "get_cloud_status") {
          return Promise.resolve({ connected: false, instanceId: null, lastError: null });
        }
        if (cmd === "cloud_connect_start") {
          return new Promise((resolve) => {
            resolveConnect = resolve;
          });
        }
        if (cmd === "load_settings") {
          return Promise.resolve({
            remote: {
              ...useSettingsStore.getState().remote,
              cloudEnabled: true,
              cloudInstanceId: "instance-2",
              cloudTunnelUrl: "wss://relay.example.test/tunnel/instance-2",
              cloudServerBaseUrl: "https://relay.example.test",
            },
          });
        }
        return Promise.resolve(undefined);
      });
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      const connect = await screen.findByTestId("remote-settings-cloud-connect");
      await user.click(connect);

      expect(connect).toHaveTextContent("Connecting...");
      expect(connect).toBeDisabled();

      await act(async () => {
        resolveConnect({ connected: false, instanceId: "instance-2", lastError: null });
      });

      await waitFor(() => {
        expect(screen.getByTestId("remote-settings-cloud-status")).toHaveTextContent(
          "Paired (waiting to connect)",
        );
      });
      expect(useSettingsStore.getState().remote.cloudEnabled).toBe(true);
      expect(useSettingsStore.getState().remote.cloudInstanceId).toBe("instance-2");
      expect(useSettingsStore.getState().remote.cloudTunnelUrl).toBe(
        "wss://relay.example.test/tunnel/instance-2",
      );
      expect(useSettingsStore.getState().remote.cloudServerBaseUrl).toBe(
        "https://relay.example.test",
      );
    });

    it("commits the edited relay draft to disk before pairing on cloud connect", async () => {
      // Regression: the backend cloud_connect_start reads relay_base_url from
      // load_settings() (disk). Editing the relay field and clicking Connect
      // WITHOUT a separate Save used to pair against the previously-saved relay.
      // Fix: Connect commits the trimmed relay draft (store + disk via
      // save_settings) before pairing, so it uses the URL the user typed.
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      const relayInput = (await screen.findByTestId(
        "remote-settings-cloud-relay-base-url-input",
      )) as HTMLInputElement;
      fireEvent.change(relayInput, { target: { value: "https://draft-relay.example.test" } });

      await user.click(screen.getByTestId("remote-settings-cloud-connect"));

      await waitFor(() => {
        expect(screen.getByTestId("remote-settings-cloud-status")).toHaveTextContent(
          "Paired (waiting to connect)",
        );
      });

      // Relay committed to the store + persisted to disk during Connect — no
      // manual Save required.
      expect(useSettingsStore.getState().remote.relayBaseUrl).toBe(
        "https://draft-relay.example.test",
      );
      expect(persistSession).toHaveBeenCalled();

      // Pairing metadata merged as before.
      expect(useSettingsStore.getState().remote.cloudEnabled).toBe(true);
      expect(useSettingsStore.getState().remote.cloudInstanceId).toBe("instance-2");
      expect(useSettingsStore.getState().remote.cloudTunnelUrl).toBe(
        "wss://relay.example.test/tunnel/instance-2",
      );
      expect(useSettingsStore.getState().remote.cloudServerBaseUrl).toBe(
        "https://relay.example.test",
      );
    });

    it("preserves other unsaved remote edits when committing relay on connect", async () => {
      // Regression guard: committing the relay must flush the WHOLE remote draft,
      // not just relayBaseUrl. A partial store update would trip useDraft's
      // store-change sync and discard a co-edited field (here: allowed IPs).
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      const relayInput = (await screen.findByTestId(
        "remote-settings-cloud-relay-base-url-input",
      )) as HTMLInputElement;
      const allowedIpsInput = screen.getByTestId(
        "remote-settings-allowed-ips-input",
      ) as HTMLTextAreaElement;
      fireEvent.change(relayInput, { target: { value: "https://draft-relay.example.test" } });
      fireEvent.change(allowedIpsInput, { target: { value: "10.0.0.0/8" } });

      await user.click(screen.getByTestId("remote-settings-cloud-connect"));

      await waitFor(() => {
        expect(screen.getByTestId("remote-settings-cloud-status")).toHaveTextContent(
          "Paired (waiting to connect)",
        );
      });

      // Both edits committed — the co-edited allowed IPs is not lost.
      expect(useSettingsStore.getState().remote.relayBaseUrl).toBe(
        "https://draft-relay.example.test",
      );
      expect(useSettingsStore.getState().remote.allowedIps).toEqual(["10.0.0.0/8"]);
    });

    it("reconciles Direct Remote runtime access when enabled is co-edited on connect", async () => {
      // Committing the remote draft on Connect must run the same runtime-access
      // reconciliation as Save, so a co-edited `enabled` toggle is not persisted
      // without updating the runtime daemon state.
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      await user.click(await screen.findByTestId("remote-settings-enabled-toggle"));
      const relayInput = screen.getByTestId(
        "remote-settings-cloud-relay-base-url-input",
      ) as HTMLInputElement;
      fireEvent.change(relayInput, { target: { value: "https://draft-relay.example.test" } });

      await user.click(screen.getByTestId("remote-settings-cloud-connect"));

      await waitFor(() => {
        expect(screen.getByTestId("remote-settings-cloud-status")).toHaveTextContent(
          "Paired (waiting to connect)",
        );
      });

      expect(useSettingsStore.getState().remote.enabled).toBe(true);
      expect(useSettingsStore.getState().remote.relayBaseUrl).toBe(
        "https://draft-relay.example.test",
      );
      // Reconcile ran (enabled false→true triggers a runtime-access sync).
      expect(mockInvoke).toHaveBeenCalledWith("set_remote_runtime_access", expect.anything());
    });

    it("does not persist relay on connect when the draft is unchanged", async () => {
      // No-op guard: an unedited relay must not trigger a settings write on Connect.
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      await user.click(screen.getByTestId("remote-settings-cloud-connect"));

      await waitFor(() => {
        expect(screen.getByTestId("remote-settings-cloud-status")).toHaveTextContent(
          "Paired (waiting to connect)",
        );
      });

      expect(persistSession).not.toHaveBeenCalled();
    });

    it("preserves a relay draft edited DURING the pending cloud connect await", async () => {
      // Regression: handleCloudConnect must branch on the draft-dirty state at
      // completion time, not the value captured when the button was clicked. If
      // the draft was clean at click but the user edits it during the long OAuth
      // await, resolving must not clobber that edit via a stale-closure setRemote.
      let resolveConnect: (value: typeof mockCloudStatus) => void = () => {};
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "list_system_monospace_fonts") {
          return Promise.resolve(["Cascadia Mono", "Fira Code", "Consolas"]);
        }
        if (cmd === "get_remote_host_candidates") {
          return Promise.resolve([
            { kind: "loopback", host: "127.0.0.1", label: "Localhost 127.0.0.1" },
          ]);
        }
        if (cmd === "get_remote_access_status") {
          return Promise.resolve(remoteAccessStatus());
        }
        if (cmd === "get_cloud_status") {
          return Promise.resolve({ connected: false, instanceId: null, lastError: null });
        }
        if (cmd === "cloud_connect_start") {
          return new Promise((resolve) => {
            resolveConnect = resolve;
          });
        }
        if (cmd === "load_settings") {
          return Promise.resolve({
            remote: {
              ...useSettingsStore.getState().remote,
              cloudEnabled: true,
              cloudInstanceId: "instance-2",
              cloudTunnelUrl: "wss://relay.example.test/tunnel/instance-2",
              cloudServerBaseUrl: "https://relay.example.test",
            },
          });
        }
        return Promise.resolve(undefined);
      });
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      // Draft is clean at click time.
      await user.click(await screen.findByTestId("remote-settings-cloud-connect"));

      // Edit the relay draft WHILE the connect promise is still pending.
      const relayInput = (await screen.findByTestId(
        "remote-settings-cloud-relay-base-url-input",
      )) as HTMLInputElement;
      fireEvent.change(relayInput, { target: { value: " https://mid-flight.example.test " } });

      await act(async () => {
        resolveConnect({ connected: false, instanceId: "instance-2", lastError: null });
      });

      await waitFor(() => {
        expect(screen.getByTestId("remote-settings-cloud-status")).toHaveTextContent(
          "Paired (waiting to connect)",
        );
      });
      // Mid-flight edit survives; store was not clobbered by a stale-closure sync.
      expect(relayInput.value).toBe(" https://mid-flight.example.test ");
      expect(useSettingsStore.getState().remote.relayBaseUrl).toBe("https://app.laymux.com");

      await user.click(screen.getByTestId("save-settings-btn"));

      expect(useSettingsStore.getState().remote.relayBaseUrl).toBe(
        "https://mid-flight.example.test",
      );
      expect(useSettingsStore.getState().remote.cloudInstanceId).toBe("instance-2");
    });

    it("preserves unsaved remote draft edits when cloud disconnect updates cloud fields", async () => {
      mockCloudStatus = { connected: false, instanceId: null, lastError: null };
      useSettingsStore.getState().setRemote({
        cloudEnabled: true,
        cloudInstanceId: "instance-1",
      });
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(screen.getByTestId("nav-remote"));
      const relayInput = (await screen.findByTestId(
        "remote-settings-cloud-relay-base-url-input",
      )) as HTMLInputElement;
      fireEvent.change(relayInput, { target: { value: " https://draft-relay.example.test " } });

      await user.click(screen.getByTestId("remote-settings-cloud-disconnect"));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("cloud_disconnect");
      });
      expect(relayInput.value).toBe(" https://draft-relay.example.test ");
      expect(useSettingsStore.getState().remote.relayBaseUrl).toBe("https://app.laymux.com");
      expect(useSettingsStore.getState().remote.cloudEnabled).toBe(true);

      await user.click(screen.getByTestId("save-settings-btn"));

      expect(useSettingsStore.getState().remote.relayBaseUrl).toBe(
        "https://draft-relay.example.test",
      );
      expect(useSettingsStore.getState().remote.cloudEnabled).toBe(false);
      expect(useSettingsStore.getState().remote.cloudInstanceId).toBeNull();
    });
  });

  describe("WorkspaceDisplaySection", () => {
    it("renders all workspace display toggles", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);
      await user.click(screen.getByTestId("nav-workspaceDisplay"));

      expect(screen.getByTestId("ws-display-minimap-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("ws-display-environment-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("ws-display-activity-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("ws-display-path-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("ws-display-result-toggle")).toBeInTheDocument();
    });

    it("all toggles default to checked", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);
      await user.click(screen.getByTestId("nav-workspaceDisplay"));

      const minimap = screen.getByTestId("ws-display-minimap-toggle") as HTMLInputElement;
      const env = screen.getByTestId("ws-display-environment-toggle") as HTMLInputElement;
      expect(minimap.checked).toBe(true);
      expect(env.checked).toBe(true);
    });

    it("toggling a checkbox and saving updates store", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);
      await user.click(screen.getByTestId("nav-workspaceDisplay"));

      const minimap = screen.getByTestId("ws-display-minimap-toggle");
      await user.click(minimap);
      expect((minimap as HTMLInputElement).checked).toBe(false);

      await user.click(screen.getByTestId("save-settings-btn"));
      expect(useSettingsStore.getState().workspaceSelector.display.minimap).toBe(false);
      expect(useSettingsStore.getState().workspaceSelector.display.environment).toBe(true);
    });

    it("renders default CWD propagation toggles", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);
      await user.click(screen.getByTestId("nav-workspaceDisplay"));

      expect(screen.getByTestId("sync-cwd-workspace-send-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("sync-cwd-workspace-receive-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("sync-cwd-dock-send-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("sync-cwd-dock-receive-toggle")).toBeInTheDocument();
    });

    it("default CWD propagation toggles use current defaults", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);
      await user.click(screen.getByTestId("nav-workspaceDisplay"));

      expect(
        (screen.getByTestId("sync-cwd-workspace-send-toggle") as HTMLInputElement).checked,
      ).toBe(false);
      expect(
        (screen.getByTestId("sync-cwd-workspace-receive-toggle") as HTMLInputElement).checked,
      ).toBe(true);
      expect((screen.getByTestId("sync-cwd-dock-send-toggle") as HTMLInputElement).checked).toBe(
        false,
      );
      expect((screen.getByTestId("sync-cwd-dock-receive-toggle") as HTMLInputElement).checked).toBe(
        true,
      );
    });

    it("does NOT update default CWD propagation in store until Save", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);
      await user.click(screen.getByTestId("nav-workspaceDisplay"));

      await user.click(screen.getByTestId("sync-cwd-workspace-send-toggle"));
      await user.click(screen.getByTestId("sync-cwd-dock-receive-toggle"));

      expect(useSettingsStore.getState().syncCwdDefaults.workspace.send).toBe(false);
      expect(useSettingsStore.getState().syncCwdDefaults.dock.receive).toBe(true);
    });

    it("saving default CWD propagation toggles updates store", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);
      await user.click(screen.getByTestId("nav-workspaceDisplay"));

      await user.click(screen.getByTestId("sync-cwd-workspace-send-toggle"));
      await user.click(screen.getByTestId("sync-cwd-dock-receive-toggle"));
      await user.click(screen.getByTestId("save-settings-btn"));

      expect(useSettingsStore.getState().syncCwdDefaults.workspace).toEqual({
        send: true,
        receive: true,
      });
      expect(useSettingsStore.getState().syncCwdDefaults.dock).toEqual({
        send: false,
        receive: false,
      });
    });
  });
});
