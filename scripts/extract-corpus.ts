/**
 * Builds a private eval corpus from real Claude Code transcripts on this
 * machine (~/.claude/projects). Samples stay under PROMPTREDUCE_HOME and are
 * never part of the repository.
 */
import { readdirSync, readFileSync, statSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { estimateTokens, kindForTool } from '../src/compress/index.ts';
import { loadConfig, paths } from '../src/proxy/config.ts';

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const KEEP_INPUT = ['command', 'file_path', 'pattern', 'query', 'url', 'path', 'description'];

export function extractCorpus(opts: { projectsDir?: string; outDir: string; maxFiles?: number; perKindLarge?: number; perKindSmall?: number; seed?: number } ) {
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects');
  const files: { path: string; size: number }[] = [];
  if (!existsSync(projectsDir)) throw new Error(`no transcripts at ${projectsDir}`);
  for (const proj of readdirSync(projectsDir)) {
    const d = join(projectsDir, proj);
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { continue; }
    for (const f of entries) if (f.endsWith('.jsonl')) { const p = join(d, f); files.push({ path: p, size: statSync(p).size }); }
  }
  files.sort((a, b) => b.size - a.size);
  const chosen = files.slice(0, opts.maxFiles ?? 80);

  type Cand = { tool: string; kind: string; input?: Record<string, unknown>; text: string; source: string; isError?: boolean; tokens: number };
  const cands: Cand[] = [];
  for (const f of chosen) {
    const uses = new Map<string, { name: string; input?: Record<string, unknown> }>();
    let lines: string[];
    try { lines = readFileSync(f.path, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      const m = d?.message; const c = m?.content;
      if (d?.type === 'assistant' && Array.isArray(c)) {
        for (const b of c) if (b?.type === 'tool_use' && typeof b.id === 'string') uses.set(b.id, { name: String(b.name ?? ''), input: b.input });
      } else if (d?.type === 'user' && Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== 'tool_result') continue;
          const cc = b.content;
          const text = typeof cc === 'string' ? cc : Array.isArray(cc) ? cc.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n') : '';
          if (!text || text.length < 200) continue;
          const use = uses.get(String(b.tool_use_id));
          const tool = use?.name ?? 'unknown';
          const input: Record<string, unknown> = {};
          for (const k of KEEP_INPUT) { const v = use?.input?.[k]; if (typeof v === 'string') input[k] = v.slice(0, 200); }
          cands.push({ tool, kind: kindForTool(use?.name, use?.input), input, text, source: f.path.split('/').slice(-2).join('/'), isError: b.is_error === true, tokens: estimateTokens(text) });
        }
      }
    }
  }

  const rand = mulberry32(opts.seed ?? 42);
  const shuffle = <T>(xs: T[]) => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const byKind = new Map<string, Cand[]>();
  for (const c of cands) (byKind.get(c.kind) ?? byKind.set(c.kind, []).get(c.kind)!).push(c);
  const picked: Cand[] = [];
  for (const [, xs] of byKind) {
    const large = shuffle(xs.filter((c) => c.tokens >= 800)).slice(0, opts.perKindLarge ?? 60);
    const small = shuffle(xs.filter((c) => c.tokens < 800)).slice(0, opts.perKindSmall ?? 30);
    picked.push(...large, ...small);
  }

  rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(opts.outDir, { recursive: true });
  picked.sort((a, b) => b.tokens - a.tokens);
  picked.forEach((c, i) => {
    const id = `${String(i + 1).padStart(4, '0')}-${c.kind}`;
    writeFileSync(join(opts.outDir, `${id}.json`), JSON.stringify({ id, tool: c.tool, kind: c.kind, input: c.input, text: c.text, source: c.source, isError: c.isError }));
  });
  return { files: chosen.length, candidates: cands.length, written: picked.length, byKind: Object.fromEntries([...byKind].map(([k, v]) => [k, v.length])) };
}

if (import.meta.main) {
  const cfg = loadConfig();
  const r = extractCorpus({ outDir: paths(cfg).corpus });
  console.log(`scanned ${r.files} transcripts, ${r.candidates} tool results, wrote ${r.written} samples to ${paths(cfg).corpus}`);
  console.log('candidates by kind:', r.byKind);
}
