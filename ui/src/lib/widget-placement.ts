/**
 * Widget placement state and the pure transforms over it (ADR-0105).
 *
 * Placement is nothing but the order of four arrays, so every operation here is
 * an array transform. Keeping them out of the store means slot moves, id
 * uniqueness and overflow collapsing are unit-testable without React.
 */

/** Registry name of a widget. Unknown values survive here and are skipped at render. */
export type WidgetType = string;

export interface WidgetInstance {
  /** Unique across all four slots; survives a move between them. */
  id: string;
  type: WidgetType;
  options: Record<string, unknown>;
}

export interface WidgetSlots {
  left: WidgetInstance[];
  right: WidgetInstance[];
}

export interface StatusLineWidgets extends WidgetSlots {
  enabled: boolean;
}

export interface WidgetsSettings {
  topBar: WidgetSlots;
  statusLine: StatusLineWidgets;
  overflow: "collapse";
}

export type WidgetSurface = "topBar" | "statusLine";
export type WidgetSide = "left" | "right";

/** Address of one slot. The four values are the whole placement vocabulary. */
export interface WidgetSlotId {
  surface: WidgetSurface;
  side: WidgetSide;
}

export const WIDGET_SLOT_IDS: readonly WidgetSlotId[] = [
  { surface: "topBar", side: "left" },
  { surface: "topBar", side: "right" },
  { surface: "statusLine", side: "left" },
  { surface: "statusLine", side: "right" },
];

export function slotKey(slot: WidgetSlotId): string {
  return `${slot.surface}.${slot.side}`;
}

export function defaultWidgets(): WidgetsSettings {
  return {
    topBar: { left: [], right: [] },
    statusLine: { enabled: false, left: [], right: [] },
    overflow: "collapse",
  };
}

export function readSlot(widgets: WidgetsSettings, slot: WidgetSlotId): WidgetInstance[] {
  return widgets[slot.surface][slot.side];
}

function writeSlot(
  widgets: WidgetsSettings,
  slot: WidgetSlotId,
  instances: WidgetInstance[],
): WidgetsSettings {
  return {
    ...widgets,
    [slot.surface]: { ...widgets[slot.surface], [slot.side]: instances },
  };
}

/**
 * Coerce anything that came off disk into a usable placement.
 *
 * **No placement is ever dropped.** The store is what the next save writes back,
 * so discarding an entry here would delete the user's widget from settings.json
 * the next time anything else is saved. An unknown `type` is kept and skipped at
 * render; a missing or duplicated `id` is repaired with a deterministic one
 * rather than removed, because the id is bookkeeping and the placement is not
 * (ADR-0105). Only an entry with no `type` at all carries no placement and is
 * therefore not a widget.
 */
export function normalizeWidgets(raw: unknown): WidgetsSettings {
  const source = (raw ?? {}) as Partial<WidgetsSettings>;
  const seen = new Set<string>();

  const slot = (value: unknown, key: string): WidgetInstance[] => {
    if (!Array.isArray(value)) return [];
    const instances: WidgetInstance[] = [];
    value.forEach((entry, index) => {
      const instance = normalizeInstance(entry);
      if (!instance) return;
      // Identity must be unambiguous for moves and option edits, so a clashing
      // id is rewritten — the widget itself stays where the user put it.
      instances.push(
        seen.has(instance.id) || instance.id.length === 0
          ? { ...instance, id: fallbackId(key, index, seen) }
          : instance,
      );
      seen.add(instances[instances.length - 1].id);
    });
    return instances;
  };

  return {
    topBar: {
      left: slot(source.topBar?.left, "topBar.left"),
      right: slot(source.topBar?.right, "topBar.right"),
    },
    statusLine: {
      enabled: source.statusLine?.enabled === true,
      left: slot(source.statusLine?.left, "statusLine.left"),
      right: slot(source.statusLine?.right, "statusLine.right"),
    },
    overflow: "collapse",
  };
}

