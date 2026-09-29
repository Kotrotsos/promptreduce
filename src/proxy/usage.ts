export interface Usage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

const EMPTY: Usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };

function merge(into: Usage, u: Partial<Usage> | undefined) {
  if (!u) return;
  for (const k of Object.keys(EMPTY) as (keyof Usage)[]) {
    const v = u[k];
    if (typeof v === 'number') into[k] = k === 'output_tokens' ? Math.max(into[k], v) : v;
  }
}

/** Pulls usage out of a complete non-streaming response body. */
export function usageFromJson(text: string): Usage | undefined {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && j.usage) { const u = { ...EMPTY }; merge(u, j.usage); return u; }
  } catch { /* not JSON */ }
  return undefined;
}

/**
 * Passes an SSE stream through untouched while reading usage from the
 * message_start and message_delta events. Calls onDone once at the end.
 */
export function teeSseUsage(body: ReadableStream<Uint8Array>, onDone: (u: Usage | undefined) => void): ReadableStream<Uint8Array> {
  const usage: Usage = { ...EMPTY };
  let seen = false;
  let pending = '';
  const decoder = new TextDecoder();
  const scan = (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === 'message_start' && ev.message?.usage) { merge(usage, ev.message.usage); seen = true; }
        else if (ev.type === 'message_delta' && ev.usage) { merge(usage, ev.usage); seen = true; }
      } catch { /* partial or non-JSON data line */ }
    }
    if (pending.length > 1_000_000) pending = pending.slice(-100_000);
  };
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try { scan(decoder.decode(chunk, { stream: true })); } catch { /* never break the stream over stats */ }
    },
    flush() {
      try { scan(decoder.decode()); } catch { /* ignore */ }
      onDone(seen ? usage : undefined);
    },
  });
  return body.pipeThrough(ts);
}

/** Buffers a non-streaming JSON response just enough to read usage, then passes it on. */
export function teeJsonUsage(body: ReadableStream<Uint8Array>, onDone: (u: Usage | undefined) => void): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (size < 8_000_000) { chunks.push(chunk); size += chunk.byteLength; }
    },
    flush() {
      try { onDone(usageFromJson(new TextDecoder().decode(Buffer.concat(chunks)))); } catch { onDone(undefined); }
    },
  });
  return body.pipeThrough(ts);
}
