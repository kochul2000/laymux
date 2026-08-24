import {
  getHomeDirectory,
  listDirectory,
  readFileForDownload,
  readFileForViewer,
  statPaths,
} from "./tauri-api";
import { normalizeViewerPath } from "./file-viewer";
import { joinPath, parentPath } from "./file-explorer-parse";
import {
  decidePathLinkAction,
  extractPathCandidatesAtOffset,
  extractPathCandidatesFromScreen,
  extractPathCandidatesFromSelection,
  isPathLinkCwdCurrent,
  joinCwdPath,
  pathPointLimits,
  pathScreenLimits,
  pathSelectionLimits,
  resolveOverlappingRanges,
  type PathSelectionCandidate,
} from "./path-link-detect";
import {
  documentPreviewKind,
  htmlToSafePreviewDocument,
  markdownToSafePreviewDocument,
} from "./file-preview";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

export interface RemoteFileViewerBridgeResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

const ok = (data: unknown): RemoteFileViewerBridgeResult => ({ success: true, data });
const err = (error: string): RemoteFileViewerBridgeResult => ({ success: false, error });

/** Remote path-link 발견 트리거(ADR-0188). 서버가 이미 검사하지만 fail-closed 로 다시 본다. */
type RemotePathLinkMode = "selection" | "point" | "screen";

function remotePathLinkMode(value: unknown): RemotePathLinkMode | null {
  return value === "selection" || value === "point" || value === "screen" ? value : null;
}

function remotePathLinkLines(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((line) => typeof line === "string") ? (value as string[]) : null;
}

/**
 * 트리거별 후보 추출(ADR-0188). 문법은 데스크톱과 같은 파서를 쓰고, 트리거마다
 * 범위와 상한만 다르다 — `point` 는 caret 이 가리키는 토큰 하나, `screen` 은
 * 화면의 strong candidate, `selection` 은 기존 bounded maximal-munch.
 */
function resolveRemotePathLinkCandidates(
  mode: RemotePathLinkMode,
  lines: string[],
  caret: unknown,
  maxPathLength: number,
): PathSelectionCandidate[] {
  if (mode === "screen") {
    return extractPathCandidatesFromScreen(lines, pathScreenLimits(maxPathLength));
  }
  if (mode === "point") {
    const position = caret as { lineIndex?: unknown; index?: unknown } | null;
    const lineIndex = position?.lineIndex;
    const index = position?.index;
    if (!Number.isSafeInteger(lineIndex) || !Number.isSafeInteger(index)) return [];
    const line = lines[lineIndex as number];
    if (line === undefined) return [];
    return extractPathCandidatesAtOffset(line, index as number, pathPointLimits(maxPathLength)).map(
      (candidate) => ({ ...candidate, lineIndex: lineIndex as number }),
    );
  }
  return extractPathCandidatesFromSelection(lines.join("\n"), pathSelectionLimits(maxPathLength));
}

