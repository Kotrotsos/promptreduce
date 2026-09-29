import { describe, expect, test } from 'bun:test';
import { rewriteRequest } from '../src/proxy/rewrite.ts';

const bigOut = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');

function request() {
  return {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'run the tests' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a.ts' } },
        { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'false' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: bigOut, cache_control: { type: 'ephemeral' } },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: bigOut }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
        { type: 'tool_result', tool_use_id: 't3', content: bigOut, is_error: true },
      ] },
    ],
  } as Record<string, unknown>;
}

describe('rewriteRequest', () => {
  test('compresses bash results, preserves cache_control and ids', () => {
    const body = request();
    const report = rewriteRequest(body, { level: 1, archive: () => '/arc/x.txt' });
    const results = (body.messages as any)[2].content;
    expect(results[0].tool_use_id).toBe('t1');
    expect(results[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(results[0].content).toContain('[promptreduce:');
    expect(results[0].content).toContain('/arc/x.txt');
    expect(report.results).toBe(3);
    expect(report.rewritten).toBe(1);
    expect(report.byTool.Bash.n).toBe(2);
    expect(report.byTool.Read.n).toBe(1);
  });
  test('leaves read results, image blocks and error results untouched', () => {
    const body = request();
    rewriteRequest(body, { level: 1 });
    const results = (body.messages as any)[2].content;
    expect(results[1].content[0].text).toBe(bigOut);
    expect(results[1].content[1].type).toBe('image');
    expect(results[2].content).toBe(bigOut);
    expect(results[2].is_error).toBe(true);
  });
  test('is idempotent across requests (same bytes)', () => {
    const a = request(); const b = request();
    rewriteRequest(a, { level: 1, archive: () => '/arc/x.txt' });
    rewriteRequest(b, { level: 1, archive: () => '/arc/x.txt' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  test('adds context_management only when asked', () => {
    const a = request(); rewriteRequest(a, { level: 1 });
    expect(a.context_management).toBeUndefined();
    const b = request(); rewriteRequest(b, { level: 1, contextEdit: true });
    expect(b.context_management).toEqual({ edits: [{ type: 'clear_tool_uses_20250919' }] });
  });
  test('tolerates bodies without messages', () => {
    expect(rewriteRequest({}, { level: 1 }).results).toBe(0);
    expect(rewriteRequest({ messages: 'nope' } as any, { level: 1 }).results).toBe(0);
  });
});

describe('dedupe and context edits', () => {
  const big = 'same result '.repeat(100);
  const body = () => ({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: big }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a2', name: 'Read', input: { file_path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a2', content: [{ type: 'text', text: big }] }] },
    ],
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
  }) as Record<string, unknown>;
  test('second identical result becomes a pointer, first stays', () => {
    const b = body();
    const r = rewriteRequest(b, { level: 1 });
    const m = b.messages as any;
    expect(m[1].content[0].content).toBe(big);
    expect(m[3].content[0].content).toBe('[promptreduce: identical to the result of tool call a1 above (1200 chars); not repeated]');
    expect(r.rewritten).toBe(1);
  });
  test('dedupe can be turned off', () => {
    const b = body();
    rewriteRequest(b, { level: 1, dedupe: false });
    expect((b.messages as any)[3].content[0].content[0].text).toBe(big);
  });
  test('context edit is appended to existing edits, once', () => {
    const b = body();
    rewriteRequest(b, { level: 1, contextEdit: true });
    rewriteRequest(b, { level: 1, contextEdit: true });
    expect((b.context_management as any).edits).toEqual([{ type: 'clear_thinking_20251015', keep: 'all' }, { type: 'clear_tool_uses_20250919' }]);
  });
});
