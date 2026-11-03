import { matchTerminalUrls } from "./terminal-url";

export interface PaneLinkPane {
  id: string;
  terminalId?: string | null;
  paneNumber?: number | null;
}
export interface PaneLinkWorkspace {
  id: string;
  name: string;
  panes: readonly PaneLinkPane[];
}
export interface PaneLinkTarget {
  paneId: string;
  terminalId: string;
  workspaceId: string | null;
}

// 더 긴 terminal ID부터 소비해 그 안의 pane ID를 별도 링크로 만들지 않는다.
// 이름에는 콜론·한글을 허용하고 마지막 콜론 뒤 양수를 공간 번호로 해석한다.
const TOKEN =
  /(?<![\p{L}\p{N}_/\\:.-])(?:lx:pane:\S+:[1-9]\d*|(?:terminal-)?pane-[0-9a-f]{8})(?![\p{L}\p{N}_/\\:-]|\.[\p{L}\p{N}_])/gu;

/** UTF-16 오프셋만 반환한다. 화면 좌표 변환은 셀 매핑을 사용하는 호출자 소유다. */
export function findPaneTokens(text: string, workspaceNames?: readonly string[]) {
  const urls = matchTerminalUrls(text);
  // 화면에서는 실제 이름을 리터럴로 매칭한다. 이름의 구두점과 표·백틱 경계를
  // 추측하지 않으며 공백 없는 인접 locator도 하나의 긴 이름으로 삼키지 않는다.
  const names = workspaceNames
    ?.filter((name) => name && !/\s/.test(name))
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern =
    names && text.includes("lx:pane:")
      ? new RegExp(
          TOKEN.source.replace("\\S+", names.length ? `(?:${names.join("|")})` : "(?!)"),
          TOKEN.flags,
        )
      : TOKEN;
  return [...text.matchAll(pattern)]
    .filter(
      (match) =>
        !urls.some(
          (url) =>
            match.index < url.index + url.text.length && match.index + match[0].length > url.index,
        ),
    )
    .map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

/** PC layout adapter와 Remote navigation snapshot이 같은 해석 규칙을 쓴다. */
export function resolvePaneLink(
  text: string,
  workspaces: readonly PaneLinkWorkspace[],
): PaneLinkTarget | null {
  let candidates = workspaces;
  let number: number | undefined;
  if (text.startsWith("lx:pane:")) {
    const separator = text.lastIndexOf(":");
    const name = text.slice("lx:pane:".length, separator);
    number = Number(text.slice(separator + 1));
    if (!name || /\s/.test(name) || !Number.isSafeInteger(number) || number < 1) return null;
    candidates = workspaces.filter((workspace) => workspace.name === name);
    if (candidates.length !== 1) return null;
  }
  const targets: PaneLinkTarget[] = [];
  for (const workspace of candidates) {
    for (const pane of workspace.panes) {
      if (!pane.terminalId) continue;
      if (
        number === undefined
          ? text === pane.id || text === pane.terminalId
          : number === pane.paneNumber
      ) {
        targets.push({ paneId: pane.id, terminalId: pane.terminalId, workspaceId: workspace.id });
      }
    }
  }
  return targets.length === 1 ? targets[0] : null;
}
