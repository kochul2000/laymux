import { readFileForViewer, statPath } from "./tauri-api";
import { normalizeViewerPath } from "./file-viewer";
import {
  decidePathLinkAction,
  isWithinPathLengthLimit,
  joinCwdPath,
  trimSelectionToPath,
} from "./path-link-detect";
import {
  filePreviewKind,
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
    if (
      !terminal ||
      !settings.pathLinkEnabled ||
      !isWithinPathLengthLimit(selection, settings.pathLinkMaxLength)
    ) {
      return ok({ valid: false });
    }

    const token = trimSelectionToPath(selection);
    if (!token) return ok({ valid: false });
    const path = joinCwdPath(terminal.cwd, token);
    if (!path) return ok({ valid: false });

    try {
      const info = await statPath(path);
      if (decidePathLinkAction(info) !== "openFile") return ok({ valid: false });
      return ok({ valid: true, token, path });
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
  let path = "";
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

    const previewKind = filePreviewKind(path);
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
