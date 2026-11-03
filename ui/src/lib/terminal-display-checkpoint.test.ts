import { beforeEach, expect, it } from "vitest";
import { useTerminalDisplayStore } from "@/stores/terminal-display-store";
import { useTerminalStore } from "@/stores/terminal-store";
import type { Settings } from "./tauri-api";
import {
  collectTerminalDisplayCheckpoint,
  restoreTerminalDisplayCheckpoint,
} from "./terminal-display-checkpoint";

const saved = {
  version: 1 as const,
  profile: "PowerShell",
  lastUserInput: "previous input",
  lastUserInputAt: 100,
};
const settings = {
  workspaces: [
    {
      panes: [
        {
          layers: [
            { id: "visible", view: { type: "TerminalView", profile: "PowerShell" } },
            { id: "hidden", view: { type: "TerminalView", profile: "PowerShell" } },
            { id: "changed", view: { type: "TerminalView", profile: "WSL" } },
            { id: "memo", view: { type: "MemoView" } },
          ],
        },
      ],
    },
  ],
  docks: [{ panes: [{ id: "dock", view: { type: "TerminalView", profile: "PowerShell" } }] }],
} as unknown as Settings;

beforeEach(() => {
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useTerminalDisplayStore.setState({ contexts: {} });
});

it("keeps hidden layers and docks but drops deleted, nonterminal and changed-profile history", () => {
  const contexts = Object.fromEntries(
    ["visible", "hidden", "changed", "memo", "dock", "deleted"].map((id) => [
      `terminal-${id}`,
      saved,
    ]),
  );
  restoreTerminalDisplayCheckpoint(contexts, settings);
  expect(Object.keys(useTerminalDisplayStore.getState().contexts).sort()).toEqual([
    "terminal-dock",
    "terminal-hidden",
    "terminal-visible",
  ]);
  // Collection performs the same filtering after in-session edits.
  useTerminalDisplayStore.setState({ contexts });
  expect(Object.keys(collectTerminalDisplayCheckpoint(settings)).sort()).toEqual([
    "terminal-dock",
    "terminal-hidden",
    "terminal-visible",
  ]);
});

it("stores bounded display data without output activity, notification delivery or live observations", () => {
  const store = useTerminalStore.getState();
  store.registerInstance({
    id: "terminal-visible",
    workspaceId: "ws",
    syncGroup: "ws",
    profile: "PowerShell",
  });
  store.updateInstanceInfo("terminal-visible", {
    lastUserInput: "🔐".repeat(3000),
    lastUserInputAt: 200,
    outputActive: true,
    generation: 5,
  });
  store.observeTask("terminal-visible", {
    source: "shell",
    taskId: "1",
    sequence: 1,
    state: "running",
  });
  store.observeTask("terminal-visible", {
    source: "shell",
    taskId: "1",
    sequence: 2,
    state: "waiting",
  });
  const contexts = collectTerminalDisplayCheckpoint(settings);
  expect(Array.from(contexts["terminal-visible"].lastUserInput!)).toHaveLength(2048);
  expect(contexts["terminal-visible"].task).toMatchObject({ state: "waiting", notificationId: 0 });
  expect(contexts["terminal-visible"].task?.notification).toBeUndefined();
  for (const key of ["outputActive", "generation", "taskObservation", "agentHook"])
    expect(contexts["terminal-visible"]).not.toHaveProperty(key);
  expect(useTerminalStore.getState().instances[0].lastUserInput).toHaveLength(6000);
});
