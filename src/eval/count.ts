/**
 * Exact token counts through the API's count_tokens endpoint. Two routes:
 * an ANTHROPIC_API_KEY in the environment, or the proxy's opt-in count
 * endpoint that reuses the credentials it last forwarded.
 */
export interface CountResult { counts: number[]; source: string; model: string }

export async function exactCount(texts: string[], opts: { apiKey?: string; proxyBase?: string; upstream: string; model?: string }): Promise<CountResult> {
  const model = opts.model ?? 'claude-opus-5-5';
  if (opts.apiKey) {
    const counts: number[] = [];
    for (const t of texts) {
      const r = await fetch(`${opts.upstream}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: t || ' ' }] }),
      });
      if (!r.ok) throw new Error(`count_tokens ${r.status}: ${(await r.text()).slice(0, 200)}`);
      counts.push((await r.json()).input_tokens);
    }
    return { counts, source: 'count_tokens (api key)', model };
  }
  if (opts.proxyBase) {
    const r = await fetch(`${opts.proxyBase}/__promptreduce/count`, { method: 'POST', body: JSON.stringify({ texts, model }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `proxy count ${r.status}`);
    return { counts: j.counts, source: 'count_tokens (via proxy credentials)', model: j.model };
  }
  throw new Error('no credentials: set ANTHROPIC_API_KEY, or run the proxy with PROMPTREDUCE_COUNT_VIA_PROXY=1');
}
