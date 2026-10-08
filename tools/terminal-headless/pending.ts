/** Preserve the unfinished VT/UTF-8 prefix at an attach boundary. Completed
 * queries and OSC actions are never replayed. Adapter is pinned to xterm 6.0.0.
 */
import type { Terminal } from "@xterm/headless";

interface PayloadHandler { _data?: string }
interface Parser {
  currentState: number;
  _collect: number;
  _params: { toArray(): Array<number | number[]> };
  _oscParser: { _id: number; _state: number; _active: PayloadHandler[] };
  _dcsParser: { _ident: number; _active: PayloadHandler[] };
}
const unpack = (value: number) => {
  let result = "";
  for (; value; value >>>= 8) result = String.fromCharCode(value & 255) + result;
  return result;
};
const payload = (handlers: PayloadHandler[]) => handlers.find((handler) => typeof handler._data === "string")?._data ?? "";

export function pendingBytes(terminal: Terminal): number[] {
  const handler = (terminal as unknown as { _core: { _inputHandler: { _parser: Parser; _utf8Decoder: { interim: Uint8Array } } } })._core._inputHandler;
  const parser = handler._parser;
  const parameters = parser._params.toArray().map((value) => Array.isArray(value) ? value.join(":") : value).join(";");
  const collected = unpack(parser._collect);
  const header = (introducer: string, collect = collected) => {
    const prefix = [...collect].filter((char) => char >= "<" && char <= "?").join("");
    const intermediates = [...collect].filter((char) => char >= " " && char <= "/").join("");
    return introducer + prefix + parameters + intermediates;
  };
  let pending = "";
  switch (parser.currentState) {
    case 0: break;
    case 1: case 2: pending = "\x1b" + collected; break;
    case 3: case 4: case 5: pending = header("\x1b["); break;
    case 6: pending = "\x1b[0:0?"; break; // enter CSI ignore
    case 7: pending = "\x1b_"; break;
    case 8:
      if (parser._oscParser._state === 3) pending = "\x1b]x"; // aborted OSC remains ignored
      else pending = "\x1b]" + (parser._oscParser._id >= 0 ? parser._oscParser._id : "") +
        (parser._oscParser._state === 2 ? ";" + payload(parser._oscParser._active) : "");
      break;
    case 9: case 10: case 12: pending = header("\x1bP"); break;
    case 11: pending = "\x1bP0:0?"; break;
    case 13: {
      const identifier = unpack(parser._dcsParser._ident);
      pending = header("\x1bP", identifier.slice(0, -1)) + identifier.slice(-1) + payload(parser._dcsParser._active);
      break;
    }
    default: throw new Error("incompatible headless xterm parser state");
  }
  const bytes = [...new TextEncoder().encode(pending)];
  for (const byte of handler._utf8Decoder.interim) {
    if (!byte) break;
    bytes.push(byte);
  }
  if (bytes.length > 1024 * 1024) throw new Error("headless pending VT prefix exceeds attach budget");
  return bytes;
}
