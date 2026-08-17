import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

/**
 * Serve the Remote client the way the Rust server does, for specs that drive the
 * real page in a browser.
 *
 * Since ADR-0169 the shell references its scripts and styles as
 * `{{ASSET:<logical name>}}` placeholders that the server rewrites to hashed,
 * immutable URLs at startup. Fulfilling `page.html` verbatim therefore ships a
 * document whose `<script src>` never resolves, so `window.Terminal` and the app
 * bundle never load. This helper does the server's substitution and answers the
 * resulting URLs from the committed assets.
 *
 * The readable `remote-app.js`/`.css` sources stand in for the minified
 * artifacts production serves under the same logical names — the drift between
 * the two is what `ui/src/remote/remote-page-bundle.test.ts` guards.
 */
const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

const ASSET_CONTENT_TYPES: Record<string, string> = {
  js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

/** Every logical name `page.html` can reference. */
const ASSETS = [
  "xterm.js",
  "xterm.css",
  "unicode-provider.js",
  "addon-fit.js",
  "addon-web-links.js",
  "remote-app.js",
  "remote-app.css",
] as const;

export async function installRemoteClientRoutes(
  page: Page,
  origin = "http://remote.test",
): Promise<void> {
  await page.route(`${origin}/remote/`, (route) => {
    let html = readFileSync(`${remoteRoot}page.html`, "utf8");
    for (const asset of ASSETS) {
      html = html.split(`{{ASSET:${asset}}}`).join(`/remote/vendor/${asset}`);
    }
    return route.fulfill({ body: html, contentType: "text/html; charset=utf-8" });
  });
  for (const asset of ASSETS) {
    const extension = asset.split(".").pop() as string;
    await page.route(`${origin}/remote/vendor/${asset}`, (route) =>
      route.fulfill({
        path: `${remoteRoot}assets/${asset}`,
        contentType: ASSET_CONTENT_TYPES[extension],
      }),
    );
  }
}
