import { describe, expect, test } from 'bun:test';
import { compress, estimateTokens, kindForTool } from '../src/compress/index.ts';

const big = Array.from({ length: 500 }, (_, i) => `[12:00:${String(i % 60).padStart(2, '0')}] worker ${i} processed item`).join('\n');

describe('compress', () => {
  test('is deterministic', () => {
    const a = compress(big, { kind: 'bash' });
    const b = compress(big, { kind: 'bash' });
    expect(a.text).toBe(b.text);
    expect(a.transforms).toEqual(b.transforms);
  });
  test('never touches read results', () => {
    const r = compress(big, { kind: 'read' });
    expect(r.changed).toBe(false);
    expect(r.text).toBe(big);
  });
  test('never touches error results', () => {
    const r = compress(big, { kind: 'bash', isError: true });
    expect(r.changed).toBe(false);
  });
  test('level 0 never truncates', () => {
    const r = compress(big, { kind: 'bash', level: 0 });
    expect(r.text.split('\n').length).toBe(500);
  });
  test('level 1 truncates bash with an archive pointer', () => {
    let archived: string | undefined;
    const r = compress(big, { kind: 'bash', level: 1, archive: (t) => { archived = t; return '/arc/abc.txt'; } });
    expect(archived).toBe(big);
    expect(r.text).toContain('Full output: /arc/abc.txt');
    expect(r.after.tokens).toBeLessThan(r.before.tokens);
    expect(r.transforms.some((t) => t.startsWith('truncate('))).toBe(true);
  });
  test('small inputs pass through', () => {
    const r = compress('a\nb\n\n\n\nc', { kind: 'bash' });
    expect(r.changed).toBe(false);
  });
  test('never grows the output', () => {
    const s = 'x'.repeat(200);
    expect(compress(s, { kind: 'bash' }).text).toBe(s);
  });
  test('json kind tabulates MCP results', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, subject: `Mail ${i}`, from: 'a@b.c', unread: false, labels: [] }));
    const r = compress(JSON.stringify(rows, null, 2), { kind: 'json' });
    expect(r.transforms).toContain('json-table');
    expect(r.text.startsWith('[table: 20 rows')).toBe(true);
  });
});

describe('helpers', () => {
  test('kindForTool maps common tools', () => {
    expect(kindForTool('Bash')).toBe('bash');
    expect(kindForTool('Read')).toBe('read');
    expect(kindForTool('Grep')).toBe('grep');
    expect(kindForTool('WebFetch')).toBe('prose');
    expect(kindForTool('mcp__claude_ai_Gmail__search_threads')).toBe('json');
    expect(kindForTool('mcp__x__list_items')).toBe('json');
    expect(kindForTool(undefined, { command: 'ls' })).toBe('bash');
    expect(kindForTool('Whatever')).toBe('generic');
  });
  test('estimateTokens is monotone-ish and positive', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens(big)).toBeGreaterThan(estimateTokens(big.slice(0, 1000)));
  });
});
