import type { SVGProps } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  BrushCleaning,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  CopyPlus,
  Download,
  Ellipsis,
  EllipsisVertical,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileSearch,
  Folder,
  FolderOpen,
  FolderUp,
  GitBranch,
  GripVertical,
  Image,
  Hourglass,
  Keyboard,
  Link,
  List,
  ListFilter,
  Maximize2,
  Minus,
  Minimize2,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Pencil,
  Pin,
  Plus,
  RadioTower,
  RefreshCw,
  Rows2,
  Settings,
  Slash,
  Square,
  TriangleAlert,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

/**
 * Application icon boundary (ADR-0205).
 *
 * Components import icons from here instead of binding themselves to Lucide.
 * This keeps compact sizing, stroke weight and decorative accessibility
 * defaults identical on every desktop surface.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  size?: number;
  strokeWidth?: number;
  "data-status-icon"?: string;
}

function renderIcon(Glyph: LucideIcon, { size = 14, strokeWidth = 2, style, ...props }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden="true"
      focusable="false"
      {...props}
      style={{ flex: "0 0 auto", ...style }}
    />
  );
}

export function ArrowDownIcon(props: IconProps) {
  return renderIcon(ArrowDown, props);
}

export function ArrowLeftIcon(props: IconProps) {
  return renderIcon(ArrowLeft, props);
}

export function ArrowRightIcon(props: IconProps) {
  return renderIcon(ArrowRight, props);
}

export function ArrowUpIcon(props: IconProps) {
  return renderIcon(ArrowUp, props);
}

export function BellIcon(props: IconProps) {
  return renderIcon(Bell, props);
}

export function BroomIcon(props: IconProps) {
  return renderIcon(BrushCleaning, props);
}

export function CameraIcon(props: IconProps) {
  return renderIcon(Camera, props);
}

export function CheckIcon(props: IconProps) {
  return renderIcon(Check, props);
}

export function ChevronDownIcon(props: IconProps) {
  return renderIcon(ChevronDown, props);
}

export function ChevronRightIcon(props: IconProps) {
  return renderIcon(ChevronRight, props);
}

export function ColumnsIcon(props: IconProps) {
  return renderIcon(Columns2, props);
}

export function CopyIcon(props: IconProps) {
  return renderIcon(Copy, props);
}

export function CopyPlusIcon(props: IconProps) {
  return renderIcon(CopyPlus, props);
}

export function DownloadIcon(props: IconProps) {
  return renderIcon(Download, props);
}

export function EllipsisIcon(props: IconProps) {
  return renderIcon(Ellipsis, props);
}

export function EllipsisVerticalIcon(props: IconProps) {
  return renderIcon(EllipsisVertical, props);
}

export function EraserIcon(props: IconProps) {
  return renderIcon(Eraser, props);
}

export function ExternalLinkIcon({ size = 12, ...props }: IconProps) {
  return renderIcon(ExternalLink, { size, ...props });
}

export function EyeIcon(props: IconProps) {
  return renderIcon(Eye, props);
}

export function EyeOffIcon(props: IconProps) {
  return renderIcon(EyeOff, props);
}

export function FileIcon(props: IconProps) {
  return renderIcon(File, props);
}

export function FileSearchIcon(props: IconProps) {
  return renderIcon(FileSearch, props);
}

export function FolderIcon(props: IconProps) {
  return renderIcon(Folder, props);
}

export function FolderOpenIcon(props: IconProps) {
  return renderIcon(FolderOpen, props);
}

export function FolderUpIcon(props: IconProps) {
  return renderIcon(FolderUp, props);
}

export function GitBranchIcon(props: IconProps) {
  return renderIcon(GitBranch, props);
}

export function GripVerticalIcon(props: IconProps) {
  return renderIcon(GripVertical, props);
}

export function ImageIcon(props: IconProps) {
  return renderIcon(Image, props);
}

export function HourglassIcon(props: IconProps) {
  return renderIcon(Hourglass, props);
}

export function KeyboardIcon(props: IconProps) {
  return renderIcon(Keyboard, props);
}

export function LinkIcon(props: IconProps) {
  return renderIcon(Link, props);
}

export function ListIcon(props: IconProps) {
  return renderIcon(List, props);
}

export function ListFilterIcon(props: IconProps) {
  return renderIcon(ListFilter, props);
}

export function MaximizeIcon(props: IconProps) {
  return renderIcon(Maximize2, props);
}

export function MinusIcon(props: IconProps) {
  return renderIcon(Minus, props);
}

export function RestoreIcon(props: IconProps) {
  return renderIcon(Minimize2, props);
}

export function MoonIcon(props: IconProps) {
  return renderIcon(Moon, props);
}

export function PanelBottomIcon(props: IconProps) {
  return renderIcon(PanelBottom, props);
}

export function PanelLeftIcon(props: IconProps) {
  return renderIcon(PanelLeft, props);
}

export function PanelRightIcon(props: IconProps) {
  return renderIcon(PanelRight, props);
}

export function PanelTopIcon(props: IconProps) {
  return renderIcon(PanelTop, props);
}

export function PencilIcon(props: IconProps) {
  return renderIcon(Pencil, props);
}

export function PinIcon(props: IconProps) {
  return renderIcon(Pin, props);
}

export function PlusIcon(props: IconProps) {
  return renderIcon(Plus, props);
}

export function RadioTowerIcon(props: IconProps) {
  return renderIcon(RadioTower, props);
}

export function RefreshIcon(props: IconProps) {
  return renderIcon(RefreshCw, props);
}

export function RowsIcon(props: IconProps) {
  return renderIcon(Rows2, props);
}

export function SettingsIcon(props: IconProps) {
  return renderIcon(Settings, props);
}

export function SlashIcon(props: IconProps) {
  return renderIcon(Slash, props);
}

export function SquareIcon(props: IconProps) {
  return renderIcon(Square, props);
}

export function WarningIcon(props: IconProps) {
  return renderIcon(TriangleAlert, props);
}

export function UploadIcon(props: IconProps) {
  return renderIcon(Upload, props);
}

export function XIcon(props: IconProps) {
  return renderIcon(X, props);
}

export function ZoomInIcon(props: IconProps) {
  return renderIcon(ZoomIn, props);
}

export function ZoomOutIcon(props: IconProps) {
  return renderIcon(ZoomOut, props);
}
