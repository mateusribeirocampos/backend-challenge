/**
 * Authentication extension point (spec 2, ADR-006). Today the adapter is a no-op and
 * every caller is anonymous. A real adapter would validate an OAuth2 client
 * credentials token against the IdP's JWKS and return the providerId it carries; the
 * guard would then refuse a body whose providerId differs. No use case changes.
 */
export interface ProviderIdentity {
  /** undefined while authentication is not implemented. */
  readonly providerId: string | undefined;
  readonly authenticated: boolean;
}

export interface ProviderCredentials {
  /** Request headers, lower case names. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface ProviderIdentityPort {
  resolve(credentials: ProviderCredentials): Promise<ProviderIdentity>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
