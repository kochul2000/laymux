import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileViewer } from "./FileViewer";
import { openExternal, openInOs, readFileForViewer } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { useOverridesStore } from "@/stores/overrides-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";

vi.mock("@/lib/tauri-api", () => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
  openInOs: vi.fn().mockResolvedValue(undefined),
  readFileForViewer: vi
    .fn()
    .mockResolvedValue({ kind: "text", content: "file content", truncated: false }),
}));

// Terminal viewer branch renders TerminalView — mock it to inspect props.
vi.mock("@/components/views/TerminalView", () => ({
  TerminalView: (props: Record<string, unknown>) => (
    <div
      data-testid="mock-terminal-view"
      data-startup-command={props.startupCommandOverride}
      data-profile={props.profile}
      data-viewer-command={(props.viewerStartup as { command?: string } | undefined)?.command}
      data-viewer-path={(props.viewerStartup as { path?: string } | undefined)?.path}
    />
  ),
}));

const baseProps = {
  viewerInstanceId: "test-viewer",
  isFocused: true,
};

describe("FileViewer", () => {
  beforeEach(() => {
    vi.mocked(openExternal).mockClear();
    vi.mocked(openInOs).mockClear();
    vi.mocked(openInOs).mockResolvedValue(undefined);
    vi.mocked(readFileForViewer).mockClear();
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "file content",
      truncated: false,
    });
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    useTerminalStartupStore.setState(useTerminalStartupStore.getInitialState());
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: [baseProps.viewerInstanceId],
      eligiblePaneIds: [baseProps.viewerInstanceId],
    });
  });

  it("renders text content for a web viewer", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "hello world",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    expect(readFileForViewer).toHaveBeenCalledWith("/home/user/a.txt");
    expect(screen.getByTestId("file-viewer-text")).toHaveTextContent("hello world");
    expect(screen.getByTestId("file-viewer-text").parentElement).toHaveClass("empty-view-scroll");
  });

  it("renders html files in preview mode by default and can switch to source", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "<h1>Report</h1><script>window.__ran = true</script>",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/report.html" />);
    });

    const iframe = screen.getByTestId("file-viewer-preview") as HTMLIFrameElement;
    expect(iframe).toHaveAttribute("sandbox", "allow-same-origin");
    expect(iframe.getAttribute("srcdoc")).toContain("<h1>Report</h1>");
    expect(iframe.getAttribute("srcdoc")).not.toContain("<script");

    fireEvent.click(screen.getByTestId("file-viewer-source-mode"));
    expect(screen.getByTestId("file-viewer-text")).toHaveTextContent("<h1>Report</h1>");
  });

  it("opens preview links through the host shell", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: '<a href="https://example.com/docs">Docs</a>',
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/report.html" />);
    });

    const iframe = screen.getByTestId("file-viewer-preview") as HTMLIFrameElement;
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<a href="https://example.com/docs">Docs</a>';
    fireEvent.load(iframe);
    doc
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("bakes the viewer font into the html preview iframe and forwards Ctrl+Wheel zoom to it", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "<h1>Report</h1>",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/report.html" />);
    });

    const iframe = screen.getByTestId("file-viewer-preview") as HTMLIFrameElement;
    const initialSize = useSettingsStore.getState().viewer.fontSize;
    expect(iframe.getAttribute("srcdoc")).toContain(`font-size:${initialSize}px !important`);

    // The iframe is a separate document — a wheel fired inside it never
    // bubbles to FileViewer's own onWheel, so PreviewFrame forwards it itself.
    // No manual fireEvent.load here: jsdom already auto-fires `load` once the
    // srcdoc assignment during render lands (verified — firing it again would
    // attach a second listener and double the delta).
    const doc = iframe.contentDocument!;
    doc.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true }),
    );

    expect(useOverridesStore.getState().viewOverrides[baseProps.viewerInstanceId]?.fontSize).toBe(
      initialSize + 1,
    );
  });

  it("renders markdown files in preview mode by default", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "# Notes\n\n- one\n\n| A | B |\n| --- | --- |\n| C | D |",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/README.md" />);
    });

    const iframe = screen.getByTestId("file-viewer-preview") as HTMLIFrameElement;
    expect(iframe.getAttribute("srcdoc")).toContain("<h1>Notes</h1>");
    expect(iframe.getAttribute("srcdoc")).toContain("<li>one</li>");
    expect(iframe.getAttribute("srcdoc")).toContain("<table>");
  });

  it("starts the vi terminal viewer when vi is configured for .md", async () => {
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".md"], command: "vi", profile: "WSL" }],
      },
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/README.md" />);
    });

    expect(readFileForViewer).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-viewer-terminal")).toHaveClass("h-full", "min-w-0", "flex-1");
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute("data-profile", "WSL");
    expect(screen.getByTestId("mock-terminal-view")).not.toHaveAttribute("data-startup-command");
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute("data-viewer-command", "vi");
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute(
      "data-viewer-path",
      "/home/user/README.md",
    );
  });

  it("keeps a terminal viewer queued until the global startup slot reveals it", async () => {
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".md"], command: "vi", profile: "WSL" }],
      },
    });
    useTerminalStartupStore.setState(useTerminalStartupStore.getInitialState());

    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/README.md" />);
    });

    expect(screen.getByTestId("file-viewer-terminal-startup-placeholder")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-terminal-view")).not.toBeInTheDocument();

    act(() => {
      useTerminalStartupStore.getState().syncCandidates({
        knownPaneIds: [baseProps.viewerInstanceId],
        eligiblePaneIds: [baseProps.viewerInstanceId],
      });
    });

    expect(screen.getByTestId("mock-terminal-view")).toBeInTheDocument();
  });

  it("renders an image for image content", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,abc123",
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/photo.png" />);
    });
    expect(screen.getByTestId("file-viewer-image")).toBeInTheDocument();
    expect(screen.getByTestId("file-viewer-image").parentElement).toHaveClass("empty-view-scroll");
  });

  it("scopes Ctrl+A to the viewer body without selecting its toolbar", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "name,size\na,1\n",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/rows.csv" />);
    });

    const root = screen.getByTestId("file-viewer-content-root");
    const body = screen.getByTestId("file-viewer-selectable-content");
    expect(screen.getByTestId("file-viewer-preview-mode")).toHaveTextContent("Preview");
    expect(screen.getByTestId("file-viewer-source-mode")).toHaveTextContent("Source");
    expect(screen.getByTestId("file-viewer-font-decrease")).toHaveTextContent("A−");
    expect(screen.getByTestId("file-viewer-font-increase")).toHaveTextContent("A+");

    const event = fireEvent.keyDown(root, { key: "a", ctrlKey: true, bubbles: true });
    // fireEvent returns false when preventDefault() was called.
    expect(event).toBe(false);

    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    const range = selection!.getRangeAt(0);
    expect(range.startContainer).toBe(body);
    expect(range.startOffset).toBe(0);
    expect(range.endContainer).toBe(body);
    expect(range.endOffset).toBe(body.childNodes.length);
  });

  it("zooms an image in/out via the toolbar buttons and Ctrl+Wheel", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,abc123",
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/photo.png" />);
    });
    expect(screen.getByTestId("file-viewer-zoom-level")).toHaveTextContent("100%");

    // Stub the decoded natural size the real onLoad event would report, so the
    // zoomed style branch (real width/height, not a paint-only transform) engages.
    const img = screen.getByTestId("file-viewer-image");
    Object.defineProperty(img, "naturalWidth", { value: 200, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 100, configurable: true });
    fireEvent.load(img);

    fireEvent.click(screen.getByTestId("file-viewer-zoom-in"));
    expect(screen.getByTestId("file-viewer-zoom-level")).toHaveTextContent("125%");
    // Real box growth (width/height), not `transform: scale()` — see ZoomableImage
    // for why a transform's paint-only overflow can't be scrolled into on all sides.
    expect(img).toHaveStyle({ width: "250px", height: "125px" });
    expect(img).not.toHaveStyle({ transform: "scale(1.25)" });
    // Past 100%, the scroll container must stop centering (flex-start) so the
    // overflow it creates stays reachable by scroll.
    expect(img.parentElement).toHaveStyle({ alignItems: "flex-start" });

    fireEvent.click(screen.getByTestId("file-viewer-zoom-out"));
    fireEvent.click(screen.getByTestId("file-viewer-zoom-out"));
    expect(screen.getByTestId("file-viewer-zoom-level")).toHaveTextContent("75%");

    fireEvent.wheel(img.parentElement!, { deltaY: -100, ctrlKey: true });
    expect(screen.getByTestId("file-viewer-zoom-level")).toHaveTextContent("100%");
    expect(img.parentElement).toHaveStyle({ alignItems: "center" });
  });

  it("zooms text font size via the toolbar buttons and Ctrl+Wheel", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "hello world",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    const initialSize = useSettingsStore.getState().viewer.fontSize;
    expect(screen.getByTestId("file-viewer-text")).toHaveStyle({ fontSize: `${initialSize}px` });

    fireEvent.click(screen.getByTestId("file-viewer-font-increase"));
    expect(screen.getByTestId("file-viewer-text")).toHaveStyle({
      fontSize: `${initialSize + 1}px`,
    });

    fireEvent.wheel(screen.getByTestId("file-viewer-text"), { deltaY: -100, ctrlKey: true });
    expect(screen.getByTestId("file-viewer-text")).toHaveStyle({
      fontSize: `${initialSize + 2}px`,
    });

    // A plain (non-Ctrl) wheel must not touch the font size — it's ordinary scroll.
    fireEvent.wheel(screen.getByTestId("file-viewer-text"), { deltaY: -100, ctrlKey: false });
    expect(screen.getByTestId("file-viewer-text")).toHaveStyle({
      fontSize: `${initialSize + 2}px`,
    });
  });

  it("renders a binary placeholder for binary content", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({ kind: "binary", size: 2048 });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/blob.bin" />);
    });
    expect(screen.getByTestId("file-viewer-binary")).toHaveTextContent("2.0 KB");
  });

  it("offers to open a binary file on this PC right where the preview would be", async () => {
    // The binary fallback is the one content kind with nothing to look at, so the
    // OS handoff is offered in the content area too, not only in the host header
    // (ADR-0191).
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, pathLinkOsOpenConfirm: false },
    });
    vi.mocked(readFileForViewer).mockResolvedValue({ kind: "binary", size: 2048 });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/blob.bin" />);
    });
    fireEvent.click(screen.getByTestId("file-viewer-binary-os-open"));
    expect(openInOs).toHaveBeenCalledWith("/home/user/blob.bin", "open");

    fireEvent.click(screen.getByTestId("file-viewer-binary-os-reveal"));
    expect(openInOs).toHaveBeenCalledWith("/home/user/blob.bin", "reveal");
  });

  it("keeps the confirm gate on the binary content-area open button", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(readFileForViewer).mockResolvedValue({ kind: "binary", size: 2048 });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/setup.exe" />);
    });
    fireEvent.click(screen.getByTestId("file-viewer-binary-os-open"));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(openInOs).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("shows an error message when reading fails", async () => {
    vi.mocked(readFileForViewer).mockRejectedValue("boom");
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    expect(screen.getByTestId("file-viewer-text")).toHaveTextContent("Error reading file: boom");
  });

  it("uses a terminal viewer with the configured command for matching extensions", async () => {
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".txt"], command: "vi", profile: "WSL" }],
      },
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    // Terminal viewer path is taken — readFileForViewer is NOT called.
    expect(readFileForViewer).not.toHaveBeenCalled();
    const term = screen.getByTestId("mock-terminal-view");
    expect(term).toHaveAttribute("data-profile", "WSL");
    expect(term).toHaveAttribute("data-viewer-command", "vi");
    expect(term).toHaveAttribute("data-viewer-path", "/home/user/a.txt");
  });

  it("uses the explicitly selected Windows profile without inferring from the path", async () => {
    useSettingsStore.setState({
      profiles: [
        {
          name: "PowerShell",
          commandLine: "powershell.exe",
          startingDirectory: "",
          startupCommand: "",
          syncCwd: "default",
        },
        {
          name: "WSL",
          commandLine: "wsl.exe",
          startingDirectory: "",
          startupCommand: "",
          syncCwd: "default",
        },
      ],
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".txt"], command: "notepad", profile: "PowerShell" }],
      },
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute("data-profile", "PowerShell");
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute(
      "data-viewer-path",
      "/home/user/a.txt",
    );
  });

  it("shows an explicit error instead of inferring a missing viewer profile", async () => {
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".md"], command: "vi", profile: "" }],
      },
    });

    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/README.md" />);
    });

    expect(screen.queryByTestId("mock-terminal-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-viewer-error")).toHaveTextContent(
      "Select a terminal profile for the .md viewer.",
    );
  });

  it("shows an explicit error when the configured viewer profile no longer exists", async () => {
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".md"], command: "vi", profile: "Deleted" }],
      },
    });

    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/README.md" />);
    });

    expect(screen.queryByTestId("mock-terminal-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-viewer-error")).toHaveTextContent(
      'Terminal profile "Deleted" does not exist.',
    );
  });

  it("routes each structured extension to its own renderer", async () => {
    const cases = [
      { path: "/w/package.json", content: '{"name":"laymux"}', testId: "json-preview" },
      { path: "/w/session.jsonl", content: '{"a":1}\n{"b":2}', testId: "jsonl-preview" },
      {
        path: "/w/fix.diff",
        content: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n",
        testId: "diff-preview",
      },
      { path: "/w/rows.csv", content: "name,size\na,1\n", testId: "csv-preview" },
      { path: "/w/build.log", content: "starting\nERROR boom\n", testId: "log-preview" },
    ];

    for (const { path, content, testId } of cases) {
      vi.mocked(readFileForViewer).mockResolvedValue({ kind: "text", content, truncated: false });
      const view = await act(async () => render(<FileViewer {...baseProps} path={path} />));
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      // Every structured preview keeps the Source escape hatch.
      expect(screen.getByTestId("file-viewer-source-mode")).toBeInTheDocument();
      view.unmount();
    }
  });

  it("sends source files to the highlighter", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "fn main() {}",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/w/main.rs" />);
    });

    // Asserting the loading state keeps this test off the real shiki chunk;
    // the highlighter's own behavior is covered in code-highlight.test.ts.
    expect(screen.getByTestId("code-preview-loading")).toBeInTheDocument();
  });

  it("shows source instead of a renderer once Source is selected", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "name,size\na,1\n",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/w/rows.csv" />);
    });

    expect(screen.getByTestId("csv-preview")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("file-viewer-source-mode"));
    });

    expect(screen.queryByTestId("csv-preview")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-viewer-text")).toHaveTextContent("name,size");
  });

  it("tells structured renderers when the backend cut the file", async () => {
    // The renderers' own caps only describe what they dropped. A file cut at
    // the backend read limit is parsed from a fragment, and without this banner
    // a truncated CSV looks complete.
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "name,size\na,1\n",
      truncated: true,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/w/huge.csv" />);
    });

    expect(screen.getByTestId("file-viewer-source-truncated")).toBeInTheDocument();
    expect(screen.getByTestId("csv-preview")).toBeInTheDocument();
  });

  it("blames truncation, not the file, when a cut JSON fails to parse", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: '{"items": [1, 2, 3',
      truncated: true,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/w/huge.json" />);
    });

    const error = screen.getByTestId("json-preview-error");
    expect(error).toHaveTextContent("cut at the viewer's read limit");
    expect(error).not.toHaveTextContent("Invalid JSON");
  });

  it("reports invalid JSON without losing the file", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: '{"name": }',
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/w/broken.json" />);
    });

    // A parse failure is not a viewer failure: say where it broke and leave the
    // Source toggle in place.
    expect(screen.getByTestId("json-preview-error")).toHaveTextContent("Invalid JSON");
    expect(screen.getByTestId("file-viewer-source-mode")).toBeInTheDocument();
  });

  it("gives svg an image/source toggle instead of a bare image", async () => {
    // base64 of `<svg xmlns="http://www.w3.org/2000/svg"/>`
    const dataUrl = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;
    vi.mocked(readFileForViewer).mockResolvedValue({ kind: "image", dataUrl });

    await act(async () => {
      render(<FileViewer {...baseProps} path="/w/icon.svg" />);
    });
    expect(screen.getByTestId("svg-preview-image")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("file-viewer-source-mode"));
    });
    expect(screen.getByTestId("svg-preview-source")).toHaveTextContent(
      "http://www.w3.org/2000/svg",
    );
  });

  it("keeps a plain image on the bare image path", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,AAAA",
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/w/shot.png" />);
    });

    expect(screen.getByTestId("file-viewer-image")).toBeInTheDocument();
    expect(screen.queryByTestId("file-viewer-source-mode")).not.toBeInTheDocument();
  });

  it("lists archive entries and admits when the listing was capped", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "archive",
      format: "zip",
      entries: [
        { name: "src/main.rs", size: 2048, compressedSize: 700, isDirectory: false },
        { name: "src/", size: 0, compressedSize: 0, isDirectory: true },
      ],
      totalEntries: 5000,
      totalBytes: 41_943_040,
      truncated: true,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/w/bundle.zip" />);
    });

    expect(screen.getAllByTestId("archive-preview-row")).toHaveLength(2);
    expect(screen.getByTestId("archive-preview-truncated")).toHaveTextContent(
      "Showing the first 2 of 5,000 entries.",
    );
    // The size must describe the whole archive, not just the listed rows —
    // pairing a full count with a partial size understates it ~2500x here.
    expect(screen.getByTestId("archive-preview-summary")).toHaveTextContent(
      "40.0 MiB uncompressed",
    );
  });

  it("hands a pdf to the host webview viewer", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "pdf",
      dataUrl: `data:application/pdf;base64,${btoa("%PDF-1.7")}`,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/w/doc.pdf" />);
    });

    expect(screen.getByTestId("pdf-preview")).toBeInTheDocument();
    // An iframe, not an object: WebView2 will not render a PDF through
    // `<object>`. That costs the fallback slot, so the escape hatch for an
    // engine with no PDF viewer has to be a permanent button.
    expect(screen.getByTestId("pdf-preview-frame")).toBeInTheDocument();
    expect(screen.getByTestId("pdf-preview-open-external")).toBeInTheDocument();
  });
});
