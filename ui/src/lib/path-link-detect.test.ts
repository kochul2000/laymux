import { describe, it, expect } from "vitest";
import {
  extractPathCandidatesFromSelection,
  isPathLinkCwdCurrent,
  joinCwdPath,
  mapSelectionCandidateToPathRange,
  normalizeMsysCwd,
  trimSelectionToPath,
  isWithinPathLengthLimit,
  decidePathLinkAction,
  mapSelectionToPathRange,
  extractPathCandidateAtOffset,
  extractPathCandidatesFromScreen,
  mapLineCandidateToPathRange,
} from "./path-link-detect";

describe("isPathLinkCwdCurrent", () => {
  it("stat 대기 중 CWD가 바뀐 요청만 stale로 판정한다", () => {
    expect(isPathLinkCwdCurrent("/work/a", "/work/a")).toBe(true);
    expect(isPathLinkCwdCurrent("/work/a", "/work/b")).toBe(false);
    expect(isPathLinkCwdCurrent(undefined, undefined)).toBe(true);
  });
});

describe("extractPathCandidatesFromSelection", () => {
  const options = {
    maxSelectionLength: 1024,
    maxLines: 8,
    maxCandidates: 16,
    maxPathLength: 256,
  };

  it("넓은 선택에서 서로 떨어진 복수 경로를 원문 범위와 함께 찾는다", () => {
    expect(
      extractPathCandidatesFromSelection(
        "diff ui/src/App.tsx against ui/src/App.test.tsx",
        options,
      ),
    ).toEqual([
      { text: "ui/src/App.tsx", lineIndex: 0, startIndex: 5, endIndex: 19 },
      { text: "ui/src/App.test.tsx", lineIndex: 0, startIndex: 28, endIndex: 47 },
    ]);
  });

  it("최장 토큰을 소비하고 내부 suffix를 별도 후보로 재해석하지 않는다", () => {
    expect(
      extractPathCandidatesFromSelection(
        "error src/components/views/TerminalView.tsx:1450",
        options,
      ),
    ).toEqual([
      {
        text: "src/components/views/TerminalView.tsx",
        lineIndex: 0,
        startIndex: 6,
        endIndex: 43,
      },
    ]);
  });

  it("최장 후보가 stat에 실패할 수 있어도 내부 경로 후보를 만들지 않는다", () => {
    expect(extractPathCandidatesFromSelection("prefix:src/main.rs", options)).toEqual([
      {
        text: "prefix:src/main.rs",
        lineIndex: 0,
        startIndex: 0,
        endIndex: 18,
      },
    ]);
  });

  it("경로:줄번호 뒤에 문장이 붙은 입력을 재현한다", () => {
    expect(
      extractPathCandidatesFromSelection(
        "orchestrator/src/mdb_orchestrator/graphs/task_types/dd_generate/phases/design_assembly/routing_axis.py:126에서",
        options,
      ),
    ).toEqual([
      {
        text: "orchestrator/src/mdb_orchestrator/graphs/task_types/dd_generate/phases/design_assembly/routing_axis.py",
        lineIndex: 0,
        startIndex: 0,
        endIndex: 102,
      },
    ]);
  });

  it("줄번호·열번호와 뒤의 문장을 함께 제거한다", () => {
    expect(extractPathCandidatesFromSelection("src/main.py:126:9에서", options)).toEqual([
      { text: "src/main.py", lineIndex: 0, startIndex: 0, endIndex: 11 },
    ]);
  });

  it("Windows 절대경로의 줄번호 접미사를 제거한다", () => {
    expect(
      extractPathCandidatesFromSelection(String.raw`C:\work\src\main.py:126에서`, options),
    ).toEqual([
      { text: String.raw`C:\work\src\main.py`, lineIndex: 0, startIndex: 0, endIndex: 19 },
    ]);
  });

  it("슬래시가 앞에 붙은 Windows 절대경로를 드라이브 경로로 정규화한다", () => {
    expect(
      extractPathCandidatesFromSelection(
        "/D:/PycharmProjects/laymux-dev/apps/android/app/src/main/assets/index.html:17",
        options,
      ),
    ).toEqual([
      {
        text: "D:/PycharmProjects/laymux-dev/apps/android/app/src/main/assets/index.html",
        lineIndex: 0,
        startIndex: 1,
        endIndex: 74,
      },
    ]);
  });

  it("한 선택 안의 여러 경로에서 각 줄번호 접미사를 독립적으로 제거한다", () => {
    expect(extractPathCandidatesFromSelection("src/a.ts:1에서 src/b.ts:2에서", options)).toEqual([
      { text: "src/a.ts", lineIndex: 0, startIndex: 0, endIndex: 8 },
      { text: "src/b.ts", lineIndex: 0, startIndex: 13, endIndex: 21 },
    ]);
  });

  it("포트가 있는 URL을 경로 후보로 만들지 않는다", () => {
    expect(
      extractPathCandidatesFromSelection("https://example.com:443/src/main.ts", options),
    ).toEqual([]);
  });

  it("넓은 선택에서는 강한 형태만 찾고 단일 토큰 선택은 맨이름도 유지한다", () => {
    expect(extractPathCandidatesFromSelection("open laymux then Cargo.toml", options)).toEqual([
      { text: "Cargo.toml", lineIndex: 0, startIndex: 17, endIndex: 27 },
    ]);
    expect(extractPathCandidatesFromSelection("laymux", options)).toEqual([
      { text: "laymux", lineIndex: 0, startIndex: 0, endIndex: 6 },
    ]);
  });

  it("URL 전체를 소비하고 그 안의 경로 모양 suffix를 재해석하지 않는다", () => {
    expect(
      extractPathCandidatesFromSelection(
        "see https://example.com/src/main.rs and ui/src/App.tsx",
        options,
      ),
    ).toEqual([{ text: "ui/src/App.tsx", lineIndex: 0, startIndex: 40, endIndex: 54 }]);
  });

  it("여러 줄의 후보를 순서대로 찾는다", () => {
    expect(extractPathCandidatesFromSelection("first src/a.ts\nthen src/b.ts", options)).toEqual([
      { text: "src/a.ts", lineIndex: 0, startIndex: 6, endIndex: 14 },
      { text: "src/b.ts", lineIndex: 1, startIndex: 5, endIndex: 13 },
    ]);
  });

  it("선택 길이·줄 수·후보 수 상한을 넘으면 전체 검사를 생략한다", () => {
    expect(extractPathCandidatesFromSelection("x".repeat(1025), options)).toEqual([]);
    expect(extractPathCandidatesFromSelection("a.ts\n".repeat(8) + "b.ts", options)).toEqual([]);
    expect(
      extractPathCandidatesFromSelection(
        Array.from({ length: 17 }, (_, index) => `f${index}.ts`).join(" "),
        options,
      ),
    ).toEqual([]);
  });

  it("개별 경로 길이 상한을 넘는 maximal token은 내부 fallback 없이 버린다", () => {
    expect(
      extractPathCandidatesFromSelection("before very/long/path.ts after ok.ts", {
        ...options,
        maxPathLength: 10,
      }),
    ).toEqual([{ text: "ok.ts", lineIndex: 0, startIndex: 31, endIndex: 36 }]);
  });
});

