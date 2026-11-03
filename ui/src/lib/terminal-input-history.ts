import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { normalizeSubmittedInput } from "./terminal-last-input";

export type InputHistoryScope = Pick<
  TerminalInstance,
  "generation" | "lastInputClearedAt" | "lastCommandAt" | "lastUserInputAt" | "lastUserInput"
> & { startedAt: number };

export function captureInputHistoryScope(id: string): InputHistoryScope | undefined {
  const instance = useTerminalStore.getState().instances.find((instance) => instance.id === id);
  return instance ? { ...instance, startedAt: Date.now() } : undefined;
}

function currentScope(id: string, expected?: InputHistoryScope) {
  const current = captureInputHistoryScope(id);
  return current &&
    (!expected ||
      (current.generation === expected.generation &&
        current.lastInputClearedAt === expected.lastInputClearedAt))
    ? current
    : undefined;
}

export function isInputHistoryClear(text: string): boolean {
  return /^(?:clear|cls|clear-host|\/clear)$/iu.test(normalizeSubmittedInput(text));
}

/** Clear display history only; activity, task authority and command results are independent. */
export function clearTerminalInputHistory(id: string, expected?: InputHistoryScope): void {
  const current = currentScope(id, expected);
  if (!current || (expected && current.lastUserInputAt !== expected.lastUserInputAt)) return;
  useTerminalStore.getState().updateInstanceInfo(id, {
    lastUserInput: undefined,
    lastUserInputAt: undefined,
    lastCommand: undefined,
    lastCommandAt: undefined,
    lastInputClearedAt: Math.max(
      Date.now(),
      (current.lastInputClearedAt ?? 0) + 1,
      (current.lastUserInputAt ?? 0) + 1,
      (current.lastCommandAt ?? 0) + 1,
    ),
  });
}

/** Call after a successful submission. Shell OSC command bodies supersede key reconstruction. */
export function recordTerminalInput(id: string, text: string, expected?: InputHistoryScope): void {
  const current = currentScope(id, expected);
  if (!current || (expected && current.lastCommandAt !== expected.lastCommandAt)) return;
  const input = normalizeSubmittedInput(text);
  if (!input) return;
  if (isInputHistoryClear(input)) {
    clearTerminalInputHistory(id);
    return;
  }
  useTerminalStore.getState().updateInstanceInfo(id, {
    lastUserInput: input,
    lastUserInputAt: Math.max(
      expected?.startedAt ?? Date.now(),
      (current.lastInputClearedAt ?? 0) + 1,
    ),
  });
}

export interface SubmittedAgentInput {
  text: string;
  timestamp: string;
}

/** Correct a known submission only. Transcript text never starts a task or restores cleared input. */
export function correctTerminalInputFromAgent(id: string, input: SubmittedAgentInput): void {
  const current = captureInputHistoryScope(id);
  if (!current?.lastUserInput || current.lastUserInputAt === undefined) return;
  const timestamp = /^\d+$/u.test(input.timestamp)
    ? Number(input.timestamp)
    : Date.parse(input.timestamp);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < current.lastUserInputAt ||
    timestamp > Date.now() + 5000 ||
    timestamp <= (current.lastInputClearedAt ?? 0)
  )
    return;
  const text = normalizeSubmittedInput(input.text);
  if (!text || text === current.lastUserInput || isInputHistoryClear(text)) return;
  useTerminalStore.getState().updateInstanceInfo(id, { lastUserInput: text });
}
