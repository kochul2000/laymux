import { validateDaemonParserState, type DaemonParserState } from "./daemon-parser-state";
export interface DaemonSurfaceCheckpoint {
  version: 1;
  incarnation: string;
  nativeGeneration: number;
  sourceSeq: number;
  pendingBytes: number[];
  parserState: DaemonParserState;
}
export function validateDaemonSurfaceCheckpoint(value: unknown): DaemonSurfaceCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid daemon surface checkpoint");
  const data = value as Record<string, unknown>;
  if (
    data.version !== 1 ||
    typeof data.incarnation !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(data.incarnation) ||
    !Number.isSafeInteger(data.nativeGeneration) ||
    (data.nativeGeneration as number) < 1 ||
    !Number.isSafeInteger(data.sourceSeq) ||
    (data.sourceSeq as number) < 0 ||
    !Array.isArray(data.pendingBytes) ||
    data.pendingBytes.length > 1024 * 1024 ||
    data.pendingBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  )
    throw new Error("invalid daemon surface checkpoint");
  return {
    version: 1,
    incarnation: data.incarnation,
    nativeGeneration: data.nativeGeneration as number,
    sourceSeq: data.sourceSeq as number,
    pendingBytes: [...data.pendingBytes] as number[],
    parserState: validateDaemonParserState(data.parserState),
  };
}
