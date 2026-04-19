import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: vi.fn().mockResolvedValue(undefined),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  loadSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

import { PaneControlBar } from "./PaneControlBar";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { useSettingsStore } from "@/stores/settings-store";
import { useOverridesStore } from "@/stores/overrides-store";

/**
 * PaneControlBar + ViewHeader 통합 테스트.
 * ViewHeader가 children 내부에 있을 때 PaneControlBar의 자체 바가 숨겨지고,
 * ViewHeader에 pane 제어가 통합되는지 검증한다.
 */
describe("PaneControlBar + ViewHeader integration", () => {
  const defaultView = { type: "TerminalView" as const, profile: "PowerShell" };
  const defaultActions = {
    onSplitH: vi.fn(),
    onSplitV: vi.fn(),
    onClear: vi.fn(),
    onChangeView: vi.fn(),
  };

  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    localStorage.clear();
    // 기존 테스트는 hover를 기본 모드로 가정
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "hover" },
    }));
    vi.clearAllMocks();
  });

  it("suppresses PaneControlBar own bar when ViewHeader exists (pinned mode)", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <ViewHeader testId="view-header">My View</ViewHeader>
        <div>body</div>
      </PaneControlBar>,
    );
    // Pin the control bar
    await user.click(screen.getByTestId("pane-control-pin"));
    // PaneControlBar의 자체 pinned 바는 숨겨져야 함
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
    // ViewHeader 내부에 pane 제어가 표시됨
    expect(screen.getByTestId("pane-control-bar-content")).toBeInTheDocument();
    // View 콘텐츠도 표시됨
    expect(screen.getByText("My View")).toBeInTheDocument();
  });

  it("shows pane controls in ViewHeader on hover", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <ViewHeader testId="view-header">Title</ViewHeader>
        <div>body</div>
      </PaneControlBar>,
    );
    // hover 모드 + hovered=true → ViewHeader에 pane 제어 표시
    expect(screen.getByTestId("pane-control-bar-content")).toBeInTheDocument();
    // PaneControlBar 자체 hover overlay는 없음
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
  });

  it("hides pane controls in ViewHeader when not hovered", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <ViewHeader testId="view-header">Title</ViewHeader>
        <div>body</div>
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-control-bar-content")).not.toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
  });

  it("shows minimized button in ViewHeader when minimized + hovered", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <ViewHeader testId="view-header">Title</ViewHeader>
        <div>body</div>
      </PaneControlBar>,
    );
    // Minimize: click minimize button from hover bar controls
    await user.click(screen.getByTestId("pane-control-minimize"));
    // ViewHeader 안에 ⋯ 버튼이 표시됨
    expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument();
    // PaneControlBar 자체 MinimizedButton은 없음 (ViewHeader가 대신 처리)
    expect(screen.getByText("Title")).toBeInTheDocument();
  });

  it("without ViewHeader, PaneControlBar works as before", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>no header view</div>
      </PaneControlBar>,
    );
    // 기존 동작: hover 모드 자체 바 표시
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();
  });

  it("pane control buttons in ViewHeader are functional", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <ViewHeader>Title</ViewHeader>
        <div>body</div>
      </PaneControlBar>,
    );
    // ViewHeader 내부의 split 버튼 클릭
    await user.click(screen.getByTestId("pane-control-split-h"));
    expect(defaultActions.onSplitH).toHaveBeenCalled();
  });
});
