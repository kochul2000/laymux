import { describe, expect, it } from "vitest";
import { localhostPreviewUrl, readPreviewResource } from "./localhost-preview.js";

describe("localhost web preview", () => {
  it("only captures HTTP loopback links on non-management ports", () => {
    for (const url of [
      "http://localhost:8765/",
      "http://127.0.0.1:8765/a?q=1",
      "http://[::1]:8765/",
    ]) {
      expect(localhostPreviewUrl(url)?.href).toBe(new URL(url).href);
    }
    for (const url of [
      "https://localhost:8765/",
      "http://evil.test:8765/",
      "http://localhost/",
      "http://localhost:19281/",
      "http://u:p@localhost:8765/",
      "file:///tmp/a",
    ]) {
      expect(localhostPreviewUrl(url)).toBeNull();
    }
  });

  it("assembles binary chunks without forwarding authentication or changing origins", async () => {
    const calls: unknown[] = [];
    const api = async (path: string, options: { body: string; fileViewerToken: string }) => {
      expect(options.fileViewerToken).toBe("secret-viewer");
      const body = JSON.parse(options.body);
      calls.push({ path, body });
      return {
        status: 200,
        contentType: "application/wasm",
        totalBytes: 4,
        offset: body.offset,
        nextOffset: body.offset + 2,
        body: body.offset === 0 ? "AP8=" : "AX8=",
      };
    };
    const result = await readPreviewResource(
      api,
      {
        sessionId: "session",
        leaseId: "lease",
        fileViewerToken: "secret-viewer",
        url: "http://localhost:8765/game/",
      },
      "index.wasm",
    );
    expect([...result.bytes]).toEqual([0, 255, 1, 127]);
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({
      path: "/remote/v1/localhost-preview/resource",
      body: { sessionId: "session", leaseId: "lease", pathAndQuery: "/game/index.wasm", offset: 2 },
    });
    await expect(
      readPreviewResource(
        api,
        { sessionId: "s", leaseId: "l", url: "http://localhost:8765/" },
        "http://localhost:19280/api/v1/settings",
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("rejects broken chunk bounds instead of looping or returning partial data", async () => {
    const api = async () => ({
      status: 200,
      contentType: "text/html",
      body: "AA==",
      offset: 0,
      nextOffset: 0,
      totalBytes: 10,
    });
    await expect(
      readPreviewResource(
        api,
        { sessionId: "s", leaseId: "l", url: "http://localhost:8765/" },
        "/",
      ),
    ).rejects.toThrow();
  });
});
