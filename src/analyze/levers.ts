import type { ScanFacts } from './scan.ts';
import { costOf, priceFor, type Cost } from './pricing.ts';

export interface CostShape {
  total: number;
  rebuild: number;
  append: number;
  cacheRead: number;
  thinking: number;
  visible: number;
  input: number;
  byModel: Record<string, Cost & { calls: number; family: string; known: boolean }>;
}

export interface Lever {
  key: string;
  name: string;
  status: 'built' | 'next' | 'later';
  /** Savings per 1,000 units of spend, low and high. */
  lo: number;
  hi: number;
  basis: string;
  source: 'measured here' | "Anthropic's runs" | 'estimate';
}

export interface Levers { shape: CostShape; levers: Lever[]; stack: { lo: number; hi: number; members: string[] }; inputs: Record<string, number> }

export function costShape(f: ScanFacts): CostShape {
  const byModel: CostShape['byModel'] = {};
  let cacheWrite = 0, cacheRead = 0, output = 0, input = 0;
  for (const [model, u] of Object.entries(f.usageByModel)) {
    const p = priceFor(model);
    const c = costOf(u, p);
    byModel[model] = { ...c, calls: f.callsByModel[model] ?? 0, family: p.family, known: p.known };
    cacheWrite += c.cacheWrite; cacheRead += c.cacheRead; output += c.output; input += c.input;
  }
  const writeTokens = f.usage.cacheWrite5m + f.usage.cacheWrite1h + f.usage.cacheWriteUnknown;
  const rebuildShare = writeTokens ? f.rebuilds.tokens / writeTokens : 0;
  const visibleTokens = f.content.assistantText + f.content.toolUse;
  const visibleShare = f.usage.output ? Math.min(1, visibleTokens / f.usage.output) : 0;
  const total = cacheWrite + cacheRead + output + input;
  return {
    total,
    rebuild: cacheWrite * rebuildShare,
    append: cacheWrite * (1 - rebuildShare),
    cacheRead,
    thinking: output * (1 - visibleShare),
    visible: output * visibleShare,
    input,
    byModel,
  };
}

const per1000 = (share: number) => Math.round(Math.max(0, share) * 1000);

