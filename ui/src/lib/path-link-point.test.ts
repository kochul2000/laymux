import { describe, it, expect, vi } from "vitest";
import { createPathLinkPointEvaluator, type PathLinkPointDeps } from "./path-link-point";
import type { CellInfo } from "./terminal-cell-map";

const asciiCells = (text: string): CellInfo[] => [...text].map((chars) => ({ chars, width: 1 }));

interface Harness {
  deps: PathLinkPointDeps;
  statPaths: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  setLine: (text: string) => void;
  setVerified: (verified: boolean) => void;
  setEnabled: (enabled: boolean) => void;
  setCwd: (cwd: string | undefined) => void;
}

function harness(
  lineText: string,
  stat: Array<{ exists: boolean; isDirectory: boolean }> = [{ exists: true, isDirectory: false }],
): Harness {
  let line = lineText;
  let verified = false;
  let enabled = true;
  let cwd: string | undefined = "/proj";
  const statPaths = vi.fn(async () => stat);
  const apply = vi.fn();
  const deps: PathLinkPointDeps = {
    getSettings: () => ({ enabled, maxPathLength: 256 }),
    getCwd: () => cwd,
    // clientX 를 1-based 컬럼으로, clientY 를 절대 버퍼 라인으로 쓰는 단순 매핑.
    resolveCell: (clientX, clientY) => ({ col: clientX, absoluteLine: clientY }),
    readLine: (absoluteLine) => (absoluteLine === 4 ? asciiCells(line) : null),
    statPaths,
    isVerifiedAt: () => verified,
    apply,
  };
  return {
    deps,
    statPaths,
    apply,
    setLine: (text) => {
      line = text;
    },
    setVerified: (value) => {
      verified = value;
    },
    setEnabled: (value) => {
      enabled = value;
    },
    setCwd: (value) => {
      cwd = value;
    },
  };
}

