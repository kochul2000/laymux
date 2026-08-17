/**
 * Rasterises the PWA icons served by the Rust remote server (issue #654).
 *
 * The remote client is served by `axum` with `include_bytes!`, so the icons have
 * to exist as committed files. Generating them from `ui/public/logo.svg` keeps a
 * single source for the brand mark; `src-tauri/src/remote_server/pwa.rs` fails
 * its tests if a committed PNG no longer has the pixel size the manifest
 * advertises.
 *
 * Rendering goes through headless Chromium, not a standalone SVG rasteriser: the
 * mark layers a cyan arrow over a white one with `mix-blend-mode: plus-lighter`,
 * so the arrow body reads white and only its edges fringe. A rasteriser that
 * ignores the blend mode paints the cyan layer opaque and the body comes out
 * cyan — the same trap the app/website icons hit, fixed the same way.
 *
 * Run: cd ui && npm run build:pwa-icons
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const SOURCE_SVG = resolve(scriptDir, "../public/logo.svg");
const OUT_DIR = resolve(scriptDir, "../../src-tauri/src/remote_server/assets/pwa");

/**
 * A maskable icon is cropped by the launcher — Android may cut it down to a
 * circle of 80% of the width. The logo's arrow reaches into the corners, so the
 * maskable variant shrinks the mark onto its own background instead of letting
 * the launcher clip it.
 */
const MASKABLE_SCALE = 0.6;
const MASKABLE_BACKGROUND = "black";

const source = readFileSync(SOURCE_SVG, "utf8");

function sourceViewBox(svg) {
  const match = /viewBox="([\d.\s-]+)"/.exec(svg);
  if (!match) throw new Error(`${SOURCE_SVG} has no viewBox`);
  const [minX, minY, width, height] = match[1].trim().split(/\s+/).map(Number);
  if (![minX, minY, width, height].every(Number.isFinite)) {
    throw new Error(`${SOURCE_SVG} has a viewBox this script cannot read: ${match[1]}`);
  }
  return { minX, minY, width, height };
}

function maskableSvg(svg) {
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (!inner) throw new Error(`${SOURCE_SVG} is not a single <svg> element`);
  const { minX, minY, width, height } = sourceViewBox(svg);
  const inset = (1 - MASKABLE_SCALE) / 2;
  const translateX = minX + width * inset;
  const translateY = minY + height * inset;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}">`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${MASKABLE_BACKGROUND}"/>`,
    `<g transform="translate(${translateX} ${translateY}) scale(${MASKABLE_SCALE})">`,
    inner[1],
    "</g>",
    "</svg>",
  ].join("");
}

/**
 * The SVG is embedded as a data URI inside an `<img>` rather than inlined into
 * the document: an inline `<svg>` would inherit page styles and let the blend
 * mode compose against the page background instead of the mark's own plate.
 */
function iconDocument(svg, size) {
  const encoded = Buffer.from(svg, "utf8").toString("base64");
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<style>",
    "  html, body { margin: 0; padding: 0; background: transparent; }",
    `  img { display: block; width: ${size}px; height: ${size}px; }`,
    "</style>",
    `<img src="data:image/svg+xml;base64,${encoded}" alt="">`,
  ].join("");
}

const targets = [
  { file: "icon-192.png", size: 192, svg: source },
  { file: "icon-512.png", size: 512, svg: source },
  { file: "icon-maskable-512.png", size: 512, svg: maskableSvg(source) },
  // iOS ignores the manifest icons for "Add to Home Screen" and takes this one.
  { file: "apple-touch-icon-180.png", size: 180, svg: source },
];

let browser;
try {
  browser = await chromium.launch();
} catch (cause) {
  throw new Error(
    "Chromium is required to rasterise the icons — run `npx playwright install chromium`.",
    { cause },
  );
}

try {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const { file, size, svg } of targets) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    try {
      await page.setContent(iconDocument(svg, size), { waitUntil: "load" });
      const png = await page.screenshot({
        type: "png",
        // The mark paints its own opaque plate; keeping the page transparent
        // means a rounded corner stays transparent instead of picking up white.
        omitBackground: true,
        clip: { x: 0, y: 0, width: size, height: size },
      });
      const out = resolve(OUT_DIR, file);
      writeFileSync(out, png);
      console.log(`wrote ${out} (${size}x${size})`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
