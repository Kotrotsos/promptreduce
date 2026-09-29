import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Full originals of truncated results, addressed by content hash so the path
 * in a compressed result is the same on every request that carries it.
 */
export function makeArchiver(dir: string) {
  let ready = false;
  return (original: string): string | undefined => {
    try {
      if (!ready) { mkdirSync(dir, { recursive: true }); ready = true; }
      const hash = new Bun.CryptoHasher('sha256').update(original).digest('hex').slice(0, 16);
      const file = join(dir, `${hash}.txt`);
      if (!existsSync(file)) writeFileSync(file, original);
      return file;
    } catch {
      return undefined;
    }
  };
}
