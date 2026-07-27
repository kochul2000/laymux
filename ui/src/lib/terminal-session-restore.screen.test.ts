import { SerializeAddon } from "@xterm/addon-serialize";
import { describe, expect, it } from "vitest";
import { serializeTerminalOutput, terminalRestoreBoundary } from "./terminal-output-cache";
import { createScreenTerminal, screenRow } from "@/test/screen/xterm-screen";

describe("terminal session restore screen boundary", () => {
  it("keeps restored history behind the live PTY screen origin", async () => {
    const surface = createScreenTerminal({ cols: 40, rows: 5 });
    const serializeAddon = new SerializeAddon();
    surface.terminal.loadAddon(serializeAddon);

    await surface.write("old line 1\r\nold line 2");
    await surface.write(terminalRestoreBoundary(surface.terminal.rows));
    await surface.write("PS> ");

    // ConPTY owns a fresh 5-row screen and addresses its first row directly
    // when it echoes input. The restored cache must therefore be scrollback,
    // not another screen still occupying those coordinates.
    await surface.write("\x1b[1;5Htyped");

    const snapshot = surface.capture();
    expect(screenRow(snapshot, 0)).toBe("PS> typed");
    expect(snapshot.viewport.slice(1).every((row) => row.text.trimEnd() === "")).toBe(true);
    expect(snapshot.baseY).toBeGreaterThan(0);

    const history = Array.from({ length: snapshot.baseY }, (_, index) =>
      surface.terminal.buffer.normal.getLine(index)?.translateToString(true),
    );
    expect(history).toContain("old line 1");
    expect(history).toContain("old line 2");
    expect(history).toContain("--- session restored ---");

    // The blank live-screen rows used to establish the PTY origin are runtime
    // state, not history. Persisting them would grow the cache by one screen on
    // every restart, which is the pollution visible in pre-fix caches.
    const serialized = serializeTerminalOutput(surface.terminal, serializeAddon);
    expect(serialized).not.toMatch(/(?:\r\n){5,}$/);

    surface.dispose();
  });
});
