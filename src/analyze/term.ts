/** Terminal rendering for analyze: a short gist by default, the full report with --full. Colors and width adapt to the terminal. */
import type { ScanFacts } from './scan.ts';
import { estimateLevers, pct, fmtK, type Levers } from './levers.ts';

const ANSI = /\x1b\[[0-9;]*m/g;
export interface TermOptions { color?: boolean; width?: number; eurRate?: number; htmlPath?: string; opened?: boolean }

export function detectColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

function palette(on: boolean) {
  const w = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: w('1'), dim: w('2'), green: w('32'), yellow: w('33'), cyan: w('36'), magenta: w('35'), blue: w('34'), gray: w('90'), boldGreen: w('1;32'), boldCyan: w('1;36'), boldYellow: w('1;33') };
}

const vlen = (s: string) => s.replace(ANSI, '').length;
const padR = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - vlen(s)));
const padL = (s: string, w: number) => ' '.repeat(Math.max(0, w - vlen(s))) + s;

/** Word-wraps plain text to width, prefixing every line with indent. */
export function wrap(text: string, width: number, indent: string): string[] {
  const max = Math.max(20, width - indent.length);
  const lines: string[] = []; let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > max) { lines.push(indent + cur); cur = word; }
    else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(indent + cur);
  return lines;
}

function fancyGlyphs(): boolean {
  return process.platform !== 'win32' || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM);
}

function money(usd: number, rate?: number) {
  return rate ? `EUR ${Math.round(usd * rate).toLocaleString('en-US')}` : `$${Math.round(usd).toLocaleString('en-US')}`;
}
const unit = (rate?: number) => (rate ? 'EUR ' : '$');
const n = (x: number) => Math.round(x).toLocaleString('en-US');

function shapeRows(f: ScanFacts, L: Levers): [string, number, string][] {
  const S = L.shape;
  const rows: [string, number, string][] = [
    ['Cache reads', S.cacheRead, 'context re-read on every turn'],
    ['Cache rebuilds', S.rebuild, `${n(f.rebuilds.count)} rebuilds, ${n(f.rebuilds.afterIdle)} after an idle gap over 1h`],
    ['Cache appends', S.append, 'new content written once'],
    ['Thinking', S.thinking, 'reasoning tokens, never shown'],
    ['Visible output', S.visible, 'text you read, files it writes'],
    ['Fresh input', S.input, 'uncached tokens'],
  ];
  return rows.sort((a, b) => b[1] - a[1]);
}

function bar(share: number, width: number, c: ReturnType<typeof palette>): string {
  const full = fancyGlyphs() ? '█' : '#';
  const empty = fancyGlyphs() ? '░' : '.';
  const k = Math.max(share > 0 ? 1 : 0, Math.round(share * width));
  return c.cyan(full.repeat(k)) + c.gray(empty.repeat(Math.max(0, width - k)));
}

function header(f: ScanFacts, c: ReturnType<typeof palette>, width = 100): string[] {
  const span = f.firstTs && f.lastTs ? `${f.firstTs.slice(0, 10)} to ${f.lastTs.slice(0, 10)}` : '';
  const scope = f.days ? `last ${f.days} days` : 'all transcripts';
  const title = `${c.boldCyan('promptreduce')} ${c.bold('analyze')}`;
  const detail = `${n(f.sessions)} transcripts  ·  ${n(f.calls)} model calls  ·  ${scope}  ·  ${span}`;
  if (vlen(title) + 2 + detail.length <= width) return [`${title}  ${c.gray(detail)}`];
  return [title, ...wrap(detail, width, '  ').map(c.gray)];
}

