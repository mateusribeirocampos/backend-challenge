import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module.js';
import type { AppConfig } from '../../../src/infrastructure/config/app-config.js';

export interface RunningTestApp {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** Boots the real Nest app (real PostgreSQL, real SQS emulator) on a random free port. */
export async function startTestApp(config: AppConfig): Promise<RunningTestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config)] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  return { baseUrl, close: () => app.close() };
}
