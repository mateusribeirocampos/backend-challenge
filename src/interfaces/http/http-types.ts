/**
 * The few parts of the Express request and response this layer touches. Declared here
 * so the code does not depend on @types/express (not installed).
 */
export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Set by CorrelationIdMiddleware. */
  correlationId?: string;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/** First value of a header (Express joins most repeated headers, but the type allows an array). */
export function headerValue(request: HttpRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
