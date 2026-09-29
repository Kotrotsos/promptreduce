import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kind } from '../compress/types.ts';

export interface Sample {
  id: string;
  tool: string;
  kind: Kind;
  input?: Record<string, unknown>;
  text: string;
  source: string;
  isError?: boolean;
}

export function loadCorpus(dir: string): Sample[] {
  if (!existsSync(dir)) return [];
  const out: Sample[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { /* skip */ }
  }
  return out;
}
