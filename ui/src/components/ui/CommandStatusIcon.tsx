import type { StatusIconGlyph } from "@/lib/activity-markers";
import { getCommandStatusIconKind } from "@/lib/command-status-icon";
import { CheckIcon, HourglassIcon, MinusIcon, XIcon, type IconProps } from "./icons";

interface CommandStatusIconProps extends Omit<IconProps, "aria-label"> {
  status: StatusIconGlyph;
  label: string;
}

/** Render the stable status contract as a Lucide glyph on desktop React surfaces. */
export function CommandStatusIcon({
  status,
  label,
  size = 10,
  strokeWidth = 2.25,
  ...props
}: CommandStatusIconProps) {
  const kind = getCommandStatusIconKind(status);
  const sharedProps: IconProps = {
    size,
    strokeWidth,
    role: "img",
    "aria-hidden": false,
    "aria-label": label,
    "data-status-icon": kind,
    ...props,
  };

  switch (kind) {
    case "working":
      return <HourglassIcon {...sharedProps} />;
    case "success":
      return <CheckIcon {...sharedProps} />;
    case "failure":
      return <XIcon {...sharedProps} />;
    case "idle":
      return <MinusIcon {...sharedProps} />;
  }
}
