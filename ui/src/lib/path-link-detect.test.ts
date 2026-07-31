import { describe, it, expect } from "vitest";
import {
  joinCwdPath,
  normalizeMsysCwd,
  trimSelectionToPath,
  isWithinPathLengthLimit,
  decidePathLinkAction,
  mapSelectionToPathRange,
} from "./path-link-detect";

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
