/**
 * The cursor of GET /wallets/:walletId/ledger: base64url of {"afterVersion": n}, where n
 * is the wallet_version of the last entry already returned.
 *
 * Stable: wallet_version is unique per wallet and never changes (the ledger is
 * append-only), so "the entries after version n" is the same set whenever it is asked,
 * plus whatever was appended since: no gap and no duplicate between pages. It is also
 * cheap: the unique index (wallet_id, wallet_version) goes straight to version n, where
 * an OFFSET of 100 000 would read and throw away 100 000 rows first.
 * Opaque: clients pass it back as is; the format can change without breaking them.
 */
interface CursorContent {
  readonly afterVersion: number;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeLedgerCursor(afterVersion: number): string {
  const content: CursorContent = { afterVersion };
  return Buffer.from(JSON.stringify(content), 'utf8').toString('base64url');
}

/** The version to continue after, or undefined when the text is not a cursor this API issued. */
export function decodeLedgerCursor(cursor: string): number | undefined {
  if (!BASE64URL.test(cursor)) {
    return undefined;
  }
  const afterVersion = afterVersionIn(Buffer.from(cursor, 'base64url').toString('utf8'));
  // Only the exact text encodeLedgerCursor produces: one cursor per position.
  if (afterVersion === undefined || encodeLedgerCursor(afterVersion) !== cursor) {
    return undefined;
  }
  return afterVersion;
}

function afterVersionIn(json: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).join() !== 'afterVersion') {
    return undefined;
  }
  const { afterVersion } = parsed as { afterVersion: unknown };
  return typeof afterVersion === 'number' && Number.isSafeInteger(afterVersion) && afterVersion >= 1 ? afterVersion : undefined;
}
