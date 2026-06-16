import { describe, it, expect, vi } from "vitest";
import type { Terminal, ILink } from "@xterm/xterm";
import { PathValidationCache, createPathLinkProvider } from "./path-link-provider";

describe("PathValidationCache", () => {
  it("미조회 경로는 ensure 시 pending 을 반환하고 검증을 시작한다", async () => {
    const validate = vi.fn().mockResolvedValue(true);
    const cache = new PathValidationCache(validate);
    const onDone = vi.fn();

    expect(cache.get("/a/b.txt")).toBeUndefined();
    expect(cache.ensure("/a/b.txt", onDone)).toBe("pending");
    expect(validate).toHaveBeenCalledWith("/a/b.txt");

    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(cache.get("/a/b.txt")).toBe("valid");
  });

  it("존재하지 않는 경로는 invalid 로 캐시한다", async () => {
    const cache = new PathValidationCache(vi.fn().mockResolvedValue(false));
    const onDone = vi.fn();
    cache.ensure("/missing", onDone);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(cache.get("/missing")).toBe("invalid");
  });

  it("검증 함수가 throw 하면 invalid 로 취급한다", async () => {
    const cache = new PathValidationCache(vi.fn().mockRejectedValue(new Error("boom")));
    const onDone = vi.fn();
    cache.ensure("/err", onDone);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(cache.get("/err")).toBe("invalid");
  });

  it("동일 경로를 다시 ensure 해도 검증을 중복 실행하지 않는다", async () => {
    const validate = vi.fn().mockResolvedValue(true);
    const cache = new PathValidationCache(validate);
    cache.ensure("/a", () => {});
    cache.ensure("/a", () => {});
    expect(validate).toHaveBeenCalledTimes(1);
  });
});

/** getLine().translateToString() 만 제공하는 최소 Terminal mock. */
function makeTerminal(lineText: string): Terminal {
  return {
    buffer: {
      active: {
        getLine: (_y: number) => ({ translateToString: () => lineText }),
      },
    },
  } as unknown as Terminal;
}

function provide(
  provider: ReturnType<typeof createPathLinkProvider>,
  line: number,
): ILink[] | undefined {
  let result: ILink[] | undefined;
  provider.provideLinks(line, (links) => {
    result = links;
  });
  return result;
}

describe("createPathLinkProvider", () => {
  it("유효한 경로만 링크로 등록한다(밑줄). 무효 경로는 미등록", async () => {
    const validate = vi.fn(async (p: string) => p.endsWith("good.ts"));
    const onValidated = vi.fn();
    const terminal = makeTerminal("see src/good.ts and src/bad.ts");
    const provider = createPathLinkProvider(terminal, {
      getCwd: () => "/proj",
      validate,
      onOpenPath: vi.fn(),
      onValidated,
    });

    // 1차: 캐시 미스 → pending, 링크 없음.
    expect(provide(provider, 1)).toBeUndefined();

    // 검증 완료 대기.
    await vi.waitFor(() => expect(onValidated).toHaveBeenCalled());

    // 2차: good.ts 만 링크로 등록.
    const links = provide(provider, 1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe("src/good.ts");
  });

  it("클릭 시 cwd 와 조합한 절대 경로로 onOpenPath 를 호출한다", async () => {
    const onOpenPath = vi.fn();
    const terminal = makeTerminal("edit src/good.ts");
    const provider = createPathLinkProvider(terminal, {
      getCwd: () => "/proj",
      validate: vi.fn().mockResolvedValue(true),
      onOpenPath,
      onValidated: vi.fn(),
    });
    provide(provider, 1); // 검증 시작
    await vi.waitFor(() => {
      const links = provide(provider, 1);
      expect(links).toHaveLength(1);
    });
    const links = provide(provider, 1)!;
    links[0].activate({} as MouseEvent, links[0].text);
    expect(onOpenPath).toHaveBeenCalledWith("/proj/src/good.ts");
  });

  it("cwd 가 없으면 상대경로는 검증조차 하지 않는다", () => {
    const validate = vi.fn();
    const terminal = makeTerminal("src/good.ts");
    const provider = createPathLinkProvider(terminal, {
      getCwd: () => undefined,
      validate,
      onOpenPath: vi.fn(),
    });
    expect(provide(provider, 1)).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
  });

  it("isEnabled 가 false 면 아무 링크도 만들지 않는다", () => {
    const validate = vi.fn();
    const terminal = makeTerminal("src/good.ts");
    const provider = createPathLinkProvider(terminal, {
      getCwd: () => "/proj",
      validate,
      onOpenPath: vi.fn(),
      isEnabled: () => false,
    });
    expect(provide(provider, 1)).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
  });

  it("절대 경로는 cwd 없이도 검증/등록한다", async () => {
    const terminal = makeTerminal("open /etc/hosts");
    const provider = createPathLinkProvider(terminal, {
      getCwd: () => undefined,
      validate: vi.fn().mockResolvedValue(true),
      onOpenPath: vi.fn(),
      onValidated: vi.fn(),
    });
    provide(provider, 1);
    await vi.waitFor(() => {
      const links = provide(provider, 1);
      expect(links?.[0]?.text).toBe("/etc/hosts");
    });
  });
});
