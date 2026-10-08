/**
 * What may be logged or shipped (DLQ attributes) about an error: its class, its code
 * (our own code, a SQLSTATE or a Node code) and the constraint name. Never the message,
 * the stack or pg's `detail`: for a database error they carry the SQL with its parameters
 * and the failing row, amounts included (spec 12, review point F). Example: a CHECK
 * violation says "update wallets set balance_amount = -125.00 ..." in its message; the
 * summary says only CheckConstraintViolationException, 23514, wallets_balance_non_negative.
 */
export type ErrorSummary = {
  readonly errorClass: string;
  readonly errorCode?: string;
  readonly constraint?: string;
  /** The error this one wraps (a 503 wraps the lock timeout 55P03). */
  readonly causeClass?: string;
  readonly causeCode?: string;
};

/** Codes and constraint names are identifiers; anything else is dropped so these fields cannot carry text. */
const IDENTIFIER = /^[A-Za-z0-9_$.]{1,128}$/;

export function summarizeError(error: unknown): ErrorSummary {
  const summary: Record<string, string> = { errorClass: classOf(error) };
  copyIdentifier(summary, 'errorCode', propertyOf(error, 'code'));
  copyIdentifier(summary, 'constraint', propertyOf(error, 'constraint'));

  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== undefined) {
    summary.causeClass = classOf(cause);
    copyIdentifier(summary, 'causeCode', propertyOf(cause, 'code'));
    if (summary.constraint === undefined) {
      copyIdentifier(summary, 'constraint', propertyOf(cause, 'constraint'));
    }
  }
  return summary as ErrorSummary;
}

/** "CheckConstraintViolationException code=23514 constraint=wallets_balance_non_negative": one line for a DLQ attribute. */
export function errorSummaryText(summary: ErrorSummary): string {
  const labelled: [string, string | undefined][] = [
    ['code', summary.errorCode],
    ['constraint', summary.constraint],
    ['cause', summary.causeClass],
    ['causeCode', summary.causeCode],
  ];
  const present = labelled.filter(([, value]) => value !== undefined).map(([label, value]) => `${label}=${value}`);
  return [summary.errorClass, ...present].join(' ');
}

/**
 * The class name, or the type of a value thrown that is not an Error. The constructor
 * first: pg's DatabaseError sets name = "error". Then `name`, for a plain Error that a
 * library renamed (the AWS SDK's "TimeoutError").
 */
function classOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error;
  }
  const constructorName = error.constructor.name;
  if (constructorName !== 'Error' && IDENTIFIER.test(constructorName)) {
    return constructorName;
  }
  return IDENTIFIER.test(error.name) ? error.name : 'Error';
}

function propertyOf(error: unknown, property: 'code' | 'constraint'): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[property] : undefined;
}

function copyIdentifier(summary: Record<string, string>, field: string, value: unknown): void {
  if (typeof value === 'string' && IDENTIFIER.test(value)) {
    summary[field] = value;
  }
}