/** Resolve Remote FileViewer queries against the desktop store and safe renderer. */
export async function handleRemoteFileViewerRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<RemoteFileViewerBridgeResult> {
  if (method === "status") {
    const viewer = useFileViewerStore.getState();
    const open = viewer.open && Boolean(viewer.path);
    return ok({ open, path: open ? viewer.path : null });
  }
  if (method === "pathLink") {
    const terminalId = typeof params.terminalId === "string" ? params.terminalId : "";
    const mode = remotePathLinkMode(params.mode);
    const lines = remotePathLinkLines(params.lines);
    const terminal = useTerminalStore.getState().instances.find((item) => item.id === terminalId);
    const settings = useSettingsStore.getState().terminal;
    if (!terminal || !settings.pathLinkEnabled || !mode || !lines) {
      return ok({ valid: false });
    }

    const candidates = resolveRemotePathLinkCandidates(
      mode,
      lines,
      params.caret,
      settings.pathLinkMaxLength,
    );
    if (candidates.length === 0) return ok({ valid: false });

    const uniquePaths: string[] = [];
    const pathIndexes = new Map<string, number>();
    const pending = candidates.flatMap((candidate) => {
      const path = joinCwdPath(terminal.cwd, candidate.text);
      if (!path) return [];
      let statIndex = pathIndexes.get(path);
      if (statIndex === undefined) {
        statIndex = uniquePaths.length;
        pathIndexes.set(path, statIndex);
        uniquePaths.push(path);
      }
      return [{ candidate, path, statIndex }];
    });
    if (pending.length === 0) return ok({ valid: false });

    try {
      const infos = await statPaths(uniquePaths);
      const currentTerminal = useTerminalStore
        .getState()
        .instances.find((item) => item.id === terminalId);
      const currentSettings = useSettingsStore.getState().terminal;
      if (
        !currentTerminal ||
        !isPathLinkCwdCurrent(terminal.cwd, currentTerminal.cwd) ||
        !currentSettings.pathLinkEnabled ||
        currentSettings.pathLinkMaxLength !== settings.pathLinkMaxLength
      ) {
        return ok({ valid: false });
      }
      // 파일(openFile)과 디렉터리(changeDir) 모두 링크가 된다(ADR-0197) —
      // Remote 는 directory match 를 explorer 열기로 라우팅한다.
      const linkable = pending.filter(({ statIndex }) => {
        const info = infos[statIndex];
        return Boolean(info) && decidePathLinkAction(info) !== "none";
      });
      // 공백 확장 후보(ADR-0191)는 접두끼리 겹친다 — 존재하는 것 중 같은 줄의
      // 겹치는 범위는 가장 긴 것만 남긴다(longest-existing-wins).
      const matches = resolveOverlappingRanges(linkable, ({ candidate }) => ({
        line: candidate.lineIndex,
        start: candidate.startIndex,
        end: candidate.endIndex,
      })).map(({ candidate, path, statIndex }) => ({
        token: candidate.text,
        path,
        kind: infos[statIndex].isDirectory ? "directory" : "file",
        lineIndex: candidate.lineIndex,
        startIndex: candidate.startIndex,
        endIndex: candidate.endIndex,
      }));
      return matches.length > 0 ? ok({ valid: true, matches }) : ok({ valid: false });
    } catch (error) {
      return err(
        `Path link validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (method === "list") {
    const maxEntries = params.maxEntries;
    if (!Number.isSafeInteger(maxEntries) || (maxEntries as number) <= 0) {
      return err("maxEntries must be a positive integer");
    }
    let path: string;
    if (params.source === "terminalCwd") {
      // The folder button opens where the user is working; a missing terminal
      // id, an unknown terminal or one that has not reported a cwd yet all
      // fall back to the host home directory.
      const terminalId = typeof params.terminalId === "string" ? params.terminalId : "";
      const terminal = useTerminalStore.getState().instances.find((item) => item.id === terminalId);
      try {
        path = terminal?.cwd || (await getHomeDirectory());
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    } else {
      path = normalizeViewerPath(typeof params.path === "string" ? params.path : "");
      if (!path) return err("path is required");
    }
    try {
      // list_directory already sorts directories-first, name case-insensitive;
      // the bridge only bounds the payload and resolves absolute paths so the
      // Remote client never owns path syntax.
      const entries = await listDirectory(path);
      const bounded = entries.slice(0, maxEntries as number);
      const parent = parentPath(path);
      return ok({
        path,
        parent: parent && parent !== path ? parent : null,
        entries: bounded.map((entry) => ({
          name: entry.name,
          path: joinPath(path, entry.name),
          isDirectory: entry.isDirectory,
          isSymlink: entry.isSymlink,
          size: entry.size,
        })),
        truncated: entries.length > bounded.length,
      });
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
  if (method === "download") {
    const maxBytes = params.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0) {
      return err("maxBytes must be a positive integer");
    }
    const path = normalizeViewerPath(typeof params.path === "string" ? params.path : "");
    if (!path) return err("path is required");
    try {
      // Raw bytes, not a rendered payload: a download of an HTML or Markdown
      // file must be the source the host holds, never the sanitized preview
      // document that `render` returns in its place.
      return ok({ path, ...(await readFileForDownload(path, maxBytes as number)) });
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
  if (method !== "render") return err(`Unknown method: fileViewer.${method}`);

  const maxBytes = params.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0) {
    return err("maxBytes must be a positive integer");
  }

  const source = params.source;
  let path: string;
  if (source === "current") {
    const viewer = useFileViewerStore.getState();
    if (!viewer.open || !viewer.path) {
      return err("No file is open in the desktop viewer");
    }
    path = viewer.path;
  } else if (source === "path") {
    path = normalizeViewerPath(typeof params.path === "string" ? params.path : "");
    if (!path) return err("path is required when source is 'path'");
  } else {
    return err("source must be 'current' or 'path'");
  }

  try {
    const content = await readFileForViewer(path, maxBytes as number);
    if (content.kind !== "text") return ok({ path, ...content });

    // Deliberately the document classifier, not the desktop one: Remote renders
    // no structured previews (ADR-0109), and only document kinds may be turned
    // into a `previewDocument`. A JSON or CSV file goes down the plain-text
    // branch above and the Remote tab shows its source, exactly as before.
    const previewKind = documentPreviewKind(path);
    if (!previewKind) return ok({ path, ...content });
    const previewDocument =
      previewKind === "markdown"
        ? markdownToSafePreviewDocument(content.content)
        : htmlToSafePreviewDocument(content.content);
    // previewDocument already contains the sanitized source. Returning the raw
    // text as well nearly doubles the JSON body and can cross the Cloud tunnel
    // response limit for an otherwise valid 8 MiB file.
    return ok({
      path,
      kind: "text",
      truncated: content.truncated,
      previewKind,
      previewDocument,
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}
