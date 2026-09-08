import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  getUsageSnapshot: vi.fn(),
  getGrokUsageSnapshot: vi.fn(),
}));

import { getGrokUsageSnapshot, getUsageSnapshot, type UsageSnapshot } from "@/lib/tauri-api";
import { WIDGET_DEFINITIONS } from "@/components/widgets/registry";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { defaultWidgets, type WidgetInstance } from "@/lib/widget-placement";
import { buildRemoteWidgetSnapshot } from "./widget-snapshot";

const NOW = new Date("2026-08-03T12:00:00Z");

function widget(id: string, type: string, options: Record<string, unknown> = {}): WidgetInstance {
  return { id, type, options };
}

function claudeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    configDir: "",
    status: { type: "ready" },
    session: { percent: 42, reset: null },
    weekAll: { percent: 7, reset: null },
    weekModel: { percent: 3, reset: null },
    weekModelLabel: null,
    plan: null,
    model: null,
    capturedAtMs: NOW.getTime(),
    nextQueryAtMs: null,
    rawScreen: null,
    ...overrides,
  };
}

function terminal(overrides: Partial<TerminalInstance> & { id: string }): TerminalInstance {
  return {
    profile: "PowerShell",
    syncGroup: "g",
    workspaceId: "ws-1",
    label: "t",
    lastActivityAt: 0,
    isFocused: false,
    ...overrides,
  };
}

function placeWidgets(widgets: Partial<ReturnType<typeof defaultWidgets>>) {
  useSettingsStore.setState({ widgets: { ...defaultWidgets(), ...widgets } });
}

