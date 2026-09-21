import { FILE_KIND_ICON_SIZE, fileKindIconName } from "@/lib/file-kind-icon";
import { FileIcon, FolderIcon, FolderUpIcon, LinkIcon } from "./icons";

const icons = { File: FileIcon, Folder: FolderIcon, FolderUp: FolderUpIcon, Link: LinkIcon };

/** 행의 종류/선택 색상을 상속해 이름과 같은 색상으로 표시한다. */
export function FileKindIcon({
  entry,
  isParent = false,
}: {
  entry: { isDirectory: boolean; isSymlink?: boolean };
  isParent?: boolean;
}) {
  const Icon = icons[fileKindIconName(entry, isParent)];
  return <Icon size={FILE_KIND_ICON_SIZE} />;
}
