import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../domain/money/money.js';

/**
 * The business fields of a submitted transaction: what makes two submissions "the same
 * operation". The Idempotency-Key header, the SQS messageId, occurredAt and any other
 * transport metadata are NOT here (ADR-003).
 */
export interface WagerPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  /** null and absent mean the same thing: no reference. */
  readonly referenceExternalTransactionId?: string | null | undefined;
}

/**
 * payloadHash = sha256, in hex, of the canonical JSON of the business fields:
 *   1. only the fields of WagerPayload (anything else the caller passes is dropped);
 *   2. amount normalized by Money ("25" -> "25.00"), UUIDs in lower case, a null
 *      reference treated as absent;
 *   3. keys sorted at every level, no whitespace, absent optional fields left out.
 * Same operation sent twice (any key order, "25" or "25.00") gives the same hash; any
 * change in a business field gives another hash, which is an idempotency conflict.
 */
export function computePayloadHash(payload: WagerPayload): string {
  const businessFields: WagerPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId.toLowerCase(),
    walletId: payload.walletId.toLowerCase(),
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? undefined,
  };
  return createHash('sha256').update(canonicalJson(businessFields), 'utf8').digest('hex');
}

/** JSON with object keys sorted at every level and no whitespace. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
