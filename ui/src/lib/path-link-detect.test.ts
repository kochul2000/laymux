import { describe, it, expect } from "vitest";
import {
  findPathCandidateAtCol,
  findPathCandidatesInLine,
  joinCwdPath,
  looksLikePath,
  normalizeMsysCwd,
  trimSelectionToPath,
  isWithinPathLengthLimit,
  decidePathLinkAction,
} from "./path-link-detect";

describe("looksLikePath", () => {
  it("슬래시와 확장자를 가진 상대경로는 경로로 본다", () => {
    expect(looksLikePath("ui/src/index.css")).toBe(true);
    expect(looksLikePath("ui/src/i18n/locales/ko.json")).toBe(true);
    expect(looksLikePath("src/main.rs")).toBe(true);
  });

  it("확장자 없이도 슬래시가 2개 이상이면 디렉토리 경로로 본다", () => {
    expect(looksLikePath("ui/src/components")).toBe(true);
  });

  it("확장자만 있고 슬래시가 없는 단일 파일명도 경로로 본다", () => {
    expect(looksLikePath("Cargo.toml")).toBe(true);
    expect(looksLikePath("package.json")).toBe(true);
  });

  it("슬래시도 확장자도 없는 평범한 단어는 경로가 아니다", () => {
    expect(looksLikePath("hello")).toBe(false);
    expect(looksLikePath("running")).toBe(false);
    expect(looksLikePath("TODO")).toBe(false);
  });

  it("문장 부호(마침표)로 끝나는 단어는 확장자로 오인하지 않는다", () => {
    // "done." 의 ".": 뒤가 비어 있으므로 확장자 아님
    expect(looksLikePath("done.")).toBe(false);
    // 슬래시 없는 버전 번호는 경로가 아니다
    expect(looksLikePath("v1.2.3")).toBe(false);
  });

  it("URL 스킴이 포함된 문자열은 경로로 보지 않는다(URL provider 담당)", () => {
    expect(looksLikePath("https://example.com/a.json")).toBe(false);
    expect(looksLikePath("http://x/y")).toBe(false);
  });

  it("절대 Unix/Windows 경로도 경로로 본다", () => {
    expect(looksLikePath("/etc/hosts")).toBe(true);
    expect(looksLikePath("C:\\Users\\me\\a.txt")).toBe(true);
  });
});

describe("findPathCandidateAtCol", () => {
  it("줄 안에서 클릭 컬럼을 포함하는 경로 토큰을 반환한다", () => {
    const line = "  modified   ui/src/index.css";
    // 'u' (ui) 시작 = 0-based 13 → 1-based 14
    const r = findPathCandidateAtCol(line, 16);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("ui/src/index.css");
    // 1-based 시작/끝 컬럼
    expect(r!.startCol).toBe(14);
    expect(r!.endCol).toBe(14 + "ui/src/index.css".length - 1);
  });

  it("경로 토큰 바깥(앞쪽 단어)을 클릭하면 null", () => {
    const line = "  modified   ui/src/index.css";
    expect(findPathCandidateAtCol(line, 4)).toBeNull(); // "modified"
  });

  it("경로처럼 보이지 않는 토큰은 null", () => {
    const line = "just some words here";
    expect(findPathCandidateAtCol(line, 7)).toBeNull();
  });

  it("따옴표로 감싼 경로는 따옴표를 제외하고 추출한다", () => {
    const line = `error in "ui/src/app.tsx" line 3`;
    const r = findPathCandidateAtCol(line, 15);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("ui/src/app.tsx");
  });

  it("괄호로 감싼 경로는 괄호를 제외한다", () => {
    const line = "see (src/lib/util.ts) for details";
    const r = findPathCandidateAtCol(line, 10);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("src/lib/util.ts");
  });

  it("URL 토큰은 경로 후보로 잡지 않는다", () => {
    const line = "open https://example.com/a.json now";
    expect(findPathCandidateAtCol(line, 12)).toBeNull();
  });

  it("trailing 콜론+줄번호(grep 스타일)는 경로에서 제외한다", () => {
    const line = "ui/src/main.ts:42:5: error";
    const r = findPathCandidateAtCol(line, 4);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("ui/src/main.ts");
  });
});

describe("findPathCandidatesInLine", () => {
  it("한 줄에서 여러 경로 토큰을 모두 찾는다", () => {
    const line = "moved ui/src/a.ts -> ui/src/b.ts done";
    const found = findPathCandidatesInLine(line);
    expect(found.map((c) => c.text)).toEqual(["ui/src/a.ts", "ui/src/b.ts"]);
  });

  it("경로가 없으면 빈 배열", () => {
    expect(findPathCandidatesInLine("just words with no paths")).toEqual([]);
  });

  it("URL 은 후보에서 제외한다", () => {
    const found = findPathCandidatesInLine("see https://x.com/a.json and src/b.ts");
    expect(found.map((c) => c.text)).toEqual(["src/b.ts"]);
  });

  it("각 후보의 컬럼 범위는 1-based 로 정확하다", () => {
    const line = "x src/a.ts";
    const found = findPathCandidatesInLine(line);
    expect(found).toHaveLength(1);
    // "src/a.ts" 시작 = 0-based 2 → 1-based 3
    expect(found[0].startCol).toBe(3);
    expect(found[0].endCol).toBe(3 + "src/a.ts".length - 1);
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

  it("공백이 끼어 여러 토큰이면 경로 한 건으로 보지 않는다", () => {
    expect(trimSelectionToPath("ui/src a.ts")).toBeNull();
  });

  it("경로처럼 안 보이는 선택은 null", () => {
    expect(trimSelectionToPath("hello")).toBeNull();
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
