import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { compress, estimateTokens, kindForTool, type Kind } from '../compress/index.ts';
import { emptyUsage, addUsage, usageFromApi, type UsageTotals } from './pricing.ts';

export interface ScanOptions {
  projectsDir?: string;
  /** Only transcripts modified in the last N days; 0 means all. */
  days?: number;
  /** Largest N transcripts by size. */
  maxFiles?: number;
  /** Tool results to run through the compressor (reservoir sampled, deterministic). */
  sampleResults?: number;
  seed?: number;
}

export interface ToolStat { n: number; tokens: number }
export interface CompStat { n: number; before: number; l1: number; l2: number }

export interface ScanFacts {
  projectsDir: string;
  files: number;
  days: number;
  sessions: number;
  calls: number;
  firstTs?: string;
  lastTs?: string;
  callsByModel: Record<string, number>;
  usageByModel: Record<string, UsageTotals>;
  usage: UsageTotals;
  rebuilds: { count: number; tokens: number; afterIdle: number; afterIdleTokens: number };
  appendTokens: number;
  idleGapsOver1h: number;
  prefixSamples: number[];
  avgContext: number;
  content: { toolResult: number; toolUse: number; userPrompt: number; assistantText: number; injected: number };
  toolResults: { n: number; tokens: number; byTool: Record<string, ToolStat>; over1k: ToolStat };
  dedupe: { repeats: number; tokens: number };
  compression: { sampled: number; before: number; l1: number; l2: number; byTool: Record<string, CompStat> };
  mcpServers: { global: number; perProject: number };
}

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((x: any) => x && x.type === 'text' && typeof x.text === 'string').map((x: any) => x.text).join('\n');
  return '';
}

export function listTranscripts(projectsDir: string, days: number, maxFiles: number): string[] {
  if (!existsSync(projectsDir)) return [];
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const files: { path: string; size: number }[] = [];
  for (const proj of readdirSync(projectsDir)) {
    const d = join(projectsDir, proj);
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(d, f);
      try { const st = statSync(p); if (st.mtimeMs >= cutoff && st.size > 0) files.push({ path: p, size: st.size }); } catch { /* skip */ }
    }
  }
  files.sort((a, b) => b.size - a.size);
  return files.slice(0, maxFiles).map((f) => f.path);
}

export function countMcpServers(): { global: number; perProject: number } {
  try {
    const cj = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    const global = Object.keys(cj.mcpServers ?? {}).length;
    let perProject = 0;
    for (const v of Object.values(cj.projects ?? {}) as any[]) perProject += Object.keys((v && v.mcpServers) || {}).length;
    return { global, perProject };
  } catch { return { global: 0, perProject: 0 }; }
}

