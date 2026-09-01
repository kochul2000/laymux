import { describe, it, expect, vi } from "vitest";
import type { LinkActivationMode } from "./link-activation";
import { createPathLinkClickHandlers, PATH_LINK_CLICK_SLOP } from "./path-link-click";

function makeEvent(
  overrides: Partial<Parameters<ReturnType<typeof setup>["onMouseDown"]>[0]> = {},
) {
  return {
    button: 0,
    clientX: 100,
    clientY: 50,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  };
}

const FILE = { absPath: "/home/u/notes.txt", isDirectory: false };
const DIR = { absPath: "/home/u/src", isDirectory: true };

function setup(
  options: {
    target?: { absPath: string; isDirectory: boolean } | null;
    inside?: boolean;
    osOpenEnabled?: boolean;
    confirmAlways?: boolean;
    confirmResult?: boolean;
    activation?: LinkActivationMode;
    /** 이 target 값에서 온 이벤트를 "칩 자신의 이벤트"로 본다. */
    chipNode?: unknown;
  } = {},
) {
  const activate = vi.fn();
  const confirm = vi.fn(() => options.confirmResult ?? true);
  const onOsHandoffSettled = vi.fn();
  const showChip = vi.fn();
  const handlers = createPathLinkClickHandlers({
    isChipEvent: (e) => options.chipNode !== undefined && e.target === options.chipNode,
    getSelectionAt: () =>
      options.inside === false ? null : options.target === undefined ? FILE : options.target,
    getSettings: () => ({
      osOpenEnabled: options.osOpenEnabled ?? true,
      confirmAlways: options.confirmAlways ?? true,
      activation: options.activation ?? "immediate",
    }),
    confirm,
    activate,
    showChip,
    onOsHandoffSettled,
  });
  return { ...handlers, activate, confirm, onOsHandoffSettled, showChip };
}

