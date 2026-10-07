import { z } from 'zod';
import { ContractViolationCode } from '../../domain/wager/failure-code.js';
import { decodeLedgerCursor } from './ledger-cursor.js';
import { moneySchema } from './money-schema.js';
import { RequestValidationError, uuidField, type ValidationDetail } from './request-validation.js';

/** Body of POST /wallets (spec 9). */
export const openWalletBody = z.object(
  {
    playerId: uuidField,
    initialBalance: moneySchema,
  },
  'the body must be a JSON object',
);

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 100;

/** 1 to 100, written as plain digits: "007", "1.5" and "1e2" are refused, not guessed. */
const PAGE_SIZE = /^[1-9]\d{0,2}$/;

export interface LedgerQuery {
  /** Continue after this wallet_version; undefined = from the first entry. */
  readonly afterVersion: number | undefined;
  readonly limit: number;
}

/** Query string of GET /wallets/:walletId/ledger?cursor=...&limit=50. Throws RequestValidationError (400). */
export function parseLedgerQuery(query: Readonly<Record<string, unknown>>): LedgerQuery {
  const details: ValidationDetail[] = [];
  const limit = parseLimit(query.limit, details);
  const afterVersion = parseCursor(query.cursor, details);
  if (details.length > 0) {
    throw new RequestValidationError(details);
  }
  return { afterVersion, limit };
}

function parseLimit(raw: unknown, details: ValidationDetail[]): number {
  if (raw === undefined) {
    return DEFAULT_LEDGER_PAGE_SIZE;
  }
  const limit = typeof raw === 'string' && PAGE_SIZE.test(raw) ? Number.parseInt(raw, 10) : undefined;
  if (limit === undefined || limit > MAX_LEDGER_PAGE_SIZE) {
    details.push({
      field: 'limit',
      code: ContractViolationCode.InvalidFormat,
      message: `must be an integer from 1 to ${MAX_LEDGER_PAGE_SIZE}`,
    });
    return DEFAULT_LEDGER_PAGE_SIZE;
  }
  return limit;
}

function parseCursor(raw: unknown, details: ValidationDetail[]): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const afterVersion = typeof raw === 'string' ? decodeLedgerCursor(raw) : undefined;
  if (afterVersion === undefined) {
    details.push({
      field: 'cursor',
      code: ContractViolationCode.InvalidFormat,
      message: 'is not a cursor returned by this endpoint',
    });
  }
  return afterVersion;
}
