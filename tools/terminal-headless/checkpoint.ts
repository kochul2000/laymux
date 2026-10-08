/** Pinned xterm 6.0.0 adapter: the public buffer API omits margins/save state.
 * It only reads parser state and emits VT; clients need no private xterm API.
 */
import type { Terminal, IBuffer, IBufferCell } from "@xterm/headless";

interface Attributes {
  extended?: { urlId: number };
  hasExtendedAttrs?(): number;
  isInverse(): number; isBold(): number; isUnderline(): number;
  isBlink(): number; isInvisible(): number; isItalic(): number;
  isDim(): number; isStrikethrough(): number; isOverline(): number;
  isFgRGB(): boolean; isBgRGB(): boolean; isFgPalette(): boolean; isBgPalette(): boolean;
  getFgColor(): number; getBgColor(): number;
}
interface BufferState {
  scrollTop: number; scrollBottom: number; savedX: number; savedY: number;
  ybase: number; savedCurAttrData: Attributes;
}
interface PinnedCore {
  _bufferService: { buffers: { normal: BufferState; alt: BufferState } };
  _inputHandler: { _curAttrData: Attributes };
  coreService: { isCursorHidden: boolean };
  _oscLinkService: { getLinkData(id: number): { id?: string; uri: string } | undefined };
}

function link(terminal: Terminal, attributes: Attributes): string {
  const core = (terminal as unknown as { _core: PinnedCore })._core;
  const data = attributes.hasExtendedAttrs?.() && attributes.extended?.urlId ? core._oscLinkService.getLinkData(attributes.extended.urlId) : undefined;
  return `\x1b]8;${data?.id ? `id=${data.id}` : ""};${data?.uri ?? ""}\x1b\\`;
}

function rendition(attributes: Attributes): string {
  const values = [0];
  for (const [enabled, code] of [
    [attributes.isBold(), 1], [attributes.isDim(), 2], [attributes.isItalic(), 3],
    [attributes.isUnderline(), 4], [attributes.isBlink(), 5], [attributes.isInverse(), 7],
    [attributes.isInvisible(), 8], [attributes.isStrikethrough(), 9], [attributes.isOverline(), 53],
  ]) if (enabled) values.push(code);
  for (const foreground of [true, false]) {
    const color = foreground ? attributes.getFgColor() : attributes.getBgColor();
    if (foreground ? attributes.isFgRGB() : attributes.isBgRGB()) {
      values.push(foreground ? 38 : 48, 2, color >>> 16 & 255, color >>> 8 & 255, color & 255);
    } else if (foreground ? attributes.isFgPalette() : attributes.isBgPalette()) {
      values.push(foreground ? 38 : 48, 5, color);
    }
  }
  return `\x1b[${values.join(";")}m`;
}

function bufferFooter(terminal: Terminal, buffer: IBuffer, state: BufferState, current: Attributes): string {
  if (!Number.isInteger(state.scrollTop) || !Number.isInteger(state.scrollBottom) ||
      state.scrollTop < 0 || state.scrollBottom >= terminal.rows || state.scrollTop > state.scrollBottom ||
      !Number.isInteger(state.savedX) || !Number.isInteger(state.savedY)) {
    throw new Error("incompatible headless xterm buffer state");
  }
  // Restore DECSC before margins/origin, in absolute viewport coordinates.
  const savedRow = Math.max(0, Math.min(terminal.rows - 1, state.savedY - state.ybase));
  let result = `\x1b[?6l\x1b[${savedRow + 1};${state.savedX + 1}H${rendition(state.savedCurAttrData)}${link(terminal, state.savedCurAttrData)}\x1b7`;
  result += `\x1b[${state.scrollTop + 1};${state.scrollBottom + 1}r`;
  if (terminal.modes.originMode) result += "\x1b[?6h";
  const row = buffer.cursorY - (terminal.modes.originMode ? state.scrollTop : 0) + 1;
  const pendingWrap = buffer.cursorX === terminal.cols;
  let col = Math.min(buffer.cursorX, terminal.cols - 1);
  let last: IBufferCell | undefined;
  if (pendingWrap) {
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    last = line?.getCell(col);
    if (last?.getWidth() === 0) last = line?.getCell(--col);
    if (!last || !last.getChars()) throw new Error("invalid headless pending wrap cell");
  }
  result += `\x1b[${row};${col + 1}H`;
  // A CUP cannot produce pending wrap. Reprint the existing last glyph with its
  // attributes, then restore the active rendition without a cursor movement.
  if (last) result += rendition(last) + link(terminal, last) + last.getChars();
  return result + rendition(current) + link(terminal, current);
}

export function completeCheckpoint(terminal: Terminal, serialized: string): string {
  const core = (terminal as unknown as { _core: PinnedCore })._core;
  if (!core?._bufferService?.buffers || !core._inputHandler?._curAttrData || !core.coreService) {
    throw new Error("incompatible headless xterm 6.0.0 runtime");
  }
  if (terminal.buffer.active.type === "alternate") {
    const marker = "\x1b[?1049h\x1b[H";
    const position = serialized.indexOf(marker);
    if (position < 0) throw new Error("headless alternate checkpoint boundary missing");
    const normal = bufferFooter(terminal, terminal.buffer.normal, core._bufferService.buffers.normal, core._bufferService.buffers.normal.savedCurAttrData);
    serialized = serialized.slice(0, position) + normal + serialized.slice(position);
  }
  const active = terminal.buffer.active.type === "alternate" ? core._bufferService.buffers.alt : core._bufferService.buffers.normal;
  return serialized + bufferFooter(terminal, terminal.buffer.active, active, core._inputHandler._curAttrData) +
    (core.coreService.isCursorHidden ? "\x1b[?25l" : "\x1b[?25h");
}
