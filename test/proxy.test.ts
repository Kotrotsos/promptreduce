import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy } from '../src/proxy/server.ts';
import { loadConfig } from '../src/proxy/config.ts';
import { usageFromJson } from '../src/proxy/usage.ts';

const bigOut = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
let received: { path: string; headers: Record<string, string>; body: string }[] = [];

// Fake upstream: records what it got, answers JSON or SSE depending on `stream`.
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    received.push({ path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body });
    if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 42 });
    let stream = false;
    try { stream = JSON.parse(body).stream === true; } catch { /* not json */ }
    if (!stream) {
      return Response.json({ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 2 } });
    }
    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 3, output_tokens: 1 } } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const rs = new ReadableStream({
      async start(c) { for (const e of events) { c.enqueue(new TextEncoder().encode(e)); await Bun.sleep(5); } c.close(); },
    });
    return new Response(rs, { headers: { 'content-type': 'text/event-stream' } });
  },
});

const home = mkdtempSync(join(tmpdir(), 'pr-'));
const proxy = startProxy(loadConfig({ PROMPTREDUCE_PORT: '0', PROMPTREDUCE_UPSTREAM: `http://localhost:${upstream.port}`, PROMPTREDUCE_HOME: home, PROMPTREDUCE_COUNT_VIA_PROXY: '1' }));
const base = `http://localhost:${proxy.server.port}`;

const body = (stream: boolean) => JSON.stringify({
  model: 'claude-opus-5-5', max_tokens: 16, stream,
  messages: [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigOut }] },
  ],
});

afterAll(() => { proxy.stop(); upstream.stop(true); });

describe('proxy', () => {
  test('health', async () => {
    const r = await fetch(`${base}/__promptreduce/health`);
    expect((await r.json()).ok).toBe(true);
  });
  test('compresses tool results on the way up, forwards headers, returns JSON', async () => {
    received = [];
    const r = await fetch(`${base}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: body(false) });
    expect(r.status).toBe(200);
    expect((await r.json()).usage.cache_read_input_tokens).toBe(5);
    expect(received.length).toBe(1);
    expect(received[0].path).toBe('/v1/messages?beta=true');
    expect(received[0].headers['x-api-key']).toBe('k');
    const sent = JSON.parse(received[0].body);
    expect(sent.messages[2].content[0].content).toContain('[promptreduce:');
    expect(sent.messages[2].content[0].content.length).toBeLessThan(bigOut.length);
  });
  test('streams SSE through untouched and records usage', async () => {
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(true) });
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const text = await r.text();
    expect(text).toContain('event: message_stop');
    expect(text).toContain('"text":"hi"');
    await Bun.sleep(20);
    const s = proxy.stats();
    expect(s.requests).toBe(2);
    expect(s.usage.cache_read_input_tokens).toBe(105);
    expect(s.usage.output_tokens).toBe(11);
    expect(s.tokensRemoved).toBeGreaterThan(0);
  });
  test('fails open on a non-JSON body', async () => {
    received = [];
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{not json' });
    expect(r.status).toBe(200);
    expect(received[0].body).toBe('{not json');
  });
  test('passes other endpoints through', async () => {
    const r = await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', body: '{}' });
    expect((await r.json()).input_tokens).toBe(42);
  });
  test('counts via proxy with last seen credentials', async () => {
    const r = await fetch(`${base}/__promptreduce/count`, { method: 'POST', body: JSON.stringify({ texts: ['a', 'b'] }) });
    expect((await r.json()).counts).toEqual([42, 42]);
  });
  test('usageFromJson', () => {
    expect(usageFromJson('{"usage":{"input_tokens":1}}')?.input_tokens).toBe(1);
    expect(usageFromJson('nope')).toBeUndefined();
  });
});
