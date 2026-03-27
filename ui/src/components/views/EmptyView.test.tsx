import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EmptyView } from "./EmptyView";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tauri-api", () => ({
  getListeningPorts: vi.fn().mockResolvedValue([]),
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
  getGitBranch: vi.fn().mockResolvedValue(null),
  sendOsNotification: vi.fn().mockResolvedValue(undefined),
}));

describe("EmptyView", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  it("renders with header", () => {
    render(<EmptyView />);
    expect(screen.getByTestId("empty-view")).toBeInTheDocument();
    expect(screen.getByText("Select a view")).toBeInTheDocument();
  });

  it("shows keyboard hint text", () => {
    render(<EmptyView />);
    expect(screen.getByText(/Press number key to quick-select/)).toBeInTheDocument();
  });

  it("shows terminal profile buttons", () => {
    render(<EmptyView />);
    // Default profiles from settings store initial state
    const profiles = useSettingsStore.getState().profiles.filter((p) => !p.hidden);
    for (const p of profiles) {
      expect(screen.getByTestId(`empty-view-terminal-${p.name}`)).toBeInTheDocument();
    }
  });

  it("shows browser preview button", () => {
    render(<EmptyView />);
    expect(screen.getByTestId("empty-view-browser")).toBeInTheDocument();
  });

  it("calls onSelectView when terminal button clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<EmptyView onSelectView={onSelect} />);

    const profiles = useSettingsStore.getState().profiles.filter((p) => !p.hidden);
    if (profiles.length > 0) {
      await user.click(screen.getByTestId(`empty-view-terminal-${profiles[0].name}`));
      expect(onSelect).toHaveBeenCalledWith({ type: "TerminalView", profile: profiles[0].name });
    }
  });

  it("calls onSelectView when browser button clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<EmptyView onSelectView={onSelect} />);

    await user.click(screen.getByTestId("empty-view-browser"));
    expect(onSelect).toHaveBeenCalledWith({ type: "BrowserPreviewView" });
  });

  it("supports keyboard number shortcuts when focused", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<EmptyView onSelectView={onSelect} isFocused={true} />);

    // Press "1" - should select first option (first terminal profile)
    await user.keyboard("1");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TerminalView" }),
    );
  });

  it("grabs DOM focus when isFocused becomes true", () => {
    render(<EmptyView isFocused={true} />);
    const wrapper = screen.getByTestId("empty-view");
    expect(document.activeElement).toBe(wrapper);
  });

  it("shows all views including dock views in any context", () => {
    render(<EmptyView context="pane" />);
    expect(screen.getByTestId("empty-view-workspace-selector")).toBeInTheDocument();
    expect(screen.getByTestId("empty-view-settings")).toBeInTheDocument();
    expect(screen.getByTestId("empty-view-browser")).toBeInTheDocument();
  });

  it("shows shortcut number badges on each option", () => {
    render(<EmptyView />);
    // Should have number badges (1, 2, etc.)
    const profiles = useSettingsStore.getState().profiles.filter((p) => !p.hidden);
    // profiles + browser = total options
    const totalOptions = profiles.length + 1;
    for (let i = 1; i <= totalOptions && i <= 9; i++) {
      expect(screen.getByText(String(i))).toBeInTheDocument();
    }
  });

  it("shows drag hint text", () => {
    render(<EmptyView />);
    expect(screen.getByText(/Drag to reorder/)).toBeInTheDocument();
  });

  it("shows drag handle on each card", () => {
    render(<EmptyView />);
    // Each card has a ⠿ drag handle
    const handles = screen.getAllByText("⠿");
    expect(handles.length).toBeGreaterThan(0);
  });

  it("respects stored viewOrder", () => {
    // Set custom order: browser first
    useSettingsStore.setState({ viewOrder: ["browser", "settings", "ws-selector"] });
    render(<EmptyView />);

    const buttons = screen.getAllByRole("button");
    // First clickable button should be Browser Preview
    const labels = buttons.map((b) => b.textContent);
    const browserIdx = labels.findIndex((l) => l?.includes("Browser Preview"));
    const wslIdx = labels.findIndex((l) => l?.includes("WSL"));
    // Browser should come before WSL since it's first in custom order
    expect(browserIdx).toBeLessThan(wslIdx);
  });
});
