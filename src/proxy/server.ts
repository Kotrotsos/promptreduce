import { loadConfig, paths, type Config } from './config.ts';
import { makeArchiver } from './archive.ts';
import { rewriteRequest, CONTEXT_EDIT_BETA, type RewriteReport } from './rewrite.ts';
import { teeSseUsage, teeJsonUsage, type Usage } from './usage.ts';
import { appendRecord, emptyAggregate, addRecord, type Aggregate } from './stats.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOP_BY_HOP = ['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'accept-encoding', 'proxy-connection', 'te', 'trailer', 'upgrade'];

export interface ProxyHandle { server: ReturnType<typeof Bun.serve>; stats: () => Aggregate; stop: () => void }

export function startProxy(cfg: Config = loadConfig()): ProxyHandle {
  const p = paths(cfg);
  const archive = makeArchiver(p.archive);
  const agg = emptyAggregate();
  let lastAuth: Record<string, string> | undefined;
  let recorded = 0;
  const log = (...a: unknown[]) => { if (cfg.verbose) console.log('[promptreduce]', ...a); };

  const isMessages = (path: string) => /\/v1\/messages\/?$/.test(path);

  async function forward(req: Request, url: URL, body: BodyInit | null, extraBeta?: string): Promise<Response> {
    const headers = new Headers(req.headers);
    for (const h of HOP_BY_HOP) headers.delete(h);
    headers.set('accept-encoding', 'identity');
    if (extraBeta) {
      const beta = headers.get('anthropic-beta');
      if (!beta) headers.set('anthropic-beta', extraBeta);
      else if (!beta.includes(extraBeta)) headers.set('anthropic-beta', `${beta},${extraBeta}`);
    }
    if (cfg.countViaProxy) {
      const auth: Record<string, string> = {};
      for (const h of ['x-api-key', 'authorization', 'anthropic-version', 'anthropic-beta']) { const v = headers.get(h); if (v) auth[h] = v; }
      if (auth['x-api-key'] || auth.authorization) lastAuth = auth;
    }
    return fetch(cfg.upstream + url.pathname + url.search, { method: req.method, headers, body, redirect: 'manual' });
  }

  function passthroughHeaders(up: Response): Headers {
    const h = new Headers(up.headers);
    h.delete('content-encoding');
    h.delete('content-length');
    h.delete('transfer-encoding');
    return h;
  }

  async function handleMessages(req: Request, url: URL): Promise<Response> {
    const started = Date.now();
    const raw = await req.text();
    let outBody = raw;
    let report: RewriteReport = { results: 0, rewritten: 0, tokensBefore: 0, tokensAfter: 0, byTool: {} };
    let model: string | undefined;
    let stream = false;
    let extraBeta: string | undefined;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      model = typeof parsed.model === 'string' ? parsed.model : undefined;
      stream = parsed.stream === true;
      report = rewriteRequest(parsed, { level: cfg.level, archive, contextEdit: cfg.contextEdit });
      if (cfg.contextEdit) extraBeta = CONTEXT_EDIT_BETA;
      outBody = JSON.stringify(parsed);
      log(`rewrite: ${report.rewritten}/${report.results} results, est ${report.tokensBefore} -> ${report.tokensAfter} tokens`);
    } catch (e) {
      // Fail open: forward exactly what we received.
      log('rewrite skipped:', (e as Error).message);
      outBody = raw;
    }

    const up = await forward(req, url, outBody, extraBeta);
    let errorBody: string | undefined;
    if (up.status >= 400) {
      try { errorBody = await up.clone().text(); } catch { errorBody = undefined; }
      console.error(`[promptreduce] upstream ${up.status} on ${url.pathname}: ${(errorBody ?? '').slice(0, 600)}`);
    }
    if (cfg.record) {
      try {
        mkdirSync(p.requests, { recursive: true });
        const name = `${new Date(started).toISOString().replace(/[:.]/g, '-')}-${++recorded}.json`;
        writeFileSync(join(p.requests, name), JSON.stringify({ ts: new Date(started).toISOString(), path: url.pathname + url.search, status: up.status, original: JSON.parse(raw), rewritten: outBody === raw ? null : JSON.parse(outBody), report, errorBody }, null, 1));
      } catch (e) { log('record failed:', (e as Error).message); }
    }
    const record = (usage: Usage | undefined) => {
      const rec = { ts: new Date(started).toISOString(), model, stream, status: up.status, ms: Date.now() - started, report, usage };
      addRecord(agg, rec);
      appendRecord(paths(cfg).stats, rec);
    };
    const headers = passthroughHeaders(up);
    if (!up.body) { record(undefined); return new Response(null, { status: up.status, headers }); }
    const ct = up.headers.get('content-type') ?? '';
    const body = ct.includes('text/event-stream') ? teeSseUsage(up.body, record) : teeJsonUsage(up.body, record);
    return new Response(body, { status: up.status, headers });
  }

  async function handleCount(req: Request): Promise<Response> {
    if (!cfg.countViaProxy) return Response.json({ error: 'count via proxy is disabled (PROMPTREDUCE_COUNT_VIA_PROXY=1)' }, { status: 403 });
    if (!lastAuth) return Response.json({ error: 'no credentials seen yet; make one request through the proxy first' }, { status: 409 });
    const { model, texts } = (await req.json()) as { model?: string; texts: string[] };
    const headers = new Headers({ 'content-type': 'application/json', ...lastAuth });
    headers.set('anthropic-version', lastAuth['anthropic-version'] ?? '2023-06-01');
    const counts: number[] = [];
    for (const t of texts) {
      const r = await fetch(`${cfg.upstream}/v1/messages/count_tokens`, {
        method: 'POST', headers,
        body: JSON.stringify({ model: model ?? 'claude-opus-5-5', messages: [{ role: 'user', content: t || ' ' }] }),
      });
      if (!r.ok) return Response.json({ error: `count_tokens ${r.status}: ${(await r.text()).slice(0, 300)}` }, { status: 502 });
      counts.push((await r.json()).input_tokens as number);
    }
    return Response.json({ counts, model: model ?? 'claude-opus-5-5' });
  }

  const server = Bun.serve({
    port: cfg.port,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === '/__promptreduce/health') return Response.json({ ok: true, upstream: cfg.upstream, level: cfg.level });
        if (url.pathname === '/__promptreduce/stats') return Response.json(agg);
        if (url.pathname === '/__promptreduce/count' && req.method === 'POST') return handleCount(req);
        if (req.method === 'POST' && isMessages(url.pathname)) return await handleMessages(req, url);
        const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
        const up = await forward(req, url, body);
        return new Response(up.body, { status: up.status, headers: passthroughHeaders(up) });
      } catch (e) {
        return Response.json({ type: 'error', error: { type: 'proxy_error', message: (e as Error).message } }, { status: 502 });
      }
    },
  });
  console.log(`promptreduce proxy on http://localhost:${server.port} -> ${cfg.upstream} (level ${cfg.level}${cfg.contextEdit ? ', context-edit' : ''}${cfg.record ? ', recording' : ''})`);
  return { server, stats: () => agg, stop: () => server.stop(true) };
}

if (import.meta.main) startProxy();