describe("createPathLinkPointEvaluator (ADR-0188 point 트리거)", () => {
  it("포인터 아래 토큰 하나만 stat 하고 셀 범위에 밑줄을 적용한다", async () => {
    // "cat src/a.ts" — 토큰은 컬럼 5~12.
    const h = harness("cat src/a.ts");
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(7, 4);

    expect(h.statPaths).toHaveBeenCalledTimes(1);
    expect(h.statPaths).toHaveBeenCalledWith(["/proj/src/a.ts"]);
    expect(h.apply).toHaveBeenCalledWith([
      {
        bufferLine: 5,
        startCol: 5,
        endCol: 12,
        absPath: "/proj/src/a.ts",
        token: "src/a.ts",
        isDirectory: false,
      },
    ]);
  });

  it("디렉토리는 isDirectory 로 표시한다", async () => {
    const h = harness("cd src/lib", [{ exists: true, isDirectory: true }]);
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(5, 4);

    expect(h.apply.mock.calls[0][0][0]).toMatchObject({
      absPath: "/proj/src/lib",
      isDirectory: true,
    });
  });

  it("이미 검증된 밑줄 위에서는 조회하지 않는다", async () => {
    const h = harness("cat src/a.ts");
    h.setVerified(true);
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(7, 4);

    expect(h.statPaths).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("기능이 꺼져 있으면 point 밑줄을 비우고 조회하지 않는다", async () => {
    const h = harness("cat src/a.ts");
    h.setEnabled(false);
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(7, 4);

    expect(h.statPaths).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledWith([]);
  });

  it("후보가 없는 지점(공백·읽을 수 없는 줄)은 밑줄을 비우고 조회하지 않는다", async () => {
    const h = harness("cat src/a.ts");
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(4, 4); // 공백 컬럼
    await evaluator.evaluateAt(7, 9); // 읽을 수 없는 라인

    expect(h.statPaths).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(h.apply).toHaveBeenLastCalledWith([]);
  });

  it("cwd 가 없는 상대경로는 조회하지 않는다", async () => {
    const h = harness("cat src/a.ts");
    h.setCwd(undefined);
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(7, 4);

    expect(h.statPaths).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledWith([]);
  });

  it("같은 (라인·토큰·cwd) 재방문은 조회를 반복하지 않는다", async () => {
    const h = harness("cat src/a.ts");
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(7, 4);
    await evaluator.evaluateAt(9, 4); // 같은 토큰 안의 다른 셀
    await evaluator.evaluateAt(12, 4);

    expect(h.statPaths).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it("존재하지 않는 후보도 기억해 같은 지점을 다시 조회하지 않는다", async () => {
    const h = harness("cat src/a.ts", [{ exists: false, isDirectory: false }]);
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(7, 4);
    await evaluator.evaluateAt(7, 4);

    expect(h.statPaths).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledWith([]);
  });

  it("invalidate 뒤에는 같은 지점을 다시 조회한다", async () => {
    const h = harness("cat src/a.ts");
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(7, 4);
    evaluator.invalidate();
    await evaluator.evaluateAt(7, 4);

    expect(h.statPaths).toHaveBeenCalledTimes(2);
  });

  it("cwd 가 바뀌면 같은 토큰이라도 다시 조회한다", async () => {
    const h = harness("cat src/a.ts");
    const evaluator = createPathLinkPointEvaluator(h.deps);

    await evaluator.evaluateAt(7, 4);
    h.setCwd("/other");
    await evaluator.evaluateAt(7, 4);

    expect(h.statPaths).toHaveBeenNthCalledWith(2, ["/other/src/a.ts"]);
  });

  it("조회 중 invalidate 된 결과는 적용하지 않는다", async () => {
    let release: (value: Array<{ exists: boolean; isDirectory: boolean }>) => void = () => {};
    const statPaths = vi.fn(
      () =>
        new Promise<Array<{ exists: boolean; isDirectory: boolean }>>((resolve) => {
          release = resolve;
        }),
    );
    const apply = vi.fn();
    const evaluator = createPathLinkPointEvaluator({
      getSettings: () => ({ enabled: true, maxPathLength: 256 }),
      getCwd: () => "/proj",
      resolveCell: (clientX, clientY) => ({ col: clientX, absoluteLine: clientY }),
      readLine: () => asciiCells("cat src/a.ts"),
      statPaths,
      isVerifiedAt: () => false,
      apply,
    });

    const pending = evaluator.evaluateAt(7, 4);
    evaluator.invalidate();
    release([{ exists: true, isDirectory: false }]);
    await pending;

    expect(apply).not.toHaveBeenCalled();
  });

  it("공백이 든 절대경로는 확장 후보를 한 배치로 stat 하고 존재하는 최장 후보만 적용한다 (ADR-0191)", async () => {
    // "run G:/a b/x.exe end" — 포인터는 "b/x.exe" 토큰 위(컬럼 12).
    const byPath = new Map([
      ["/proj/b/x.exe", { exists: false, isDirectory: false }],
      ["G:/a b/x.exe", { exists: true, isDirectory: false }],
      ["G:/a b/x.exe end", { exists: false, isDirectory: false }],
    ]);
    const statPaths = vi.fn(async (paths: string[]) =>
      paths.map((path) => byPath.get(path) ?? { exists: false, isDirectory: false }),
    );
    const apply = vi.fn();
    const evaluator = createPathLinkPointEvaluator({
      getSettings: () => ({ enabled: true, maxPathLength: 256 }),
      getCwd: () => "/proj",
      resolveCell: (clientX, clientY) => ({ col: clientX, absoluteLine: clientY }),
      readLine: () => asciiCells("run G:/a b/x.exe end"),
      statPaths,
      isVerifiedAt: () => false,
      apply,
    });

    await evaluator.evaluateAt(12, 4);

    // 후보 3개(포인터 토큰 + 확장 접두 2개)가 배치 1회로 나간다.
    expect(statPaths).toHaveBeenCalledTimes(1);
    expect(statPaths).toHaveBeenCalledWith(["/proj/b/x.exe", "G:/a b/x.exe", "G:/a b/x.exe end"]);
    // 존재하는 후보 중 가장 긴 것 하나만 밑줄이 된다.
    expect(apply).toHaveBeenCalledWith([
      {
        bufferLine: 5,
        startCol: 5,
        endCol: 16,
        absPath: "G:/a b/x.exe",
        token: "G:/a b/x.exe",
        isDirectory: false,
      },
    ]);
  });

  it("존재하는 접두 디렉토리와 전체 경로가 겹치면 긴 쪽이 이긴다", async () => {
    const byPath = new Map([
      ["G:/my dir", { exists: true, isDirectory: true }],
      ["G:/my dir name", { exists: true, isDirectory: true }],
    ]);
    const statPaths = vi.fn(async (paths: string[]) =>
      paths.map((path) => byPath.get(path) ?? { exists: false, isDirectory: false }),
    );
    const apply = vi.fn();
    const evaluator = createPathLinkPointEvaluator({
      getSettings: () => ({ enabled: true, maxPathLength: 256 }),
      getCwd: () => "/proj",
      resolveCell: (clientX, clientY) => ({ col: clientX, absoluteLine: clientY }),
      readLine: () => asciiCells("G:/my dir name"),
      statPaths,
      isVerifiedAt: () => false,
      apply,
    });

    await evaluator.evaluateAt(8, 4); // "dir" 토큰 위

    expect(apply).toHaveBeenCalledWith([
      expect.objectContaining({ absPath: "G:/my dir name", isDirectory: true }),
    ]);
    expect(apply.mock.calls[0][0]).toHaveLength(1);
  });

  it("한글이 앞에 있으면 밑줄을 셀 기준으로 보정한다", async () => {
    const h = harness("");
    const evaluator = createPathLinkPointEvaluator({
      ...h.deps,
      // "한 src/a.ts" — 한글(셀 1~2) + 공백(3) + 토큰(셀 4~11).
      readLine: () => [
        { chars: "한", width: 2 },
        { chars: "", width: 0 },
        ...asciiCells(" src/a.ts"),
      ],
    });

    await evaluator.evaluateAt(6, 4);

    expect(h.apply.mock.calls[0][0][0]).toMatchObject({ startCol: 4, endCol: 11 });
  });
});

describe("createPathLinkPointEvaluator 상수", () => {
  it("hover dwell 지연은 300ms 다", async () => {
    const { PATH_LINK_HOVER_DWELL_MS } = await import("./path-link-point");
    expect(PATH_LINK_HOVER_DWELL_MS).toBe(300);
  });

  it("조회 중 cwd 가 바뀐 결과는 적용하지 않는다", async () => {
    let release: (value: Array<{ exists: boolean; isDirectory: boolean }>) => void = () => {};
    const apply = vi.fn();
    let cwd = "/proj";
    const evaluator = createPathLinkPointEvaluator({
      getSettings: () => ({ enabled: true, maxPathLength: 256 }),
      getCwd: () => cwd,
      resolveCell: (clientX, clientY) => ({ col: clientX, absoluteLine: clientY }),
      readLine: () => asciiCells("cat src/a.ts"),
      statPaths: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      isVerifiedAt: () => false,
      apply,
    });

    const pending = evaluator.evaluateAt(7, 4);
    cwd = "/other";
    release([{ exists: true, isDirectory: false }]);
    await pending;

    expect(apply).not.toHaveBeenCalled();
  });
});

describe("createPathLinkPointEvaluator 중복 조회 방지 (ADR-0188)", () => {
  function slowHarness() {
    const releases: Array<(value: Array<{ exists: boolean; isDirectory: boolean }>) => void> = [];
    const statPaths = vi.fn(
      () =>
        new Promise<Array<{ exists: boolean; isDirectory: boolean }>>((resolve) => {
          releases.push(resolve);
        }),
    );
    const apply = vi.fn();
    const evaluator = createPathLinkPointEvaluator({
      getSettings: () => ({ enabled: true, maxPathLength: 256 }),
      getCwd: () => "/proj",
      resolveCell: (clientX, clientY) => ({ col: clientX, absoluteLine: clientY }),
      readLine: () => asciiCells("cat src/a.ts"),
      statPaths,
      isVerifiedAt: () => false,
      apply,
    });
    return { evaluator, statPaths, apply, releases };
  }

  it("조회가 아직 도는 중이면 같은 지점을 다시 조회하지 않는다", async () => {
    const h = slowHarness();

    const first = h.evaluator.evaluateAt(7, 4);
    // 느린 stat 이 도는 동안 dwell 이 같은 토큰 안에서 다시 발동한다.
    await h.evaluator.evaluateAt(9, 4);
    await h.evaluator.evaluateAt(11, 4);
    expect(h.statPaths).toHaveBeenCalledTimes(1);

    h.releases[0]([{ exists: true, isDirectory: false }]);
    await first;
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it("조회가 실패로 끝나면 in-flight 표시를 풀어 다시 시도할 수 있다", async () => {
    const statPaths = vi.fn().mockRejectedValueOnce(new Error("IPC lost"));
    const apply = vi.fn();
    const evaluator = createPathLinkPointEvaluator({
      getSettings: () => ({ enabled: true, maxPathLength: 256 }),
      getCwd: () => "/proj",
      resolveCell: (clientX, clientY) => ({ col: clientX, absoluteLine: clientY }),
      readLine: () => asciiCells("cat src/a.ts"),
      statPaths,
      isVerifiedAt: () => false,
      apply,
    });

    await evaluator.evaluateAt(7, 4);
    statPaths.mockResolvedValueOnce([{ exists: true, isDirectory: false }]);
    await evaluator.evaluateAt(7, 4);

    expect(statPaths).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith([
      expect.objectContaining({ absPath: "/proj/src/a.ts" }),
    ]);
  });

  it("forget 은 memo 만 지우고 진행 중 조회 결과는 살린다", async () => {
    const h = slowHarness();

    const pending = h.evaluator.evaluateAt(7, 4);
    // 출력이 도착한다 — 화면이 달라질 수 있으니 음성 memo 는 못 믿지만,
    // 진행 중 조회를 죽이면 출력이 잦은 pane 에서 밑줄이 영원히 안 켜진다.
    h.evaluator.forget();
    h.releases[0]([{ exists: true, isDirectory: false }]);
    await pending;

    expect(h.apply).toHaveBeenCalledWith([
      expect.objectContaining({ absPath: "/proj/src/a.ts", token: "src/a.ts" }),
    ]);
  });

  it("음성 결과는 forget 뒤 같은 지점에서 다시 조회된다", async () => {
    const statPaths = vi.fn().mockResolvedValue([{ exists: false, isDirectory: false }]);
    const apply = vi.fn();
    const evaluator = createPathLinkPointEvaluator({
      getSettings: () => ({ enabled: true, maxPathLength: 256 }),
      getCwd: () => "/proj",
      resolveCell: (clientX, clientY) => ({ col: clientX, absoluteLine: clientY }),
      readLine: () => asciiCells("cat src/a.ts"),
      statPaths,
      isVerifiedAt: () => false,
      apply,
    });

    await evaluator.evaluateAt(7, 4);
    await evaluator.evaluateAt(7, 4);
    expect(statPaths).toHaveBeenCalledTimes(1);

    // `touch src/a.ts` 같은 출력 뒤에는 같은 지점이 이제 파일일 수 있다.
    evaluator.forget();
    await evaluator.evaluateAt(7, 4);
    expect(statPaths).toHaveBeenCalledTimes(2);
  });
});
