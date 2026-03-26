import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserPreviewView } from "./BrowserPreviewView";

// Mock tauri-api
const mockLaunchCdpBrowser = vi.fn();
const mockCloseCdpBrowser = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/tauri-api", () => ({
  launchCdpBrowser: (...args: unknown[]) => mockLaunchCdpBrowser(...args),
  closeCdpBrowser: (...args: unknown[]) => mockCloseCdpBrowser(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BrowserPreviewView", () => {
  it("renders with default url", () => {
    render(<BrowserPreviewView />);
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument();
  });

  it("renders with provided url", () => {
    render(<BrowserPreviewView url="http://localhost:3000" />);
    const input = screen.getByTestId("browser-url-input") as HTMLInputElement;
    expect(input.value).toBe("http://localhost:3000");
  });

  it("renders iframe with the url", () => {
    render(<BrowserPreviewView url="http://localhost:8080" />);
    const iframe = screen.getByTestId("browser-iframe") as HTMLIFrameElement;
    expect(iframe.src).toBe("http://localhost:8080/");
  });

  it("has a reload button", () => {
    render(<BrowserPreviewView url="http://localhost:3000" />);
    expect(screen.getByTestId("browser-reload-btn")).toBeInTheDocument();
  });

  it("navigates to new url on enter", async () => {
    const user = userEvent.setup();
    render(<BrowserPreviewView url="http://localhost:3000" />);

    const input = screen.getByTestId("browser-url-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "http://localhost:8080{Enter}");

    const iframe = screen.getByTestId("browser-iframe") as HTMLIFrameElement;
    expect(iframe.src).toBe("http://localhost:8080/");
  });

  it("has back and forward buttons", () => {
    render(<BrowserPreviewView url="http://localhost:3000" />);
    expect(screen.getByTestId("browser-back-btn")).toBeInTheDocument();
    expect(screen.getByTestId("browser-forward-btn")).toBeInTheDocument();
  });
});

describe("BrowserPreviewView CDP", () => {
  it("shows CDP launch button", () => {
    render(<BrowserPreviewView url="http://localhost:3000" />);
    expect(screen.getByTestId("cdp-launch-btn")).toBeInTheDocument();
    expect(screen.getByTestId("cdp-launch-btn")).toHaveTextContent("CDP");
  });

  it("launches CDP browser on button click", async () => {
    const user = userEvent.setup();
    mockLaunchCdpBrowser.mockResolvedValue({
      id: "test-id",
      cdpPort: 9222,
      cdpWsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      targetUrl: "http://localhost:3000",
      pid: 12345,
    });

    render(<BrowserPreviewView url="http://localhost:3000" />);
    await user.click(screen.getByTestId("cdp-launch-btn"));

    await waitFor(() => {
      expect(mockLaunchCdpBrowser).toHaveBeenCalledWith("http://localhost:3000");
    });

    await waitFor(() => {
      expect(screen.getByTestId("cdp-info-bar")).toBeInTheDocument();
      expect(screen.getByTestId("cdp-ws-url")).toHaveTextContent(
        "ws://127.0.0.1:9222/devtools/browser/abc",
      );
      expect(screen.getByTestId("cdp-http-url")).toHaveTextContent(
        "http://localhost:9222",
      );
    });
  });

  it("shows CDP close button when connected", async () => {
    const user = userEvent.setup();
    mockLaunchCdpBrowser.mockResolvedValue({
      id: "test-id",
      cdpPort: 9222,
      cdpWsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      targetUrl: "http://localhost:3000",
      pid: 12345,
    });

    render(<BrowserPreviewView url="http://localhost:3000" />);
    await user.click(screen.getByTestId("cdp-launch-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("cdp-close-btn")).toBeInTheDocument();
      expect(screen.getByTestId("cdp-close-btn")).toHaveTextContent("CDP :9222");
    });
  });

  it("closes CDP browser on close button click", async () => {
    const user = userEvent.setup();
    mockLaunchCdpBrowser.mockResolvedValue({
      id: "test-id",
      cdpPort: 9222,
      cdpWsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      targetUrl: "http://localhost:3000",
      pid: 12345,
    });
    mockCloseCdpBrowser.mockResolvedValue(undefined);

    render(<BrowserPreviewView url="http://localhost:3000" />);
    await user.click(screen.getByTestId("cdp-launch-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("cdp-close-btn")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("cdp-close-btn"));

    await waitFor(() => {
      expect(mockCloseCdpBrowser).toHaveBeenCalledWith("test-id");
      expect(screen.getByTestId("cdp-launch-btn")).toBeInTheDocument();
    });
  });

  it("shows error when CDP launch fails", async () => {
    const user = userEvent.setup();
    mockLaunchCdpBrowser.mockRejectedValue(
      new Error("No Chromium-based browser found"),
    );

    render(<BrowserPreviewView url="http://localhost:3000" />);
    await user.click(screen.getByTestId("cdp-launch-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("cdp-error")).toHaveTextContent(
        "No Chromium-based browser found",
      );
    });
  });

  it("shows CDP launch button for about:blank", () => {
    render(<BrowserPreviewView />);
    expect(screen.getByTestId("cdp-launch-btn")).toBeInTheDocument();
  });
});
