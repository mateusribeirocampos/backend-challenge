import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigValidationError, loadConfig } from './infrastructure/config/app-config.js';

async function bootstrap(): Promise<void> {
  // Validate env before anything connects: a bad config stops here with a clear list.
  const config = loadConfig(process.env);

  const app = await NestFactory.create(AppModule.register(config));
  // SIGTERM/SIGINT run onApplicationShutdown hooks: the ORM pool and the SQS client close.
  app.enableShutdownHooks();
  await app.listen(config.http.port);
}

try {
  await bootstrap();
} catch (error) {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
}
