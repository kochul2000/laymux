import { render, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConnectionInfoModal } from "./ConnectionInfoModal";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe("ConnectionInfoModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ port: 19280, key: "test-uuid-key-123" });
  });

  it("calls get_automation_info on mount", async () => {
    render(<ConnectionInfoModal />);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_automation_info");
    });
  });

  it("renders host, port, and key as environment variables", async () => {
    render(<ConnectionInfoModal />);
    await waitFor(() => {
      const pre = document.querySelector("pre");
      expect(pre?.textContent).toContain("LX_AUTOMATION_HOST=127.0.0.1");
      expect(pre?.textContent).toContain("LX_AUTOMATION_PORT=19280");
      expect(pre?.textContent).toContain("LX_AUTOMATION_KEY=test-uuid-key-123");
    });
  });
});