describe("mapSelectionCandidateToPathRange", () => {
  it("첫 줄과 다음 줄 후보의 선택 상대 좌표를 절대 버퍼 좌표로 바꾼다", () => {
    const pos = { start: { x: 4, y: 10 }, end: { x: 12, y: 11 } };
    expect(
      mapSelectionCandidateToPathRange(pos, {
        text: "src/a.ts",
        lineIndex: 0,
        startIndex: 6,
        endIndex: 14,
      }),
    ).toEqual({ bufferLine: 11, startCol: 11, endCol: 18 });
    expect(
      mapSelectionCandidateToPathRange(pos, {
        text: "src/b.ts",
        lineIndex: 1,
        startIndex: 5,
        endIndex: 13,
      }),
    ).toEqual({ bufferLine: 12, startCol: 6, endCol: 13 });
  });

  it("셀 정보가 있으면 와이드 문자 앞의 실제 셀 컬럼을 사용한다", () => {
    const ascii = (text: string) => [...text].map((chars) => ({ chars, width: 1 }));
    const cells = [
      { chars: "한", width: 2 },
      { chars: "", width: 0 },
      { chars: "글", width: 2 },
      { chars: "", width: 0 },
      ...ascii(" src/a.ts"),
    ];
    const pos = { start: { x: 0, y: 2 }, end: { x: 13, y: 2 } };
    expect(
      mapSelectionCandidateToPathRange(
        pos,
        { text: "src/a.ts", lineIndex: 0, startIndex: 3, endIndex: 11 },
        cells,
      ),
    ).toEqual({ bufferLine: 3, startCol: 6, endCol: 13 });
  });
});