/** Position-derived id, so the same file always normalizes the same way. */
function fallbackId(slotKeyName: string, index: number, seen: Set<string>): string {
  const base = `w-${slotKeyName.replace(".", "-")}-${index}`;
  let candidate = base;
  let suffix = 1;
  while (seen.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function normalizeInstance(entry: unknown): WidgetInstance | null {
  if (entry === null || typeof entry !== "object") return null;
  const candidate = entry as Partial<WidgetInstance>;
  if (typeof candidate.type !== "string" || candidate.type.length === 0) return null;
  const options =
    candidate.options !== null && typeof candidate.options === "object"
      ? { ...(candidate.options as Record<string, unknown>) }
      : {};
  return {
    id: typeof candidate.id === "string" ? candidate.id : "",
    type: candidate.type,
    options,
  };
}

/** Every placed instance, paired with the slot it sits in. */
export function allPlacements(
  widgets: WidgetsSettings,
): { slot: WidgetSlotId; instance: WidgetInstance; index: number }[] {
  return WIDGET_SLOT_IDS.flatMap((slot) =>
    readSlot(widgets, slot).map((instance, index) => ({ slot, instance, index })),
  );
}

/** Append a new instance to a slot. `id` must already be unique. */
export function addWidget(
  widgets: WidgetsSettings,
  slot: WidgetSlotId,
  instance: WidgetInstance,
): WidgetsSettings {
  return writeSlot(widgets, slot, [...readSlot(widgets, slot), instance]);
}

export function removeWidget(widgets: WidgetsSettings, id: string): WidgetsSettings {
  return WIDGET_SLOT_IDS.reduce(
    (next, slot) =>
      writeSlot(
        next,
        slot,
        readSlot(next, slot).filter((instance) => instance.id !== id),
      ),
    widgets,
  );
}

export function updateWidgetOptions(
  widgets: WidgetsSettings,
  id: string,
  options: Record<string, unknown>,
): WidgetsSettings {
  return WIDGET_SLOT_IDS.reduce(
    (next, slot) =>
      writeSlot(
        next,
        slot,
        readSlot(next, slot).map((instance) =>
          instance.id === id
            ? { ...instance, options: { ...instance.options, ...options } }
            : instance,
        ),
      ),
    widgets,
  );
}

/**
 * Move an instance to `targetIndex` of `targetSlot`.
 *
 * The index is interpreted against the slot *after* removal, which is what makes
 * a within-slot reorder land where the user dropped it.
 */
export function moveWidget(
  widgets: WidgetsSettings,
  id: string,
  targetSlot: WidgetSlotId,
  targetIndex: number,
): WidgetsSettings {
  const found = allPlacements(widgets).find((placement) => placement.instance.id === id);
  if (!found) return widgets;

  const removed = removeWidget(widgets, id);
  const target = readSlot(removed, targetSlot);
  const index = Math.max(0, Math.min(targetIndex, target.length));
  return writeSlot(removed, targetSlot, [
    ...target.slice(0, index),
    found.instance,
    ...target.slice(index),
  ]);
}

/** Move an instance one step within its own slot. Returns unchanged at the ends. */
export function nudgeWidget(widgets: WidgetsSettings, id: string, delta: -1 | 1): WidgetsSettings {
  const found = allPlacements(widgets).find((placement) => placement.instance.id === id);
  if (!found) return widgets;
  const next = found.index + delta;
  if (next < 0 || next >= readSlot(widgets, found.slot).length) return widgets;
  return moveWidget(widgets, id, found.slot, next);
}

export interface FitCandidate {
  id: string;
  minWidth: number;
}

export interface FitResult {
  visible: string[];
  collapsed: string[];
}

/**
 * Decide which widgets a slot can afford to draw.
 *
 * The order of `candidates` is the user's order, and it is the *only* thing that
 * decides what survives: a slot sheds from the end farthest from the window edge
 * — the tail for a left slot, the head for a right slot. The app owns no
 * priority of its own (ADR-0105).
 *
 * `available` is the width the slot actually got, which already reflects the top
 * bar's reserved drag region: whatever the drag region keeps is never offered
 * here, so the drag minimum outranks widget display without a second rule.
 */
export function fitWidgets(
  candidates: readonly FitCandidate[],
  available: number,
  side: WidgetSide,
  overflowIndicatorWidth: number,
): FitResult {
  const keepOrder = side === "left" ? [...candidates] : [...candidates].reverse();

  let used = 0;
  const kept: string[] = [];
  for (const candidate of keepOrder) {
    const isLast = kept.length === keepOrder.length - 1;
    // Room for the indicator is only required while something is still dropped;
    // the final widget may use the space the indicator would have taken.
    const reserve = isLast ? 0 : overflowIndicatorWidth;
    if (used + candidate.minWidth + reserve > available) break;
    used += candidate.minWidth;
    kept.push(candidate.id);
  }

  const keptSet = new Set(kept);
  return {
    visible: candidates.filter((candidate) => keptSet.has(candidate.id)).map((c) => c.id),
    collapsed: candidates.filter((candidate) => !keptSet.has(candidate.id)).map((c) => c.id),
  };
}
