import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteWorktrees } from "./remote-worktrees.js";
import { initializeRemoteLanguage } from "./remote-i18n.js";

const source = readFileSync(
  path.resolve(__dirname, "../../../src-tauri/src/remote_server/assets/remote-app.js"),
  "utf8",
);
function functionSource(name: string, next: string) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}

describe("Remote navigation과 Worktrees 연결", () => {
  let controller: ReturnType<typeof createRemoteWorktrees> | undefined;
  afterEach(() => {
    controller?.close();
    controller = undefined;
  });
  function setup() {
    localStorage.clear();
    initializeRemoteLanguage({ locale: "ko" });
    document.body.innerHTML = `<div class="app"></div><div id="worktreesOverlay" hidden>
      <button id="worktreesAll"></button><button id="worktreesCandidates"></button>
      <button id="worktreesRefresh"></button><button id="worktreesClose"></button>
      <div id="worktreesRepo"></div><div id="worktreesStatus"></div>
      <div id="worktreesList"></div><div id="worktreesDetail"></div></div>`;
    // 실제 app의 두 함수를 실행한다. drawer를 다시 그리지 않는 metadata 경로를 검증한다.
    const runtime = new Function(
      "worktreeView",
      `
      let navigationState = null, terminalInfoById = new Map();
      const activeTerminalId = "source", paneLinkUnderlines = null;
      const workspaceCloseToasts = { sync() {} }, ensureRemoteFont = () => {};
      const renderKeyboardShortcutList = () => {}, renderNavigation = () => {};
      const terminalMetaEl = {}, terminalMetaLabel = () => "", syncNavigationViewPolling = () => {};
      ${functionSource("installNavigationSnapshot", "navigationViewPollingNeeded")}
      ${functionSource("navigationViewPollingNeeded", "syncNavigationViewPolling")}
      return { installNavigationSnapshot, navigationViewPollingNeeded, cwd: () => terminalInfoById.get(activeTerminalId)?.cwd };
    `,
    )({
      syncContext: () => controller?.syncContext(),
      isOpen: () => controller?.isOpen() ?? false,
      isSuspended: () => controller?.isSuspended() ?? false,
    }) as {
      installNavigationSnapshot: (data: unknown, options: { render: boolean }) => void;
      navigationViewPollingNeeded: () => boolean;
      cwd: () => string;
    };
    const install = (cwd: string) =>
      runtime.installNavigationSnapshot(
        { terminals: [{ id: "source", cwd }], paneLinkEnabled: false },
        { render: false },
      );
    install("/work/main");
    const entry = { path: "/work/clean", branch: "clean", head: "abc", usage: [] };
    const api = vi.fn(async (url: string) =>
      url.endsWith("/inspect")
        ? {
            data: {
              worktree: entry,
              canRemove: true,
              blockers: [],
              usage: [],
              files: [],
              trackedChanges: 0,
              untrackedFiles: 0,
              ignoredFiles: 0,
            },
          }
        : { cwd: runtime.cwd(), data: { repositoryPath: "/work/main", worktrees: [entry] } },
    );
    const stateChanged = vi.fn();
    controller = createRemoteWorktrees({
      api,
      getContext: () => ({ leaseId: "lease", terminalId: "source", cwd: runtime.cwd() }),
      copy: vi.fn(),
      openFile: vi.fn(),
      canOpenFile: () => true,
      focusUsage: vi.fn(),
      beforeOpen: vi.fn(),
      afterClose: vi.fn(),
      onStateChange: stateChanged,
    });
    return { runtime, install, api, stateChanged };
  }

  it("drawer를 그리지 않는 CWD 갱신도 이전 제거 확인을 폐기하고 새 목록을 요청한다", async () => {
    const { install, api } = setup();
    controller!.open();
    await vi.waitFor(() => expect(document.querySelector("[data-worktree-path]")).not.toBeNull());
    (document.querySelector("[data-worktree-path]") as HTMLElement).click();
    const find = (label: string) =>
      [...document.querySelectorAll("button")].find((item) => item.textContent === label);
    await vi.waitFor(() => expect(find("워크트리 제거")).toBeDefined());
    find("워크트리 제거")!.click();
    expect(find("제거 확인")).toBeDefined();
    const before = api.mock.calls.length;
    install("/work/main/sub");
    await vi.waitFor(() => expect(find("제거 확인")).toBeUndefined());
    expect(document.getElementById("worktreesDetail")!.hidden).toBe(true);
    expect(api.mock.calls.length).toBeGreaterThan(before);
  });

  it("pane 링크와 drawer가 꺼져 있어도 열린 Worktrees는 기존 metadata 폴링을 사용한다", () => {
    const { runtime } = setup();
    expect(runtime.navigationViewPollingNeeded()).toBe(false);
    controller!.open();
    expect(runtime.navigationViewPollingNeeded()).toBe(true);
    controller!.close();
    expect(runtime.navigationViewPollingNeeded()).toBe(false);
  });

  it("열기·파일 뷰어 전환·복귀·닫기는 metadata 폴링 필요 상태를 알린다", () => {
    const { stateChanged } = setup();
    controller!.open();
    expect(stateChanged).toHaveBeenCalledTimes(1);
    controller!.suspend();
    expect(stateChanged).toHaveBeenCalledTimes(2);
    controller!.resume();
    expect(stateChanged).toHaveBeenCalledTimes(3);
    controller!.close();
    expect(stateChanged).toHaveBeenCalledTimes(4);
  });
});
