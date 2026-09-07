import { afterEach, expect, it } from "vitest";
import { createScreenTerminal, type ScreenTerminal } from "@/test/screen/xterm-screen";
import {
  readPathLinkLines,
  readPathLinkSelection,
  mapPathLinkParts,
  pathLinkPartsCurrent,
} from "./path-link-lines";
import { extractPathCandidatesFromScreen, pathScreenLimits } from "./path-link-detect";
import { createPathLinkPointEvaluator } from "./path-link-point";
import { createPathLinkController } from "./path-link-provider";

const screens: ScreenTerminal[] = [];
afterEach(() => {
  screens.splice(0).forEach((s) => s.dispose());
  document.body.replaceChildren();
});
function enableSelection(s: ScreenTerminal) {
  if (!window.matchMedia)
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      }),
    });
  const host = document.createElement("div");
  document.body.appendChild(host);
  s.terminal.open(host);
}
async function setup(output: string, cols = 20) {
  const s = createScreenTerminal({ cols, rows: 12, scrollback: 30 });
  screens.push(s);
  await s.write(output);
  return s;
}
function paths(s: ScreenTerminal, start = 0, end = 12) {
  const lines = readPathLinkLines(s.terminal.buffer.active, start, end);
  return extractPathCandidatesFromScreen(
    lines.map((l) => l.text),
    pathScreenLimits(256),
  ).map((candidate) => ({
    candidate,
    parts: mapPathLinkParts(lines[candidate.lineIndex], candidate),
  }));
}

it.each([
  "D:/projects/laymux/docs/adr/decision.md",
  "/D:/projects/laymux/docs/adr/decision.md:12:3",
  "../projects/laymux/docs/adr/decision.md",
  "\\\\server\\share\\projects\\laymux\\decision.md",
  "D:/내 드라이브/프로젝트/문서/보고서.md",
  "/project/😀/e\u0301/very-long-file-name.md",
])("자동 줄바꿈을 복원하고 각 물리 줄에 매핑한다: %s", async (path) => {
  const s = await setup(`확인 (${path}).`);
  const expected = path.replace(/^\/([A-Za-z]:)/, "$1").replace(/:\d.*$/, "");
  const found = paths(s).find(({ candidate }) => candidate.text === expected);
  expect(found, JSON.stringify(paths(s))).toBeDefined();
  expect(found!.parts.map((p) => p.token).join("")).toBe(expected);
  expect(found!.parts.length).toBeGreaterThan(1);
  expect(pathLinkPartsCurrent(s.terminal.buffer.active, found!.parts)).toBe(true);
});

it("신고된 Codex 들여쓰기 개행 경로를 복원한다", async () => {
  const s = await setup("  ADR (/D:/repo/docs/\r\n  adr/decision.md).", 21);
  expect(paths(s).map(({ candidate }) => candidate.text)).toContain("D:/repo/docs/adr/decision.md");
});

it("전각 문자가 다음 줄로 밀릴 때 생긴 빈 셀은 경로 공백이 아니다", async () => {
  const s = await setup("/123456789012345678한글.md");
  expect(paths(s)[0].candidate.text).toBe("/123456789012345678한글.md");
});

it("실제 스페이스와 탭, 빈 줄, 독립된 경로 줄은 개행 경계로 유지한다", async () => {
  const s = await setup("/one.md\r\n/two.md\r\n\r\nrelative/three.md\r\n\t/four.md");
  expect(paths(s).map(({ candidate }) => candidate.text)).toEqual([
    "/one.md",
    "/two.md",
    "relative/three.md",
    "/four.md",
  ]);
});

it("창 위아래에서 잘린 자동 줄바꿈 경로 조각은 후보로 내지 않는다", async () => {
  const s = await setup("/" + "long-directory/".repeat(5) + "end.md");
  expect(paths(s, 1, 3)).toEqual([]);
  expect(paths(s, 0, 2)).toEqual([]);
});

it("뒷줄이 바뀌면 앞줄을 포함한 전체 링크가 무효다", async () => {
  const s = await setup("D:/projects/laymux/docs/decision.md");
  const found = paths(s)[0];
  await s.write("\x1b[2;1HWRONG");
  expect(pathLinkPartsCurrent(s.terminal.buffer.active, found.parts)).toBe(false);
});

it("직사각형 선택 밖의 경로는 검사하지 않는다", async () => {
  const s = await setup("pick /outside-one.md\r\npick /outside-two.md", 40);
  enableSelection(s);
  const service = (
    s.terminal as unknown as {
      _core: {
        _selectionService: {
          _activeSelectionMode: number;
          _model: {
            selectionStart: number[];
            selectionEnd: number[];
          };
        };
      };
    }
  )._core._selectionService;
  service._activeSelectionMode = 3;
  service._model.selectionStart = [0, 0];
  service._model.selectionEnd = [4, 1];
  const selected = s.terminal.getSelection();
  expect(selected.replace(/\r\n/g, "\n")).toBe("pick\npick");
  expect(
    readPathLinkSelection(s.terminal.buffer.active, s.terminal.getSelectionPosition()!, selected),
  ).toEqual([]);
});

it.each(["soft", "hard"])("실제 %s 선택 원문은 줄바꿈 복원을 허용한다", async (wrap) => {
  const s = await setup(
    "  ADR (/D:/repo/docs/" + (wrap === "hard" ? "\r\n  " : "") + "adr/file.md).",
    21,
  );
  enableSelection(s);
  s.terminal.select(7, 0, 25 + (wrap === "hard" ? 2 : 0));
  const lines = readPathLinkSelection(
    s.terminal.buffer.active,
    s.terminal.getSelectionPosition()!,
    s.terminal.getSelection(),
  );
  expect(lines[0]?.text).toBe("/D:/repo/docs/adr/file.md");
});

