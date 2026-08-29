import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type ExportTarget = {
  types: string;
  import: string;
  default: string;
};

describe('published package exports', () => {
  it('provides a default condition for legacy resolvers', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, ExportTarget> };

    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    });
    expect(manifest.exports['./cloudflare']).toEqual({
      types: './dist/cloudflare.d.ts',
      import: './dist/cloudflare.js',
      default: './dist/cloudflare.js',
    });
  });
});
