import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { normalizeSubmittedInput } from "./terminal-last-input";

export type InputHistoryScope = Pick<
  TerminalInstance,
  | "generation"
  | "lastInputClearedAt"
  | "lastCommandAt"
  | "lastUserInputAt"
  | "lastUserInput"
  | "lastInputSubmissionAt"
  | "lastCommand"
  | "inputDraftResetRevision"
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
export function clearTerminalInputHistory(
  id: string,
  expected?: InputHistoryScope,
  options: { discardDraft?: boolean; submittedCommand?: string } = {},
): void {
  const current = currentScope(id, expected);
  if (
    !current ||
    (expected &&
      (current.lastUserInputAt !== expected.lastUserInputAt ||
        current.lastInputSubmissionAt !== expected.lastInputSubmissionAt ||
        (current.lastCommandAt !== expected.lastCommandAt &&
          (options.submittedCommand === undefined ||
            normalizeSubmittedInput(current.lastCommand ?? "") !==
              normalizeSubmittedInput(options.submittedCommand)))))
  )
    return;
  useTerminalStore.getState().updateInstanceInfo(id, {
    lastUserInput: undefined,
    lastUserInputAt: undefined,
    lastCommand: undefined,
    lastCommandAt: undefined,
    lastInputSubmissionAt: undefined,
    ...(options.discardDraft
      ? { inputDraftResetRevision: (current.inputDraftResetRevision ?? 0) + 1 }
      : {}),
    lastInputClearedAt: Math.max(
      Date.now(),
      (current.lastInputClearedAt ?? 0) + 1,
      (current.lastUserInputAt ?? 0) + 1,
      (current.lastCommandAt ?? 0) + 1,
    ),
  });
}

/** An Enter intent alone is not display text or task evidence. */
export function noteTerminalInputSubmission(id: string, expected?: InputHistoryScope): void {
  const current = currentScope(id, expected);
  if (!current) return;
  useTerminalStore.getState().updateInstanceInfo(id, {
    lastInputSubmissionAt: Math.max(
      expected?.startedAt ?? Date.now(),
      (current.lastInputClearedAt ?? 0) + 1,
      (current.lastInputSubmissionAt ?? 0) + 1,
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
    clearTerminalInputHistory(id, undefined, { discardDraft: true });
    return;
  }
  useTerminalStore.getState().updateInstanceInfo(id, {
    lastUserInput: input,
    lastUserInputAt: Math.max(
      expected?.startedAt ?? Date.now(),
      (current.lastInputClearedAt ?? 0) + 1,
    ),
    lastInputSubmissionAt: Math.max(
      expected?.startedAt ?? Date.now(),
      (current.lastInputClearedAt ?? 0) + 1,
    ),
  });
}

export interface SubmittedAgentInput {
  text: string;
  timestamp: string;
}

/** A display observation may only correct the exact successful submission it captured. */
export function correctTerminalInputFromScreen(
  id: string,
  text: string,
  expected: InputHistoryScope,
): boolean {
  const current = currentScope(id, expected);
  if (
    !current ||
    current.lastUserInput !== expected.lastUserInput ||
    current.lastUserInputAt !== expected.lastUserInputAt ||
    current.lastInputSubmissionAt !== expected.lastInputSubmissionAt ||
    current.lastCommandAt !== expected.lastCommandAt
  )
    return false;
  recordTerminalInput(id, text, {
    ...expected,
    startedAt: expected.lastUserInputAt ?? expected.startedAt,
  });
  return true;
}

/** Correct a known submission only. Transcript text never starts a task or restores cleared input. */
export function correctTerminalInputFromAgent(id: string, input: SubmittedAgentInput): void {
  const current = captureInputHistoryScope(id);
  const submittedAt = current?.lastInputSubmissionAt ?? current?.lastUserInputAt;
  if (!current || submittedAt === undefined) return;
  const timestamp = /^\d+$/u.test(input.timestamp)
    ? Number(input.timestamp)
    : Date.parse(input.timestamp);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < submittedAt ||
    timestamp > Date.now() + 5000 ||
    timestamp <= (current.lastInputClearedAt ?? 0)
  )
    return;
  const text = normalizeSubmittedInput(input.text);
  if (
    !text ||
    (text === current.lastUserInput && current.lastUserInputAt === submittedAt) ||
    isInputHistoryClear(text)
  )
    return;
  useTerminalStore
    .getState()
    .updateInstanceInfo(id, { lastUserInput: text, lastUserInputAt: submittedAt });
}