describe("joinCwdPath", () => {
  it("절대 경로는 cwd 와 무관하게 그대로 반환한다", () => {
    expect(joinCwdPath("/home/me/proj", "/etc/hosts")).toBe("/etc/hosts");
    expect(joinCwdPath("C:\\proj", "D:\\x\\y.txt")).toBe("D:\\x\\y.txt");
  });

  it("Unix cwd 와 상대경로를 슬래시로 조합한다", () => {
    expect(joinCwdPath("/home/me/proj", "ui/src/index.css")).toBe("/home/me/proj/ui/src/index.css");
  });

  it("cwd 끝 슬래시 중복을 정리한다", () => {
    expect(joinCwdPath("/home/me/proj/", "a/b.txt")).toBe("/home/me/proj/a/b.txt");
  });

  it("Windows cwd 와 상대경로를 백슬래시로 조합한다", () => {
    expect(joinCwdPath("C:\\proj", "ui\\src\\index.css")).toBe("C:\\proj\\ui\\src\\index.css");
  });

  it("Windows cwd + 슬래시 상대경로는 백슬래시로 정규화한다", () => {
    expect(joinCwdPath("C:\\proj", "ui/src/index.css")).toBe("C:\\proj\\ui\\src\\index.css");
  });

  it("cwd 가 없으면 null 을 반환한다", () => {
    expect(joinCwdPath(undefined, "a/b.txt")).toBeNull();
    expect(joinCwdPath("", "a/b.txt")).toBeNull();
  });

  it("MSYS/git-bash cwd(/d/proj)는 Windows 드라이브로 변환해 백슬래시 조합한다", () => {
    expect(joinCwdPath("/d/PycharmProjects/laymux", "ui/src/index.css")).toBe(
      "D:\\PycharmProjects\\laymux\\ui\\src\\index.css",
    );
    expect(joinCwdPath("/c/Users/me", "a/b.txt")).toBe("C:\\Users\\me\\a\\b.txt");
  });

  it("PowerShell cwd(D:\\...)는 백슬래시로 조합한다(end-to-end)", () => {
    expect(joinCwdPath("D:\\PycharmProjects\\laymux", "ui/src/index.css")).toBe(
      "D:\\PycharmProjects\\laymux\\ui\\src\\index.css",
    );
  });

  it("POSIX cwd(/home/...)는 슬래시로 조합한다(변환하지 않음)", () => {
    expect(joinCwdPath("/home/me/proj", "src/a.ts")).toBe("/home/me/proj/src/a.ts");
  });

  it("WSL UNC cwd(\\\\wsl.localhost\\...)는 그대로 백슬래시 조합(깨지지 않음)", () => {
    expect(joinCwdPath("\\\\wsl.localhost\\Ubuntu\\home\\me", "a/b.txt")).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\a\\b.txt",
    );
  });

  it("/mnt/ 로 시작하는 WSL 마운트 cwd 는 드라이브 변환하지 않는다", () => {
    expect(joinCwdPath("/mnt/d/proj", "a/b.txt")).toBe("/mnt/d/proj/a/b.txt");
  });
});

