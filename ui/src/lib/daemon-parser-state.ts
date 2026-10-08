/** Pinned xterm 6.0.0 state omitted by addon-serialize 0.14.0 (ADR-0302). */
type Charset = Record<string, string> | null;
export interface DaemonParserState {
  version: 1;
  charset: Charset;
  charsets: [Charset, Charset, Charset, Charset];
  glevel: number;
  normal: { tabs: number[]; savedCharset: Charset };
  alternate: { tabs: number[]; savedCharset: Charset };
  mouseEncoding: "DEFAULT" | "SGR" | "SGR_PIXELS";
}

interface BufferState {
  tabs: Record<number, boolean>;
  savedCharset?: Record<string, string>;
}
interface ParserCore {
  _charsetService: {
    charset?: Record<string, string>;
    glevel: number;
    _charsets: Array<Record<string, string> | undefined>;
  };
  _bufferService: { buffers: { normal: BufferState; alt: BufferState } };
  coreMouseService: { activeEncoding: string };
}
const coreOf = (terminal: unknown) => (terminal as { _core: ParserCore })._core;
const charsetCopy = (charset: Record<string, string> | undefined): Charset =>
  charset ? { ...charset } : null;

export function captureDaemonParserState(terminal: unknown): DaemonParserState {
  const core = coreOf(terminal);
  const buffer = (value: BufferState) => ({
    tabs: Object.keys(value.tabs)
      .filter((key) => value.tabs[Number(key)])
      .map(Number),
    savedCharset: charsetCopy(value.savedCharset),
  });
  const state = {
    version: 1,
    charset: charsetCopy(core._charsetService.charset),
    charsets: [0, 1, 2, 3].map((index) => charsetCopy(core._charsetService._charsets[index])),
    glevel: core._charsetService.glevel,
    normal: buffer(core._bufferService.buffers.normal),
    alternate: buffer(core._bufferService.buffers.alt),
    mouseEncoding: core.coreMouseService.activeEncoding,
  };
  return validateDaemonParserState(state);
}

export function validateDaemonParserState(value: unknown): DaemonParserState {
  const fail = (): never => {
    throw new Error("invalid daemon parser supplement");
  };
  const object = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail();
    return item as Record<string, unknown>;
  };
  const charset = (item: unknown): Charset => {
    if (item === null) return null;
    const entries = Object.entries(object(item));
    if (
      entries.length > 128 ||
      entries.some(
        ([key, val]) =>
          key.length !== 1 ||
          key.charCodeAt(0) > 127 ||
          typeof val !== "string" ||
          val.length < 1 ||
          val.length > 4,
      )
    )
      return fail();
    return Object.fromEntries(entries) as Record<string, string>;
  };
  const buffer = (item: unknown) => {
    const row = object(item);
    if (
      !Array.isArray(row.tabs) ||
      row.tabs.length > 4096 ||
      row.tabs.some((tab) => !Number.isSafeInteger(tab) || tab < 0 || tab >= 4096)
    )
      return fail();
    return { tabs: [...row.tabs] as number[], savedCharset: charset(row.savedCharset) };
  };
  const state = object(value);
  if (
    state.version !== 1 ||
    !Number.isInteger(state.glevel) ||
    (state.glevel as number) < 0 ||
    (state.glevel as number) > 3 ||
    !Array.isArray(state.charsets) ||
    state.charsets.length !== 4 ||
    !["DEFAULT", "SGR", "SGR_PIXELS"].includes(state.mouseEncoding as string)
  )
    return fail();
  return {
    version: 1,
    charset: charset(state.charset),
    charsets: state.charsets.map(charset) as DaemonParserState["charsets"],
    glevel: state.glevel as number,
    normal: buffer(state.normal),
    alternate: buffer(state.alternate),
    mouseEncoding: state.mouseEncoding as DaemonParserState["mouseEncoding"],
  };
}

/** Apply only after the snapshot write callback, before pending bytes/live deltas. */
export function applyDaemonParserState(terminal: unknown, value: unknown): void {
  const state = validateDaemonParserState(value);
  const core = coreOf(terminal);
  core._charsetService._charsets = state.charsets.map((charset) => charset ?? undefined);
  core._charsetService.glevel = state.glevel;
  core._charsetService.charset = state.charset ?? undefined;
  for (const [target, source] of [
    [core._bufferService.buffers.normal, state.normal],
    [core._bufferService.buffers.alt, state.alternate],
  ] as const) {
    target.tabs = Object.fromEntries(source.tabs.map((tab) => [tab, true]));
    target.savedCharset = source.savedCharset ?? undefined;
  }
  core.coreMouseService.activeEncoding = state.mouseEncoding;
}
