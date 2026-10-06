import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { DependencyCheck } from '../../application/health/check-readiness.js';

@Injectable()
export class DatabaseCheck implements DependencyCheck {
  readonly name = 'database';

  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    // Raw query on the connection pool: no entity, no identity map, so it does
    // not need a request context (allowGlobalContext is false).
    await this.orm.em.getConnection().execute('select 1');
  }
}
