import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkspaceCloseToasts } from "./remote-workspace-close-toasts.js";

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

it.each([-60000, 60000])("단말 시계가 호스트와 %dms 달라도 5초 복원을 제공한다", async (offset) => {
  const serverTime = Date.now();
  vi.setSystemTime(serverTime + offset);
  const restore = vi.fn().mockResolvedValue(undefined);
  const toasts = createWorkspaceCloseToasts({ getLease: () => "lease", restore, onError: vi.fn() });
  const pending = [
    { id: "a", name: "A", expiresAt: serverTime + 5000 },
    { id: "b", name: "B", expiresAt: serverTime + 5000 },
  ];
  toasts.sync(pending, serverTime);
  expect(document.querySelector("[role=status]")).not.toBeNull();
  vi.advanceTimersByTime(4000);
  toasts.sync(pending, serverTime + 4000);
  document.querySelector<HTMLButtonElement>('[data-workspace-restore="a"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(restore).toHaveBeenCalledExactlyOnceWith("a", "lease");
  expect(document.querySelector("[role=status]")).not.toBeNull();
  vi.advanceTimersByTime(1000);
  expect(document.querySelector("[role=status]")).toBeNull();
});

it("호스트 만료 시각을 사용하고 재조회로 유예를 연장하지 않는다", () => {
  const restore = vi.fn();
  const toasts = createWorkspaceCloseToasts({ getLease: () => "lease", restore, onError: vi.fn() });
  const pending = [{ id: "ws-1", name: "작업", expiresAt: Date.now() + 5000 }];
  toasts.sync(pending);
  expect(document.querySelector("[role=status]")?.textContent).toContain("작업");
  vi.advanceTimersByTime(4000);
  toasts.sync(pending);
  vi.advanceTimersByTime(1000);
  expect(document.querySelector("[role=status]")).toBeNull();
  expect(restore).not.toHaveBeenCalled();
  toasts.sync(pending);
  expect(document.querySelector("[role=status]")).toBeNull();
});

it("늦게 발견한 닫기는 남은 기간부터 진행 막대를 표시하고 재조회로 되감지 않는다", () => {
  const toasts = createWorkspaceCloseToasts({
    getLease: () => "lease",
    restore: vi.fn(),
    onError: vi.fn(),
  });
  const pending = [{ id: "a", name: "A", expiresAt: 5000 }];
  toasts.sync(pending, 4000);
  const fill = document.querySelector<HTMLElement>(".toast-countdown-fill")!;
  expect(fill).not.toBeNull();
  expect(fill.style.animationDuration).toBe("5000ms");
  expect(fill.style.animationDelay).toBe("-4000ms");
  vi.advanceTimersByTime(500);
  toasts.sync(pending, 4500);
  expect(document.querySelector(".toast-countdown-fill")).toBe(fill);
  vi.advanceTimersByTime(500);
  expect(document.querySelector("[role=status]")).toBeNull();
});

it("복원은 열었던 lease로 요청하고 완료 후 토스트를 지운다", async () => {
  const restore = vi.fn().mockResolvedValue(undefined);
  const toasts = createWorkspaceCloseToasts({ getLease: () => "lease", restore, onError: vi.fn() });
  toasts.sync([{ id: "ws-1", name: "작업", expiresAt: Date.now() + 5000 }]);
  document.querySelector<HTMLButtonElement>("[data-workspace-restore]")!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(restore).toHaveBeenCalledExactlyOnceWith("ws-1", "lease");
  expect(document.querySelector("[role=status]")).toBeNull();
});

it("제어권이 바뀌면 이전 버튼은 요청하지 않고 여러 토스트를 독립적으로 관리한다", () => {
  let lease = "lease-1";
  const restore = vi.fn();
  const toasts = createWorkspaceCloseToasts({ getLease: () => lease, restore, onError: vi.fn() });
  toasts.sync([
    { id: "a", name: "A", expiresAt: Date.now() + 5000 },
    { id: "b", name: "B", expiresAt: Date.now() + 6000 },
  ]);
  expect(document.querySelectorAll("[role=status]")).toHaveLength(2);
  lease = "lease-2";
  document.querySelector<HTMLButtonElement>("[data-workspace-restore]")!.click();
  expect(restore).not.toHaveBeenCalled();
  toasts.sync([]);
  expect(document.querySelectorAll("[role=status]")).toHaveLength(0);
});

it("이전 복원의 늦은 응답이 같은 workspace의 새 닫기 토스트를 지우지 않는다", async () => {
  let complete;
  const restore = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const toasts = createWorkspaceCloseToasts({ getLease: () => "lease", restore, onError: vi.fn() });
  toasts.sync([{ id: "a", name: "A", expiresAt: Date.now() + 5000 }]);
  document.querySelector<HTMLButtonElement>("[data-workspace-restore]")!.click();
  vi.advanceTimersByTime(1000);
  toasts.sync([{ id: "a", name: "A", expiresAt: Date.now() + 5000 }]);
  complete!();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector("[role=status]")).not.toBeNull();
  vi.advanceTimersByTime(4000);
  expect(document.querySelector("[role=status]")).not.toBeNull();
  vi.advanceTimersByTime(1000);
  expect(document.querySelector("[role=status]")).toBeNull();
});
