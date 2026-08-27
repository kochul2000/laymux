# Remote Browser Assets

These files are committed copies of the browser builds used by the Direct Remote
Mode entry served from `/remote/`.

- `xterm.js`, `xterm.css`: copied from `ui/node_modules/@xterm/xterm`
- `addon-fit.js`: copied from `ui/node_modules/@xterm/addon-fit`
- `addon-web-links.js`: copied from `ui/node_modules/@xterm/addon-web-links`

`pwa/*.png` are the home-screen launcher icons the web app manifest advertises
(ADR-0091). They are **generated**, not hand-edited: rasterised from
`ui/public/logo.svg` by `cd ui && npm run build:pwa-icons`. Refresh them in the
same change as the logo; `pwa.rs` fails its tests if a file no longer has the
pixel size the manifest declares.

The remaining files are intentionally served by the Rust remote server instead of a CDN so the
Tailscale/browser entry works offline and does not depend on the Vite dev server.
When updating the npm package versions, refresh these files and the paired
license files in the same change.

`remote-app.min.{js,css}` also include the tree-shaken Lucide DOM icons from
`ui/src/remote/remote-icons.js`. The generated banner hashes that source and
the lockfile identity of the `lucide` package along with `remote-app.{js,css}`
so an icon-only edit or dependency upgrade cannot leave the committed Remote
bundle stale (ADR-0210).
