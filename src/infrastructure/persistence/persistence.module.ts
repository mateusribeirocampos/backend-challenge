import { type DynamicModule, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { DatabaseConfig } from '../config/app-config.js';
import { DatabaseCheck } from './database-check.js';
import { buildMikroOrmConfig } from './mikro-orm.config.js';

@Module({})
export class PersistenceModule {
  static register(database: DatabaseConfig): DynamicModule {
    return {
      module: PersistenceModule,
      // forRoot also registers the RequestContext middleware (a forked EntityManager
      // per HTTP request) and closes the ORM on application shutdown.
      imports: [MikroOrmModule.forRoot(buildMikroOrmConfig(database))],
      providers: [DatabaseCheck],
      exports: [DatabaseCheck],
    };
  }
}
