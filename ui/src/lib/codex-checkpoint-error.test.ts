import { beforeEach, expect, it } from "vitest";
import i18n from "@/i18n";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { formatCodexCheckpointError } from "./codex-checkpoint-error";

beforeEach(async () => {
  await i18n.changeLanguage("ko");
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws",
        name: "백엔드",
        panes: [
          { id: "right", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          { id: "left", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
        ],
      },
    ],
  });
  useDockStore.setState({ docks: [] });
  useTerminalStore.setState({ instances: [] });
});

it("identifies an inactive pane by workspace, spatial number and title, with recovery instructions", () => {
  useTerminalStore
    .getState()
    .registerInstance({ id: "terminal-right", profile: "WSL", syncGroup: "ws", workspaceId: "ws" });
  useTerminalStore.getState().updateInstanceInfo("terminal-right", { title: "API 작업" });
  const error = formatCodexCheckpointError("Ambiguous WSL Codex process [terminal-right]");
  expect(error.message).toContain("백엔드 · pane 2 · API 작업");
  expect(error.message).toContain("수동으로 종료한 뒤 다시 시도");
  expect(error.message).toContain("Ambiguous WSL Codex process");
});

it("names every affected pane and retains an unknown terminal ID", () => {
  const error = formatCodexCheckpointError(
    "Could not verify WSL Codex processes [terminal-left] [terminal-right] [terminal-removed]",
  );
  expect(error.message).toContain("백엔드 · pane 1");
  expect(error.message).toContain("백엔드 · pane 2");
  expect(error.message).toContain("terminal-removed");
});

it("identifies dock panes without pretending they belong to a workspace", () => {
  useDockStore.setState({
    docks: [
      {
        position: "bottom",
        activeView: "TerminalView",
        views: ["TerminalView"],
        visible: true,
        size: 200,
        panes: [
          { id: "dock", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView", profile: "WSL" } },
        ],
      },
    ],
  });
  expect(formatCodexCheckpointError("[terminal-dock] timed out").message).toContain(
    "하단 Dock · pane 1 · WSL",
  );
});

it("uses the app language and preserves diagnostic reasons", async () => {
  await i18n.changeLanguage("en");
  const error = formatCodexCheckpointError("[terminal-left] timed out");
  expect(error.message).toContain("manually end");
  expect(error.message).toContain("try again");
  expect(error.message).toContain("timed out");
});