export function estimateLevers(f: ScanFacts): Levers {
  const shape = costShape(f);
  const T = shape.total || 1;
  const ctxCostShare = (shape.cacheRead + shape.rebuild + shape.append) / T;

  const msgTokens = f.content.toolResult + f.content.toolUse + f.content.userPrompt + f.content.assistantText + f.content.injected;
  const trShare = msgTokens ? f.content.toolResult / msgTokens : 0.45;
  const prefix = median(f.prefixSamples);
  const msgShare = f.avgContext ? Math.min(0.95, Math.max(0.3, 1 - prefix / f.avgContext)) : 0.6;
  const removalL1 = f.compression.before ? 1 - f.compression.l1 / f.compression.before : 0;
  const removalL2 = f.compression.before ? 1 - f.compression.l2 / f.compression.before : 0;
  const dupShare = f.toolResults.tokens ? f.dedupe.tokens / f.toolResults.tokens : 0;
  const rebuildShare = shape.rebuild / T;
  const idleShareOfRebuilds = f.rebuilds.tokens ? f.rebuilds.afterIdleTokens / f.rebuilds.tokens : 0;
  const visibleShare = shape.visible / T;
  const toolsTokens = Math.max(0, prefix - 15_000);
  const toolsShare = f.avgContext ? toolsTokens / f.avgContext : 0;

  const levers: Lever[] = [
    {
      key: 'compression', name: 'Tool-result compression', status: 'built',
      lo: per1000(removalL1 * trShare * msgShare * ctxCostShare), hi: per1000(removalL2 * trShare * msgShare * ctxCostShare),
      basis: `level 1 removes ${pct(removalL1)} and level 2 ${pct(removalL2)} of your tool-result tokens; tool results are ${pct(trShare)} of message tokens and messages about ${pct(msgShare)} of context`, source: 'measured here',
    },
    {
      key: 'dedupe', name: 'Result dedupe', status: 'built',
      lo: per1000(0.5 * dupShare * trShare * msgShare * ctxCostShare), hi: per1000(dupShare * trShare * msgShare * ctxCostShare),
      basis: `${f.dedupe.repeats.toLocaleString('en-US')} results repeated an earlier identical one, ${pct(dupShare)} of tool-result tokens`, source: 'measured here',
    },
    {
      key: 'rebuild-guard', name: 'Cache rebuild guard', status: 'next',
      lo: per1000(rebuildShare * 0.4), hi: per1000(rebuildShare * 0.6),
      basis: `cache rebuilds are ${pct(rebuildShare)} of your spend (${f.rebuilds.count.toLocaleString('en-US')} events, ${pct(idleShareOfRebuilds)} of their tokens after an idle gap over an hour); assumes 40 to 60% avoidable by pinning the prefix and keeping idle caches warm`, source: 'estimate',
    },
    {
      key: 'effort-medium', name: 'Effort control, medium', status: 'next', lo: 150, hi: 300,
      basis: 'medium matched default accuracy at 70 to 85% of cost per task in Anthropic\'s runs; Claude Code defaults to xhigh', source: "Anthropic's runs",
    },
    {
      key: 'effort-low', name: 'Effort control, low', status: 'next', lo: 330, hi: 500,
      basis: 'low gave up 1 to 3 points for a third to a half off cost per task in Anthropic\'s runs; suited to exploration and subagents', source: "Anthropic's runs",
    },
    {
      key: 'verbosity', name: 'Verbosity setting', status: 'next',
      lo: per1000(visibleShare * 0.3), hi: per1000(visibleShare * 0.5),
      basis: `visible output and edits are ${pct(visibleShare)} of your spend; thinking is ${pct(shape.thinking / T)}; assumes a 30 to 50% trim of visible text`, source: 'estimate',
    },
    {
      key: 'tool-slimming', name: 'Tool-definition slimming', status: 'next',
      lo: per1000(toolsShare * 0.6 * ctxCostShare), hi: per1000(toolsShare * 0.8 * ctxCostShare),
      basis: `your session prefix (system prompt plus tool definitions) is a median ${fmtK(prefix)} tokens, ${pct(prefix / (f.avgContext || 1))} of an average request; ${f.mcpServers.global + f.mcpServers.perProject} MCP servers configured; assumes 60 to 80% of tool definitions unused`, source: 'estimate',
    },
    { key: 'eviction', name: 'Stale-result eviction', status: 'later', lo: 80, hi: 150, basis: 'sessions past a hundred turns; 30 to 50% of message tokens assumed stale, net of the rebuild it triggers', source: 'estimate' },
    {
      key: 'summarization', name: 'Long-result summarization', status: 'later',
      lo: per1000(0.5 * (f.toolResults.tokens ? f.toolResults.over1k.tokens / f.toolResults.tokens : 0.6) * 0.7 * trShare * msgShare * ctxCostShare), hi: per1000((f.toolResults.tokens ? f.toolResults.over1k.tokens / f.toolResults.tokens : 0.6) * 0.7 * trShare * msgShare * ctxCostShare),
      basis: `results over 1,000 tokens are ${pct(f.toolResults.tokens ? f.toolResults.over1k.tokens / f.toolResults.tokens : 0)} of your tool-result tokens; assumes a further 70% reduction on them, net of the small model's cost`, source: 'estimate',
    },
    { key: 'routing', name: 'Model routing for subagents', status: 'later', lo: 125, hi: 200, basis: 'Sonnet at half the Opus price on 25 to 40% delegable work; effort control comes first', source: 'estimate' },
  ];

  const members = ['compression', 'rebuild-guard', 'effort-medium', 'tool-slimming'];
  const pick = (k: string) => levers.find((l) => l.key === k)!;
  const lo = 1 - members.reduce((acc, k) => acc * (1 - pick(k).lo / 1000), 1);
  const hi = 1 - members.reduce((acc, k) => acc * (1 - pick(k).hi / 1000), 1);
  return {
    shape, levers,
    stack: { lo: per1000(lo), hi: per1000(hi), members },
    inputs: { trShare, msgShare, prefix, removalL1, removalL2, dupShare, rebuildShare, idleShareOfRebuilds, visibleShare, toolsShare, ctxCostShare },
  };
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const fmtK = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
