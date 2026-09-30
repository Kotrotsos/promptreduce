/** Self-contained HTML report for analyze. Light mode, print-friendly, no external requests except an optional web font. */
import type { ScanFacts } from './scan.ts';
import { estimateLevers, pct, fmtK } from './levers.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const n = (x: number) => Math.round(x).toLocaleString('en-US');

export function renderHtml(f: ScanFacts, opts: { eurRate?: number; generatedAt?: Date } = {}): string {
  const L = estimateLevers(f); const S = L.shape; const T = S.total || 1;
  const rate = opts.eurRate; const cur = rate ? '€' : '$';
  const money = (usd: number) => `${cur}${Math.round(usd * (rate ?? 1)).toLocaleString('en-US')}`;
  const when = (opts.generatedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ');
  const span = f.firstTs && f.lastTs ? `${f.firstTs.slice(0, 10)} to ${f.lastTs.slice(0, 10)}` : '';
  const comp = L.levers.find((l) => l.key === 'compression')!;

  const shape: [string, number, string][] = ([
    ['Cache reads', S.cacheRead, 'Context re-read on every turn'],
    ['Cache rebuilds', S.rebuild, `${n(f.rebuilds.count)} rebuilds, ${n(f.rebuilds.afterIdle)} right after an idle gap over an hour`],
    ['Cache appends', S.append, 'New content written to the cache once'],
    ['Thinking', S.thinking, 'Reasoning tokens, never shown'],
    ['Visible output', S.visible, 'Text you read and files it writes'],
    ['Fresh input', S.input, 'Uncached tokens'],
  ] as [string, number, string][]).sort((a, b) => b[1] - a[1]);
  const maxShare = Math.max(...shape.map((r) => r[1] / T), 0.01);

  const tools = Object.entries(f.compression.byTool).filter(([, t]) => t.before >= 2000).sort((a, b) => b[1].before - a[1].before).slice(0, 12);
  const unknownIds = Object.entries(S.byModel).filter(([, m]) => !m.known).map(([id]) => id);
  const models = Object.entries(f.callsByModel).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const leverRows = L.levers.map((l) => `
      <tr>
        <td><span class="tag ${l.status}">${l.status}</span></td>
        <td class="lever">${esc(l.name)}<div class="basis">${esc(l.basis)}</div></td>
        <td class="n money">${l.lo === l.hi ? `${cur}${l.lo}` : `${cur}${l.lo} to ${cur}${l.hi}`}</td>
        <td class="src ${l.source === 'measured here' ? 'measured' : l.source === 'estimate' ? 'estimate' : 'anthropic'}">${esc(l.source)}</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>promptreduce analysis</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
  :root {
    --bg: #f7f8f7; --surface: #ffffff; --ink: #16211d; --muted: #5c6b66; --line: #dfe5e2;
    --accent: #0e6b5c; --accent-soft: #e2f0ec; --accent-ink: #0a4d43;
    --warn: #9a6a00; --warn-soft: #fbf1d9; --info: #2c5d8f; --info-soft: #e5eef7;
    --sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 15px; line-height: 1.5; padding-inline: 20px; padding-block: 32px 56px; }
  .wrap { max-width: 1040px; margin: 0 auto; display: grid; gap: 28px; }
  h1 { font-size: 1.9rem; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 1.15rem; margin: 0 0 12px; }
  .meta { color: var(--muted); font-size: 0.9rem; margin-top: 4px; }
  .eyebrow { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--accent); }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 20px 22px; min-width: 0; }
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .tile { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
  .tile .k { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .tile .v { font-size: 1.8rem; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .tile .d { font-size: 0.86rem; color: var(--muted); margin-top: 4px; }
  .tile.good { border-color: var(--accent); background: var(--accent-soft); }
  .tile.good .v { color: var(--accent-ink); }
  .tile.next { border-color: #e6cf94; background: var(--warn-soft); }
  .tile.next .v { color: var(--warn); }
  .bars { display: grid; gap: 10px; }
  .bar { display: grid; grid-template-columns: 150px minmax(0, 1fr) 56px 90px; gap: 12px; align-items: center; }
  .bar .label { font-weight: 500; }
  .bar .label small { display: block; color: var(--muted); font-weight: 400; font-size: 0.8rem; }
  .bar .track { height: 14px; background: var(--accent-soft); border-radius: 4px; overflow: hidden; }
  .bar .fill { height: 100%; background: var(--accent); border-radius: 4px; }
  .bar .pct { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar .amt { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; }
  .fact .v { font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .fact .k { font-size: 0.86rem; color: var(--muted); }
  .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  th { font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.mono { font-family: var(--mono); font-size: 0.84rem; word-break: break-all; }
  .hi { color: var(--accent-ink); font-weight: 600; }
  .mid { color: var(--warn); font-weight: 600; }
  .lo { color: var(--muted); }
  .tag { display: inline-block; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; }
  .tag.built { background: var(--accent-soft); color: var(--accent-ink); }
  .tag.next { background: var(--warn-soft); color: var(--warn); }
  .tag.later { background: #eef0ee; color: var(--muted); }
  .lever { font-weight: 600; }
  .basis { font-weight: 400; color: var(--muted); font-size: 0.85rem; margin-top: 3px; max-width: 62ch; }
  .money { font-weight: 700; color: var(--accent-ink); }
  .src { font-size: 0.82rem; white-space: nowrap; }
  .src.measured { color: var(--accent-ink); }
  .src.anthropic { color: var(--info); }
  .src.estimate { color: var(--muted); }
  .levels { display: flex; gap: 22px; flex-wrap: wrap; margin-bottom: 14px; }
  .levels div { font-size: 0.9rem; color: var(--muted); }
  .levels b { font-size: 1.35rem; color: var(--accent-ink); display: block; font-variant-numeric: tabular-nums; }
  .stack { background: var(--accent-soft); border-radius: 10px; padding: 16px 20px; color: var(--accent-ink); }
  .stack b { font-size: 1.1rem; }
  .note { font-size: 0.84rem; color: var(--muted); }
  code { font-family: var(--mono); font-size: 0.86em; background: var(--accent-soft); color: var(--accent-ink); padding: 1px 5px; border-radius: 4px; }
  @media (max-width: 760px) { .tiles, .grid2 { grid-template-columns: 1fr; } .bar { grid-template-columns: 1fr 50px 80px; } .bar .track { grid-column: 1 / -1; order: 4; } }
  @media print { body { background: #fff; padding: 0; } .card, .tile { break-inside: avoid; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">promptreduce analysis</div>
    <h1>Where your Claude spend goes, and what you could keep</h1>
    <div class="meta">${n(f.sessions)} transcripts · ${n(f.calls)} model calls · ${f.days ? `last ${f.days} days` : 'all transcripts'} · ${esc(span)} · generated ${esc(when)}</div>
  </header>

  <section class="tiles">
    <div class="tile"><div class="k">Spend in this period</div><div class="v">${money(S.total)}</div><div class="d">at list prices for the models used</div></div>
    <div class="tile good"><div class="k">promptreduce today</div><div class="v">${cur}${comp.lo} to ${cur}${comp.hi}</div><div class="d">saved per ${cur}1,000, about ${money(S.total * comp.lo / 1000)} to ${money(S.total * comp.hi / 1000)} on this period</div></div>
    <div class="tile next"><div class="k">With the next levers</div><div class="v">${cur}${L.stack.lo} to ${cur}${L.stack.hi}</div><div class="d">saved per ${cur}1,000, about ${money(S.total * L.stack.lo / 1000)} to ${money(S.total * L.stack.hi / 1000)} on this period</div></div>
  </section>

  <section class="card">
    <h2>Where the money goes</h2>
    <div class="bars">
      ${shape.map(([label, v, note]) => `<div class="bar"><div class="label">${esc(label)}<small>${esc(note)}</small></div><div class="track"><div class="fill" style="width:${(100 * (v / T) / maxShare).toFixed(1)}%"></div></div><div class="pct">${pct(v / T)}</div><div class="amt">${money(v)}</div></div>`).join('\n      ')}
    </div>
    <p class="note">Models: ${models.map(([m, k]) => `${esc(m || 'unknown')} ${pct(k / f.calls)}`).join(', ')}.${unknownIds.length ? ` Priced as Opus 5.5 because they are not in the price table: ${unknownIds.map(esc).join(', ')}.` : ''} Bar lengths are relative to the largest category.</p>
  </section>

  <section class="card">
    <h2>Your context</h2>
    <div class="facts">
      <div class="fact"><div class="v">${fmtK(f.avgContext)}</div><div class="k">tokens in an average request</div></div>
      <div class="fact"><div class="v">${fmtK(L.inputs.prefix)}</div><div class="k">tokens of system prompt and tool definitions on a cold start, ${pct(L.inputs.prefix / (f.avgContext || 1))} of a request, ${f.mcpServers.global + f.mcpServers.perProject} MCP servers</div></div>
      <div class="fact"><div class="v">${pct(L.inputs.trShare)}</div><div class="k">of message tokens are tool results</div></div>
      <div class="fact"><div class="v">${pct(f.toolResults.tokens ? f.toolResults.over1k.tokens / f.toolResults.tokens : 0)}</div><div class="k">of tool-result tokens sit in the ${pct(f.toolResults.n ? f.toolResults.over1k.n / f.toolResults.n : 0)} of results over 1,000 tokens</div></div>
      <div class="fact"><div class="v">${n(f.idleGapsOver1h)}</div><div class="k">idle gaps over an hour, each one lets the cache expire</div></div>
    </div>
  </section>

  <section class="card">
    <h2>What promptreduce removes now</h2>
    <div class="levels">
      <div><b>${pct(L.inputs.removalL1)}</b>level 1, structural</div>
      <div><b>${pct(L.inputs.removalL2)}</b>level 2, aggressive</div>
      <div><b>${pct(L.inputs.dupShare)}</b>identical repeats, deduplicated</div>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Tool</th><th class="n">Level 1</th><th class="n">Level 2</th><th class="n">Tokens</th><th class="n">Results</th></tr></thead>
      <tbody>
      ${tools.map(([tool, t]) => { const a = 1 - t.l1 / t.before, b = 1 - t.l2 / t.before; const cls = (x: number) => (x >= 0.2 ? 'hi' : x >= 0.05 ? 'mid' : 'lo'); return `<tr><td class="mono">${esc(tool)}</td><td class="n ${cls(a)}">${pct(a)}</td><td class="n ${cls(b)}">${pct(b)}</td><td class="n">${n(t.before)}</td><td class="n">${n(t.n)}</td></tr>`; }).join('\n      ')}
      </tbody>
    </table></div>
    <p class="note">Measured by running the compressor on ${n(f.compression.sampled)} of your own tool results. File reads are never touched, so their line numbers survive later edits.</p>
  </section>

  <section class="card">
    <h2>Savings per ${cur}1,000 spent</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Status</th><th>Lever</th><th class="n">Per ${cur}1,000</th><th>Source</th></tr></thead>
      <tbody>${leverRows}
      </tbody>
    </table></div>
  </section>

  <section class="stack">
    <b>Stack: ${cur}${L.stack.lo} to ${cur}${L.stack.hi} per ${cur}1,000</b>, about ${money(S.total * L.stack.lo / 1000)} to ${money(S.total * L.stack.hi / 1000)} on this period's spend. The levers overlap, so the stack multiplies what each one leaves instead of adding: ${L.stack.members.map((k) => esc(L.levers.find((l) => l.key === k)!.name.toLowerCase())).join(', ')}.
  </section>

  <p class="note">List prices for the models seen; on a subscription the same savings are rate-limit headroom. Usage is counted once per response. Token counts in the compression table are local estimates. Effort figures come from Anthropic's published runs; rows marked estimate state their assumption. Run <code>promptreduce setup --all --dry-run</code> to see the wiring before applying it.</p>
</div>
</body>
</html>
`;
}