describe("normalizeMsysCwd", () => {
  it("/<drive>/... 를 X:\\... 로 변환한다", () => {
    expect(normalizeMsysCwd("/d/PycharmProjects")).toBe("D:\\PycharmProjects");
    expect(normalizeMsysCwd("/c/Users/me")).toBe("C:\\Users\\me");
  });

  it("드라이브 루트(/d)도 X:\\ 로 변환한다", () => {
    expect(normalizeMsysCwd("/d")).toBe("D:");
    expect(normalizeMsysCwd("/d/")).toBe("D:\\");
  });

  it("/mnt/ 마운트는 변환하지 않는다", () => {
    expect(normalizeMsysCwd("/mnt/d/proj")).toBe("/mnt/d/proj");
  });

  it("일반 POSIX/Windows/UNC 경로는 그대로 둔다", () => {
    expect(normalizeMsysCwd("/home/me/proj")).toBe("/home/me/proj");
    expect(normalizeMsysCwd("D:\\proj")).toBe("D:\\proj");
    expect(normalizeMsysCwd("\\\\wsl.localhost\\Ubuntu")).toBe("\\\\wsl.localhost\\Ubuntu");
  });
});

describe("trimSelectionToPath", () => {
  it("경로처럼 보이는 선택은 정리해 반환한다", () => {
    expect(trimSelectionToPath("ui/src/index.css")).toBe("ui/src/index.css");
    expect(trimSelectionToPath("  ui/src/index.css  ")).toBe("ui/src/index.css");
  });

  it("따옴표/괄호/grep 꼬리를 떼어낸다", () => {
    expect(trimSelectionToPath('"ui/src/app.tsx"')).toBe("ui/src/app.tsx");
    expect(trimSelectionToPath("ui/src/main.ts:42:5")).toBe("ui/src/main.ts");
  });

  it("절대 경로도 그대로 인정한다", () => {
    expect(trimSelectionToPath("/etc/hosts")).toBe("/etc/hosts");
  });

  it("슬래시가 앞에 붙은 Windows 드라이브 경로의 슬래시를 제거한다", () => {
    expect(trimSelectionToPath("/D:/work/src/main.ts:17")).toBe("D:/work/src/main.ts");
  });

  it("공백이 끼어 여러 토큰이면 경로 한 건으로 보지 않는다", () => {
    expect(trimSelectionToPath("ui/src a.ts")).toBeNull();
  });

  it("슬래시·확장자 없는 맨이름도 후보로 받는다(선택 기반, stat 이 게이트)", () => {
    // ls 출력의 디렉토리/확장자 없는 파일명: laymux, v3, class …
    expect(trimSelectionToPath("laymux")).toBe("laymux");
    expect(trimSelectionToPath("v3")).toBe("v3");
    expect(trimSelectionToPath("  fibonacci.py  ")).toBe("fibonacci.py");
  });

  it("URL 스킴은 제외(WebLinks 담당), 빈 선택은 null", () => {
    expect(trimSelectionToPath("https://example.com")).toBeNull();
    expect(trimSelectionToPath("")).toBeNull();
  });

  it("여러 줄 선택은 첫 줄만 사용한다", () => {
    expect(trimSelectionToPath("src/a.ts\nsrc/b.ts")).toBe("src/a.ts");
  });
});

describe("isWithinPathLengthLimit", () => {
  it("길이 이내면 true, 초과면 false", () => {
    expect(isWithinPathLengthLimit("abc", 8)).toBe(true);
    expect(isWithinPathLengthLimit("123456789", 8)).toBe(false);
  });

  it("빈 문자열은 false", () => {
    expect(isWithinPathLengthLimit("", 8)).toBe(false);
  });
});

describe("decidePathLinkAction", () => {
  it("존재하지 않으면 none", () => {
    expect(decidePathLinkAction({ exists: false, isDirectory: false })).toBe("none");
  });
  it("디렉토리면 changeDir", () => {
    expect(decidePathLinkAction({ exists: true, isDirectory: true })).toBe("changeDir");
  });
  it("파일이면 openFile", () => {
    expect(decidePathLinkAction({ exists: true, isDirectory: false })).toBe("openFile");
  });
});

