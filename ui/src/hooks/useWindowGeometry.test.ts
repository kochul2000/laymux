import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadWindowGeometry = vi.fn();
const mockSaveWindowGeometry = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  loadWindowGeometry: (...args: unknown[]) => mockLoadWindowGeometry(...args),
  saveWindowGeometry: (...args: unknown[]) => mockSaveWindowGeometry(...args),
}));

const mockGetCurrentWindow = vi.fn();
const mockAvailableMonitors = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockGetCurrentWindow(),
  availableMonitors: () => mockAvailableMonitors(),
  PhysicalSize: class {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
  },
  PhysicalPosition: class {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  },
}));

import {
  restoreWindowGeometry,
  captureWindowGeometry,
  _resetCachedGeometry,
  _getCachedGeometry,
} from "./useWindowGeometry";

describe("useWindowGeometry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCachedGeometry();
  });

  describe("restoreWindowGeometry", () => {
    it("does nothing when no saved geometry", async () => {
      mockLoadWindowGeometry.mockResolvedValue(null);
      const mockWindow = {
        setSize: vi.fn(),
        setPosition: vi.fn(),
        maximize: vi.fn(),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow);

      await restoreWindowGeometry();

      expect(mockWindow.setSize).not.toHaveBeenCalled();
      expect(mockWindow.setPosition).not.toHaveBeenCalled();
    });

    it("restores saved size and position", async () => {
      mockLoadWindowGeometry.mockResolvedValue({
        x: 100,
        y: 200,
        width: 1400,
        height: 900,
        maximized: false,
      });
      mockAvailableMonitors.mockResolvedValue([
        { size: { width: 1920, height: 1080 }, position: { x: 0, y: 0 } },
      ]);
      const mockWindow = {
        setSize: vi.fn().mockResolvedValue(undefined),
        setPosition: vi.fn().mockResolvedValue(undefined),
        maximize: vi.fn(),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow);

      await restoreWindowGeometry();

      expect(mockWindow.setSize).toHaveBeenCalled();
      expect(mockWindow.setPosition).toHaveBeenCalled();
      expect(mockWindow.maximize).not.toHaveBeenCalled();
    });

    it("maximizes window when saved as maximized", async () => {
      mockLoadWindowGeometry.mockResolvedValue({
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        maximized: true,
      });
      mockAvailableMonitors.mockResolvedValue([
        { size: { width: 1920, height: 1080 }, position: { x: 0, y: 0 } },
      ]);
      const mockWindow = {
        setSize: vi.fn().mockResolvedValue(undefined),
        setPosition: vi.fn().mockResolvedValue(undefined),
        maximize: vi.fn().mockResolvedValue(undefined),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow);

      await restoreWindowGeometry();

      expect(mockWindow.maximize).toHaveBeenCalled();
    });

    it("clamps size to monitor bounds when saved size exceeds screen", async () => {
      mockLoadWindowGeometry.mockResolvedValue({
        x: 0,
        y: 0,
        width: 3000,
        height: 2000,
        maximized: false,
      });
      mockAvailableMonitors.mockResolvedValue([
        { size: { width: 1920, height: 1080 }, position: { x: 0, y: 0 } },
      ]);
      const mockWindow = {
        setSize: vi.fn().mockResolvedValue(undefined),
        setPosition: vi.fn().mockResolvedValue(undefined),
        maximize: vi.fn(),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow);

      await restoreWindowGeometry();

      const sizeArg = mockWindow.setSize.mock.calls[0][0];
      expect(sizeArg.width).toBeLessThanOrEqual(1920);
      expect(sizeArg.height).toBeLessThanOrEqual(1080);
    });

    it("skips geometry with negative coordinates (minimized window)", async () => {
      mockLoadWindowGeometry.mockResolvedValue({
        x: -32000,
        y: -32000,
        width: 160,
        height: 28,
        maximized: false,
      });
      mockAvailableMonitors.mockResolvedValue([
        { size: { width: 1920, height: 1080 }, position: { x: 0, y: 0 } },
      ]);
      const mockWindow = {
        setSize: vi.fn(),
        setPosition: vi.fn(),
        maximize: vi.fn(),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow);

      await restoreWindowGeometry();

      expect(mockWindow.setSize).not.toHaveBeenCalled();
      expect(mockWindow.setPosition).not.toHaveBeenCalled();
    });

    it("skips geometry with too small size", async () => {
      mockLoadWindowGeometry.mockResolvedValue({
        x: 100,
        y: 100,
        width: 50,
        height: 20,
        maximized: false,
      });
      mockAvailableMonitors.mockResolvedValue([
        { size: { width: 1920, height: 1080 }, position: { x: 0, y: 0 } },
      ]);
      const mockWindow = {
        setSize: vi.fn(),
        setPosition: vi.fn(),
        maximize: vi.fn(),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow);

      await restoreWindowGeometry();

      expect(mockWindow.setSize).not.toHaveBeenCalled();
    });
  });

  describe("captureWindowGeometry", () => {
    it("captures inner size (not outer size) to match setSize restore", async () => {
      mockSaveWindowGeometry.mockResolvedValue(undefined);
      const mockWindow = {
        outerPosition: vi.fn().mockResolvedValue({ x: 50, y: 100 }),
        innerSize: vi.fn().mockResolvedValue({ width: 1200, height: 770 }),
        outerSize: vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
        isMaximized: vi.fn().mockResolvedValue(false),
        isMinimized: vi.fn().mockResolvedValue(false),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow);

      await captureWindowGeometry();

      // Must use innerSize, not outerSize, because restoreWindowGeometry
      // calls setSize() which sets inner (content) size.
      expect(mockWindow.innerSize).toHaveBeenCalled();
      expect(mockSaveWindowGeometry).toHaveBeenCalledWith({
        x: 50,
        y: 100,
        width: 1200,
        height: 770,
        maximized: false,
      });
    });

    it("updates cached geometry on normal capture", async () => {
      mockSaveWindowGeometry.mockResolvedValue(undefined);
      const mockWindow = {
        outerPosition: vi.fn().mockResolvedValue({ x: 200, y: 300 }),
        innerSize: vi.fn().mockResolvedValue({ width: 1400, height: 870 }),
        outerSize: vi.fn().mockResolvedValue({ width: 1400, height: 900 }),
        isMaximized: vi.fn().mockResolvedValue(false),
        isMinimized: vi.fn().mockResolvedValue(false),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow);

      await captureWindowGeometry();

      expect(_getCachedGeometry()).toEqual({
        x: 200,
        y: 300,
        width: 1400,
        height: 870,
        maximized: false,
      });
    });

    it("saves cached geometry when window is minimized", async () => {
      // First capture in normal state to populate cache
      mockSaveWindowGeometry.mockResolvedValue(undefined);
      const normalWindow = {
        outerPosition: vi.fn().mockResolvedValue({ x: 100, y: 200 }),
        innerSize: vi.fn().mockResolvedValue({ width: 1200, height: 770 }),
        outerSize: vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
        isMaximized: vi.fn().mockResolvedValue(false),
        isMinimized: vi.fn().mockResolvedValue(false),
      };
      mockGetCurrentWindow.mockReturnValue(normalWindow);
      await captureWindowGeometry();
      mockSaveWindowGeometry.mockClear();

      // Now capture while minimized — should save the cached values
      const minimizedWindow = {
        outerPosition: vi.fn().mockResolvedValue({ x: -32000, y: -32000 }),
        outerSize: vi.fn().mockResolvedValue({ width: 160, height: 28 }),
        isMaximized: vi.fn().mockResolvedValue(false),
        isMinimized: vi.fn().mockResolvedValue(true),
      };
      mockGetCurrentWindow.mockReturnValue(minimizedWindow);

      await captureWindowGeometry();

      expect(mockSaveWindowGeometry).toHaveBeenCalledWith({
        x: 100,
        y: 200,
        width: 1200,
        height: 770,
        maximized: false,
      });
    });

    it("skips saving when minimized and no cached geometry", async () => {
      const mockWindow = {
        outerPosition: vi.fn().mockResolvedValue({ x: -32000, y: -32000 }),
        innerSize: vi.fn().mockResolvedValue({ width: 160, height: 28 }),
        outerSize: vi.fn().mockResolvedValue({ width: 160, height: 28 }),
        isMaximized: vi.fn().mockResolvedValue(false),
        isMinimized: vi.fn().mockResolvedValue(true),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow);

      await captureWindowGeometry();

      expect(mockSaveWindowGeometry).not.toHaveBeenCalled();
    });
  });
});
