import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import {
  PROVIDER_IDENTITY,
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../application/ports/provider-identity.js';
import type { HttpRequest } from './http-types.js';

/**
 * Authentication extension point (spec 2, ADR-006). Registered on the wallet and
 * wagering controllers; health stays open. Today it lets every request through,
 * because the identity port is a no-op. With a real port it would:
 *   - answer 401 when resolve() fails (missing or invalid token);
 *   - answer 403 when identity.providerId differs from the providerId in the body.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequest & { providerIdentity?: ProviderIdentity }>();
    request.providerIdentity = await this.identities.resolve({ headers: request.headers });
    return true;
  }
}
