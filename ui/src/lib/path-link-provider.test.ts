import { describe, it, expect, vi } from "vitest";
import type { Terminal, ILink } from "@xterm/xterm";
import { createPathLinkProvider } from "./path-link-provider";

/** provideLinks 는 terminal 을 직접 쓰지 않으므로 빈 mock 으로 충분. */
function makeTerminal(): Terminal {
  return {} as unknown as Terminal;
}

function provide(
  provider: ReturnType<typeof createPathLinkProvider>["provider"],
  line: number,
): ILink[] | undefined {
  let result: ILink[] | undefined;
  provider.provideLinks(line, (links) => {
    result = links;
  });
  return result;
}

describe("createPathLinkProvider (선택 기반)", () => {
  it("검증된 선택이 없으면 어떤 줄도 링크를 반환하지 않는다", () => {
    const ctrl = createPathLinkProvider(makeTerminal(), {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
    });
    expect(provide(ctrl.provider, 1)).toBeUndefined();
    expect(provide(ctrl.provider, 5)).toBeUndefined();
  });

  it("검증된 선택 줄에만 ILink 를 반환하고 다른 줄은 미반환한다", () => {
    const ctrl = createPathLinkProvider(makeTerminal(), {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
    });
    ctrl.setVerifiedSelection({
      bufferLine: 3,
      startCol: 5,
      endCol: 20,
      absPath: "/proj/src/a.ts",
      isDirectory: false,
    });

    expect(provide(ctrl.provider, 2)).toBeUndefined();
    expect(provide(ctrl.provider, 4)).toBeUndefined();

    const links = provide(ctrl.provider, 3);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe("/proj/src/a.ts");
    expect(links![0].range.start).toEqual({ x: 5, y: 3 });
    expect(links![0].range.end).toEqual({ x: 20, y: 3 });
  });

  it("파일 선택 클릭은 onOpenPath 로 라우팅한다", () => {
    const onOpenPath = vi.fn();
    const onChangeDir = vi.fn();
    const ctrl = createPathLinkProvider(makeTerminal(), { onOpenPath, onChangeDir });
    ctrl.setVerifiedSelection({
      bufferLine: 1,
      startCol: 1,
      endCol: 10,
      absPath: "/proj/a.ts",
      isDirectory: false,
    });
    const links = provide(ctrl.provider, 1)!;
    links[0].activate({} as MouseEvent, links[0].text);
    expect(onOpenPath).toHaveBeenCalledWith("/proj/a.ts");
    expect(onChangeDir).not.toHaveBeenCalled();
  });

  it("디렉토리 선택 클릭은 onChangeDir 로 라우팅한다", () => {
    const onOpenPath = vi.fn();
    const onChangeDir = vi.fn();
    const ctrl = createPathLinkProvider(makeTerminal(), { onOpenPath, onChangeDir });
    ctrl.setVerifiedSelection({
      bufferLine: 1,
      startCol: 1,
      endCol: 10,
      absPath: "/proj/src",
      isDirectory: true,
    });
    const links = provide(ctrl.provider, 1)!;
    links[0].activate({} as MouseEvent, links[0].text);
    expect(onChangeDir).toHaveBeenCalledWith("/proj/src");
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it("clear() 후에는 더 이상 링크를 반환하지 않는다", () => {
    const ctrl = createPathLinkProvider(makeTerminal(), {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
    });
    ctrl.setVerifiedSelection({
      bufferLine: 2,
      startCol: 1,
      endCol: 5,
      absPath: "/x",
      isDirectory: false,
    });
    expect(provide(ctrl.provider, 2)).toHaveLength(1);
    ctrl.clear();
    expect(provide(ctrl.provider, 2)).toBeUndefined();
    expect(ctrl.getCurrent()).toBeNull();
  });

  it("setVerifiedSelection 으로 범위를 갱신하면 새 줄에만 링크가 뜬다", () => {
    const ctrl = createPathLinkProvider(makeTerminal(), {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
    });
    ctrl.setVerifiedSelection({
      bufferLine: 2,
      startCol: 1,
      endCol: 5,
      absPath: "/a",
      isDirectory: false,
    });
    ctrl.setVerifiedSelection({
      bufferLine: 7,
      startCol: 3,
      endCol: 9,
      absPath: "/b",
      isDirectory: false,
    });
    expect(provide(ctrl.provider, 2)).toBeUndefined();
    expect(provide(ctrl.provider, 7)).toHaveLength(1);
  });
});
