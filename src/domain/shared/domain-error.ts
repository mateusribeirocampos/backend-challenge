/**
 * Base of every error the domain throws. `code` is stable and machine readable, so
 * the layers above can map an error without parsing its message.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A precondition inside the domain was broken: a bug in the caller (for example the
 * use case passed the wrong wallet), never a business outcome. Business outcomes are
 * returned as values (REJECTED + failureCode), not thrown.
 */
export class DomainInvariantError extends DomainError {
  readonly code = 'DOMAIN_INVARIANT_VIOLATED';
}
