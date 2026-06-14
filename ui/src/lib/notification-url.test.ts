import { describe, it, expect } from "vitest";
import { extractNotificationUrl } from "./notification-url";

describe("extractNotificationUrl", () => {
  it("returns null when no URL present", () => {
    expect(extractNotificationUrl("Codex task completed")).toBeNull();
    expect(extractNotificationUrl("")).toBeNull();
  });

  it("extracts a bare https URL", () => {
    expect(extractNotificationUrl("https://example.com/auth?code=abc")).toBe(
      "https://example.com/auth?code=abc",
    );
  });

  it("extracts an http URL", () => {
    expect(extractNotificationUrl("Open http://localhost:1455/callback now")).toBe(
      "http://localhost:1455/callback",
    );
  });

  it("extracts a URL embedded in a sentence", () => {
    expect(extractNotificationUrl("Sign in at https://codex.example.com/login to continue")).toBe(
      "https://codex.example.com/login",
    );
  });

  it("trims trailing sentence punctuation", () => {
    expect(extractNotificationUrl("Visit https://example.com/page.")).toBe(
      "https://example.com/page",
    );
    expect(extractNotificationUrl("See https://example.com/x!")).toBe("https://example.com/x");
  });

  it("trims an unbalanced trailing closing paren", () => {
    expect(extractNotificationUrl("(see https://example.com/docs)")).toBe(
      "https://example.com/docs",
    );
  });

  it("keeps balanced parentheses inside the URL", () => {
    expect(extractNotificationUrl("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
  });

  it("returns the first URL when several are present", () => {
    expect(extractNotificationUrl("https://a.com and https://b.com")).toBe("https://a.com");
  });

  it("preserves query and fragment", () => {
    expect(extractNotificationUrl("go https://x.io/p?a=1&b=2#frag here")).toBe(
      "https://x.io/p?a=1&b=2#frag",
    );
  });
});
