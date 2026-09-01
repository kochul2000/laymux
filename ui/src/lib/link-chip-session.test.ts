import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinkAction } from "./link-activation";
import { createLinkChipSession, type LinkChipTargetShape } from "./link-chip-session";
import type { LinkChipAnchor, LinkChipItem } from "./link-chip";

const ANCHOR: LinkChipAnchor = { left: 10, right: 10, top: 20, bottom: 20 };

const FILE: LinkChipTargetShape = {
  kind: "file",
  value: "/home/u/notes.txt",
  bufferLine: 12,
  startCol: 5,
  endCol: 20,
  token: "notes.txt",
};
const URL_TARGET: LinkChipTargetShape = {
  kind: "url",
  value: "https://example.com/x",
  bufferLine: 30,
  startCol: 1,
  endCol: 21,
  token: "https://example.com/x",
};

function setup(options: { alive?: boolean } = {}) {
  let alive = options.alive ?? true;
  let selectHandler: ((action: LinkAction) => void) | null = null;
  const shown: Array<{ anchor: LinkChipAnchor; items: readonly LinkChipItem[] }> = [];
  const insideNodes = new Set<unknown>(["chip-button"]);
  const view = {
    show: vi.fn((anchor: LinkChipAnchor, items: readonly LinkChipItem[]) => {
      shown.push({ anchor, items });
    }),
    hide: vi.fn(),
    contains: vi.fn((node: unknown) => insideNodes.has(node)),
    onSelect: vi.fn((handler: (action: LinkAction) => void) => {
      selectHandler = handler;
    }),
  };
  const run = vi.fn();
  const onDismiss = vi.fn();
  const session = createLinkChipSession({
    view,
    labelFor: (action, kind) => `${kind}:${action}`,
    run,
    isTokenAlive: () => alive,
    onDismiss,
  });
  return {
    session,
    view,
    run,
    onDismiss,
    shown,
    select: (action: LinkAction) => selectHandler?.(action),
    setAlive: (value: boolean) => {
      alive = value;
    },
  };
}

describe("createLinkChipSession — opening", () => {
  it("renders one labeled button per action", () => {
    const h = setup();
    h.session.open({ target: FILE, anchor: ANCHOR, actions: ["viewer", "osOpen", "copy"] });

    expect(h.session.isOpen()).toBe(true);
    expect(h.session.target()).toBe(FILE);
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].anchor).toBe(ANCHOR);
    expect(h.shown[0].items).toEqual([
      { action: "viewer", label: "file:viewer" },
      { action: "osOpen", label: "file:osOpen" },
      { action: "copy", label: "file:copy" },
    ]);
    // 칩을 띄우는 것만으로는 아무것도 실행되지 않는다.
    expect(h.run).not.toHaveBeenCalled();
  });

  it("replaces the previous chip — one chip at a time", () => {
    const h = setup();
    h.session.open({ target: FILE, anchor: ANCHOR, actions: ["viewer", "copy"] });
    h.session.open({ target: URL_TARGET, anchor: ANCHOR, actions: ["browser", "copy"] });

    expect(h.session.target()).toBe(URL_TARGET);
    expect(h.view.show).toHaveBeenCalledTimes(2);
    // 교체도 소멸이다 — 밀려난 대상의 자원(줄을 따라가던 마커)을 되돌린다.
    expect(h.onDismiss).toHaveBeenCalledTimes(1);
    expect(h.onDismiss).toHaveBeenCalledWith(FILE);
  });

  it("shows nothing when there is no action to offer", () => {
    const h = setup();
    h.session.open({ target: FILE, anchor: ANCHOR, actions: [] });
    expect(h.session.isOpen()).toBe(false);
    expect(h.view.show).not.toHaveBeenCalled();
  });
});

describe("createLinkChipSession — action routing", () => {
  it("runs the chosen action with the captured target and closes the chip", () => {
    const h = setup();
    h.session.open({ target: FILE, anchor: ANCHOR, actions: ["viewer", "osOpen", "copy"] });
    h.select("osOpen");

    expect(h.run).toHaveBeenCalledWith(FILE, "osOpen");
    // 확인 대화상자가 뜨는 액션에서 칩이 대화상자 뒤에 남지 않도록 먼저 거둔다.
    expect(h.view.hide).toHaveBeenCalled();
    expect(h.session.isOpen()).toBe(false);
  });

  it("ignores a selection when no chip is open", () => {
    const h = setup();
    h.select("copy");
    expect(h.run).not.toHaveBeenCalled();
  });
});

describe("createLinkChipSession — dismissal", () => {
  let h: ReturnType<typeof setup>;

  beforeEach(() => {
    h = setup();
    h.session.open({ target: FILE, anchor: ANCHOR, actions: ["viewer", "copy"] });
  });

  it("closes on Escape and consumes only that key", () => {
    expect(h.session.handleKeyDown("a")).toBe(false);
    expect(h.session.isOpen()).toBe(true);
    expect(h.session.handleKeyDown("Escape")).toBe(true);
    expect(h.session.isOpen()).toBe(false);
    // 칩이 없으면 Escape 를 소비하지 않는다 — TUI 로 그대로 흐른다.
    expect(h.session.handleKeyDown("Escape")).toBe(false);
  });

  it("closes on a pointer down outside the chip but not inside it", () => {
    h.session.handlePointerDown("chip-button");
    expect(h.session.isOpen()).toBe(true);
    h.session.handlePointerDown("terminal-cell");
    expect(h.session.isOpen()).toBe(false);
  });

  it("closes on scroll, selection, switch, resize and dispose", () => {
    for (const reason of ["scroll", "selection", "switch", "resize", "dispose"] as const) {
      const each = setup();
      each.session.open({ target: FILE, anchor: ANCHOR, actions: ["viewer", "copy"] });
      each.session.dismiss(reason);
      expect(each.session.isOpen()).toBe(false);
      expect(each.view.hide).toHaveBeenCalled();
    }
  });

  it("closes when the captured text is gone at the stable frame", () => {
    h.session.revalidate();
    expect(h.session.isOpen()).toBe(true);

    h.setAlive(false);
    h.session.revalidate();
    expect(h.session.isOpen()).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("does nothing on dismiss or revalidate when no chip is open", () => {
    h.session.dismiss("escape");
    h.view.hide.mockClear();
    h.onDismiss.mockClear();
    h.session.dismiss("escape");
    h.session.revalidate();
    expect(h.view.hide).not.toHaveBeenCalled();
    expect(h.onDismiss).not.toHaveBeenCalled();
  });

  it("hands the target back exactly once on every exit path", () => {
    // 칩이 살아 있는 동안만 붙잡는 자원(마커)이 새지 않아야 한다.
    for (const exit of [
      (s: typeof h) => s.session.dismiss("scroll"),
      (s: typeof h) => s.session.handleKeyDown("Escape"),
      (s: typeof h) => s.session.handlePointerDown("terminal-cell"),
      (s: typeof h) => s.select("viewer"),
      (s: typeof h) => {
        s.setAlive(false);
        s.session.revalidate();
      },
    ]) {
      const each = setup();
      each.session.open({ target: FILE, anchor: ANCHOR, actions: ["viewer", "copy"] });
      exit(each);
      expect(each.onDismiss).toHaveBeenCalledTimes(1);
      expect(each.onDismiss).toHaveBeenCalledWith(FILE);
    }
  });
});