describe("mapSelectionToPathRange", () => {
  // 핵심 회귀(#363): xterm getSelectionPosition() 은 0-based·end exclusive,
  // provider 는 1-based 절대 버퍼 라인 → +1 보정이 없으면 밑줄이 좌상단으로 밀린다.
  it("0-based 선택을 1-based 절대 버퍼 좌표로 보정한다 (선택 전체)", () => {
    // 버퍼 라인 5(0-based 4)에서 컬럼 2~9(0-based) 선택, end exclusive=10.
    const pos = { start: { x: 2, y: 4 }, end: { x: 10, y: 4 } };
    const r = mapSelectionToPathRange(pos, "  src/a.ts", "src/a.ts");
    // 토큰 "src/a.ts" 가 raw 첫 줄에서 인덱스 2 → 시작 0-based 2+2=4, 1-based 5.
    expect(r.bufferLine).toBe(5); // y 4 → 5
    expect(r.startCol).toBe(5); // (2+2)+1
    expect(r.endCol).toBe(12); // 4 + len(8) - 1 = 11, +1 = 12
  });

  it("토큰을 못 찾으면 선택 전체 폭을 1-based 로 매핑", () => {
    const pos = { start: { x: 0, y: 0 }, end: { x: 5, y: 0 } };
    const r = mapSelectionToPathRange(pos, "abc", "zzz");
    expect(r.bufferLine).toBe(1); // y 0 → 1
    expect(r.startCol).toBe(1); // 0 → 1
    expect(r.endCol).toBe(5); // end exclusive 5 → 마지막 셀 4(0-based) → 1-based 5
  });

  // #691: 셀 정보를 주면 와이드 문자(한글/CJK/이모지)를 셀 단위로 매핑한다.
  // 문자 수로 계산하면 한글 경로의 밑줄이 절반 길이로 그어진다.
  describe("셀 정보가 주어지면 (#691)", () => {
    const ascii = (text: string) => [...text].map((c) => ({ chars: c, width: 1 }));
    const wide = (char: string) => [
      { chars: char, width: 2 },
      { chars: "", width: 0 },
    ];
    const cellsOf = (parts: { chars: string; width: number }[][]) => parts.flat();

    it("경로 전체가 한글이면 밑줄이 두 배 폭을 덮는다", () => {
      // 화면: "한글" (셀 1~4). 선택은 셀 0-based 0 에서 시작.
      const cells = cellsOf([wide("한"), wide("글")]);
      const pos = { start: { x: 0, y: 0 }, end: { x: 2, y: 0 } };
      const r = mapSelectionToPathRange(pos, "한글", "한글", cells);
      expect(r.startCol).toBe(1);
      expect(r.endCol).toBe(4); // 문자 수(2)가 아니라 셀 수(4)
    });

    it("앞선 한글이 시작 컬럼을 밀어낸다", () => {
      // 화면: "한글 src/a.ts" — "한글"(셀 1~4) + 공백(5) + 토큰(셀 6~13)
      const cells = cellsOf([wide("한"), wide("글"), ascii(" src/a.ts")]);
      const pos = { start: { x: 5, y: 3 }, end: { x: 13, y: 3 } };
      const r = mapSelectionToPathRange(pos, "src/a.ts", "src/a.ts", cells);
      expect(r.bufferLine).toBe(4);
      expect(r.startCol).toBe(6);
      expect(r.endCol).toBe(13);
    });

    it("한글 디렉터리 + ASCII 파일명을 끝까지 덮는다", () => {
      // "문서/a.txt" — 문서(셀 1~4) + "/a.txt"(셀 5~10)
      const cells = cellsOf([wide("문"), wide("서"), ascii("/a.txt")]);
      const pos = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
      const r = mapSelectionToPathRange(pos, "문서/a.txt", "문서/a.txt", cells);
      expect(r.startCol).toBe(1);
      expect(r.endCol).toBe(10);
    });

    it("이모지(서로게이트 페어)도 셀 기준으로 끝난다", () => {
      const cells = cellsOf([ascii("a"), wide("😀"), ascii("b")]);
      const pos = { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } };
      const r = mapSelectionToPathRange(pos, "a😀b", "a😀b", cells);
      expect(r.startCol).toBe(1);
      expect(r.endCol).toBe(4); // a(1) + 이모지(2~3) + b(4)
    });

    it("같은 토큰이 여러 번 나오면 선택 시작에 가까운 쪽을 쓴다", () => {
      // "a.txt 한 a.txt" — 두 번째 토큰(셀 9~13)을 선택했다.
      const cells = cellsOf([ascii("a.txt "), wide("한"), ascii(" a.txt")]);
      const pos = { start: { x: 9, y: 0 }, end: { x: 14, y: 0 } };
      const r = mapSelectionToPathRange(pos, "a.txt", "a.txt", cells);
      expect(r.startCol).toBe(10);
      expect(r.endCol).toBe(14);
    });

    it("셀에서 토큰을 못 찾으면 문자열 기반 계산으로 떨어진다", () => {
      const cells = cellsOf([ascii("nothing here")]);
      const pos = { start: { x: 0, y: 0 }, end: { x: 3, y: 0 } };
      const r = mapSelectionToPathRange(pos, "zzz", "zzz", cells);
      expect(r.startCol).toBe(1);
      expect(r.endCol).toBe(3);
    });
  });

  it("여러 줄 선택이면 첫 줄(start.y)만 사용한다", () => {
    const pos = { start: { x: 3, y: 7 }, end: { x: 2, y: 9 } };
    const r = mapSelectionToPathRange(pos, "/etc/hosts", "/etc/hosts");
    expect(r.bufferLine).toBe(8); // y 7 → 8
    expect(r.startCol).toBe(4); // (3+0)+1, 토큰 인덱스 0
    expect(r.endCol).toBe(13); // 3 + len(10) - 1 = 12, +1 = 13
  });
});

