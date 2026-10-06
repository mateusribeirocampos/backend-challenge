import type {
  ProviderCredentials,
  ProviderIdentity,
  ProviderIdentityPort,
} from '../../application/ports/provider-identity.js';

/**
 * NO-OP on purpose (ADR-006, phase 1): authentication is not implemented and every
 * caller is anonymous. This is the class to replace with a JWT validator (Keycloak or
 * Zitadel, client credentials per provider, JWKS); nothing else changes.
 */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(_credentials: ProviderCredentials): Promise<ProviderIdentity> {
    return { providerId: undefined, authenticated: false };
  }
}