it("hard wrap의 들여쓰기 조건이 바뀌면 전체 링크를 폐기한다", async () => {
  const s = await setup("  ADR (/D:/repo/docs/\r\n  adr/decision.md).", 21);
  const parts = paths(s)[0].parts;
  expect(pathLinkPartsCurrent(s.terminal.buffer.active, parts)).toBe(true);
  await s.write("\x1b[2;1Hx ");
  expect(pathLinkPartsCurrent(s.terminal.buffer.active, parts)).toBe(false);
});

it("desktop point는 뒷줄에서도 전체 경로만 조회하고 모든 조각을 함께 폐기한다", async () => {
  const path = "D:/projects/laymux/docs/decision.md";
  const s = await setup(path);
  const batches: string[][] = [];
  const controller = createPathLinkController(s.terminal, {
    onOpenPath: () => {},
    onChangeDir: () => {},
    onOsAction: () => {},
  });
  const point = createPathLinkPointEvaluator({
    getSettings: () => ({ enabled: true, maxPathLength: 256 }),
    getCwd: () => "D:/other",
    resolveCell: () => ({ absoluteLine: 1, col: 4 }),
    readLine: (row) => s.terminal.buffer.active.getLine(row),
    statPaths: async (paths) => {
      batches.push(paths);
      return paths.map((p) => ({ exists: p === path, isDirectory: false }));
    },
    isVerifiedAt: () => false,
    apply: (parts) => controller.setVerifiedSelections("point", parts),
  });
  await point.evaluateAt(0, 0);
  expect(batches).toEqual([[path]]);
  expect(controller.getCurrent()).toHaveLength(2);
  await s.write("\x1b[2;1HWRONG");
  expect(controller.revalidate()).toBe(2);
  expect(controller.getCurrent()).toEqual([]);
});

it("선택 앞뒤의 텍스트는 포함하지 않고 자동 wrap 뒤의 별도 경로도 정확히 매핑한다", async () => {
  const s = await setup("prefix /long-directory/file.md suffix\r\n/other.md");
  const position = { start: { x: 7, y: 0 }, end: { x: 9, y: 2 } };
  const lines = readPathLinkLines(s.terminal.buffer.active, 0, 3, position);
  expect(lines.map((line) => line.text)).toEqual(["/long-directory/file.md suffix", "/other.md"]);
  const candidates = extractPathCandidatesFromScreen(
    lines.map((l) => l.text),
    pathScreenLimits(256),
  );
  expect(
    mapPathLinkParts(lines[1], candidates.find((c) => c.text === "/other.md")!)[0],
  ).toMatchObject({ bufferLine: 3, startCol: 1, endCol: 9 });
});

it("wrap 경계의 실제 공백은 파일명에서 보존한다", async () => {
  const path = "D:/12345678901234567 name/file.md";
  const s = await setup(path);
  expect(readPathLinkLines(s.terminal.buffer.active, 0, 5)[0].text).toBe(path);
});

it("완성된 상대경로 목록과 URL은 hard wrap으로 결합하지 않는다", async () => {
  for (const first of ["12345678901234/a.txt", "https://host/aaaaaaa"]) {
    const s = await setup(first + "\r\nrelative/b.txt", 19);
    expect(
      readPathLinkLines(s.terminal.buffer.active, 0, 5)
        .map((l) => l.text)
        .filter(Boolean),
    ).toEqual([first, "relative/b.txt"]);
  }
});

it("hard wrap 중간 파일명과 3줄 경로도 원문 좌표를 유지한다", async () => {
  const s = await setup("  /long-dir/long-name\r\n  -continued-dir/abc\r\n  /file.md", 21);
  const lines = readPathLinkLines(s.terminal.buffer.active, 0, 6);
  expect(lines[0].text).toBe("  /long-dir/long-name-continued-dir/abc");
  // 새 절대경로는 앞 경로에 합치지 않는다.
  expect(lines[1].text).toBe("  /file.md");
});

it("리사이즈 후 옛 범위는 무효이며 새 셀 좌표로 다시 복원한다", async () => {
  const path = "/long-directory/deeper/file.md";
  const s = await setup(path);
  const parts = paths(s)[0].parts;
  await s.write("\r\n");
  s.terminal.resize(12, 12);
  expect(pathLinkPartsCurrent(s.terminal.buffer.active, parts)).toBe(false);
  expect(paths(s)[0].candidate.text).toBe(path);
});

it("scrollback trim은 같은 마커 이동량을 모든 조각에 적용한다", async () => {
  const s = await setup("\r\n".repeat(20) + "/long-directory/deeper/file.md");
  const lines = readPathLinkLines(s.terminal.buffer.active, 20, 24);
  const candidate = extractPathCandidatesFromScreen(
    lines.map((l) => l.text),
    pathScreenLimits(256),
  )[0];
  const parts = mapPathLinkParts(lines[0], candidate);
  const marker = s.terminal.registerMarker(
    20 - s.terminal.buffer.active.baseY - s.terminal.buffer.active.cursorY,
  )!;
  await s.write("\r\n".repeat(23));
  expect(marker.line).toBeLessThan(20);
  expect(pathLinkPartsCurrent(s.terminal.buffer.active, parts, marker.line - 20)).toBe(true);
});
