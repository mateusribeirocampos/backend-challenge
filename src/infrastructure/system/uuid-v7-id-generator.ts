import type { IdGenerator } from '../../application/ports/id-generator.js';

export class UuidV7IdGenerator implements IdGenerator {
  newId(): string {
    return Bun.randomUUIDv7();
  }
}
