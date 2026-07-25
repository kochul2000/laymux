/**
 * Remote-client entry for the shared cell-width provider.
 *
 * Issue #538. The Direct Remote Mode browser client loads a committed xterm
 * bundle and, until now, no provider — so it kept xterm's default Unicode 6
 * widths while the desktop registers `terminal-unicode-width.ts`. Measured
 * divergence: 89 BMP code points and effectively every supplementary-plane
 * emoji report 1 cell on remote and 2 on the desktop, so the same PTY output
 * wraps at different columns on the two surfaces.
 *
 * Copying the width table into `page.html` would recreate the two-sources-of-
 * truth split ADR-0058 exists to remove. Instead this entry is **built from the
 * same module** into `src-tauri/src/remote_server/assets/unicode-provider.js`
 * (`npm run build:remote-provider`) and served alongside the xterm bundle. The
 * generated asset is committed because the Rust server embeds its assets with
 * `include_str!`; `remote-unicode-provider.test.ts` re-derives the widths from
 * the TypeScript source and fails if the committed asset has drifted.
 *
 * The global is a plain object rather than a module export: `page.html` loads
 * classic scripts, the same way it picks up `window.Terminal`.
 */

import {
  LAYMUX_UNICODE_VERSION,
  charProperties,
  codePointCellWidth,
} from "@/lib/terminal-unicode-width";

declare global {
  interface Window {
    LaymuxUnicodeProvider?: {
      version: string;
      wcwidth: (codePoint: number) => number;
      charProperties: (codePoint: number, preceding: number) => number;
    };
  }
}

window.LaymuxUnicodeProvider = {
  version: LAYMUX_UNICODE_VERSION,
  wcwidth: codePointCellWidth,
  charProperties,
};
