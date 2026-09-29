import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priceFor, usageFromApi, costOf } from '../src/analyze/pricing.ts';
import { scanTranscripts } from '../src/analyze/scan.ts';
import { estimateLevers, median } from '../src/analyze/levers.ts';
import { renderReport } from '../src/analyze/report.ts';

describe('pricing', () => {
  test('maps model ids to families', () => {
    expect(priceFor('claude-opus-5-5').family).toBe('opus-5.5');
    expect(priceFor('claude-haiku-4-5-20251001').family).toBe('haiku-4.5');
    expect(priceFor('claude-fable-5-1').cacheRead).toBe(0.25);
    expect(priceFor('claude-sonnet-4-6').input).toBe(3);
    expect(priceFor('something-new').known).toBe(false);
  });
  test('splits cache writes by ttl and prices them', () => {
    const u = usageFromApi({ input_tokens: 10, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 } });
    expect(u.cacheWrite1h).toBe(1_000_000);
    const c = costOf(u, priceFor('claude-opus-5-5'));
    expect(c.cacheRead).toBeCloseTo(0.2, 5);
    expect(c.cacheWrite).toBeCloseTo(8, 5);
    expect(c.output).toBeCloseTo(0.02, 5);
  });
  test('unknown breakdown counts as 5m writes', () => {
    const u = usageFromApi({ cache_creation_input_tokens: 100 });
    expect(u.cacheWriteUnknown).toBe(100);
  });
});

function transcript(lines: object[]): string { return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'; }
const usage = (cr: number, cc: number, out: number) => ({ input_tokens: 5, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: out, cache_creation: { ephemeral_1h_input_tokens: cc, ephemeral_5m_input_tokens: 0 } });
const big = Array.from({ length: 300 }, (_, i) => `line ${i} of a long shell output`).join('\n');

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-analyze-'));
  const proj = join(dir, '-Users-x-proj'); mkdirSync(proj);
  const t0 = Date.parse('2026-09-01T10:00:00Z');
  const ts = (min: number) => new Date(t0 + min * 60_000).toISOString();
  writeFileSync(join(proj, 'a.jsonl'), transcript([
    { type: 'user', timestamp: ts(0), message: { role: 'user', content: 'hello' } },
    // first call: prefix write; the same usage repeats on a second content-block line
    { type: 'assistant', timestamp: ts(0), message: { id: 'm1', model: 'claude-opus-5-5', usage: usage(0, 50_000, 10), content: [{ type: 'text', text: 'ok' }] } },
    { type: 'assistant', timestamp: ts(0), message: { id: 'm1', model: 'claude-opus-5-5', usage: usage(0, 50_000, 40), content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', timestamp: ts(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] } },
    { type: 'assistant', timestamp: ts(1), message: { id: 'm2', model: 'claude-opus-5-5', usage: usage(50_000, 2_000, 30), content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: big }] } },
    // idle gap of two hours, then a full rebuild
    { type: 'assistant', timestamp: ts(130), message: { id: 'm3', model: 'claude-opus-5-5', usage: usage(0, 54_000, 20), content: [{ type: 'text', text: 'done' }] } },
  ]));
  return dir;
}

describe('scan and levers', () => {
  const facts = scanTranscripts({ projectsDir: fixture(), days: 0, sampleResults: 100 });
  test('dedupes usage by message id and classifies rebuilds', () => {
    expect(facts.sessions).toBe(1);
    expect(facts.calls).toBe(3);
    expect(facts.usage.output).toBe(40 + 30 + 20);
    expect(facts.rebuilds.count).toBe(2);
    expect(facts.rebuilds.afterIdle).toBe(1);
    expect(facts.idleGapsOver1h).toBe(1);
    expect(facts.appendTokens).toBe(2_000);
    expect(facts.prefixSamples).toEqual([50_005]);
  });
  test('measures tool results, repeats and compression', () => {
    expect(facts.toolResults.n).toBe(2);
    expect(facts.dedupe.repeats).toBe(1);
    expect(facts.compression.sampled).toBe(2);
    expect(facts.compression.l1).toBeLessThan(facts.compression.before);
  });
  test('levers are bounded and the report renders', () => {
    const L = estimateLevers(facts);
    for (const l of L.levers) { expect(l.lo).toBeGreaterThanOrEqual(0); expect(l.hi).toBeLessThanOrEqual(1000); expect(l.hi).toBeGreaterThanOrEqual(l.lo); }
    expect(L.stack.hi).toBeGreaterThan(L.stack.lo);
    const text = renderReport(facts);
    expect(text).toContain('WHERE THE MONEY GOES');
    expect(text).toContain('PER $1,000 SPENT');
    expect(renderReport(facts, { eurRate: 0.9 })).toContain('EUR ');
  });
  test('median', () => { expect(median([3, 1, 2])).toBe(2); expect(median([])).toBe(0); expect(median([1, 4])).toBe(3); });
});
