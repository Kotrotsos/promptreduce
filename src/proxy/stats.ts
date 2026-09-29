import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RewriteReport } from './rewrite.ts';
import type { Usage } from './usage.ts';

export interface RequestRecord {
  ts: string;
  model?: string;
  stream: boolean;
  status: number;
  ms: number;
  report: RewriteReport;
  usage?: Usage;
}

export interface Aggregate {
  requests: number;
  results: number;
  rewritten: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensRemoved: number;
  usage: Usage;
  byTool: Record<string, { n: number; rewritten: number; before: number; after: number }>;
  first?: string;
  last?: string;
}

export function appendRecord(file: string, rec: RequestRecord) {
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch { /* stats must never break a request */ }
}

export function emptyAggregate(): Aggregate {
  return {
    requests: 0, results: 0, rewritten: 0, tokensBefore: 0, tokensAfter: 0, tokensRemoved: 0,
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    byTool: {},
  };
}

export function addRecord(agg: Aggregate, rec: RequestRecord) {
  agg.requests++;
  agg.results += rec.report.results;
  agg.rewritten += rec.report.rewritten;
  agg.tokensBefore += rec.report.tokensBefore;
  agg.tokensAfter += rec.report.tokensAfter;
  agg.tokensRemoved += rec.report.tokensBefore - rec.report.tokensAfter;
  if (rec.usage) for (const k of Object.keys(agg.usage) as (keyof Usage)[]) agg.usage[k] += rec.usage[k] ?? 0;
  for (const [tool, s] of Object.entries(rec.report.byTool)) {
    const t = (agg.byTool[tool] ??= { n: 0, rewritten: 0, before: 0, after: 0 });
    t.n += s.n; t.rewritten += s.rewritten; t.before += s.before; t.after += s.after;
  }
  agg.first ??= rec.ts;
  agg.last = rec.ts;
}

export function readAggregate(file: string): Aggregate {
  const agg = emptyAggregate();
  if (!existsSync(file)) return agg;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { addRecord(agg, JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return agg;
}
