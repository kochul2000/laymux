import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  Circle,
  CircleMinus,
  Copy,
  createElement,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  FolderUp,
  Hourglass,
  Keyboard,
  Link,
  LoaderCircle,
  Menu,
  Minus,
  Paperclip,
  Pencil,
  Plug,
  Plus,
  Send,
  Settings,
  Star,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide";

/**
 * Direct Remote icon boundary (ADR-0210).
 *
 * The desktop wrapper in `ui/src/components/ui/icons.tsx` and this vanilla-DOM
 * boundary intentionally share the same defaults. Remote call sites name a
 * Lucide icon instead of owning SVG path data or font glyphs.
 */
const ICONS = Object.freeze({
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  Circle,
  CircleMinus,
  Copy,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  FolderUp,
  Hourglass,
  Keyboard,
  Link,
  LoaderCircle,
  Menu,
  Minus,
  Paperclip,
  Pencil,
  Plug,
  Plus,
  Send,
  Settings,
  Star,
  X,
  ZoomIn,
  ZoomOut,
});

const DEFAULT_SIZE = 14;
const DEFAULT_STROKE_WIDTH = 2;

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function createRemoteIcon(
  name,
  { size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE_WIDTH, className = "", fill } = {},
) {
  const iconNode = ICONS[name];
  if (!iconNode) throw new Error(`Unknown Remote icon: ${name}`);

  const resolvedSize = finitePositive(size, DEFAULT_SIZE);
  const resolvedStrokeWidth = Number.isFinite(Number(strokeWidth))
    ? Number(strokeWidth)
    : DEFAULT_STROKE_WIDTH;
  const classes = ["remote-icon", className].filter(Boolean).join(" ");
  return createElement(iconNode, {
    width: resolvedSize,
    height: resolvedSize,
    "stroke-width": resolvedStrokeWidth,
    "aria-hidden": "true",
    focusable: "false",
    class: classes,
    "data-remote-icon-name": name,
    ...(fill ? { fill } : {}),
  });
}

export function setRemoteIcon(host, name, options) {
  host.replaceChildren(createRemoteIcon(name, options));
}

/** Replace static shell placeholders after the end-of-body bundle executes. */
export function hydrateRemoteIcons(root = globalThis.document) {
  const placeholders = [];
  if (root instanceof globalThis.Element && root.matches("[data-remote-icon]")) {
    placeholders.push(root);
  }
  placeholders.push(...root.querySelectorAll("[data-remote-icon]"));

  for (const placeholder of placeholders) {
    const name = placeholder.dataset.remoteIcon;
    const icon = createRemoteIcon(name, {
      size: finitePositive(placeholder.dataset.iconSize, DEFAULT_SIZE),
      strokeWidth: finitePositive(placeholder.dataset.iconStrokeWidth, DEFAULT_STROKE_WIDTH),
      className: placeholder.className,
      fill: placeholder.dataset.iconFill,
    });
    for (const { name: attributeName, value } of placeholder.attributes) {
      if (
        attributeName === "class" ||
        attributeName === "data-remote-icon" ||
        attributeName === "data-icon-size" ||
        attributeName === "data-icon-stroke-width" ||
        attributeName === "data-icon-fill"
      ) {
        continue;
      }
      icon.setAttribute(attributeName, value);
    }
    placeholder.replaceWith(icon);
  }
}

const COMMAND_STATUS_ICONS = Object.freeze({
  "⏳": "Hourglass",
  "✓": "Check",
  "✗": "X",
  "—": "Minus",
});

export function commandStatusIconName(status) {
  return COMMAND_STATUS_ICONS[status] || null;
}

/** Keep in lockstep with `ui/src/lib/file-kind-icon.ts`. */
export function fileKindIconName(entry, isParent = false) {
  if (isParent) return "FolderUp";
  if (entry && entry.isDirectory) return "Folder";
  if (entry && entry.isSymlink) return "Link";
  return "File";
}
