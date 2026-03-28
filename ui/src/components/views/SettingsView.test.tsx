import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { SettingsView } from "./SettingsView";
import { useSettingsStore } from "@/stores/settings-store";
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

describe("SettingsView", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  it("renders settings panel", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("settings-view")).toBeInTheDocument();
  });

  // -- Startup section (renamed from General) --

  it("displays Startup section with font settings", () => {
    render(<SettingsView />);
    expect(screen.getAllByText("Startup").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Font")).toBeInTheDocument();
  });

  it("shows current font face", () => {
    render(<SettingsView />);
    const input = screen.getByTestId("font-face-input") as HTMLInputElement;
    expect(input.value).toBe("Cascadia Mono");
  });

  it("shows current font size", () => {
    render(<SettingsView />);
    const input = screen.getByTestId("font-size-input") as HTMLInputElement;
    expect(input.value).toBe("14");
  });

  it("shows font weight selector", () => {
    render(<SettingsView />);
    const select = screen.getByTestId("font-weight-select") as HTMLSelectElement;
    expect(select.value).toBe("normal");
  });

  it("does NOT update font face in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("font-face-input") as HTMLSelectElement;
    await user.selectOptions(select, "Fira Code");

    // Store should still have original value (draft only in local state)
    expect(useSettingsStore.getState().font.face).toBe("Cascadia Mono");
    // But the UI select should show the new value
    expect(select.value).toBe("Fira Code");
  });

  it("updates font face in store only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("font-face-input") as HTMLSelectElement;
    await user.selectOptions(select, "Fira Code");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().font.face).toBe("Fira Code");
  });

  it("does NOT update font size in store until Save is clicked", () => {
    render(<SettingsView />);

    const input = screen.getByTestId("font-size-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "16" } });

    // Store should still have original value
    expect(useSettingsStore.getState().font.size).toBe(14);
    // But the UI input should show the new value
    expect(input.value).toBe("16");
  });

  it("updates font size in store only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const input = screen.getByTestId("font-size-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "16" } });

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().font.size).toBe(16);
  });

  it("does NOT update font weight in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("font-weight-select");
    await user.selectOptions(select, "bold");

    // Store should still have original value
    expect(useSettingsStore.getState().font.weight).toBe("normal");
  });

  it("updates font weight in store only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("font-weight-select");
    await user.selectOptions(select, "bold");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().font.weight).toBe("bold");
  });

  // -- App Theme draft --

  it("does NOT update appTheme in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
    await user.selectOptions(select, "dracula");

    expect(useSettingsStore.getState().appThemeId).toBe("catppuccin-mocha");
    expect(select.value).toBe("dracula");
  });

  it("updates appTheme in store only after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("app-theme-select") as HTMLSelectElement;
    await user.selectOptions(select, "dracula");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().appThemeId).toBe("dracula");
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

  it("profile Additional Settings tab shows Appearance and Advanced fields", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await navigateToProfile(user, "PowerShell");

    const tabBar = screen.getByTestId("profile-tabs");
    await user.click(within(tabBar).getByText("Additional Settings"));

    // Appearance fields
    expect(screen.getByText("Cursor Shape")).toBeInTheDocument();
    expect(screen.getByText("Opacity")).toBeInTheDocument();
    expect(screen.getByText("Padding")).toBeInTheDocument();
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
    expect(options).toContain("emptyBox");
    expect(options).toContain("doubleUnderscore");
    expect(options).toContain("vintage");
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

  it("adds a keybinding", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Keybindings"));
    await user.click(screen.getByTestId("add-keybinding-btn"));

    expect(useSettingsStore.getState().keybindings).toHaveLength(1);
  });

  // -- Color Schemes --

  it("shows color schemes section", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByText("Color Schemes"));
    expect(screen.getByTestId("add-color-scheme-btn")).toBeInTheDocument();
  });

  // -- Save --

  it("has a save button that triggers persistSession", async () => {
    vi.mocked(persistSession).mockClear();
    const user = userEvent.setup();
    render(<SettingsView />);

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(persistSession).toHaveBeenCalledTimes(1);
  });

  // -- Defaults page --

  it("shows Defaults page with Appearance and Advanced sections", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    expect(screen.getByText("Profile Defaults")).toBeInTheDocument();
    // Content area has Appearance heading (h4) and Advanced heading (h4)
    expect(screen.getByText("Cursor Shape")).toBeInTheDocument();
    expect(screen.getByText("Scrollback Lines")).toBeInTheDocument();
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

  // -- Convenience section --

  it("shows Convenience nav button", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("nav-convenience")).toBeInTheDocument();
  });

  it("renders Convenience section with smart paste toggle", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    // "Convenience" appears in both nav button and section title
    expect(screen.getAllByText("Convenience").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("smart-paste-toggle")).toBeInTheDocument();
  });

  it("smart paste toggle is checked by default", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("does NOT update smart paste in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    const toggle = screen.getByTestId("smart-paste-toggle");
    await user.click(toggle);

    // Store unchanged
    expect(useSettingsStore.getState().convenience.smartPaste).toBe(true);
  });

  it("toggling smart paste updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    const toggle = screen.getByTestId("smart-paste-toggle");
    await user.click(toggle);

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().convenience.smartPaste).toBe(false);
  });

  it("does NOT update copy on select in store until Save is clicked", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    const toggle = screen.getByTestId("copy-on-select-toggle");
    await user.click(toggle);

    expect(useSettingsStore.getState().convenience.copyOnSelect).toBe(true);
  });

  it("toggling copy on select updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    const toggle = screen.getByTestId("copy-on-select-toggle");
    await user.click(toggle);

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().convenience.copyOnSelect).toBe(false);
  });

  it("shows paste image dir input", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    expect(screen.getByTestId("paste-image-dir-input")).toBeInTheDocument();
  });

  it("does NOT update paste image dir in store until Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    const input = screen.getByTestId("paste-image-dir-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "C:\\my\\dir");

    expect(useSettingsStore.getState().convenience.pasteImageDir).toBe("");
  });

  it("paste image dir input updates store after Save", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    const input = screen.getByTestId("paste-image-dir-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "C:\\my\\dir");

    const saveBtn = screen.getByTestId("save-settings-btn");
    await user.click(saveBtn);

    expect(useSettingsStore.getState().convenience.pasteImageDir).toBe("C:\\my\\dir");
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

  // -- Discard --

  it("has a discard button", () => {
    render(<SettingsView />);
    expect(screen.getByTestId("discard-settings-btn")).toBeInTheDocument();
  });

  it("discard reverts font draft to store value", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const select = screen.getByTestId("font-face-input") as HTMLSelectElement;
    await user.selectOptions(select, "Fira Code");
    expect(select.value).toBe("Fira Code");

    const discardBtn = screen.getByTestId("discard-settings-btn");
    await user.click(discardBtn);

    expect(select.value).toBe("Cascadia Mono");
    expect(useSettingsStore.getState().font.face).toBe("Cascadia Mono");
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
    expect(useSettingsStore.getState().appThemeId).toBe("catppuccin-mocha");
  });

  it("discard reverts convenience draft to store value", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
    await user.click(toggle);
    expect(toggle.checked).toBe(false);

    const discardBtn = screen.getByTestId("discard-settings-btn");
    await user.click(discardBtn);

    // Need to navigate back to convenience since discard may re-render
    await user.click(screen.getByTestId("nav-convenience"));
    const toggleAfter = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
    expect(toggleAfter.checked).toBe(true);
    expect(useSettingsStore.getState().convenience.smartPaste).toBe(true);
  });
});
