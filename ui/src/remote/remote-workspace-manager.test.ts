import { beforeEach, expect, it, vi } from "vitest";
import { createWorkspaceManager } from "./remote-workspace-manager.js";

beforeEach(() => document.body.replaceChildren());

function setup() {
  let lease: string | null = "lease-1";
  const rename = vi.fn().mockResolvedValue(undefined);
  const hide = vi.fn().mockResolvedValue(undefined);
  const manager = createWorkspaceManager({ getLease: () => lease, rename, hide });
  const button = document.createElement("button");
  document.body.append(button);
  // jsdom does not implement the native dialog lifecycle.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  manager.open({ id: "ws-1", name: "Alpha" }, true, button);
  return {
    manager,
    rename,
    hide,
    loseLease: () => {
      lease = null;
    },
  };
}

it("공백 이름을 거부하고 저장 실패 시 입력을 유지한다", async () => {
  const { rename } = setup();
  document.querySelector<HTMLButtonElement>("[data-workspace-action=rename]")!.click();
  const input = document.querySelector<HTMLInputElement>("#workspaceNameInput")!;
  const form = document.querySelector<HTMLFormElement>("#workspaceRenameForm")!;
  input.value = " \t ";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(rename).not.toHaveBeenCalled();
  rename.mockRejectedValueOnce(new Error("Connection lost"));
  input.value = "New name";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toBe("Connection lost"),
  );
  expect(input.value).toBe("New name");
  expect(document.querySelector("dialog")!.open).toBe(true);
});

it("롱클릭 진입은 메뉴 동작 목록 대신 이름 변경 입력에 바로 포커스한다", () => {
  const { manager } = setup();
  manager.open({ id: "ws-1", name: "Alpha" }, true, document.createElement("button"), {
    rename: true,
  });
  expect(document.querySelector<HTMLElement>("#workspaceManagerActions")!.hidden).toBe(true);
  expect(document.querySelector<HTMLElement>("#workspaceRenameForm")!.hidden).toBe(false);
  const input = document.querySelector<HTMLInputElement>("#workspaceNameInput")!;
  expect(input.value).toBe("Alpha");
  expect(document.activeElement).toBe(input);
  manager.close();
});

it("워크스페이스 닫기는 한 번에 유예를 요청하고 마지막 workspace는 비활성화한다", async () => {
  const remove = vi.fn().mockResolvedValue(undefined);
  const manager = createWorkspaceManager({
    getLease: () => "lease-1",
    rename: vi.fn(),
    hide: vi.fn(),
    remove,
  });
  manager.open({ id: "ws-2", name: "Beta" }, true, document.createElement("button"), {
    canClose: true,
  });
  const button = document.querySelector<HTMLButtonElement>(
    '#workspaceManager [data-workspace-action="remove"]',
  )!;
  button.click();
  await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith("ws-2", "lease-1"));
  manager.open({ id: "ws-2", name: "Beta" }, false, document.createElement("button"), {
    canClose: false,
  });
  expect(button.disabled).toBe(true);
  manager.close();
});

it("마지막 표시 워크스페이스는 숨길 수 없고 제어권 상실 후 전송하지 않는다", () => {
  const { manager, rename, hide, loseLease } = setup();
  manager.open({ id: "ws-1", name: "Alpha" }, false, document.createElement("button"));
  expect(document.querySelector<HTMLButtonElement>("[data-workspace-action=hide]")!.title).toBe(
    "The last visible workspace cannot be hidden",
  );
  expect(document.querySelector<HTMLButtonElement>("[data-workspace-action=hide]")!.disabled).toBe(
    true,
  );
  document.querySelector<HTMLButtonElement>("[data-workspace-action=rename]")!.click();
  loseLease();
  document
    .querySelector<HTMLFormElement>("#workspaceRenameForm")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  expect(rename).not.toHaveBeenCalled();
  expect(hide).not.toHaveBeenCalled();
  expect(document.querySelector("dialog")!.open).toBe(false);
});
