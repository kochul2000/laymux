import { render, screen, within, fireEvent, act } from "@testing-library/react";
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

  it("displays Startup section", () => {
    render(<SettingsView />);
    expect(screen.getAllByText("Startup").length).toBeGreaterThanOrEqual(1);
  });

  it("shows font settings in Profile Defaults", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByTestId("nav-profile-defaults"));
    expect(screen.getByText("Font")).toBeInTheDocument();
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

  it("profile Additional Settings tab shows Font, Appearance and Advanced fields", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await navigateToProfile(user, "PowerShell");

    const tabBar = screen.getByTestId("profile-tabs");
    await user.click(within(tabBar).getByText("Additional Settings"));

    // Font fields
    expect(screen.getByText("Font")).toBeInTheDocument();
    expect(screen.getByTestId("font-face-input")).toBeInTheDocument();
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

  it("shows Defaults page with Appearance and Advanced sections", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-profile-defaults"));
    expect(screen.getByText("Profile Defaults")).toBeInTheDocument();
    // Content area has Appearance heading (h4) and Advanced heading (h4)
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

  // -- Scrollbar style --

  it("shows scrollbar style select in convenience section", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    expect(screen.getByTestId("scrollbar-style-select")).toBeInTheDocument();
  });

  it("scrollbar style select updates store", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByTestId("nav-convenience"));
    const select = screen.getByTestId("scrollbar-style-select") as HTMLSelectElement;
    await user.selectOptions(select, "separate");
    expect(useSettingsStore.getState().convenience.scrollbarStyle).toBe("separate");
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

      await user.click(screen.getByTestId("nav-convenience"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      await user.click(toggle);
      expect(toggle.checked).toBe(false);

      // ConvenienceSection이 구독하는 store 상태 변경으로 재렌더 유발
      act(() => {
        const state = useSettingsStore.getState();
        useSettingsStore.setState({
          convenience: { ...state.convenience },
        });
      });

      // 재렌더 후 draft 보존 + Save 정상 동작
      await user.click(screen.getByTestId("save-settings-btn"));
      expect(useSettingsStore.getState().convenience.smartPaste).toBe(false);
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
      await user.click(screen.getByTestId("nav-convenience"));

      // Save → DefaultsSection의 flush 콜백이 cleanup으로 삭제됨
      await user.click(screen.getByTestId("save-settings-btn"));

      // BUG: font face 변경이 유실됨
      expect(useSettingsStore.getState().profileDefaults.font.face).toBe("Fira Code");
    });

    it("ConvenienceSection에서 변경 → 다른 섹션 이동 → Save 시 변경 유실", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // ConvenienceSection으로 이동 후 smart paste 토글
      await user.click(screen.getByTestId("nav-convenience"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      await user.click(toggle);
      expect(toggle.checked).toBe(false);

      // Claude 섹션으로 이동 → ConvenienceSection 언마운트
      await user.click(screen.getByTestId("nav-claude"));

      // Save
      await user.click(screen.getByTestId("save-settings-btn"));

      // BUG: smart paste 변경이 유실됨
      expect(useSettingsStore.getState().convenience.smartPaste).toBe(false);
    });

    it("여러 섹션에서 순차 변경 → Save 시 마지막 섹션만 반영됨", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // 1. DefaultsSection: font 변경
      await user.click(screen.getByTestId("nav-profile-defaults"));
      const fontSelect = screen.getByTestId("font-face-input") as HTMLSelectElement;
      await user.selectOptions(fontSelect, "Fira Code");

      // 2. ConvenienceSection: smart paste 변경
      await user.click(screen.getByTestId("nav-convenience"));
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
      expect(state.convenience.smartPaste).toBe(false);
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
      await user.click(screen.getByTestId("nav-convenience"));

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
      await user.click(screen.getByTestId("nav-convenience"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      expect(toggle.checked).toBe(true); // 기본값

      // 외부에서 store 변경 (settings.json 핫 리로드 시뮬레이션)
      act(() => {
        useSettingsStore.setState({
          convenience: { ...useSettingsStore.getState().convenience, smartPaste: false },
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
      await user.click(screen.getByTestId("nav-convenience"));
      const toggle = screen.getByTestId("smart-paste-toggle") as HTMLInputElement;
      await user.click(toggle);
      const saveBtn = screen.getByTestId("save-settings-btn");
      expect(saveBtn).not.toBeDisabled(); // dirty 상태

      // 외부에서 store 변경 → draft 리셋 → dirty 클리어
      act(() => {
        useSettingsStore.setState({
          convenience: { ...useSettingsStore.getState().convenience, smartPaste: false },
        });
      });

      // Save 버튼이 비활성화되어야 함 (dirty 클리어)
      expect(saveBtn).toBeDisabled();
    });

    it("사용자가 A 필드 수정 중 + B 필드만 외부 변경 → A의 dirty 상태 유지", async () => {
      const user = userEvent.setup();
      render(<SettingsView />);

      // A 필드 수정: convenience 섹션의 smartPaste 토글
      await user.click(screen.getByTestId("nav-convenience"));
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
        useSettingsStore.setState({ appThemeId: "dracula" });
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
      expect(useSettingsStore.getState().workspaceDisplay.minimap).toBe(false);
      expect(useSettingsStore.getState().workspaceDisplay.environment).toBe(true);
    });
  });
});
