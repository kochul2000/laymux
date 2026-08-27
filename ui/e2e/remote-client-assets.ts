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
 * App requests use the committed minified artifacts, like production. The
 * readable app source imports the Lucide boundary as an ES module build input
 * and is not itself a browser script; the drift test below the Remote source
 * tree guarantees the committed bundle matches all of its inputs.
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

function committedAssetName(logicalName: (typeof ASSETS)[number]): string {
  if (logicalName === "remote-app.js") return "remote-app.min.js";
  if (logicalName === "remote-app.css") return "remote-app.min.css";
  return logicalName;
}

/**
 * The served document policy, from the same `page-csp.txt` the Rust route
 * compiles in. Mocked responses carry it so the suite exercises the page under
 * the policy production ships — a directive that blocks the client fails here
 * rather than on a phone.
 */
export function remoteClientCsp(origin: string): string {
  const template = readFileSync(`${remoteRoot}page-csp.txt`, "utf8").trimEnd();
  const { host } = new URL(origin);
  return template.replace("__WS_SOURCES__", ` ws://${host} wss://${host}`);
}

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
      headers: { "content-security-policy": remoteClientCsp(route.request().url()) },
    });
    return true;
  }
  const asset = ASSETS.find((name) => pathname === `/remote/vendor/${name}`);
  if (!asset) return false;
  await route.fulfill({
    path: `${remoteRoot}assets/${committedAssetName(asset)}`,
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
    route.fulfill({
      body: remoteClientPageHtml(),
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": remoteClientCsp(origin) },
    }),
  );
  for (const asset of ASSETS) {
    await page.route(`${origin}/remote/vendor/${asset}`, (route) =>
      route.fulfill({
        path: `${remoteRoot}assets/${committedAssetName(asset)}`,
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
  const inline = (name: (typeof ASSETS)[number]) =>
    readFileSync(`${remoteRoot}assets/${committedAssetName(name)}`, "utf8");
  const html = readFileSync(`${remoteRoot}page.html`, "utf8").replace(
    `<link rel="stylesheet" href="{{ASSET:remote-app.css}}" />`,
    () => `<style>\n${inline("remote-app.css")}\n</style>`,
  );
  if (!script) {
    return html
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<link[^>]*xterm\.css[^>]*>/g, "");
  }
  // An inline classic script closes at the first literal `</script>`, even
  // when those bytes occur inside a JavaScript string. Production serves this
  // bundle externally; escape only the test helper's inline representation.
  const appScript = inline("remote-app.js").replace(/<\/script/gi, "<\\/script");
  return html
    .replace(
      `<script src="{{ASSET:unicode-provider.js}}"></script>`,
      () => `<script>\n${inline("unicode-provider.js")}\n</script>`,
    )
    .replace(
      `<script src="{{ASSET:remote-app.js}}"></script>`,
      () => `<script>\n${appScript}\n</script>`,
    )
    .replace(/<script\s+src=[^>]*><\/script>/g, "")
    .replace(/<link[^>]*xterm\.css[^>]*>/g, "");
}
