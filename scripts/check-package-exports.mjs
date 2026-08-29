import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

for (const entrypoint of ['@festapp/banksync', '@festapp/banksync/cloudflare']) {
  const esm = await import(entrypoint);
  const cjs = require(entrypoint);

  if (typeof esm !== 'object' || typeof cjs !== 'object') {
    throw new Error(`Package entrypoint ${entrypoint} did not load in both module systems`);
  }
}
