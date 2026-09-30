import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Level } from '../compress/index.ts';

/**
 * Tool-call ids whose results the proxy has compressed, with the level used.
 *
 * Upstream caches the exact bytes of every prefix it has seen. A result that
 * went upstream uncompressed (the proxy was not in the path yet, or was
 * restarted without this file) must keep going upstream uncompressed, or the
 * whole cached prefix is rebuilt. A result the proxy compressed must keep
 * being compressed the same way, at the same level. This store is how the
 * proxy tells the two apart across requests and restarts.
 */
export interface KnownIds {
  get(id: string): Level | undefined;
  add(id: string, level: Level): void;
}

const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

export function memoryKnownIds(): KnownIds {
  const m = new Map<string, Level>();
  return { get: (id) => m.get(id), add: (id, level) => { m.set(id, level); } };
}

/** Append-only file of `id<TAB>level<TAB>epochMs`; entries older than two weeks are dropped on load. */
export function fileKnownIds(file: string, now = Date.now()): KnownIds {
  const m = new Map<string, Level>();
  const keep: string[] = [];
  try {
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const [id, lv, ts] = line.split('\t');
        if (!id || now - Number(ts) > MAX_AGE_MS) continue;
        const level = Number(lv);
        if (level !== 0 && level !== 1 && level !== 2) continue;
        m.set(id, level as Level);
        keep.push(line);
      }
      writeFileSync(file, keep.length ? keep.join('\n') + '\n' : '');
    } else {
      mkdirSync(dirname(file), { recursive: true });
    }
  } catch { /* an unreadable store degrades to "nothing known yet" */ }
  return {
    get: (id) => m.get(id),
    add: (id, level) => {
      if (m.has(id)) return;
      m.set(id, level);
      try { appendFileSync(file, `${id}\t${level}\t${Date.now()}\n`); } catch { /* never break a request */ }
    },
  };
}
