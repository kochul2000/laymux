import { describe, it, expect } from "vitest";
import {
  findPathCandidateAtCol,
  findPathCandidatesInLine,
  joinCwdPath,
  looksLikePath,
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
});
