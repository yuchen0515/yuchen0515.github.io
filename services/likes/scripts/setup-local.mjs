import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

try {
  await writeFile(new URL('../.dev.vars', import.meta.url),
    `VISITOR_HMAC_SECRET="${randomBytes(32).toString('hex')}"\n`,
    { flag: 'wx', mode: 0o600 });
  console.log('Local development secret created; its value is not printed.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing local development secret preserved.');
}
