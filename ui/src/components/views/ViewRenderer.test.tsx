import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: vi.fn().mockResolvedValue({}),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  getSyncGroupTerminals: vi.fn().mockResolvedValue([]),
  handleLxMessage: vi.fn().mockResolvedValue({}),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onSyncCwd: vi.fn().mockResolvedValue(() => {}),
  onSyncBranch: vi.fn().mockResolvedValue(() => {}),
  onLxNotify: vi.fn().mockResolvedValue(() => {}),
  onSetTabTitle: vi.fn().mockResolvedValue(() => {}),
  getListeningPorts: vi.fn().mockResolvedValue([]),
  getGitBranch: vi.fn().mockResolvedValue(null),
  sendOsNotification: vi.fn().mockResolvedValue(undefined),
  loadSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  loadMemo: vi.fn().mockResolvedValue(""),
  saveMemo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

// Mock TerminalView to capture props
const terminalViewProps: {
  syncGroup?: string;
  profile?: string;
  instanceId?: string;
  restartCwd?: string;
  restartCwdSourceProfile?: string;
  isUserRestart?: boolean;
  restoreSessionOnRestart?: boolean;
  onRestart?: () => void;
}[] = [];
vi.mock("./TerminalView", () => ({
  TerminalView: (props: {
    instanceId: string;
    profile: string;
    syncGroup: string;
    restartCwd?: string;
    restartCwdSourceProfile?: string;
    isUserRestart?: boolean;
    restoreSessionOnRestart?: boolean;
    onRestart?: () => void;
  }) => {
    terminalViewProps.push({
      syncGroup: props.syncGroup,
      profile: props.profile,
      instanceId: props.instanceId,
      restartCwd: props.restartCwd,
      restartCwdSourceProfile: props.restartCwdSourceProfile,
      isUserRestart: props.isUserRestart,
      restoreSessionOnRestart: props.restoreSessionOnRestart,
      onRestart: props.onRestart,
    });
    return (
      <div
        data-testid="mock-terminal"
        data-syncgroup={props.syncGroup}
        data-profile={props.profile}
        data-instanceid={props.instanceId}
      />
    );
  },
}));

// Mock FileExplorerView to capture props
const fileExplorerProps: { cwdSend?: boolean; cwdReceive?: boolean; syncGroup?: string }[] = [];
vi.mock("./FileExplorerView", () => ({
  FileExplorerView: (props: {
    instanceId: string;
    cwdSend?: boolean;
    cwdReceive?: boolean;
    syncGroup: string;
  }) => {
    fileExplorerProps.push({
      cwdSend: props.cwdSend,
      cwdReceive: props.cwdReceive,
      syncGroup: props.syncGroup,
    });
    return (
      <div
        data-testid="mock-file-explorer"
        data-cwdsend={String(props.cwdSend)}
        data-cwdreceive={String(props.cwdReceive)}
      />
    );
  },
}));

// Mock GitHubView to capture props
const githubProps: { instanceId?: string; cwdReceive?: boolean; syncGroup?: string }[] = [];
vi.mock("./GitHubView", () => ({
  GitHubView: (props: { instanceId: string; cwdReceive?: boolean; syncGroup: string }) => {
    githubProps.push({
      instanceId: props.instanceId,
      cwdReceive: props.cwdReceive,
      syncGroup: props.syncGroup,
    });
    return <div data-testid="mock-github" data-cwdreceive={String(props.cwdReceive)} />;
  },
}));

import { ViewRenderer } from "./ViewRenderer";
vi.mock("./WorktreeView", () => ({
  WorktreeView: () => {
    const [selected, select] = useState(false);
    return <button onClick={() => select(true)}>{selected ? "선택 유지" : "항목 선택"}</button>;
  },
}));
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { makeSlot } from "@/lib/pane-layers";
import type { ViewInstanceConfig } from "@/stores/types";

