import type { Direction } from "./pane-navigation";
import type { DockPosition } from "@/stores/types";

const DIRECTION_TO_DOCK: Record<Direction, DockPosition> = {
  left: "left",
  right: "right",
  up: "top",
  down: "bottom",
};

const DOCK_EXIT_DIRECTION: Record<DockPosition, Direction> = {
  left: "right",
  right: "left",
  top: "down",
  bottom: "up",
};

export function getDockForDirection(direction: Direction): DockPosition {
  return DIRECTION_TO_DOCK[direction];
}

export function getDockExitDirection(dock: DockPosition): Direction {
  return DOCK_EXIT_DIRECTION[dock];
}