describe("buildRemoteWidgetSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUsageSnapshot).mockResolvedValue(claudeSnapshot());
    vi.mocked(getGrokUsageSnapshot).mockResolvedValue({
      configDir: "",
      status: { type: "idle" },
      rows: [],
      capturedAtMs: null,
      nextQueryAtMs: null,
      rawScreen: null,
    });
    useSettingsStore.setState({ widgets: defaultWidgets() });
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-1" });
    useGridStore.setState(useGridStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useNotificationStore.setState({ notifications: [] });
  });

  it("folds the four desktop slots into left and right, keeping each slot's order", async () => {
    placeWidgets({
      topBar: { left: [widget("a", "cwd")], right: [widget("b", "notifications")] },
      statusLine: {
        enabled: true,
        left: [widget("c", "terminalActivity")],
        right: [widget("d", "claudeUsage")],
      },
    });

    const snapshot = await buildRemoteWidgetSnapshot(NOW);

    expect(snapshot.items.map((item) => [item.id, item.align])).toEqual([
      ["a", "left"],
      ["c", "left"],
      ["b", "right"],
      ["d", "right"],
    ]);
  });

  it("omits status line widgets while the desktop is not drawing that surface", async () => {
    // The remote mirrors what the desktop shows; a placement behind a disabled
    // status line is not shown there, so it must not appear here either.
    placeWidgets({
      statusLine: { enabled: false, left: [widget("c", "cwd")], right: [] },
    });

    expect((await buildRemoteWidgetSnapshot(NOW)).items).toEqual([]);
  });

  it("skips a type this build does not know instead of failing the whole strip", async () => {
    placeWidgets({
      topBar: { left: [widget("future", "fromTheFuture"), widget("known", "cwd")], right: [] },
    });

    const snapshot = await buildRemoteWidgetSnapshot(NOW);

    expect(snapshot.items.map((item) => item.id)).toEqual(["known"]);
  });

  it("derives Grok weekly elapsed the same way the desktop widget does", async () => {
    vi.mocked(getGrokUsageSnapshot).mockResolvedValue({
      configDir: "",
      status: { type: "ready" },
      rows: [{ key: "weekly", percent: 66, remaining: null, reset: "August 20, 16:13" }],
      capturedAtMs: NOW.getTime(),
      nextQueryAtMs: null,
      rawScreen: null,
    });
    placeWidgets({
      topBar: { left: [widget("g", "grokUsage", { display: "both" })], right: [] },
    });

    const [item] = (await buildRemoteWidgetSnapshot(new Date(2026, 7, 17, 4, 13))).items;

    if (item.kind !== "usage") throw new Error("expected a usage item");
    expect(item.unavailable).toBeNull();
    expect(item.rows).toEqual([
      expect.objectContaining({ key: "weekly", percent: 66, elapsed: 50 }),
    ]);
    expect(item.title).toContain("50% elapsed");
  });

  it("hands the remote finished row text and the account's own colours", async () => {
    placeWidgets({
      topBar: { left: [widget("u", "claudeUsage", { display: "both", barWidth: 30 })], right: [] },
    });
    useSettingsStore.setState({
      usage: {
        ...useSettingsStore.getState().usage,
        claude: {
          ...useSettingsStore.getState().usage.claude,
          visibleRows: ["session"],
          colors: { used: "#d97757", pace: "#f9e2af", track: "#585858" },
        },
      },
    });

    const [item] = (await buildRemoteWidgetSnapshot(NOW)).items;

    expect(item.kind).toBe("usage");
    if (item.kind !== "usage") throw new Error("expected a usage item");
    expect(item.unavailable).toBeNull();
    expect(item.rows).toEqual([
      expect.objectContaining({ key: "session", text: "Session 42%", percent: 42 }),
    ]);
    expect(item.colors.used).toBe("#d97757");
    expect(item.barWidth).toBe(30);
  });

  it("reports a stopped probe instead of the last good numbers", async () => {
    // ADR-0102's invariant reaches the remote unchanged: a failure is shown, not
    // swallowed by a stale percentage.
    vi.mocked(getUsageSnapshot).mockResolvedValue(
      claudeSnapshot({ status: { type: "claudeMissing" } }),
    );
    placeWidgets({ topBar: { left: [widget("u", "claudeUsage")], right: [] } });

    const [item] = (await buildRemoteWidgetSnapshot(NOW)).items;

    if (item.kind !== "usage") throw new Error("expected a usage item");
    expect(item.unavailable).toBe("`claude` not found in this profile's shell");
  });

  it("survives a snapshot read that throws", async () => {
    vi.mocked(getUsageSnapshot).mockRejectedValue(new Error("probe registry locked"));
    placeWidgets({ topBar: { left: [widget("u", "claudeUsage")], right: [] } });

    const [item] = (await buildRemoteWidgetSnapshot(NOW)).items;

    if (item.kind !== "usage") throw new Error("expected a usage item");
    expect(item.unavailable).toBe("Probe stopped");
    expect(item.rows).toEqual([]);
  });

  it("reads one snapshot per account, not one per placement", async () => {
    // Two placements of the same account are normal (a top bar glance and a
    // status line glance), and they must not double the backend reads.
    placeWidgets({
      topBar: {
        left: [widget("u1", "claudeUsage", { configDir: "/a" })],
        right: [widget("u2", "claudeUsage", { configDir: "/a" })],
      },
      statusLine: {
        enabled: true,
        left: [widget("u3", "claudeUsage", { configDir: "/b" })],
        right: [],
      },
    });

    await buildRemoteWidgetSnapshot(NOW);

    expect(
      vi
        .mocked(getUsageSnapshot)
        .mock.calls.map((call) => call[0])
        .sort(),
    ).toEqual(["/a", "/b"]);
  });

  it("counts terminal activity in the scope the placement asked for", async () => {
    useTerminalStore.setState({
      instances: [
        terminal({ id: "t1", workspaceId: "ws-1", activity: { type: "running" } }),
        terminal({ id: "t2", workspaceId: "ws-1" }),
        terminal({ id: "t3", workspaceId: "ws-2", activity: { type: "running" } }),
      ],
    });
    placeWidgets({
      topBar: {
        left: [
          widget("scoped", "terminalActivity", { scope: "workspace" }),
          widget("all", "terminalActivity", { scope: "all" }),
        ],
        right: [],
      },
    });

    const items = (await buildRemoteWidgetSnapshot(NOW)).items;

    expect(items[0]).toMatchObject({ kind: "activity", busy: 1, total: 2 });
    expect(items[1]).toMatchObject({ kind: "activity", busy: 2, total: 3 });
  });

  it("carries the focused terminal's path plus the full path to copy", async () => {
    useWorkspaceStore.setState({
      activeWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Current",
          panes: [
            {
              id: "current",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView" },
            },
          ],
        },
      ],
    });
    useTerminalStore.setState({
      instances: [terminal({ id: "terminal-current", cwd: "/home/dev/projects/laymux" })],
    });
    placeWidgets({ topBar: { left: [widget("c", "cwd")], right: [] } });

    const [item] = (await buildRemoteWidgetSnapshot(NOW)).items;

    if (item.kind !== "text") throw new Error("expected a text item");
    expect(item.copyText).toBe("/home/dev/projects/laymux");
    expect(item.text).toContain("laymux");
  });

  it("uses the active workspace pane instead of stale terminal focus metadata", async () => {
    useWorkspaceStore.setState({
      activeWorkspaceId: "ws-current",
      workspaces: [
        {
          id: "ws-stale",
          name: "Stale",
          panes: [
            {
              id: "stale",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView" },
            },
          ],
        },
        {
          id: "ws-current",
          name: "Current",
          panes: [
            {
              id: "current",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView" },
            },
          ],
        },
      ],
    });
    useTerminalStore.setState({
      instances: [
        terminal({
          id: "terminal-stale",
          workspaceId: "ws-stale",
          isFocused: true,
          cwd: "/home/dev/stale",
        }),
        terminal({
          id: "terminal-current",
          workspaceId: "ws-current",
          cwd: "/home/dev/current",
        }),
      ],
    });
    placeWidgets({ topBar: { left: [widget("c", "cwd")], right: [] } });

    const [item] = (await buildRemoteWidgetSnapshot(NOW)).items;

    if (item.kind !== "text") throw new Error("expected a text item");
    expect(item.copyText).toBe("/home/dev/current");
  });

  it("says there is nothing to copy when no terminal is focused", async () => {
    placeWidgets({ topBar: { left: [widget("c", "cwd")], right: [] } });

    const [item] = (await buildRemoteWidgetSnapshot(NOW)).items;

    if (item.kind !== "text") throw new Error("expected a text item");
    expect(item.copyText).toBeNull();
    expect(item.text).toBe("—");
  });

  it("counts only unread notifications", async () => {
    useNotificationStore.setState({
      notifications: [
        { id: "n1", readAt: null },
        { id: "n2", readAt: 1 },
      ] as never,
    });
    placeWidgets({ topBar: { left: [widget("n", "notifications")], right: [] } });

    expect((await buildRemoteWidgetSnapshot(NOW)).items[0]).toMatchObject({
      kind: "notifications",
      unread: 1,
    });
  });

  it("mirrors the shared widget typography", async () => {
    placeWidgets({ fontFamily: "Cascadia Mono", fontSize: 99 });

    const snapshot = await buildRemoteWidgetSnapshot(NOW);

    expect(snapshot.fontFamily).toBe("Cascadia Mono");
    // Clamped by the same reader the desktop slot uses, so an out-of-range value
    // in settings.json cannot reach the remote unbounded.
    expect(snapshot.fontSize).toBe(20);
  });

  /**
   * A widget the desktop can draw but the remote cannot model would be a
   * silently missing indicator, so registering a type has to fail here until it
   * is mapped onto a `kind` (ADR-0124).
   */
  // `codexUsage` reads the real subscription module, which answers its pending
  // snapshot when no poller has run — the same thing it hands the desktop
  // widget before the first capture, so no mock is needed to exercise the path.
  it("produces an item for every registered widget type", async () => {
    placeWidgets({
      topBar: {
        left: WIDGET_DEFINITIONS.map((definition, index) =>
          widget(`w${index}`, definition.type, { ...definition.defaultOptions }),
        ),
        right: [],
      },
    });

    const snapshot = await buildRemoteWidgetSnapshot(NOW);

    expect(snapshot.items.map((item) => item.type).sort()).toEqual(
      WIDGET_DEFINITIONS.map((definition) => definition.type).sort(),
    );
  });
});
