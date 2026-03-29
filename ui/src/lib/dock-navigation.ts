import type { Direction } from "./pane-navigation";
import type { DockPosition } from "@/stores/types";

/**
 * Maps a navigation direction to the dock position it leads to.
 * E.g., pressing "left" at the left edge → LeftDock.
 */
const DIRECTION_TO_DOCK: Record<Direction, DockPosition> = {
  left: "left",
  right: "right",
  up: "top",
  down: "bottom",
};

/**
 * Maps a dock position to the direction that would exit the dock
 * back into the workspace area. E.g., LeftDock → "right".
 */
const DOCK_EXIT_DIRECTION: Record<DockPosition, Direction> = {
  left: "right",
  right: "left",
  top: "down",
  bottom: "up",
};

/**
 * Given a direction, return the dock position that would be reached
 * if navigating from the workspace edge.
 */
export function getDockForDirection(direction: Direction): DockPosition {
  return DIRECTION_TO_DOCK[direction];
}

/**
 * Given a dock position, return the direction that exits the dock
 * back into the workspace area.
 */
export function getDockExitDirection(dock: DockPosition): Direction {
  return DOCK_EXIT_DIRECTION[dock];
}
