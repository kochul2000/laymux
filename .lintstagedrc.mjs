import path from "path";

/** Convert Windows backslashes to forward slashes for bash compatibility. */
function toPosix(p) {
  return p.replace(/\\/g, "/");
}

export default {
  "ui/**/*.{ts,tsx}": (files) => {
    const relFiles = files.map((f) => toPosix(path.relative("ui", f))).join(" ");
    return [
      `bash -c 'cd ui && npx prettier --write ${relFiles}'`,
      `bash -c 'cd ui && npx eslint --fix ${relFiles}'`,
    ];
  },
  "ui/**/*.{json,css,md}": (files) => {
    const relFiles = files.map((f) => toPosix(path.relative("ui", f))).join(" ");
    return [`bash -c 'cd ui && npx prettier --write ${relFiles}'`];
  },
  "**/*.rs": ["rustfmt"],
};
