# Remote Browser Assets

These files are committed copies of the browser builds used by the Direct Remote
Mode entry served from `/remote/`.

- `xterm.js`, `xterm.css`: copied from `ui/node_modules/@xterm/xterm`
- `addon-fit.js`: copied from `ui/node_modules/@xterm/addon-fit`
- `addon-web-links.js`: copied from `ui/node_modules/@xterm/addon-web-links`

They are intentionally served by the Rust remote server instead of a CDN so the
Tailscale/browser entry works offline and does not depend on the Vite dev server.
When updating the npm package versions, refresh these files and the paired
license files in the same change.