export function renderGist(f: ScanFacts, o: TermOptions = {}): string {
  const c = palette(o.color ?? detectColor());
  if (!f.calls) return `${c.boldCyan('promptreduce')} ${c.bold('analyze')}\n  No model calls found. Try ${c.cyan('--all')} or ${c.cyan('--days 365')}.`;
  const L = estimateLevers(f); const S = L.shape; const T = S.total || 1; const cur = unit(o.eurRate);
  const width = Math.min(o.width ?? process.stdout.columns ?? 100, 110);
  const barW = Math.max(10, Math.min(28, width - 60));
  const out: string[] = [...header(f, c, width), ''];
  out.push(`  ${c.bold('Spend')} ${c.gray('at list prices')}   ${c.bold(money(S.total, o.eurRate))}`);
  for (const [label, v] of shapeRows(f, L).slice(0, 4)) {
    out.push(`  ${bar(v / T, barW, c)}  ${padR(label, 16)}${padL(pct(v / T), 5)}  ${c.gray(padL(money(v, o.eurRate), 9))}`);
  }
  out.push('');
  const comp = L.levers.find((l) => l.key === 'compression')!;
  const guard = L.levers.find((l) => l.key === 'rebuild-guard')!;
  const rng = (lo: number, hi: number) => `${cur}${lo} to ${cur}${hi}`;
  const onSpend = (lo: number, hi: number) => `${money(S.total * lo / 1000, o.eurRate)} to ${money(S.total * hi / 1000, o.eurRate)}`;
  out.push(`  ${padR(c.bold('promptreduce today'), 22)}${c.boldGreen(padR(`saves ${rng(comp.lo, comp.hi)}`, 22))} ${c.gray(`per ${cur}1,000, about ${onSpend(comp.lo, comp.hi)} this period`)}`);
  out.push(`  ${padR(c.bold('With the next levers'), 22)}${c.boldYellow(padR(`saves ${rng(L.stack.lo, L.stack.hi)}`, 22))} ${c.gray(`per ${cur}1,000, about ${onSpend(L.stack.lo, L.stack.hi)} this period`)}`);
  out.push(`  ${padR(c.bold('Biggest lever'), 22)}${c.magenta('Cache rebuild guard')} ${c.gray(`${rng(guard.lo, guard.hi)} per ${cur}1,000 (${n(f.rebuilds.count)} rebuilds)`)}`);
  out.push('');
  if (o.htmlPath) out.push(`  ${c.bold('Full report')}  ${c.cyan(o.htmlPath)}${o.opened ? c.gray('  (opened in your browser)') : ''}`);
  out.push(`  ${c.gray('In the terminal:')} ${c.cyan('promptreduce analyze --full')}   ${c.gray('Wire it up:')} ${c.cyan('promptreduce setup --all')}`);
  return out.map((l) => truncateLine(l, width)).join('\n');
}

function truncateLine(line: string, width: number): string {
  if (vlen(line) <= width) return line;
  // Drop gray trailing detail first by cutting visible characters; keep ANSI resets intact.
  let visible = 0; let outStr = ''; let i = 0;
  while (i < line.length && visible < width - 1) {
    const m = line.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (m) { outStr += m[0]; i += m[0].length; continue; }
    outStr += line[i]; visible++; i++;
  }
  return outStr + '…' + (line.includes('\x1b') ? '\x1b[0m' : '');
}

