import type { ScanFacts } from './scan.ts';
import { estimateLevers, pct, fmtK, type Levers } from './levers.ts';

export interface ReportOptions { eurRate?: number }

const money = (usd: number, rate?: number) => rate ? `EUR ${Math.round(usd * rate).toLocaleString('en-US')}` : `$${Math.round(usd).toLocaleString('en-US')}`;
const n = (x: number) => Math.round(x).toLocaleString('en-US');
const pad = (s: string, w: number) => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const rpad = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s);
const unit = (rate?: number) => (rate ? 'EUR ' : '$');

export function renderReport(f: ScanFacts, opts: ReportOptions = {}): string {
  const L = estimateLevers(f);
  const S = L.shape; const T = S.total || 1; const rate = opts.eurRate; const cur = unit(rate);
  const out: string[] = [];
  const h = (s: string) => { out.push(''); out.push(s.toUpperCase()); };
  const row = (label: string, value: string, note = '') => out.push(`  ${pad(label, 30)}${rpad(value, 12)}   ${note}`.trimEnd());

  out.push(`promptreduce analyze  |  ${f.projectsDir}`);
  if (!f.calls) { out.push('  no model calls found in the selected transcripts (try --all or --days 365)'); return out.join('\n'); }
  const span = f.firstTs && f.lastTs ? `${f.firstTs.slice(0, 10)} to ${f.lastTs.slice(0, 10)}` : '';
  out.push(`  ${n(f.sessions)} transcripts${f.days ? ` modified in the last ${f.days} days` : ''} | ${n(f.calls)} model calls | ${span}`);
  const models = Object.entries(f.callsByModel).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m, c]) => `${m || 'unknown'} ${pct(c / f.calls)}`).join(' | ');
  out.push(`  models: ${models}`);
  const unknownIds = Object.entries(S.byModel).filter(([, m]) => !m.known).map(([id]) => id || '(empty)');
  if (unknownIds.length) out.push(`  not in the price table, priced as Opus 5.5: ${unknownIds.join(', ')}`);

  h(`Where the money goes  (list prices, ${rate ? `EUR at ${rate} per USD` : 'USD'})`);
  const shapeRows: [string, number, string][] = [
    ['cache rebuilds', S.rebuild, `${n(f.rebuilds.count)} events, ${n(f.rebuilds.afterIdle)} after an idle gap over 1h`],
    ['cache reads', S.cacheRead, 'context re-read on every turn'],
    ['thinking', S.thinking, 'reasoning tokens, never shown'],
    ['cache appends', S.append, 'new content written once'],
    ['fresh input', S.input, 'uncached tokens'],
    ['visible output and edits', S.visible, 'text you read, files it writes'],
  ];
  shapeRows.sort((a, b) => b[1] - a[1]);
  for (const [label, v, note] of shapeRows) row(label, `${money(v, rate)}  ${rpad(pct(v / T), 4)}`, note);
  row('total', money(S.total, rate));

  h('Context');
  row('average context per call', `${fmtK(f.avgContext)} tokens`);
  row('session prefix (median)', `${fmtK(L.inputs.prefix)} tokens`, `system prompt plus tool definitions on a cold start, ${pct(L.inputs.prefix / (f.avgContext || 1))} of an average request, ${n(f.prefixSamples.length)} cold starts | ${f.mcpServers.global + f.mcpServers.perProject} MCP servers configured`);
  row('tool results', `${pct(L.inputs.trShare)}`, 'of message tokens (the rest: edits and writes, prompts, assistant text)');
  row('long tail', `${pct(f.toolResults.tokens ? f.toolResults.over1k.tokens / f.toolResults.tokens : 0)}`, `of tool-result tokens sit in the ${pct(f.toolResults.n ? f.toolResults.over1k.n / f.toolResults.n : 0)} of results over 1,000 tokens`);
  row('idle gaps over 1h', n(f.idleGapsOver1h), 'each one lets the cache expire');

  h(`What promptreduce would remove now  (compressor run on ${n(f.compression.sampled)} of your tool results)`);
  row('level 1, structural', pct(L.inputs.removalL1), 'of tool-result tokens');
  row('level 2, aggressive', pct(L.inputs.removalL2), 'of tool-result tokens');
  row('dedupe', pct(L.inputs.dupShare), `of tool-result tokens are identical repeats (${n(f.dedupe.repeats)} results)`);
  const byTool = Object.entries(f.compression.byTool).filter(([, t]) => t.before >= 2000).sort((a, b) => b[1].before - a[1].before).slice(0, 8);
  for (const [tool, t] of byTool) row(`  ${tool.slice(0, 28)}`, `${pct(1 - t.l1 / t.before)} / ${pct(1 - t.l2 / t.before)}`, `${n(t.before)} tokens in ${n(t.n)} results`);

  h(`Per ${cur}1,000 spent`);
  for (const l of L.levers) {
    const range = l.lo === l.hi ? `${cur}${l.lo}` : `${cur}${l.lo} to ${cur}${l.hi}`;
    out.push(`  ${pad(l.status, 7)}${pad(l.name, 28)}${rpad(range, 16)}   ${l.source}`);
    out.push(`         ${wrap(l.basis, 100, 9)}`);
  }
  out.push('');
  out.push(`  stack of ${L.stack.members.join(', ')}: ${cur}${L.stack.lo} to ${cur}${L.stack.hi} per ${cur}1,000 (multiplicative)`);
  out.push(`  on this period's spend of ${money(S.total, rate)}: ${money(S.total * L.stack.lo / 1000, rate)} to ${money(S.total * L.stack.hi / 1000, rate)} back`);
  out.push('');
  out.push('  Prices are list prices for the models seen; on a subscription the same savings are rate-limit headroom.');
  out.push('  Token counts are local estimates; effort figures come from Anthropic\'s published runs, the rest is measured on your transcripts.');
  return out.join('\n');
}

function wrap(s: string, width: number, indent: number): string {
  const words = s.split(' '); const lines: string[] = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > width) { lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join('\n' + ' '.repeat(indent));
}

export function reportJson(f: ScanFacts): { facts: ScanFacts; levers: Levers } {
  return { facts: f, levers: estimateLevers(f) };
}
