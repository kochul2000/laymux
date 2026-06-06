import { render, screen, waitFor, within } from "@testing-library/react";
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

/**
 * Install a ResizeObserver stub that reports a fixed content-box size, so the
 * size-adaptive behavior (#298) can be exercised in jsdom. Returns a restore fn.
 */
function mockResizeObserverSize(width: number, height: number): () => void {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element) {
      setTimeout(() => {
        this.cb(
          [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }, 0);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = original;
  };
}

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

  it("supports keyboard number shortcuts when focused", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<EmptyView onSelectView={onSelect} isFocused={true} />);

    // Press "1" - should select first option (first terminal profile)
    await user.keyboard("1");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: "TerminalView" }));
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
    expect(screen.getByTestId("empty-view-memo")).toBeInTheDocument();
  });

  it("shows shortcut number badges on each option", () => {
    render(<EmptyView />);
    // Should have number badges (1, 2, etc.)
    const profiles = useSettingsStore.getState().profiles.filter((p) => !p.hidden);
    // profiles + memo = total options
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

  it("shows memo option button", () => {
    render(<EmptyView />);
    expect(screen.getByTestId("empty-view-memo")).toBeInTheDocument();
  });

  it("calls onSelectView with MemoView when memo clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<EmptyView onSelectView={onSelect} />);

    await user.click(screen.getByTestId("empty-view-memo"));
    expect(onSelect).toHaveBeenCalledWith({ type: "MemoView" });
  });

  it("hides the guidance header when the pane is too short (issue #298)", async () => {
    // Report a content-box height below the compact threshold so the header drops.
    const restore = mockResizeObserverSize(400, 100);
    try {
      render(<EmptyView />);
      // Option list stays visible — only the guidance is dropped.
      expect(screen.getByTestId("empty-view-memo")).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByText("Select a view")).not.toBeInTheDocument();
        expect(screen.queryByText(/Press number key to quick-select/)).not.toBeInTheDocument();
      });
    } finally {
      restore();
    }
  });

  it("drops card chrome and hint when the pane is too narrow (issue #298)", async () => {
    // Narrow but tall: cards shed their category tag + drag handle and the
    // header hint is hidden, but the title and the option list stay visible.
    const restore = mockResizeObserverSize(120, 600);
    try {
      render(<EmptyView />);
      expect(screen.getByTestId("empty-view-memo")).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryAllByText("⠿")).toHaveLength(0);
        expect(screen.queryByText(/Press number key to quick-select/)).not.toBeInTheDocument();
      });
      // Title still shown because the pane is tall enough.
      expect(screen.getByText("Select a view")).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("gives each option label min-w-0 so truncate works on the flex child (issue #298)", () => {
    // jsdom does not lay out, so guard the class contract instead: a flex child
    // needs min-w-0 for `truncate` to clip rather than overflow the card.
    render(<EmptyView />);
    const button = screen.getByTestId("empty-view-memo");
    const label = within(button).getByText("Memo");
    expect(label.className).toContain("min-w-0");
    expect(label.className).toContain("truncate");
  });

  it("does not clip top content when overflowing (issue #298)", () => {
    // The scroll container must NOT use justify-center: combined with
    // overflow-y-auto it pushes the top of tall content above the scroll
    // origin, making the first items unreachable. Centering is done by an
    // inner my-auto wrapper that collapses to 0 on overflow instead.
    render(<EmptyView />);
    const container = screen.getByTestId("empty-view");
    expect(container.className).not.toContain("justify-center");
    expect(container.className).toContain("overflow-y-auto");

    // Header and options live inside a my-auto wrapper.
    const header = screen.getByText("Select a view");
    const wrapper = header.closest(".my-auto");
    expect(wrapper).not.toBeNull();
    expect(wrapper).toContainElement(screen.getByTestId("empty-view-memo"));
  });

  it("respects stored viewOrder", () => {
    // Set custom order: memo first
    useSettingsStore.setState({ viewOrder: ["memo", "settings", "ws-selector"] });
    render(<EmptyView />);

    const buttons = screen.getAllByRole("button");
    // First clickable button should be Memo
    const labels = buttons.map((b) => b.textContent);
    const memoIdx = labels.findIndex((l) => l?.includes("Memo"));
    const wslIdx = labels.findIndex((l) => l?.includes("WSL"));
    // Memo should come before WSL since it's first in custom order
    expect(memoIdx).toBeLessThan(wslIdx);
  });
});