export function renderFull(f: ScanFacts, o: TermOptions = {}): string {
  const c = palette(o.color ?? detectColor());
  if (!f.calls) return renderGist(f, o);
  const L = estimateLevers(f); const S = L.shape; const T = S.total || 1; const cur = unit(o.eurRate);
  const width = Math.min(o.width ?? process.stdout.columns ?? 100, 120);
  const barW = Math.max(10, Math.min(24, width - 70));
  const out: string[] = [...header(f, c, width)];
  const models = Object.entries(f.callsByModel).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, k]) => `${m || 'unknown'} ${pct(k / f.calls)}`);
  out.push(...wrap(`models: ${models.join(', ')}`, width, '  ').map(c.gray));
  const unknownIds = Object.entries(S.byModel).filter(([, m]) => !m.known).map(([id]) => id);
  if (unknownIds.length) out.push(...wrap(`priced as Opus 5.5 (not in the price table): ${unknownIds.join(', ')}`, width, '  ').map(c.gray));
  const section = (title: string, sub = '') => { out.push(''); out.push(`${c.boldCyan(title.toUpperCase())}${sub ? '  ' + c.gray(sub) : ''}`); };

  section('Where the money goes', `list prices, ${o.eurRate ? `EUR at ${o.eurRate} per USD` : 'USD'}`);
  for (const [label, v, note] of shapeRows(f, L)) {
    const line = `  ${bar(v / T, barW, c)}  ${padR(label, 16)}${padL(pct(v / T), 5)}  ${padL(money(v, o.eurRate), 9)}   `;
    const rest = width - vlen(line);
    out.push(line + c.gray(note.length > rest ? note.slice(0, Math.max(0, rest - 1)) + '…' : note));
  }
  out.push(`  ${' '.repeat(barW)}  ${padR(c.bold('Total'), 16)}${padL('', 5)}  ${c.bold(padL(money(S.total, o.eurRate), 9))}`);

  section('Your context');
  const facts: [string, string, string][] = [
    ['Average request', `${fmtK(f.avgContext)} tokens`, ''],
    ['Session prefix', `${fmtK(L.inputs.prefix)} tokens`, `system prompt and tool definitions on a cold start, ${pct(L.inputs.prefix / (f.avgContext || 1))} of a request; ${f.mcpServers.global + f.mcpServers.perProject} MCP servers`],
    ['Tool results', pct(L.inputs.trShare), 'of message tokens'],
    ['Long tail', pct(f.toolResults.tokens ? f.toolResults.over1k.tokens / f.toolResults.tokens : 0), `of tool-result tokens are in the ${pct(f.toolResults.n ? f.toolResults.over1k.n / f.toolResults.n : 0)} of results over 1,000 tokens`],
    ['Idle gaps over 1h', n(f.idleGapsOver1h), 'each one lets the cache expire'],
  ];
  for (const [k, v, note] of facts) {
    const head = `  ${padR(k, 20)}${c.bold(padL(v, 12))}   `;
    const lines = note ? wrap(note, width, ' '.repeat(vlen(head))) : [];
    out.push(head + (lines[0] ? c.gray(lines[0].trimStart()) : ''));
    for (const l of lines.slice(1)) out.push(c.gray(l));
  }

  section('What promptreduce removes now', `compressor run on ${n(f.compression.sampled)} of your tool results`);
  out.push(`  ${padR('Level 1, structural', 22)}${c.boldGreen(padL(pct(L.inputs.removalL1), 5))}   ${padR('Level 2, aggressive', 22)}${c.boldGreen(padL(pct(L.inputs.removalL2), 5))}   ${padR('Dedupe', 8)}${c.boldGreen(padL(pct(L.inputs.dupShare), 5))}`);
  out.push('');
  const nameW = Math.max(16, Math.min(34, width - 50));
  out.push(c.gray(`  ${padR('Tool', nameW)}${padL('Level 1', 9)}${padL('Level 2', 9)}${padL('Tokens', 13)}${padL('Results', 9)}`));
  const byTool = Object.entries(f.compression.byTool).filter(([, t]) => t.before >= 2000).sort((a, b) => b[1].before - a[1].before).slice(0, 10);
  for (const [tool, t] of byTool) {
    const name = tool.length > nameW - 1 ? tool.slice(0, nameW - 2) + '…' : tool;
    const l1 = 1 - t.l1 / t.before, l2 = 1 - t.l2 / t.before;
    const col = (x: number) => (x >= 0.2 ? c.green : x >= 0.05 ? c.yellow : c.gray)(padL(pct(x), 9));
    out.push(`  ${padR(name, nameW)}${col(l1)}${col(l2)}${padL(n(t.before), 13)}${padL(n(t.n), 9)}`);
  }

  section(`Savings per ${cur}1,000 spent`);
  const tag = (s: string) => (s === 'built' ? c.boldGreen : s === 'next' ? c.boldYellow : c.gray)(padR(s.toUpperCase(), 7));
  const leverNameW = 30;
  for (const l of L.levers) {
    const range = l.lo === l.hi ? `${cur}${l.lo}` : `${cur}${l.lo} to ${cur}${l.hi}`;
    const src = l.source === 'measured here' ? c.green(l.source) : l.source === 'estimate' ? c.gray(l.source) : c.blue(l.source);
    out.push(`  ${tag(l.status)}${c.bold(padR(l.name, leverNameW))}${c.boldGreen(padL(range, 16))}   ${src}`);
    for (const line of wrap(l.basis, width, ' '.repeat(9))) out.push(c.dim(line));
  }
  out.push('');
  out.push(...wrap(`Stack of ${L.stack.members.join(', ')}, multiplied: ${cur}${L.stack.lo} to ${cur}${L.stack.hi} per ${cur}1,000, about ${money(S.total * L.stack.lo / 1000, o.eurRate)} to ${money(S.total * L.stack.hi / 1000, o.eurRate)} on this period's spend.`, width, '  ').map(c.bold));
  out.push('');
  out.push(...wrap('List prices for the models seen. On a subscription the same savings are rate-limit headroom. Token counts are local estimates; effort figures come from Anthropic\'s published runs.', width, '  ').map(c.gray));
  if (o.htmlPath) { out.push(''); out.push(`  ${c.bold('HTML report')}  ${c.cyan(o.htmlPath)}`); }
  return out.join('\n');
}
