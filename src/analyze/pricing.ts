/**
 * List prices in USD per million tokens. Cache reads are a fraction of the
 * input price; cache writes cost 1.25x input on the 5-minute TTL and 2x on
 * the 1-hour TTL. Unknown models are priced like Claude Opus 5.5 and flagged.
 */
export interface Price { family: string; input: number; output: number; cacheRead: number; write5m: number; write1h: number; known: boolean }

const TABLE: Array<[RegExp, string, number, number, number]> = [
  [/fable-5|mythos-5/, 'fable-5', 10, 50, 0.25],
  [/opus-5-5/, 'opus-5.5', 4, 20, 0.20],
  [/opus-5/, 'opus-5', 5, 25, 0.50],
  [/opus-4-[5678]/, 'opus-4.5+', 5, 25, 0.50],
  [/opus-4/, 'opus-4', 15, 75, 1.50],
  [/sonnet-5/, 'sonnet-5', 2, 10, 0.20],
  [/sonnet-[34]/, 'sonnet-4', 3, 15, 0.30],
  [/haiku-4-5/, 'haiku-4.5', 1, 5, 0.10],
  [/haiku/, 'haiku-3', 0.8, 4, 0.08],
];

export function priceFor(model: string | undefined): Price {
  const m = (model ?? '').toLowerCase();
  for (const [re, family, input, output, cacheRead] of TABLE) {
    if (re.test(m)) return { family, input, output, cacheRead, write5m: input * 1.25, write1h: input * 2, known: true };
  }
  return { family: 'unknown (priced as opus-5.5)', input: 4, output: 20, cacheRead: 0.20, write5m: 5, write1h: 8, known: false };
}

export interface UsageTotals { input: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; cacheWriteUnknown: number; output: number }
export const emptyUsage = (): UsageTotals => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, output: 0 });

export interface Cost { input: number; cacheRead: number; cacheWrite: number; output: number; total: number }

export function costOf(u: UsageTotals, p: Price): Cost {
  const input = (u.input / 1e6) * p.input;
  const cacheRead = (u.cacheRead / 1e6) * p.cacheRead;
  const cacheWrite = (u.cacheWrite5m / 1e6) * p.write5m + (u.cacheWrite1h / 1e6) * p.write1h + (u.cacheWriteUnknown / 1e6) * p.write5m;
  const output = (u.output / 1e6) * p.output;
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}

export function addUsage(into: UsageTotals, u: UsageTotals) {
  for (const k of Object.keys(into) as (keyof UsageTotals)[]) into[k] += u[k];
}

/** Reads one API usage object (as Claude Code stores it) into totals, splitting cache writes by TTL when the breakdown is present. */
export function usageFromApi(u: Record<string, unknown>): UsageTotals {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out = emptyUsage();
  out.input = n(u.input_tokens);
  out.cacheRead = n(u.cache_read_input_tokens);
  out.output = n(u.output_tokens);
  const cc = n(u.cache_creation_input_tokens);
  const breakdown = u.cache_creation as Record<string, unknown> | undefined;
  if (breakdown && typeof breakdown === 'object') {
    const h = n(breakdown.ephemeral_1h_input_tokens), m = n(breakdown.ephemeral_5m_input_tokens);
    out.cacheWrite1h = h; out.cacheWrite5m = m;
    const rest = cc - h - m;
    if (rest > 0) out.cacheWriteUnknown = rest;
  } else {
    out.cacheWriteUnknown = cc;
  }
  return out;
}
