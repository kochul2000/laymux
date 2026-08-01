/** Byte formatting shared by the file viewer's structured previews. */

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** Human-readable size, e.g. `948 B`, `12.4 KiB`, `1.07 GiB`. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown size";
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  // Bytes are always whole; larger units keep enough precision to distinguish
  // neighbouring files without a wall of digits.
  if (unit === 0) return `${size} B`;
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${UNITS[unit]}`;
}

/** `1 entry` / `12 entries` — pluralisation for the archive and record counts. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}
