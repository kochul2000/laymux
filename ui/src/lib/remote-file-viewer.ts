import { readFileForViewer, statPaths } from "./tauri-api";
import { normalizeViewerPath } from "./file-viewer";
import {
  decidePathLinkAction,
  extractPathCandidatesFromSelection,
  joinCwdPath,
  pathSelectionLimits,
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
    const selection = typeof params.selection === "string" ? params.selection : "";
    const terminal = useTerminalStore.getState().instances.find((item) => item.id === terminalId);
    const settings = useSettingsStore.getState().terminal;
    if (!terminal || !settings.pathLinkEnabled) {
      return ok({ valid: false });
    }

    const candidates = extractPathCandidatesFromSelection(
      selection,
      pathSelectionLimits(settings.pathLinkMaxLength),
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
      const matches = pending.flatMap(({ candidate, path, statIndex }) => {
        const info = infos[statIndex];
        if (!info || decidePathLinkAction(info) !== "openFile") return [];
        return [
          {
            token: candidate.text,
            path,
            lineIndex: candidate.lineIndex,
            startIndex: candidate.startIndex,
            endIndex: candidate.endIndex,
          },
        ];
      });
      return matches.length > 0 ? ok({ valid: true, matches }) : ok({ valid: false });
    } catch (error) {
      return err(
        `Path link validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
