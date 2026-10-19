import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteWorktrees } from "./remote-worktrees.js";

const entry = { path: "/work/feature", branch: "feature", head: "abc", usage: [] };
const result = {
  success: true,
  cwd: "/work/main",
  data: { repositoryPath: "/work/main", worktrees: [entry], usageWarnings: [] },
};
const inspection = {
  worktree: entry,
  canRemove: true,
  blockers: [],
  usage: [],
  files: [],
  trackedChanges: 0,
  untrackedFiles: 0,
  ignoredFiles: 0,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Remote Worktrees 요청 소유권", () => {
  let context: { leaseId: string | null; terminalId: string; cwd: string };
  let controller: ReturnType<typeof createRemoteWorktrees>;
  const api = vi.fn();
  const focusUsage = vi.fn();
  beforeEach(() => {
    document.body.innerHTML = `<div id="worktreesOverlay" hidden>
      <button id="worktreesAll"></button><button id="worktreesCandidates"></button>
      <button id="worktreesRefresh"></button><button id="worktreesClose"></button>
      <div id="worktreesRepo"></div><div id="worktreesStatus"></div>
      <div id="worktreesList"></div><div id="worktreesDetail"></div></div>`;
    context = { leaseId: "lease", terminalId: "terminal-1", cwd: "/work/main" };
    focusUsage.mockReset().mockResolvedValue(undefined);
    api
      .mockReset()
      .mockImplementation(async (url: string) =>
        url.endsWith("/inspect") ? { data: inspection } : result,
      );
    controller = createRemoteWorktrees({
      api,
      getContext: () => context,
      copy: vi.fn().mockResolvedValue(undefined),
      openFile: vi.fn(),
      canOpenFile: () => true,
      focusUsage,
      beforeOpen: vi.fn(),
      afterClose: vi.fn(),
    });
  });
  afterEach(() => controller.close());
  const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((item) => item.textContent === label)!;

  it("terminal 변경 뒤 도착한 목록은 표시하거나 추가 검사하지 않는다", async () => {
    const old = deferred<typeof result>();
    api.mockReturnValueOnce(old.promise);
    controller.open();
    context = { ...context, terminalId: "terminal-2" };
    controller.syncContext();
    old.resolve(result);
    await old.promise;
    expect(controller.isOpen()).toBe(false);
    expect(document.querySelector("[data-worktree-path]")).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("같은 terminal의 CWD 변경은 선택·확인과 이전 상세 응답을 버린다", async () => {
    controller.open();
    await vi.waitFor(() => expect(document.querySelector("[data-worktree-path]")).not.toBeNull());
    const old = deferred<{ data: typeof inspection }>();
    api.mockReturnValueOnce(old.promise);
    click("[data-worktree-path]");
    context = { ...context, cwd: "/work/next" };
    controller.syncContext();
    old.resolve({ data: inspection });
    await old.promise;
    await vi.waitFor(() => expect(document.getElementById("worktreesDetail")?.hidden).toBe(true));
    expect(button("제거 확인")).toBeUndefined();
  });

  it("lease를 잃으면 기존 확인 버튼 참조로도 제거할 수 없다", async () => {
    controller.open();
    await vi.waitFor(() => expect(document.querySelector("[data-worktree-path]")).not.toBeNull());
    click("[data-worktree-path]");
    await vi.waitFor(() => expect(button("워크트리 제거")).toBeDefined());
    button("워크트리 제거").click();
    const confirm = button("제거 확인");
    context = { ...context, leaseId: null };
    controller.syncContext();
    confirm.click();
    expect(controller.isOpen()).toBe(false);
    expect(api.mock.calls.some(([url]) => url.endsWith("/remove"))).toBe(false);
  });

  it("내용 검사는 최대 3개씩 실행하며 미검사를 후보에 넣지 않는다", async () => {
    const waiting = deferred<{ data: typeof inspection }>();
    api.mockImplementation((url: string) =>
      url.endsWith("/inspect")
        ? waiting.promise
        : Promise.resolve({
            ...result,
            data: {
              ...result.data,
              worktrees: Array.from({ length: 5 }, (_, index) => ({
                ...entry,
                path: `/work/${index}`,
              })),
            },
          }),
    );
    controller.open();
    await vi.waitFor(() =>
      expect(api.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(3),
    );
    expect(document.getElementById("worktreesCandidates")?.textContent).toBe("정리 후보 · 검사 중");
    controller.close();
    waiting.resolve({ data: inspection });
    await waiting.promise;
    expect(api.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(3);
  });

  it("늦은 터미널 이동 완료는 새로 연 패널을 닫지 않는다", async () => {
    const pending = deferred<void>();
    focusUsage.mockReturnValue(pending.promise);
    api.mockImplementation(async (url: string) =>
      url.endsWith("/inspect")
        ? {
            data: {
              ...inspection,
              usage: [
                {
                  terminalId: "terminal-2",
                  paneId: "pane-2",
                  workspaceName: "개발",
                  agentType: "codex",
                  kind: "live",
                },
              ],
            },
          }
        : result,
    );
    controller.open();
    await vi.waitFor(() => expect(document.querySelector("[data-worktree-path]")).not.toBeNull());
    click("[data-worktree-path]");
    await vi.waitFor(() => expect(button("개발 · codex · 실행 중")).toBeDefined());
    button("개발 · codex · 실행 중").click();
    context = { ...context, terminalId: "terminal-2" };
    controller.syncContext();
    controller.open();
    pending.resolve();
    await pending.promise;
    expect(controller.isOpen()).toBe(true);
  });

  it("상세는 목록과 전환하고 닫으면 목록 스크롤을 복원한다", async () => {
    controller.open();
    await vi.waitFor(() => expect(document.querySelector("[data-worktree-path]")).not.toBeNull());
    const list = document.getElementById("worktreesList")!;
    const content = list.parentElement!;
    content.scrollTop = 120;
    click("[data-worktree-path]");
    expect(list.hidden).toBe(true);
    expect(content.scrollTop).toBe(0);
    button("상세 닫기").click();
    expect(list.hidden).toBe(false);
    expect(content.scrollTop).toBe(120);
  });

  it("파일 뷰어에서 복귀할 때 선택을 유지하되 다른 terminal로는 복귀하지 않는다", async () => {
    controller.open();
    await vi.waitFor(() => expect(document.querySelector("[data-worktree-path]")).not.toBeNull());
    click("[data-worktree-path]");
    await vi.waitFor(() => expect(button("워크트리 제거")).toBeDefined());
    controller.suspend();
    expect(controller.isOpen()).toBe(false);
    expect(controller.resume()).toBe(true);
    expect(document.getElementById("worktreesDetail")?.hidden).toBe(false);
    expect(button("워크트리 제거")).toBeDefined();
    controller.suspend();
    context = { ...context, terminalId: "terminal-2" };
    expect(controller.resume()).toBe(false);
    expect(controller.isSuspended()).toBe(false);
  });

  it("같은 대상의 갱신은 선택을 유지하고 이전 제거 확인을 재사용하지 않는다", async () => {
    controller.open();
    await vi.waitFor(() => expect(document.querySelector("[data-worktree-path]")).not.toBeNull());
    click("[data-worktree-path]");
    await vi.waitFor(() => expect(button("워크트리 제거")).toBeDefined());
    button("워크트리 제거").click();
    const pending = deferred<typeof result>();
    api.mockReturnValueOnce(pending.promise);
    click("#worktreesRefresh");
    expect(document.getElementById("worktreesDetail")?.hidden).toBe(false);
    expect(document.getElementById("worktreesCandidates")?.textContent).toContain("검사 중");
    expect(button("제거 확인")).toBeUndefined();
    expect(button("워크트리 제거")).toBeUndefined();
    pending.resolve(result);
    await vi.waitFor(() => expect(button("워크트리 제거")).toBeDefined());
    expect(document.getElementById("worktreesList")?.hidden).toBe(true);
  });

  it("제거 거부는 검사 실패로 표시하고 검사 중 상태로 남기지 않는다", async () => {
    api.mockImplementation(async (url: string) => {
      if (url.endsWith("/remove")) throw new Error("사용 중");
      return url.endsWith("/inspect") ? { data: inspection } : result;
    });
    controller.open();
    await vi.waitFor(() => expect(document.querySelector("[data-worktree-path]")).not.toBeNull());
    click("[data-worktree-path]");
    await vi.waitFor(() => expect(button("워크트리 제거")).toBeDefined());
    button("워크트리 제거").click();
    button("제거 확인").click();
    await vi.waitFor(() =>
      expect(document.getElementById("worktreesDetail")?.textContent).toContain("사용 중"),
    );
    expect(document.getElementById("worktreesStatus")?.textContent).not.toContain("검사 중");
    expect(document.getElementById("worktreesList")?.textContent).toContain("검사 실패: 사용 중");
  });
});
