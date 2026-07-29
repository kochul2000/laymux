/**
 * Rasterises the PWA icons served by the Rust remote server (issue #654).
 *
 * The remote client is served by `axum` with `include_bytes!`, so the icons have
 * to exist as committed files. Generating them from `ui/public/logo.svg` keeps a
 * single source for the brand mark; `src-tauri/src/remote_server/pwa.rs` fails
 * its tests if a committed PNG no longer has the pixel size the manifest
 * advertises.
 *
 * Run: cd ui && npm run build:pwa-icons
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

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

function renderPng(svg, size) {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    // The mark is drawn on its own opaque plate, so this only covers rounding
    // seams at the edges.
    background: MASKABLE_BACKGROUND,
  })
    .render()
    .asPng();
  return png;
}

const targets = [
  { file: "icon-192.png", size: 192, svg: source },
  { file: "icon-512.png", size: 512, svg: source },
  { file: "icon-maskable-512.png", size: 512, svg: maskableSvg(source) },
  // iOS ignores the manifest icons for "Add to Home Screen" and takes this one.
  { file: "apple-touch-icon-180.png", size: 180, svg: source },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, svg } of targets) {
  const out = resolve(OUT_DIR, file);
  writeFileSync(out, renderPng(svg, size));
  console.log(`wrote ${out} (${size}x${size})`);
}
