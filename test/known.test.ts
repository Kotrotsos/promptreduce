import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rewriteRequest } from '../src/proxy/rewrite.ts';
import { fileKnownIds, memoryKnownIds } from '../src/proxy/known.ts';

const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
const call = (id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] });
const result = (id: string, text = big) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] });

/** A conversation with tool calls a..n, one result per user turn. */
function convo(ids: string[]) {
  const messages: unknown[] = [{ role: 'user', content: 'go' }];
  for (const id of ids) messages.push(call(id), result(id));
  return { model: 'claude-opus-5-5', messages } as Record<string, unknown>;
}
const contentOf = (body: Record<string, unknown>, id: string) =>
  (body.messages as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b: any) => b.tool_use_id === id).content;

describe('mid-session safety', () => {
  test('results sent before the proxy saw them keep their bytes; the newest is compressed', () => {
    const known = memoryKnownIds();
    const body = convo(['a', 'b', 'c']);
    const r = rewriteRequest(body, { level: 1, known });
    expect(contentOf(body, 'a')).toBe(big);
    expect(contentOf(body, 'b')).toBe(big);
    expect(contentOf(body, 'c')).not.toBe(big);
    expect(r.frozen).toBe(2);
  });

  test('a result compressed once stays compressed identically on later requests', () => {
    const known = memoryKnownIds();
    const first = convo(['a', 'b']);
    rewriteRequest(first, { level: 1, known });
    const second = convo(['a', 'b', 'c']);
    rewriteRequest(second, { level: 1, known });
    expect(contentOf(second, 'a')).toBe(big);
    expect(contentOf(second, 'b')).toBe(contentOf(first, 'b'));
    // The prefix of the second request equals the whole first request.
    expect(JSON.stringify((second.messages as any[]).slice(0, 5))).toBe(JSON.stringify(first.messages));
  });

  test('known results keep the level they were first compressed at', () => {
    const known = memoryKnownIds();
    const first = convo(['a']);
    rewriteRequest(first, { level: 2, known });
    const second = convo(['a', 'b']);
    rewriteRequest(second, { level: 1, known });
    expect(contentOf(second, 'a')).toBe(contentOf(first, 'a'));
  });

  test('without a store every result is compressed (CLI behavior)', () => {
    const body = convo(['a', 'b']);
    rewriteRequest(body, { level: 1 });
    expect(contentOf(body, 'a')).not.toBe(big);
  });

  test('the file store survives a restart and drops stale entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-known-'));
    const file = join(dir, 'known-ids.tsv');
    writeFileSync(file, `old\t1\t${Date.now() - 30 * 24 * 3600 * 1000}\n`);
    const a = fileKnownIds(file);
    a.add('x', 2);
    const b = fileKnownIds(file);
    expect(b.get('x')).toBe(2);
    expect(b.get('old')).toBeUndefined();
    expect(readFileSync(file, 'utf8')).not.toContain('old');
  });
});
