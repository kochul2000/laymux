import { describe, it, expect, beforeEach } from "vitest";
import {
  registerTerminalSerializer,
  unregisterTerminalSerializer,
  getTerminalSerializeMap,
} from "./terminal-serialize-registry";

describe("terminal-serialize-registry", () => {
  beforeEach(() => {
    // Clean up all registered serializers
    const map = getTerminalSerializeMap();
    for (const key of map.keys()) {
      unregisterTerminalSerializer(key);
    }
  });

  it("registers and retrieves a serializer", () => {
    const fn = () => "data";
    registerTerminalSerializer("pane-1", fn);

    const map = getTerminalSerializeMap();
    expect(map.size).toBe(1);
    expect(map.get("pane-1")!()).toBe("data");
  });

  it("unregisters a serializer", () => {
    registerTerminalSerializer("pane-2", () => "data");
    unregisterTerminalSerializer("pane-2");

    const map = getTerminalSerializeMap();
    expect(map.size).toBe(0);
    expect(map.has("pane-2")).toBe(false);
  });

  it("returns a copy, not the live registry", () => {
    registerTerminalSerializer("pane-3", () => "data");
    const map1 = getTerminalSerializeMap();

    registerTerminalSerializer("pane-4", () => "more");
    const map2 = getTerminalSerializeMap();

    // map1 should still have only 1 entry (it's a snapshot)
    expect(map1.size).toBe(1);
    expect(map2.size).toBe(2);
  });

  it("overwrites existing serializer for same paneId", () => {
    registerTerminalSerializer("pane-5", () => "old");
    registerTerminalSerializer("pane-5", () => "new");

    const map = getTerminalSerializeMap();
    expect(map.size).toBe(1);
    expect(map.get("pane-5")!()).toBe("new");
  });
});
