import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { remoteClientCsp, fulfillRemoteClientAsset } from "./remote-client-assets";

const root = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));
const controller = readFileSync(
  fileURLToPath(new URL("../src/remote/localhost-preview.js", import.meta.url)),
  "utf8",
);
const wasm = Buffer.from(
  "0061736d010000000105016000017f0302010007070103616e7300000a06010400412a0b",
  "hex",
);

async function harness(page: Page, live = false) {
  const target = process.env.LAYMUX_PREVIEW_REPRO_URL || "http://localhost:8765/";
  const resources = new Map<string, { bytes: Buffer; contentType: string }>();
  resources.set("/", {
    contentType: "text/html",
    bytes: Buffer.from(
      `<!doctype html><body><p id="result">Loading</p><script src="app.js"></script></body>`,
    ),
  });
  resources.set("/app.js", {
    contentType: "application/javascript",
    bytes: Buffer.from(`
    let blocked=false; try {parent.document.body.dataset.compromised="yes";} catch {blocked=true;}
    document.body.dataset.parentBlocked=String(blocked);
    let storage=false; try{localStorage.getItem("secret");}catch{storage=true;}
    document.body.dataset.storageBlocked=String(storage);
    fetch("module.wasm").then(r=>WebAssembly.instantiateStreaming(r)).then(w=>document.getElementById("result").textContent=String(w.instance.exports.ans()));
  `),
  });
  resources.set("/module.wasm", { contentType: "application/wasm", bytes: wasm });
  const closes: string[] = [];
  const requests: string[] = [];
  await page.route("https://remote.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/remote/")
      return route.fulfill({
        contentType: "text/html",
        headers: { "Content-Security-Policy": remoteClientCsp("https://remote.test") },
        body: `<!doctype html><link rel="stylesheet" href="/remote/vendor/remote-app.css"><button id="play">Play</button><script type="module" src="/remote/controller.js"></script>`,
      });
    if (path === "/remote/controller.js")
      return route.fulfill({
        contentType: "application/javascript",
        body:
          controller +
          `
      const preview=createLocalhostPreview({getLease:()=>${JSON.stringify(live ? process.env.LAYMUX_PREVIEW_BACKEND_LEASE || "test-lease" : "test-lease")},isAndroid:()=>false,api:async(path,options)=>{const r=await fetch(path,options);if(!r.ok)throw Error("Preview failed");return r.json();}});
      document.getElementById("play").onclick=()=>preview.open(new URL(${JSON.stringify(target)}));
    `,
      });
    if (path === "/remote/localhost-preview/")
      return route.fulfill({
        contentType: "text/html",
        headers: {
          "Content-Security-Policy": readFileSync(root + "preview-csp.txt", "utf8").trim(),
        },
        body: readFileSync(root + "preview.html", "utf8").replace(
          "{{BOOTSTRAP}}",
          readFileSync(root + "preview-bootstrap.js", "utf8"),
        ),
      });
    if (await fulfillRemoteClientAsset(route, path)) return;
    const body = route.request().postDataJSON();
    if (
      live &&
      process.env.LAYMUX_PREVIEW_BACKEND_TOKEN &&
      path.startsWith("/remote/v1/localhost-preview/")
    ) {
      const response = await fetch("http://127.0.0.1:19281" + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + process.env.LAYMUX_PREVIEW_BACKEND_TOKEN,
        },
        body: JSON.stringify(body),
      });
      return route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: await response.text(),
      });
    }
    if (path.endsWith("/begin"))
      return route.fulfill({
        json: { sessionId: "preview-test", url: target, chunkBytes: 512 * 1024 },
      });
    if (path.endsWith("/close")) {
      closes.push(body.sessionId);
      return route.fulfill({ json: { closed: true } });
    }
    if (path.endsWith("/resource")) {
      requests.push(body.pathAndQuery);
      let resource = resources.get(body.pathAndQuery);
      if (live && body.offset === 0) {
        const response = await fetch(new URL(body.pathAndQuery, target));
        resource = {
          bytes: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get("content-type") || "application/octet-stream",
        };
        resources.set(body.pathAndQuery, resource);
      }
      if (!resource) return route.fulfill({ status: 404, json: { error: "missing resource" } });
      const end = Math.min(body.offset + (live ? 512 * 1024 : 16), resource.bytes.length);
      return route.fulfill({
        json: {
          status: 200,
          contentType: resource.contentType,
          body: resource.bytes.subarray(body.offset, end).toString("base64"),
          offset: body.offset,
          nextOffset: end,
          totalBytes: resource.bytes.length,
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("https://remote.test/remote/");
  await page.locator("#play").click();
  return { closes, requests };
}

test("isolated localhost preview runs external scripts and chunked WASM without Remote storage access", async ({
  page,
}) => {
  const { closes, requests } = await harness(page);
  const preview = page.frameLocator(".localhost-preview-overlay iframe");
  await expect(preview.locator("#result")).toHaveText("42");
  await expect(preview.locator("body")).toHaveAttribute("data-parent-blocked", "true");
  await expect(preview.locator("body")).toHaveAttribute("data-storage-blocked", "true");
  expect(await page.locator("body").getAttribute("data-compromised")).toBeNull();
  expect(requests.filter((path) => path === "/module.wasm").length).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".localhost-preview-overlay")).toBeHidden();
  await expect.poll(() => closes).toEqual(["preview-test"]);
});

test("live single-thread Godot export finishes loading through the bounded resource bridge", async ({
  page,
}) => {
  test.skip(
    !process.env.LAYMUX_PREVIEW_REPRO_URL,
    "Set LAYMUX_PREVIEW_REPRO_URL for the live Godot reproduction.",
  );
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await harness(page, true);
  const preview = page.frameLocator(".localhost-preview-overlay iframe");
  await expect(preview.locator("#canvas")).toBeVisible();
  await expect(preview.locator("#status")).toHaveCount(0, { timeout: 90000 });
  // startGame resolves before the engine's first rendered frame.
  await page
    .frames()
    .find((frame) => frame.url().endsWith("/remote/localhost-preview/"))!
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        ),
    );
  expect(errors).toEqual([]);
  await page.screenshot({ path: "../.screenshots/localhost-preview-godot.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(preview.locator("#canvas")).toBeVisible();
  await page.screenshot({ path: "../.screenshots/localhost-preview-godot-mobile.png" });
});
