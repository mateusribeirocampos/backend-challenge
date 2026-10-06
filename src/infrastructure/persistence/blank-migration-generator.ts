import { TSMigrationGenerator } from '@mikro-orm/migrations';

/**
 * The default TS generator leaves out down() when there is no schema diff, and the
 * base Migration.down() throws "cannot be reverted". We always create blank migrations
 * by hand, so this generator always writes both methods for the author to fill in.
 */
export class BlankMigrationGenerator extends TSMigrationGenerator {
  override generateMigrationFile(className: string): string {
    return [
      `import { Migration } from '@mikro-orm/migrations';`,
      ``,
      `export class ${className} extends Migration {`,
      `  override name = '${className}';`,
      ``,
      `  override up(): void {`,
      `    // this.addSql('...');`,
      `  }`,
      ``,
      `  // Must undo everything up() created, in reverse order.`,
      `  override down(): void {`,
      `    // this.addSql('...');`,
      `  }`,
      `}`,
      ``,
    ].join('\n');
  }
}
