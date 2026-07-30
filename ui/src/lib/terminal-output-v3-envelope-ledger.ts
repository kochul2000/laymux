import type { TerminalOutputEnvelope } from "./terminal-output-envelope";

export type TerminalOutputV3KnownEnvelopeMatch = "same" | "conflict" | "unknown";

export interface TerminalOutputV3RepairIdentity {
  readonly generation: number;
  readonly leaseToken: string;
  readonly envelopeId: number;
  readonly grantId: string | null;
  readonly seqStart: number;
}

interface EnvelopeRecord<T> {
  key: string;
  envelope: TerminalOutputEnvelope;
  value: T;
}

/** Bounded immutable identity/backing owner for current + previous v3 retries. */
export class TerminalOutputV3EnvelopeLedger<T> {
  private readonly records: EnvelopeRecord<T>[] = [];

  get size(): number {
    return this.records.length;
  }

  lookup(
    envelope: TerminalOutputEnvelope,
  ):
    | { readonly kind: "same"; readonly value: T }
    | { readonly kind: "conflict" }
    | { readonly kind: "unknown" } {
    const record = this.records.find(({ key }) => key === envelopeIdentityKey(envelope));
    if (!record) return { kind: "unknown" };
    if (!sameTerminalOutputEnvelope(record.envelope, envelope)) return { kind: "conflict" };
    return { kind: "same", value: record.value };
  }

  match(envelope: TerminalOutputEnvelope): TerminalOutputV3KnownEnvelopeMatch {
    return this.lookup(envelope).kind;
  }

  remember(envelope: TerminalOutputEnvelope, value: T): void {
    this.records.push({ key: envelopeIdentityKey(envelope), envelope, value });
    if (this.records.length > 2) this.records.shift();
  }

  hasRepairIdentity(identity: TerminalOutputV3RepairIdentity): boolean {
    return this.records.some(
      ({ envelope }) =>
        envelope.generation === identity.generation &&
        envelope.leaseToken === identity.leaseToken &&
        envelope.envelopeId === identity.envelopeId &&
        envelope.grantId === identity.grantId &&
        envelope.seqStart === identity.seqStart,
    );
  }
}

export function sameTerminalOutputEnvelope(
  left: TerminalOutputEnvelope,
  right: TerminalOutputEnvelope,
): boolean {
  if (
    left.seqStart !== right.seqStart ||
    left.seqEnd !== right.seqEnd ||
    left.backing.byteLength !== right.backing.byteLength ||
    left.deltas.length !== right.deltas.length
  ) {
    return false;
  }
  for (let index = 0; index < left.backing.byteLength; index += 1) {
    if (left.backing[index] !== right.backing[index]) return false;
  }
  return left.deltas.every((delta, index) => {
    const candidate = right.deltas[index];
    return (
      delta.seqStart === candidate.seqStart &&
      delta.seqEnd === candidate.seqEnd &&
      delta.geometry.revision === candidate.geometry.revision &&
      delta.geometry.cols === candidate.geometry.cols &&
      delta.geometry.rows === candidate.geometry.rows
    );
  });
}

function envelopeIdentityKey(envelope: TerminalOutputEnvelope): string {
  return JSON.stringify([
    envelope.generation,
    envelope.leaseToken,
    envelope.envelopeId,
    envelope.grantId,
  ]);
}
