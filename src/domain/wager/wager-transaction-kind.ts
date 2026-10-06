/**
 * `as const` object + union type instead of a TypeScript `enum`: same call site
 * (WagerTransactionKind.Bet), but the type is the plain string union
 * 'OPENING' | 'BET' | ..., which is exactly what goes to JSON and to the database.
 */
export const WagerTransactionKind = {
  /** Internal: credit of the initial balance when a wallet is opened. Never submitted by a provider. */
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;
export type WagerTransactionKind = (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

const ALL_KINDS: readonly string[] = Object.values(WagerTransactionKind);

export function isWagerTransactionKind(value: unknown): value is WagerTransactionKind {
  return typeof value === 'string' && ALL_KINDS.includes(value);
}

/**
 * Which kinds a transaction may point to with referenceExternalTransactionId.
 * Spec section 7 rule 3: REFUND only reverts a BET; ROLLBACK reverts BET, WIN or REFUND.
 * WIN and LOSS may point to the BET of the round they settle. BET and OPENING never
 * have a reference.
 */
export const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  OPENING: [],
  BET: [],
  WIN: [WagerTransactionKind.Bet],
  LOSS: [WagerTransactionKind.Bet],
  REFUND: [WagerTransactionKind.Bet],
  ROLLBACK: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/** REFUND and ROLLBACK undo another transaction; they are the only reversals. */
export function isReversal(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}