export function scanTranscripts(opts: ScanOptions = {}): ScanFacts {
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects');
  const files = listTranscripts(projectsDir, opts.days ?? 30, opts.maxFiles ?? 300);
  const sampleMax = opts.sampleResults ?? 3000;
  const rand = mulberry32(opts.seed ?? 7);

  const f: ScanFacts = {
    projectsDir, files: files.length, days: opts.days ?? 30, sessions: 0, calls: 0, callsByModel: {}, usageByModel: {}, usage: emptyUsage(),
    rebuilds: { count: 0, tokens: 0, afterIdle: 0, afterIdleTokens: 0 }, appendTokens: 0, idleGapsOver1h: 0,
    prefixSamples: [], avgContext: 0,
    content: { toolResult: 0, toolUse: 0, userPrompt: 0, assistantText: 0, injected: 0 },
    toolResults: { n: 0, tokens: 0, byTool: {}, over1k: { n: 0, tokens: 0 } },
    dedupe: { repeats: 0, tokens: 0 },
    compression: { sampled: 0, before: 0, l1: 0, l2: 0, byTool: {} },
    mcpServers: countMcpServers(),
  };
  let ctxSum = 0;
  type Sample = { tool: string; kind: Kind; text: string; isError: boolean };
  const reservoir: Sample[] = [];
  let seenForSample = 0;

  for (const path of files) {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    f.sessions++;
    const calls = new Map<string, { usage: UsageTotals; ts: number; model: string }>();
    const toolUses = new Map<string, { name: string; input?: Record<string, unknown> }>();
    const seenHashes = new Set<string>();

    for (const line of text.split('\n')) {
      if (!line) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      const m = d?.message; const c = m?.content; const type = d?.type;
      if (type === 'assistant') {
        if (m?.usage && typeof m.usage === 'object' && !String(m.model ?? '').startsWith('<')) {
          const id = String(m.id ?? `${path}:${calls.size}`);
          const prev = calls.get(id);
          const ts = Date.parse(d.timestamp ?? '') || (prev?.ts ?? 0);
          // The usage object repeats on every content-block line of one response; keep the last one (output grows).
          calls.set(id, { usage: usageFromApi(m.usage), ts: prev?.ts || ts, model: String(m.model ?? '') });
        }
        if (Array.isArray(c)) {
          for (const b of c) {
            if (!b || typeof b !== 'object') continue;
            if (b.type === 'tool_use') {
              if (typeof b.id === 'string') toolUses.set(b.id, { name: String(b.name ?? ''), input: b.input });
              f.content.toolUse += estimateTokens(JSON.stringify(b.input ?? {}));
            } else if (b.type === 'text') f.content.assistantText += estimateTokens(String(b.text ?? ''));
          }
        }
      } else if (type === 'user') {
        if (typeof c === 'string') f.content.userPrompt += estimateTokens(c);
        else if (Array.isArray(c)) {
          for (const b of c) {
            if (!b || typeof b !== 'object') continue;
            if (b.type === 'tool_result') {
              const t = resultText(b.content);
              if (!t) continue;
              const tokens = estimateTokens(t);
              const use = toolUses.get(String(b.tool_use_id));
              const tool = use?.name ?? 'unknown';
              f.content.toolResult += tokens;
              f.toolResults.n++; f.toolResults.tokens += tokens;
              const ts = (f.toolResults.byTool[tool] ??= { n: 0, tokens: 0 }); ts.n++; ts.tokens += tokens;
              if (tokens >= 1000) { f.toolResults.over1k.n++; f.toolResults.over1k.tokens += tokens; }
              if (t.length >= 500 && b.is_error !== true) {
                const h = new Bun.CryptoHasher('sha256').update(t).digest('hex');
                if (seenHashes.has(h)) { f.dedupe.repeats++; f.dedupe.tokens += tokens; }
                else seenHashes.add(h);
              }
              if (t.length >= 200) {
                seenForSample++;
                const s: Sample = { tool, kind: kindForTool(use?.name, use?.input), text: t, isError: b.is_error === true };
                if (reservoir.length < sampleMax) reservoir.push(s);
                else { const j = Math.floor(rand() * seenForSample); if (j < sampleMax) reservoir[j] = s; }
              }
            } else if (b.type === 'text') {
              const t = String(b.text ?? '');
              if (t.startsWith('<')) f.content.injected += estimateTokens(t); else f.content.userPrompt += estimateTokens(t);
            }
          }
        }
      }
    }

    // Per-call analysis in transcript order.
    let prevTs = 0; let first = true;
    for (const call of calls.values()) {
      f.calls++;
      f.callsByModel[call.model] = (f.callsByModel[call.model] ?? 0) + 1;
      addUsage((f.usageByModel[call.model] ??= emptyUsage()), call.usage);
      addUsage(f.usage, call.usage);
      const u = call.usage;
      const cc = u.cacheWrite5m + u.cacheWrite1h + u.cacheWriteUnknown;
      const ctx = u.input + u.cacheRead + cc;
      ctxSum += ctx;
      if (first) { if (u.cacheRead === 0 && cc > 0) f.prefixSamples.push(cc + u.input); first = false; }
      const idle = prevTs && call.ts && call.ts - prevTs > 3_600_000;
      if (idle) f.idleGapsOver1h++;
      if (cc > 0 && ctx > 0) {
        if (cc >= 0.5 * ctx) { f.rebuilds.count++; f.rebuilds.tokens += cc; if (idle) { f.rebuilds.afterIdle++; f.rebuilds.afterIdleTokens += cc; } }
        else f.appendTokens += cc;
      }
      if (call.ts) prevTs = call.ts;
      const iso = call.ts ? new Date(call.ts).toISOString() : undefined;
      if (iso) { if (!f.firstTs || iso < f.firstTs) f.firstTs = iso; if (!f.lastTs || iso > f.lastTs) f.lastTs = iso; }
    }
  }
  f.avgContext = f.calls ? Math.round(ctxSum / f.calls) : 0;

  for (const s of reservoir) {
    const r1 = compress(s.text, { kind: s.kind, level: 1, isError: s.isError, archive: () => '<archive>' });
    const r2 = compress(s.text, { kind: s.kind, level: 2, isError: s.isError, archive: () => '<archive>' });
    f.compression.sampled++; f.compression.before += r1.before.tokens; f.compression.l1 += r1.after.tokens; f.compression.l2 += r2.after.tokens;
    const t = (f.compression.byTool[s.tool] ??= { n: 0, before: 0, l1: 0, l2: 0 });
    t.n++; t.before += r1.before.tokens; t.l1 += r1.after.tokens; t.l2 += r2.after.tokens;
  }
  return f;
}