describe("createPathLinkClickHandlers — event ownership", () => {
  it("ends the mousedown for Ctrl and Ctrl+Shift inside the underline", () => {
    for (const mods of [
      { ctrlKey: true, shiftKey: false },
      { ctrlKey: true, shiftKey: true },
    ]) {
      const h = setup();
      const e = makeEvent(mods);
      h.onMouseDown(e);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(e.stopImmediatePropagation).toHaveBeenCalled();
    }
  });

  it("leaves a plain click alone so xterm selection keeps working", () => {
    const h = setup();
    const e = makeEvent();
    h.onMouseDown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("leaves Shift/Alt clicks alone — #352 owns those", () => {
    for (const mods of [
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, metaKey: true },
    ]) {
      const h = setup();
      const e = makeEvent(mods);
      h.onMouseDown(e);
      expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
    }
  });

  it("ignores a non-primary button and clicks outside the underline", () => {
    const right = setup();
    const e1 = makeEvent({ button: 2, ctrlKey: true });
    right.onMouseDown(e1);
    right.onMouseUp(makeEvent({ button: 2, ctrlKey: true }));
    expect(e1.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(right.activate).not.toHaveBeenCalled();

    const outside = setup({ inside: false });
    const e2 = makeEvent({ ctrlKey: true });
    outside.onMouseDown(e2);
    outside.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(e2.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(outside.activate).not.toHaveBeenCalled();
  });
});

describe("createPathLinkClickHandlers — activation", () => {
  it("routes a plain click to the existing behavior", () => {
    const file = setup();
    file.onMouseDown(makeEvent());
    file.onMouseUp(makeEvent());
    expect(file.activate).toHaveBeenCalledWith(FILE, "viewer");

    const dir = setup({ target: DIR });
    dir.onMouseDown(makeEvent());
    dir.onMouseUp(makeEvent());
    expect(dir.activate).toHaveBeenCalledWith(DIR, "changeDir");
  });

  it("routes Ctrl to osOpen and Ctrl+Shift to osReveal", () => {
    const open = setup();
    open.onMouseDown(makeEvent({ ctrlKey: true }));
    open.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(open.activate).toHaveBeenCalledWith(FILE, "osOpen");

    const reveal = setup();
    reveal.onMouseDown(makeEvent({ ctrlKey: true, shiftKey: true }));
    reveal.onMouseUp(makeEvent({ ctrlKey: true, shiftKey: true }));
    expect(reveal.activate).toHaveBeenCalledWith(FILE, "osReveal");
  });

  it("falls back to the existing behavior when the feature is disabled", () => {
    const h = setup({ osOpenEnabled: false });
    const e = makeEvent({ ctrlKey: true });
    h.onMouseDown(e);
    h.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(h.activate).toHaveBeenCalledWith(FILE, "viewer");
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("does not activate when the pointer moved past the slop (drag = reselect)", () => {
    const h = setup();
    h.onMouseDown(makeEvent({ ctrlKey: true }));
    h.onMouseUp(makeEvent({ ctrlKey: true, clientX: 100 + PATH_LINK_CLICK_SLOP + 1 }));
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    // mousedown was prevented for this combination, so focus still has to
    // come back even though nothing was opened.
    expect(h.onOsHandoffSettled).toHaveBeenCalled();
  });

  it("does not restore focus for a plain drag — that mousedown was never prevented", () => {
    const h = setup();
    h.onMouseDown(makeEvent());
    h.onMouseUp(makeEvent({ clientX: 100 + PATH_LINK_CLICK_SLOP + 1 }));
    expect(h.onOsHandoffSettled).not.toHaveBeenCalled();
  });

  it("does not activate a mouseup without a matching mousedown", () => {
    const h = setup();
    h.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(h.activate).not.toHaveBeenCalled();
  });
});

describe("createPathLinkClickHandlers — confirmation gate", () => {
  it("cancelling the dialog performs nothing", () => {
    const h = setup({ confirmResult: false });
    h.onMouseDown(makeEvent({ ctrlKey: true }));
    h.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(h.confirm).toHaveBeenCalledWith({ path: FILE.absPath, isDirectory: false });
    expect(h.activate).not.toHaveBeenCalled();
    // Focus must still come back — the dialog took it and mousedown was prevented.
    expect(h.onOsHandoffSettled).toHaveBeenCalled();
  });

  it("confirming proceeds and restores focus", () => {
    const h = setup({ confirmResult: true });
    h.onMouseDown(makeEvent({ ctrlKey: true }));
    h.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(h.activate).toHaveBeenCalledWith(FILE, "osOpen");
    expect(h.onOsHandoffSettled).toHaveBeenCalled();
  });

  it("skips the dialog for an ordinary file once the setting is off", () => {
    const h = setup({ confirmAlways: false });
    h.onMouseDown(makeEvent({ ctrlKey: true }));
    h.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.activate).toHaveBeenCalledWith(FILE, "osOpen");
  });

  it("still asks for a hard-class file once the setting is off", () => {
    const exe = { absPath: "C:/tools/setup.exe", isDirectory: false };
    const h = setup({ target: exe, confirmAlways: false, confirmResult: false });
    h.onMouseDown(makeEvent({ ctrlKey: true }));
    h.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(h.confirm).toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("never asks for reveal or for opening a directory", () => {
    const reveal = setup();
    reveal.onMouseDown(makeEvent({ ctrlKey: true, shiftKey: true }));
    reveal.onMouseUp(makeEvent({ ctrlKey: true, shiftKey: true }));
    expect(reveal.confirm).not.toHaveBeenCalled();
    expect(reveal.activate).toHaveBeenCalledWith(FILE, "osReveal");

    const dir = setup({ target: DIR });
    dir.onMouseDown(makeEvent({ ctrlKey: true }));
    dir.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(dir.confirm).not.toHaveBeenCalled();
    expect(dir.activate).toHaveBeenCalledWith(DIR, "osOpen");
  });
});

// -- ADR-0224: chip 모드 --

describe("createPathLinkClickHandlers — chip mode arms instead of executing", () => {
  it("shows a chip and executes nothing on a plain click", () => {
    for (const target of [FILE, DIR]) {
      const h = setup({ target, activation: "chip" });
      const down = makeEvent();
      h.onMouseDown(down);
      // 칩 모드의 클릭은 "관찰"이다 — 이벤트를 종결하지 않는다.
      expect(down.preventDefault).not.toHaveBeenCalled();
      expect(down.stopImmediatePropagation).not.toHaveBeenCalled();
      h.onMouseUp(makeEvent());

      expect(h.activate).not.toHaveBeenCalled();
      expect(h.confirm).not.toHaveBeenCalled();
      expect(h.showChip).toHaveBeenCalledTimes(1);
      const [chipTarget, actions, point] = h.showChip.mock.calls[0];
      expect(chipTarget).toBe(target);
      expect(actions).toEqual(
        target === FILE ? ["viewer", "osOpen", "copy"] : ["changeDir", "osOpen", "copy"],
      );
      expect(point).toEqual({ clientX: 100, clientY: 50 });
    }
  });

  it("keeps the Ctrl / Ctrl+Shift bypass immediate in chip mode", () => {
    const open = setup({ activation: "chip" });
    open.onMouseDown(makeEvent({ ctrlKey: true }));
    open.onMouseUp(makeEvent({ ctrlKey: true }));
    expect(open.showChip).not.toHaveBeenCalled();
    expect(open.activate).toHaveBeenCalledWith(FILE, "osOpen");

    const reveal = setup({ activation: "chip" });
    reveal.onMouseDown(makeEvent({ ctrlKey: true, shiftKey: true }));
    reveal.onMouseUp(makeEvent({ ctrlKey: true, shiftKey: true }));
    expect(reveal.showChip).not.toHaveBeenCalled();
    expect(reveal.activate).toHaveBeenCalledWith(FILE, "osReveal");
  });

  it("still ends the mousedown for the bypass combinations", () => {
    const h = setup({ activation: "chip" });
    const e = makeEvent({ ctrlKey: true });
    h.onMouseDown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
  });

  it("drops the OS action from the chip when the OS open feature is off", () => {
    const h = setup({ activation: "chip", osOpenEnabled: false });
    h.onMouseDown(makeEvent());
    h.onMouseUp(makeEvent());
    expect(h.showChip.mock.calls[0][1]).toEqual(["viewer", "copy"]);
  });

  it("does not show a chip for a drag", () => {
    const h = setup({ activation: "chip" });
    h.onMouseDown(makeEvent());
    h.onMouseUp(makeEvent({ clientX: 100 + PATH_LINK_CLICK_SLOP + 1 }));
    expect(h.showChip).not.toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("does not show a chip outside the underline", () => {
    const h = setup({ activation: "chip", inside: false });
    h.onMouseDown(makeEvent());
    h.onMouseUp(makeEvent());
    expect(h.showChip).not.toHaveBeenCalled();
  });
});

// -- ADR-0224: 칩 버튼이 밑줄 위에 겹칠 때 --

describe("createPathLinkClickHandlers — a press never arms from the chip itself", () => {
  const CHIP = { chipButton: true };

  // 칩은 탭 지점 바로 아래에 그려지므로 다음 줄의 밑줄과 겹칠 수 있고, 밑줄
  // hit-test 는 z-order 를 보지 않는다. 칩 버튼을 누른 mousedown 이 그 밑줄을
  // 무장하면 window mouseup 이 칩의 click 보다 먼저 실행된다.
  it("immediate 모드: 겹친 밑줄이 열리지 않는다", () => {
    const h = setup({ chipNode: CHIP });
    h.onMouseDown(makeEvent({ target: CHIP }));
    h.onMouseUp(makeEvent({ target: CHIP }));
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("chip 모드: 칩 대상이 교체되지 않는다", () => {
    const h = setup({ activation: "chip", chipNode: CHIP });
    h.onMouseDown(makeEvent({ target: CHIP }));
    h.onMouseUp(makeEvent({ target: CHIP }));
    expect(h.showChip).not.toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("수정자 조합도 칩 위에서는 이벤트를 종결하지 않는다", () => {
    const h = setup({ chipNode: CHIP });
    const e = makeEvent({ target: CHIP, ctrlKey: true });
    h.onMouseDown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
    h.onMouseUp(makeEvent({ target: CHIP, ctrlKey: true }));
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("칩 밖 클릭은 그대로 밑줄을 무장한다", () => {
    const h = setup({ chipNode: CHIP });
    h.onMouseDown(makeEvent({ target: { terminalCell: true } }));
    h.onMouseUp(makeEvent({ target: { terminalCell: true } }));
    expect(h.activate).toHaveBeenCalledWith(FILE, "viewer");
  });
});
