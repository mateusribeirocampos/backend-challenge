import { z } from 'zod';
import { sha256OfCanonicalJson } from '../../application/wagering/payload-hash.js';
import type { ProcessWagerTransactionCommand } from '../../application/wagering/process-wager-transaction.js';
import { Money } from '../../domain/money/money.js';
import { parseRequest, requiredText, type ValidationDetail } from '../http/request-validation.js';
import { submitWagerTransactionBody } from '../http/wager-transaction.request.js';
import { DeadLetterReason } from './processing-failure.js';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/**
 * data of the message: exactly the HTTP body (same zod schema, same codes) plus the
 * idempotency key, which over HTTP comes in the Idempotency-Key header.
 */
const wagerMessageData = submitWagerTransactionBody.extend({ idempotencyKey: requiredText(255) });

/** The envelope of spec 10. Unknown fields are dropped. */
const wagerTransactionMessage = z.object(
  {
    messageId: requiredText(255),
    type: z.literal(WAGER_TRANSACTION_REQUESTED, `must be "${WAGER_TRANSACTION_REQUESTED}"`),
    occurredAt: z.iso.datetime({ offset: true, error: 'must be an ISO-8601 date-time' }),
    // Not in the spec example; accepted so a producer can tie its own trace to ours.
    correlationId: requiredText(128).optional(),
    data: wagerMessageData,
  },
  'the message must be a JSON object',
);

export type WagerMessage = z.output<typeof wagerTransactionMessage>;

export interface MessageParseFailure {
  readonly reason: typeof DeadLetterReason.MalformedJson | typeof DeadLetterReason.SchemaInvalid;
  /** The first problem's code, for the DLQ attribute. */
  readonly errorCode: string;
  readonly details: readonly ValidationDetail[];
}

export type MessageParseResult =
  | { readonly ok: true; readonly message: WagerMessage }
  | { readonly ok: false; readonly failure: MessageParseFailure };

/** Body of a SQS message -> validated envelope, or why it can never be processed. */
export function parseWagerMessage(body: string): MessageParseResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return {
      ok: false,
      failure: { reason: DeadLetterReason.MalformedJson, errorCode: DeadLetterReason.MalformedJson, details: [] },
    };
  }
  const parsed = parseRequest(wagerTransactionMessage, json);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: {
        reason: DeadLetterReason.SchemaInvalid,
        errorCode: parsed.details[0]?.code ?? DeadLetterReason.SchemaInvalid,
        details: parsed.details,
      },
    };
  }
  return { ok: true, message: parsed.value };
}

/** The same command the HTTP controller builds, so both entries run the same use case. */
export function commandOf(message: WagerMessage): ProcessWagerTransactionCommand {
  const { referenceExternalTransactionId, idempotencyKey, ...fields } = message.data;
  return {
    ...fields,
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    idempotencyKey,
    correlationId: message.correlationId ?? message.messageId,
    causationId: message.messageId,
  };
}

/**
 * The inbox payload_hash: sha256 of the canonical JSON of data, with the amount
 * normalized like the operation hash ("25" and "25.00" are the same message).
 * The envelope fields (messageId, occurredAt) are not in it: they identify the
 * delivery, not the content.
 */
export function messageDataHash(message: WagerMessage): string {
  return sha256OfCanonicalJson({ ...message.data, money: Money.from(message.data.money).toJSON() });
}