describe("ViewRenderer", () => {
  it("dock workspace 그룹 변경만으로 Worktree 검토 맥락을 재마운트하지 않는다", () => {
    const props = {
      viewType: "WorktreeView" as const,
      viewConfig: { type: "WorktreeView" as const, cwdReceive: false },
      paneId: "dock",
      location: "dock" as const,
    };
    const view = render(<ViewRenderer {...props} workspaceId="first" />);
    fireEvent.click(screen.getByRole("button", { name: "항목 선택" }));
    view.rerender(<ViewRenderer {...props} workspaceId="second" />);
    expect(screen.getByRole("button", { name: "선택 유지" })).toBeInTheDocument();
  });
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    terminalViewProps.length = 0;
    fileExplorerProps.length = 0;
    githubProps.length = 0;
  });

  describe.each(["TerminalView", "FileExplorerView"] as const)(
    "%s sync groups across workspace and stack operations",
    (viewType) => {
      it.each(["split", "stack"])(
        "$operation creates content in the workspace default group",
        (operation) => {
          const store = useWorkspaceStore.getState();
          store.setPaneView(0, { type: viewType, syncGroup: "shared-dev" });
          let paneIndex = 0;
          if (operation === "split") {
            store.splitPane(0, "vertical");
            paneIndex = 1;
          } else {
            store.stackPane(0);
          }
          store.setPaneView(paneIndex, { type: viewType });
          const workspace = useWorkspaceStore.getState().getActiveWorkspace()!;
          const slot = workspace.panes[paneIndex];
          const layer = slot.layers.find((item) => item.id === slot.activeLayerId)!;
          render(
            <ViewRenderer
              viewType={viewType}
              viewConfig={layer.view}
              workspaceId={workspace.id}
              paneId={layer.id}
            />,
          );
          const props = viewType === "TerminalView" ? terminalViewProps : fileExplorerProps;
          expect(props.at(-1)?.syncGroup).toBe(workspace.id);
          expect(workspace.panes[0].layers[0].view.syncGroup).toBe("shared-dev");
        },
      );

      it.each(
        [undefined, "", "shared-dev", "none"].flatMap((syncGroup) =>
          ["move", "duplicate", "layout", "rename", "extract", "merge"].map((operation) => ({
            syncGroup,
            operation,
          })),
        ),
      )("$operation with configured group '$syncGroup'", ({ syncGroup, operation }) => {
        const view: ViewInstanceConfig = { type: viewType };
        if (syncGroup !== undefined) view.syncGroup = syncGroup;
        const sourcePane = makeSlot("source-pane", { x: 0, y: 0, w: 0.5, h: 1 }, view);
        useWorkspaceStore.setState({
          activeWorkspaceId: "source",
          workspaces: [
            {
              id: "source",
              name: "Source",
              panes: [
                sourcePane,
                makeSlot("source-spare", { x: 0.5, y: 0, w: 0.5, h: 1 }, { type: "MemoView" }),
              ],
            },
            {
              id: "target",
              name: "Target",
              panes: [makeSlot("target-pane", { x: 0, y: 0, w: 1, h: 1 }, { type: "MemoView" })],
            },
          ],
        });
        const store = useWorkspaceStore.getState();
        let ownerId = "source";
        let layerId = "source-pane";
        if (operation === "move") {
          // Moving a stacked pane must rehome every layer, including inactive ones.
          store.stackPane(0, { type: "MemoView" });
          store.movePaneToWorkspace(layerId, "target");
          ownerId = "target";
        } else if (operation === "duplicate") {
          const result = store.duplicateWorkspace("source")!;
          ownerId = result.newWorkspaceId;
          layerId = result.paneIdMap[layerId];
        } else if (operation === "layout") {
          store.exportAsNewLayout("Template");
          const layout = useWorkspaceStore.getState().layouts.at(-1)!;
          store.addWorkspace("From template", layout.id);
          const created = useWorkspaceStore.getState().workspaces.at(-1)!;
          ownerId = created.id;
          layerId = created.panes[0].layers[0].id;
        } else if (operation === "rename") {
          store.renameWorkspace("source", "Renamed");
        } else if (operation === "extract") {
          store.stackPane(0, { type: "MemoView" });
          expect(store.extractLayer(layerId, "vertical")).toBe(layerId);
        } else {
          expect(store.mergeSlotIntoStack("source-pane", "source-spare")).toBe(true);
        }
        const owner = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === ownerId)!;
        const layer = owner.panes
          .flatMap((pane) => pane.layers)
          .find((item) => item.id === layerId)!;
        render(
          <ViewRenderer
            viewType={viewType}
            viewConfig={layer.view}
            workspaceId={owner.id}
            workspaceName={owner.name}
            paneId={layer.id}
          />,
        );
        const props = viewType === "TerminalView" ? terminalViewProps : fileExplorerProps;
        expect(props.at(-1)?.syncGroup).toBe(syncGroup || owner.id);
        expect(layer.view.syncGroup).toBe(syncGroup);
        if (operation === "move" || operation === "extract" || operation === "merge") {
          expect(layer.id).toBe("source-pane");
        }
      });
    },
  );

  it("renders EmptyView for EmptyView type", () => {
    render(<ViewRenderer viewType="EmptyView" />);
    expect(screen.getByTestId("empty-view")).toBeInTheDocument();
  });

  it("passes syncGroup from viewConfig to TerminalView", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView", syncGroup: "MyGroup" }}
        workspaceName="Default"
      />,
    );
    expect(terminalViewProps.at(-1)?.syncGroup).toBe("MyGroup");
  });

  it("constrains the terminal wrapper to the pane width", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        workspaceName="Default"
      />,
    );

    expect(screen.getByTestId("view-terminal")).toHaveClass("w-full", "min-w-0", "overflow-hidden");
  });

  it("defaults syncGroup to workspaceId when syncGroup is empty", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView", syncGroup: "" }}
        workspaceName="ProjectA"
        workspaceId="ws-abc123"
      />,
    );
    expect(terminalViewProps.at(-1)?.syncGroup).toBe("ws-abc123");
  });

  it("defaults syncGroup to workspaceId when syncGroup is not specified", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        workspaceName="ProjectB"
        workspaceId="ws-def456"
      />,
    );
    expect(terminalViewProps.at(-1)?.syncGroup).toBe("ws-def456");
  });

  it("passes profile from viewConfig to TerminalView", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView", profile: "WSL" }}
      />,
    );
    expect(terminalViewProps.at(-1)?.profile).toBe("WSL");
  });

  it("defaults profile to settings defaultProfile when viewConfig has no profile", () => {
    useSettingsStore.setState({ defaultProfile: "WSL" });
    render(<ViewRenderer viewType="TerminalView" viewConfig={{ type: "TerminalView" }} />);
    expect(terminalViewProps.at(-1)?.profile).toBe("WSL");
  });

  it("defaults profile to settings defaultProfile when viewConfig is undefined", () => {
    useSettingsStore.setState({ defaultProfile: "WSL" });
    render(<ViewRenderer viewType="TerminalView" />);
    expect(terminalViewProps.at(-1)?.profile).toBe("WSL");
  });

  it("falls back to PowerShell when no profile and no defaultProfile set", () => {
    useSettingsStore.setState({ defaultProfile: "" });
    render(<ViewRenderer viewType="TerminalView" viewConfig={{ type: "TerminalView" }} />);
    expect(terminalViewProps.at(-1)?.profile).toBe("PowerShell");
  });

  it("renders MemoView with data-testid", () => {
    render(<ViewRenderer viewType="MemoView" viewConfig={{ type: "MemoView" }} paneId="pane-99" />);
    expect(screen.getByTestId("view-memo")).toBeInTheDocument();
    expect(screen.getByTestId("memo-textarea")).toBeInTheDocument();
  });

  it("MemoView does not use onSelectView", () => {
    const onSelectView = vi.fn();
    render(
      <ViewRenderer
        viewType="MemoView"
        viewConfig={{ type: "MemoView" }}
        paneId="pane-99"
        onSelectView={onSelectView}
      />,
    );
    expect(onSelectView).not.toHaveBeenCalled();
  });

  it("FileExplorerView defaults cwdSend off / cwdReceive on from syncCwdDefaults", () => {
    // 기본 syncCwdDefaults.dock = { send: false, receive: true } → send off, receive on
    render(
      <ViewRenderer
        viewType="FileExplorerView"
        viewConfig={{ type: "FileExplorerView" }}
        workspaceId="ws-1"
        paneId="dp-1"
        location="dock"
      />,
    );
    const last = fileExplorerProps.at(-1);
    expect(last?.cwdSend).toBe(false);
    expect(last?.cwdReceive).toBe(true);
  });

  it("FileExplorerView honors custom syncCwdDefaults.dock", () => {
    useSettingsStore.setState((s) => ({
      syncCwdDefaults: {
        ...s.syncCwdDefaults,
        dock: { send: true, receive: true },
      },
    }));
    render(
      <ViewRenderer
        viewType="FileExplorerView"
        viewConfig={{ type: "FileExplorerView" }}
        workspaceId="ws-1"
        paneId="pane-1"
        location="dock"
      />,
    );
    const last = fileExplorerProps.at(-1);
    expect(last?.cwdSend).toBe(true);
    expect(last?.cwdReceive).toBe(true);
  });

  it("FileExplorerView respects explicit cwdReceive=false in viewConfig", () => {
    render(
      <ViewRenderer
        viewType="FileExplorerView"
        viewConfig={{ type: "FileExplorerView", cwdReceive: false }}
        workspaceId="ws-1"
        paneId="dp-2"
        location="dock"
      />,
    );
    const last = fileExplorerProps.at(-1);
    expect(last?.cwdReceive).toBe(false);
  });

  it("renders GitHubView with a registered instanceId prefix (회귀: #708)", () => {
    // 등록되지 않은 view 타입이면 getInstanceId 가 렌더 중 throw 해 앱이 멈춘다.
    render(
      <ViewRenderer
        viewType="GitHubView"
        viewConfig={{ type: "GitHubView" }}
        workspaceId="ws-1"
        paneId="pane-7"
      />,
    );
    const last = githubProps.at(-1);
    expect(screen.getByTestId("mock-github")).toBeInTheDocument();
    expect(last?.instanceId).toBe("github-pane-7");
    expect(last?.syncGroup).toBe("ws-1");
  });

  it("GitHubView follows the resolved receive default and an explicit override", () => {
    const { rerender } = render(
      <ViewRenderer
        viewType="GitHubView"
        viewConfig={{ type: "GitHubView" }}
        workspaceId="ws-1"
        paneId="pane-8"
        location="dock"
      />,
    );
    expect(githubProps.at(-1)?.cwdReceive).toBe(true);

    rerender(
      <ViewRenderer
        viewType="GitHubView"
        viewConfig={{ type: "GitHubView", cwdReceive: false }}
        workspaceId="ws-1"
        paneId="pane-8"
        location="dock"
      />,
    );
    expect(githubProps.at(-1)?.cwdReceive).toBe(false);
  });

  it("uses paneId for stable terminal instanceId", () => {
    const { rerender } = render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        workspaceName="Default"
        paneId="pane-42"
      />,
    );
    const terminal = screen.getByTestId("mock-terminal");
    // instanceId should be derived from paneId, not a random counter
    // Re-render with the same paneId should produce the same instanceId
    rerender(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        workspaceName="Default"
        paneId="pane-42"
      />,
    );
    // The mock captures syncGroup; we mainly assert that the component
    // rendered without creating a new instance by checking testid is still present
    expect(screen.getByTestId("mock-terminal")).toBe(terminal);
  });

  it("restarts a TerminalView as a fresh shell at the supplied CWD", () => {
    const restart = vi.fn();
    const { rerender } = render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        paneId="pane-42"
        onTerminalRestart={restart}
      />,
    );
    expect(terminalViewProps.at(-1)?.isUserRestart).toBe(false);
    terminalViewProps.at(-1)?.onRestart?.();
    expect(restart).toHaveBeenCalledOnce();

    rerender(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        paneId="pane-42"
        terminalRestartEpoch={1}
        terminalRestartCwd="C:\work"
        terminalRestartCwdSourceProfile="WSL"
        terminalRestartFresh
        terminalRestartRestoreSession
      />,
    );
    expect(terminalViewProps.at(-1)).toMatchObject({
      restartCwd: "C:\\work",
      restartCwdSourceProfile: "WSL",
      isUserRestart: true,
      restoreSessionOnRestart: true,
    });

    rerender(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        paneId="pane-42"
        terminalRestartEpoch={1}
        terminalRestartCwd="C:\work"
        terminalRestartFresh={false}
      />,
    );
    expect(terminalViewProps.at(-1)?.isUserRestart).toBe(false);
  });

  it("paneId 가 빈 문자열이면 fallback id 로 폴백한다 (빈 instanceId 방지)", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        workspaceName="Default"
        paneId=""
      />,
    );
    const terminal = screen.getByTestId("mock-terminal");
    const instanceId = terminal.getAttribute("data-instanceid");
    // "terminal-" 처럼 식별자가 빈 id 가 만들어지면 안 된다.
    expect(instanceId).not.toBe("terminal-");
    expect(instanceId).toMatch(/^terminal-.+/);
  });
});