describe("extractPathCandidateAtOffset (ADR-0188 point 트리거)", () => {
  const limits = { maxPathLength: 256 };

  it("offset을 덮는 maximal token 하나만 원문 범위와 함께 낸다", () => {
    // "build failed: ui/src/lib/foo.ts:12:3 (see log)"
    const line = "build failed: ui/src/lib/foo.ts:12:3 (see log)";
    expect(extractPathCandidateAtOffset(line, 20, limits)).toEqual({
      text: "ui/src/lib/foo.ts",
      lineIndex: 0,
      startIndex: 14,
      endIndex: 31,
    });
  });

  it("이웃 토큰이나 토큰 내부 basename은 후보로 만들지 않는다", () => {
    const line = "diff ui/src/App.tsx ui/src/App.test.tsx";
    // 첫 토큰 안의 offset → 첫 토큰만.
    expect(extractPathCandidateAtOffset(line, 6, limits)?.text).toBe("ui/src/App.tsx");
    // 두 번째 토큰 안의 offset → 두 번째 토큰만.
    expect(extractPathCandidateAtOffset(line, 25, limits)?.text).toBe("ui/src/App.test.tsx");
  });

  it("공백·경계 위 offset이나 범위 밖 offset은 후보가 없다", () => {
    const line = "a  ui/src/App.tsx";
    expect(extractPathCandidateAtOffset(line, 1, limits)).toBeNull();
    expect(extractPathCandidateAtOffset(line, 999, limits)).toBeNull();
    expect(extractPathCandidateAtOffset("", 0, limits)).toBeNull();
    expect(extractPathCandidateAtOffset(line, -1, limits)).toBeNull();
  });

  it("포인터로 지목한 토큰은 슬래시·확장자 없는 맨이름도 받는다", () => {
    expect(extractPathCandidateAtOffset("cd laymux 로 이동", 4, limits)?.text).toBe("laymux");
  });

  it("URL 스킴은 제외하고, 후보 길이 상한을 넘으면 버린다", () => {
    expect(extractPathCandidateAtOffset("see https://a.dev/x now", 8, limits)).toBeNull();
    expect(extractPathCandidateAtOffset("aaaa/bbbb", 2, { maxPathLength: 4 })).toBeNull();
  });

  it("따옴표·괄호와 grep 꼬리를 떼고 시작 offset을 보정한다", () => {
    const line = 'log ("src/main.rs:42:5")';
    expect(extractPathCandidateAtOffset(line, 8, limits)).toEqual({
      text: "src/main.rs",
      lineIndex: 0,
      startIndex: 6,
      endIndex: 17,
    });
  });
});

