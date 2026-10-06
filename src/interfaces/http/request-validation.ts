import { z } from 'zod';
import { ContractViolationCode } from '../../domain/wager/failure-code.js';

/** One problem in a request, with the stable code the provider can branch on. */
export interface ValidationDetail {
  /** Body path ("money.amount"), header ("Idempotency-Key") or route parameter. Absent for whole-payload rules. */
  readonly field?: string;
  readonly code: ContractViolationCode;
  readonly message: string;
}

/** HTTP 400. Nothing was stored: the request must be fixed before it is sent again. */
export class RequestValidationError extends Error {
  constructor(readonly details: readonly ValidationDetail[]) {
    super('The request is invalid');
    this.name = 'RequestValidationError';
  }
}

/**
 * Parses with a zod schema and turns every issue into a ValidationDetail with a
 * ContractViolationCode. Same role as @Valid + Bean Validation in Spring, but the
 * schema is a value, not annotations on a class.
 */
export function parseRequest<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  fieldPrefix = '',
): { ok: true; value: z.output<Schema> } | { ok: false; details: ValidationDetail[] } {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, details: result.error.issues.map((issue) => toDetail(issue, fieldPrefix)) };
}

/** Same as parseRequest, for a single value: throws RequestValidationError. */
export function parseOrThrow<Schema extends z.ZodType>(schema: Schema, input: unknown, fieldPrefix = ''): z.output<Schema> {
  const parsed = parseRequest(schema, input, fieldPrefix);
  if (!parsed.ok) {
    throw new RequestValidationError(parsed.details);
  }
  return parsed.value;
}

/** A custom issue that already knows its code (see violation() below). */
interface ViolationParams {
  readonly violation?: ContractViolationCode;
}

function toDetail(issue: z.core.$ZodIssue, fieldPrefix: string): ValidationDetail {
  const path = issue.path.map(String).join('.');
  const field = [fieldPrefix, path].filter((part) => part !== '').join('.');
  return {
    ...(field === '' ? {} : { field }),
    code: codeOf(issue),
    message: issue.message,
  };
}

function codeOf(issue: z.core.$ZodIssue): ContractViolationCode {
  const custom = issue.code === 'custom' ? (issue.params as ViolationParams | undefined)?.violation : undefined;
  if (custom !== undefined) {
    return custom;
  }
  if (issue.code === 'invalid_type' && issue.input === undefined) {
    return ContractViolationCode.MissingField;
  }
  if (issue.code === 'too_small' && issue.origin === 'string') {
    return ContractViolationCode.MissingField; // blank after trim
  }
  return ContractViolationCode.InvalidFormat;
}

/** Adds an issue to a zod refinement with a fixed ContractViolationCode. */
export function violation(ctx: z.RefinementCtx, code: ContractViolationCode, message: string): void {
  ctx.addIssue({ code: 'custom', message, params: { violation: code } satisfies ViolationParams });
}

// ---- building blocks shared by the request schemas ----

/**
 * No control characters (U+0000 to U+001F and U+007F). A NUL byte cannot be stored in a
 * PostgreSQL text column at all: the driver gets a protocol error. Refused here, it is a
 * plain 400 instead of a database error.
 */
const WITHOUT_CONTROL_CHARACTERS = /^[^\u0000-\u001F\u007F]*$/;

/** Required text: trimmed, not blank, bounded (the columns are text; the bound stops abuse), no control characters. */
export function requiredText(maxLength = 255) {
  return z
    .string('is required')
    .trim()
    .min(1, 'is required')
    .max(maxLength, `at most ${maxLength} characters`)
    .regex(WITHOUT_CONTROL_CHARACTERS, 'must not contain control characters');
}

/** UUID in any case, stored and compared in lower case (PostgreSQL's canonical form). */
export const uuidField = z
  .string('is required')
  .trim()
  .pipe(z.uuid('must be a UUID'))
  .transform((value) => value.toLowerCase());
