import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

const reportFileViewerSignal = vi.fn<(signal: unknown) => Promise<void>>();

vi.mock("@/lib/tauri-api", () => ({
  reportFileViewerSignal: (signal: unknown) => reportFileViewerSignal(signal),
}));

import { useRemoteFileViewerSignal } from "./useRemoteFileViewerSignal";
import { useFileViewerStore } from "@/stores/file-viewer-store";

const sent = () => reportFileViewerSignal.mock.calls.map(([signal]) => signal);

describe("useRemoteFileViewerSignal (ADR-0291)", () => {
  beforeEach(() => {
    reportFileViewerSignal.mockReset();
    reportFileViewerSignal.mockResolvedValue(undefined);
    useFileViewerStore.getState().closeFileViewer();
  });

  it("reports the current signal on mount, even when nothing is open", () => {
    // A reloaded WebView starts a new epoch; the backend must drop the old one.
    const { openEpoch, openRevision } = useFileViewerStore.getState();
    renderHook(() => useRemoteFileViewerSignal());
    expect(sent()).toEqual([{ open: false, epoch: openEpoch, revision: openRevision }]);
  });

  it("reports every open, including the same path again, and the close", () => {
    renderHook(() => useRemoteFileViewerSignal());
    reportFileViewerSignal.mockClear();
    const { openEpoch, openRevision } = useFileViewerStore.getState();

    act(() => {
      useFileViewerStore.getState().openFileViewer("/tmp/a.md");
    });
    act(() => {
      useFileViewerStore.getState().openFileViewer("/tmp/a.md");
    });
    act(() => {
      useFileViewerStore.getState().closeFileViewer();
    });

    expect(sent()).toEqual([
      { open: true, epoch: openEpoch, revision: openRevision + 1 },
      { open: true, epoch: openEpoch, revision: openRevision + 2 },
      { open: false, epoch: openEpoch, revision: openRevision + 2 },
    ]);
  });

  it("stays quiet for changes that do not alter the signal", () => {
    renderHook(() => useRemoteFileViewerSignal());
    act(() => {
      useFileViewerStore.getState().openFileViewer("/tmp/a.md");
    });
    reportFileViewerSignal.mockClear();

    act(() => {
      useFileViewerStore.getState().toggleMaximized();
    });
    expect(sent()).toEqual([]);
  });

  it("treats the empty viewer as nothing open", () => {
    renderHook(() => useRemoteFileViewerSignal());
    reportFileViewerSignal.mockClear();

    act(() => {
      useFileViewerStore.getState().openEmptyFileViewer();
    });
    // The empty prompt has no file for Remote to show: same signal as closed.
    expect(sent()).toEqual([]);
  });

  it("stops reporting after unmount", () => {
    const { unmount } = renderHook(() => useRemoteFileViewerSignal());
    unmount();
    reportFileViewerSignal.mockClear();
    act(() => {
      useFileViewerStore.getState().openFileViewer("/tmp/a.md");
    });
    expect(sent()).toEqual([]);
  });
});
