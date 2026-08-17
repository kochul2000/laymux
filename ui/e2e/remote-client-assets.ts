import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page, Route } from "@playwright/test";

/**
 * Serve the Remote client the way the Rust server does, for specs that drive the
 * real page in a browser.
 *
 * Since ADR-0169 the shell references its scripts and styles as
 * `{{ASSET:<logical name>}}` placeholders that the server rewrites to hashed,
 * immutable URLs at startup. Fulfilling `page.html` verbatim therefore ships a
 * document whose `<script src>` never resolves, so `window.Terminal` and the app
 * bundle never load. This module does the server's substitution and answers the
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

/** The shell with every `{{ASSET:...}}` pointing at `/remote/vendor/<name>`. */
export function remoteClientPageHtml(): string {
  let html = readFileSync(`${remoteRoot}page.html`, "utf8");
  for (const asset of ASSETS) {
    html = html.split(`{{ASSET:${asset}}}`).join(`/remote/vendor/${asset}`);
  }
  return html;
}

/**
 * Fulfil `/remote/` and `/remote/vendor/*` for specs that route the whole
 * `/remote/**` surface through one handler, and report whether it did — so the
 * caller can fall through to its own paths (`/remote/viewer/`, `/remote/v1/...`).
 */
export async function fulfillRemoteClientAsset(route: Route, pathname: string): Promise<boolean> {
  if (pathname === "/remote/") {
    await route.fulfill({
      body: remoteClientPageHtml(),
      contentType: "text/html; charset=utf-8",
    });
    return true;
  }
  const asset = ASSETS.find((name) => pathname === `/remote/vendor/${name}`);
  if (!asset) return false;
  await route.fulfill({
    path: `${remoteRoot}assets/${asset}`,
    contentType: ASSET_CONTENT_TYPES[asset.split(".").pop() as string],
  });
  return true;
}

/** Register the client routes on their own, for specs that route path by path. */
export async function installRemoteClientRoutes(
  page: Page,
  origin = "http://remote.test",
): Promise<void> {
  await page.route(`${origin}/remote/`, (route) =>
    route.fulfill({ body: remoteClientPageHtml(), contentType: "text/html; charset=utf-8" }),
  );
  for (const asset of ASSETS) {
    await page.route(`${origin}/remote/vendor/${asset}`, (route) =>
      route.fulfill({
        path: `${remoteRoot}assets/${asset}`,
        contentType: ASSET_CONTENT_TYPES[asset.split(".").pop() as string],
      }),
    );
  }
}

/**
 * The shell for specs that call `page.setContent` instead of navigating: the app
 * stylesheet (and, unless `script: false`, the app bundle) inlined, every vendor
 * script dropped.
 *
 * Those specs deliberately run without xterm. Before ADR-0169 the app code and
 * styles were inline in `page.html`, so stripping `<script src>` and the xterm
 * `<link>` left a working page behind; now the same strip removes the app
 * itself, hence the inlining here. `script: false` keeps the markup+CSS-only
 * variant, for layout assertions that must not run the client.
 */
export function remoteClientMarkupWithoutXterm({ script = true } = {}): string {
  const inline = (name: string) => readFileSync(`${remoteRoot}assets/${name}`, "utf8");
  const html = readFileSync(`${remoteRoot}page.html`, "utf8").replace(
    `<link rel="stylesheet" href="{{ASSET:remote-app.css}}" />`,
    `<style>\n${inline("remote-app.css")}\n</style>`,
  );
  if (!script) {
    return html
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<link[^>]*xterm\.css[^>]*>/g, "");
  }
  return html
    .replace(
      `<script src="{{ASSET:unicode-provider.js}}"></script>`,
      `<script>\n${inline("unicode-provider.js")}\n</script>`,
    )
    .replace(
      `<script src="{{ASSET:remote-app.js}}"></script>`,
      `<script>\n${inline("remote-app.js")}\n</script>`,
    )
    .replace(/<script\s+src=[^>]*><\/script>/g, "")
    .replace(/<link[^>]*xterm\.css[^>]*>/g, "");
}
