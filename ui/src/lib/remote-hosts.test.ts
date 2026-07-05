import { describe, expect, it } from "vitest";
import {
  appendAllowedIps,
  buildRemoteHostOptions,
  buildRemoteUrlWithToken,
  chooseRemoteHost,
  formatAllowedIps,
  formatHostForUrl,
  normalizeCustomHosts,
  parseAllowedIps,
} from "./remote-hosts";

describe("remote-hosts", () => {
  it("parses and formats allowed IPs with dedupe", () => {
    expect(parseAllowedIps("127.0.0.1/32, 127.0.0.1/32\n100.64.0.0/10")).toEqual([
      "127.0.0.1/32",
      "100.64.0.0/10",
    ]);
    expect(formatAllowedIps(["127.0.0.1/32", "::1/128"])).toBe("127.0.0.1/32\n::1/128");
    expect(appendAllowedIps("127.0.0.1/32", ["127.0.0.1/32", "100.64.0.0/10"])).toBe(
      "127.0.0.1/32\n100.64.0.0/10",
    );
  });

  it("normalizes and merges detected and custom hosts", () => {
    const options = buildRemoteHostOptions(
      [
        { kind: "loopback", host: "127.0.0.1", label: "Localhost" },
        { kind: "lan", host: "192.168.0.4", label: "LAN" },
      ],
      [" 192.168.0.4 ", "devbox.tailnet.ts.net"],
    );

    expect(normalizeCustomHosts([" host ", "host", ""])).toEqual(["host"]);
    expect(options.map((option) => option.host)).toEqual([
      "127.0.0.1",
      "192.168.0.4",
      "devbox.tailnet.ts.net",
    ]);
    expect(chooseRemoteHost(options, "devbox.tailnet.ts.net")).toBe("devbox.tailnet.ts.net");
    expect(chooseRemoteHost(options, "missing")).toBe("127.0.0.1");
  });

  it("brackets IPv6 hosts for URL building", () => {
    expect(formatHostForUrl("fd7a:115c:a1e0::7")).toBe("[fd7a:115c:a1e0::7]");
    expect(formatHostForUrl("[::1]")).toBe("[::1]");
    expect(buildRemoteUrlWithToken("fd7a:115c:a1e0::7", 19281, "a b")).toBe(
      "http://[fd7a:115c:a1e0::7]:19281/remote/#token=a%20b",
    );
  });
});
