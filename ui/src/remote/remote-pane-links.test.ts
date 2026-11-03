import { expect, it, vi } from "vitest";
import { remotePaneLinkDependencies } from "./remote-pane-links";

function setup() {
  let snapshot = {
    paneLinkEnabled: true,
    workspaces: [
      {
        id: "ws-1",
        name: "laymux-0",
        panes: [
          { id: "pane-11111111", terminalId: "terminal-pane-11111111", paneNumber: 1 },
          { id: "pane-22222222", terminalId: "terminal-pane-22222222", paneNumber: 2 },
        ],
      },
    ],
  };
  let context = { terminalId: "source", leaseId: "lease", outputEpoch: 1, ready: true };
  let deliver!: (value: typeof snapshot) => void;
  const select = vi.fn().mockResolvedValue(undefined);
  const deps = remotePaneLinkDependencies({
    getSnapshot: () => snapshot,
    getContext: () => context,
    loadSnapshot: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
    installSnapshot: (value) => {
      snapshot = value as typeof snapshot;
    },
    select,
    onError: vi.fn(),
  });
  const click = () =>
    deps.navigate(deps.resolve("lx:pane:laymux-0:1")!, "lx:pane:laymux-0:1", () => true);
  return {
    deps,
    select,
    click,
    get snapshot() {
      return snapshot;
    },
    deliver: (value = snapshot) => deliver(value),
    changeContext: (change: Partial<typeof context>) => {
      context = { ...context, ...change };
    },
  };
}

it("클릭 뒤 최신 공간 번호를 해석하고 기존 terminal 선택 경로로 넘긴다", async () => {
  const state = setup();
  state.click();
  const snapshot = structuredClone(state.snapshot);
  snapshot.workspaces[0].panes.forEach((pane) => {
    pane.paneNumber = 3 - pane.paneNumber;
  });
  state.deliver(snapshot);
  await vi.waitFor(() =>
    expect(state.select).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "terminal-pane-22222222" }),
    ),
  );
});
it("최신 host 설정이 끔이면 밑줄 상태를 갱신하고 탐색하지 않는다", async () => {
  const state = setup();
  state.click();
  state.deliver({ ...state.snapshot, paneLinkEnabled: false });
  await vi.waitFor(() => expect(state.deps.enabled()).toBe(false));
  expect(state.select).not.toHaveBeenCalled();
});
it.each([{ leaseId: "new" }, { terminalId: "other" }, { outputEpoch: 2 }, { ready: false }])(
  "비동기 조회 중 원본 표면·lease가 바뀌면 취소한다: %j",
  async (change) => {
    const state = setup();
    state.click();
    state.changeContext(change);
    state.deliver();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.select).not.toHaveBeenCalled();
  },
);
it("최신 레이아웃에서 대상이 사라지면 취소한다", async () => {
  const state = setup();
  state.click();
  state.deliver({ ...state.snapshot, workspaces: [] });
  await vi.waitFor(() => expect(state.deps.resolve("lx:pane:laymux-0:1")).toBeNull());
  expect(state.select).not.toHaveBeenCalled();
});