describe("extractPathCandidatesFromScreen (ADR-0188 screen 트리거)", () => {
  const limits = {
    maxLines: 64,
    maxChars: 8192,
    maxCandidates: 64,
    maxPathLength: 256,
  };

  it("화면 여러 줄의 strong candidate를 읽기 순서로 모은다", () => {
    expect(
      extractPathCandidatesFromScreen(["edit ui/src/App.tsx now", "", "cat Cargo.toml"], limits),
    ).toEqual([
      { text: "ui/src/App.tsx", lineIndex: 0, startIndex: 5, endIndex: 19 },
      { text: "Cargo.toml", lineIndex: 2, startIndex: 4, endIndex: 14 },
    ]);
  });

  it("지목되지 않은 화면에서는 맨이름을 후보로 만들지 않는다", () => {
    expect(extractPathCandidatesFromScreen(["cd laymux and build v3"], limits)).toEqual([]);
  });

  it("후보 상한을 넘으면 앞쪽만 남기고 자른다(부분 결과 허용)", () => {
    const line = Array.from({ length: 5 }, (_, i) => `a${i}.txt`).join(" ");
    const candidates = extractPathCandidatesFromScreen([line, line], {
      ...limits,
      maxCandidates: 6,
    });
    expect(candidates).toHaveLength(6);
    expect(candidates[5]).toEqual({ text: "a0.txt", lineIndex: 1, startIndex: 0, endIndex: 6 });
  });

  it("줄 수·총 문자 수 상한을 넘긴 뒤쪽 줄은 버린다", () => {
    const rows = ["a/1.txt", "a/2.txt", "a/3.txt"];
    expect(
      extractPathCandidatesFromScreen(rows, { ...limits, maxLines: 2 }).map((c) => c.lineIndex),
    ).toEqual([0, 1]);
    expect(
      extractPathCandidatesFromScreen(rows, { ...limits, maxChars: 14 }).map((c) => c.lineIndex),
    ).toEqual([0, 1]);
  });
});

describe("mapLineCandidateToPathRange (ADR-0188)", () => {
  const candidate = { text: "가/a.txt", lineIndex: 0, startIndex: 2, endIndex: 9 };

  it("셀 정보가 있으면 와이드 문자를 셀 단위로 보정한다", () => {
    // "x가 가/a.txt" — 앞의 한글 1개(2셀)와 후보 안의 한글 1개(2셀).
    const cells = [
      { chars: "x", width: 1 },
      { chars: "가", width: 2 },
      { chars: "", width: 0 },
      { chars: " ", width: 1 },
      { chars: "가", width: 2 },
      { chars: "", width: 0 },
      ...[..."/a.txt"].map((chars) => ({ chars, width: 1 })),
    ];
    expect(
      mapLineCandidateToPathRange(12, { ...candidate, startIndex: 3, endIndex: 10 }, cells),
    ).toEqual({ bufferLine: 12, startCol: 5, endCol: 12 });
  });

  it("셀 정보가 없으면 UTF-16 offset을 1-based 컬럼으로 쓴다", () => {
    expect(mapLineCandidateToPathRange(3, candidate)).toEqual({
      bufferLine: 3,
      startCol: 3,
      endCol: 9,
    });
  });
});
