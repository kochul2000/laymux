import { describe, expect, it } from "vitest";
import config from "./vite.config";

describe("vite config", () => {
  it("binds the dev server to all interfaces for Tailscale mobile webview access", () => {
    expect(typeof config).toBe("object");
    if (typeof config !== "object") {
      return;
    }

    expect(config.server?.host).toBe("0.0.0.0");
    expect(config.server?.port).toBe(1420);
    expect(config.server?.strictPort).toBe(true);
  });
});
