import pageImport from './page.html' with { type: 'text' };
// bun-types declares *.html as an HTMLBundle; with { type: 'text' } the runtime hands us the file's text.
const page = pageImport as unknown as string;
import { loadConfig, paths, type Config } from '../proxy/config.ts';
import { compress, estimateTokens, type Kind, type Level } from '../compress/index.ts';
import { readAggregate } from '../proxy/stats.ts';
import { loadCorpus, type Sample } from './corpus.ts';
import { exactCount } from './count.ts';

const KINDS: Kind[] = ['bash', 'read', 'grep', 'json', 'prose', 'generic'];
const asLevel = (v: unknown): Level => (v === 0 || v === '0' ? 0 : v === 2 || v === '2' ? 2 : 1);
const asKind = (v: unknown): Kind => (KINDS.includes(v as Kind) ? (v as Kind) : 'generic');

export function startEval(cfg: Config = loadConfig()) {
  const p = paths(cfg);
  const proxyBase = `http://localhost:${cfg.port}`;
  let corpus = loadCorpus(p.corpus);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const countRoute = async (texts: string[], model?: string) => {
    let proxyCounts = false;
    try { const h = await fetch(`${proxyBase}/__promptreduce/health`); proxyCounts = h.ok; } catch { /* proxy down */ }
    return exactCount(texts, { apiKey, proxyBase: proxyCounts ? proxyBase : undefined, upstream: cfg.upstream, model });
  };

  const server = Bun.serve({
    port: cfg.evalPort,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (path === '/' || path === '/index.html') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });

        if (path === '/api/health') {
          let proxy: unknown = null;
          try { const r = await fetch(`${proxyBase}/__promptreduce/health`); proxy = r.ok ? await r.json() : null; } catch { proxy = null; }
          return Response.json({ ok: true, corpus: corpus.length, corpusDir: p.corpus, proxy, proxyBase, level: cfg.level, exactCounts: Boolean(apiKey) || Boolean(proxy && cfg.countViaProxy) });
        }

        if (path === '/api/corpus' && req.method === 'GET') {
          corpus = loadCorpus(p.corpus);
          return Response.json(corpus.map((s) => ({ id: s.id, tool: s.tool, kind: s.kind, chars: s.text.length, tokens: estimateTokens(s.text), source: s.source, isError: s.isError ?? false, preview: (s.input?.command ?? s.input?.file_path ?? s.input?.pattern ?? s.input?.query ?? s.input?.url ?? '') as string })));
        }
        const one = path !== '/api/corpus/run' ? path.match(/^\/api\/corpus\/([\w-]+)$/) : null;
        if (one) {
          const s = corpus.find((x) => x.id === one[1]);
          return s ? Response.json(s) : Response.json({ error: 'not found' }, { status: 404 });
        }

        if (path === '/api/compress' && req.method === 'POST') {
          const j = (await req.json()) as { text: string; kind?: string; level?: unknown; exact?: boolean; isError?: boolean; model?: string };
          const result = compress(String(j.text ?? ''), { kind: asKind(j.kind), level: asLevel(j.level), isError: j.isError, archive: () => '<archive path>' });
          let exact: unknown = null; let exactError: string | null = null;
          if (j.exact) {
            try { const c = await countRoute([j.text, result.text], j.model); exact = { before: c.counts[0], after: c.counts[1], source: c.source, model: c.model }; }
            catch (e) { exactError = (e as Error).message; }
          }
          return Response.json({ result, exact, exactError });
        }

        if (path === '/api/corpus/run' && req.method === 'POST') {
          const j = (await req.json().catch(() => ({}))) as { level?: unknown };
          const level = asLevel(j.level);
          corpus = loadCorpus(p.corpus);
          const byKind: Record<string, { n: number; changed: number; before: number; after: number }> = {};
          const byTool: Record<string, { n: number; changed: number; before: number; after: number }> = {};
          const transforms: Record<string, number> = {};
          const samples = corpus.map((s: Sample) => {
            const r = compress(s.text, { kind: s.kind, level, isError: s.isError, archive: () => '<archive path>' });
            for (const t of r.transforms) { const name = t.replace(/\(.*\)$/, ''); transforms[name] = (transforms[name] ?? 0) + 1; }
            for (const [table, key] of [[byKind, s.kind], [byTool, s.tool]] as const) {
              const e = (table[key] ??= { n: 0, changed: 0, before: 0, after: 0 });
              e.n++; if (r.changed) e.changed++; e.before += r.before.tokens; e.after += r.after.tokens;
            }
            return { id: s.id, tool: s.tool, kind: s.kind, before: r.before.tokens, after: r.after.tokens, saved: r.before.tokens - r.after.tokens, transforms: r.transforms };
          });
          const before = samples.reduce((a, s) => a + s.before, 0);
          const after = samples.reduce((a, s) => a + s.after, 0);
          samples.sort((a, b) => b.saved - a.saved);
          return Response.json({ level, n: samples.length, before, after, byKind, byTool, transforms, top: samples.slice(0, 40) });
        }

        if (path === '/api/stats') {
          const file = readAggregate(p.stats);
          let live: unknown = null;
          try { const r = await fetch(`${proxyBase}/__promptreduce/stats`); live = r.ok ? await r.json() : null; } catch { live = null; }
          return Response.json({ file, live, statsFile: p.stats });
        }

        if (path === '/api/count' && req.method === 'POST') {
          const j = (await req.json()) as { texts: string[]; model?: string };
          try { return Response.json(await countRoute(j.texts, j.model)); }
          catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
        }

        return new Response('not found', { status: 404 });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    },
  });
  console.log(`promptreduce eval on http://localhost:${server.port} (corpus: ${corpus.length} samples from ${p.corpus})`);
  return server;
}

if (import.meta.main) startEval();
