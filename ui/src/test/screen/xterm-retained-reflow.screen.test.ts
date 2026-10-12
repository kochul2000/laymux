import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const desktopCjs = require(
  resolve(__dirname, "../../../node_modules/@xterm/xterm/lib/xterm.js"),
) as { Terminal: typeof Terminal };
const remoteCjs = require(
  resolve(__dirname, "../../../../src-tauri/src/remote_server/assets/xterm.js"),
) as { Terminal: typeof Terminal };
const engines = [
  ["desktop ESM", Terminal],
  ["desktop CJS", desktopCjs.Terminal],
  ["Remote CJS", remoteCjs.Terminal],
] as const;

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

// Leave the cursor on an independent hard line: xterm deliberately excludes
// the active cursor's paragraph from reflow unless explicitly configured.
const paragraph = `${"0123456789".repeat(9)}ABCDE`;

describe.each(engines)(
  "%s wider reflow retains a paragraph spanning several rows",
  (_name, Engine) => {
    it("keeps the last retained row wrapped after partial widening", async () => {
      const term = new Engine({ allowProposedApi: true, cols: 10, rows: 20 });
      try {
        await write(term, `${paragraph}\r\nNEXT\r\n`);
        term.resize(20, 20);
        expect(term.buffer.active.getLine(4)?.translateToString(true)).toBe("0123456789ABCDE");
        expect(term.buffer.active.getLine(4)?.isWrapped).toBe(true);
      } finally {
        term.dispose();
      }
    });

    it("joins the complete paragraph on a second widening without merging hard lines", async () => {
      const term = new Engine({ allowProposedApi: true, cols: 10, rows: 20 });
      try {
        await write(term, `${paragraph}\r\nNEXT\r\n`);
        term.resize(20, 20);
        term.resize(100, 20);
        expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(paragraph);
        expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("NEXT");
        expect(term.buffer.active.getLine(1)?.isWrapped).toBe(false);
      } finally {
        term.dispose();
      }
    });
  },
);
