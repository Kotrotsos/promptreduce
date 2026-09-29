import { describe, expect, test } from 'bun:test';
import { htmlToText, compactJsonDeep, truncate } from '../src/compress/layer1.ts';
import { looksLikeHtml, looksLikeJson, kindForTool } from '../src/compress/detect.ts';
import { compress } from '../src/compress/index.ts';

const email = `<html><head><style>.x{color:red}</style></head><body>
<div style="font-family:Arial"><p>Hi&nbsp;Marco,</p><p>See the <a href="https://x.example/doc">document</a>.<br>Thanks &amp; regards</p>
<table><tr><td>Q3</td><td>done</td></tr></table><img src="pixel.gif" alt=""><script>track()</script></div></body></html>`;

describe('htmlToText', () => {
  test('keeps text, links and table cells, drops styles and scripts', () => {
    const t = htmlToText(email);
    expect(t).toBe('Hi Marco,\nSee the document (https://x.example/doc).\nThanks & regards\n\nQ3 done');
    expect(t).not.toContain('track()');
    expect(t).not.toContain('color:red');
  });
  test('decodes numeric entities', () => {
    expect(htmlToText('<p>a &#8211; b &#x27;c&#x27;</p>')).toBe("a – b 'c'");
  });
});

describe('detect', () => {
  test('looksLikeHtml needs real markup density', () => {
    expect(looksLikeHtml(email)).toBe(true);
    expect(looksLikeHtml('if (a < b) return a > c ? 1 : 2; // <not html> at all, just code with angle brackets')).toBe(false);
  });
  test('looksLikeJson requires a closing bracket', () => {
    expect(looksLikeJson('{"a":1}')).toBe(true);
    expect(looksLikeJson('{not json')).toBe(false);
  });
  test('mcp tools are json even when named search', () => {
    expect(kindForTool('mcp__claude_ai_Gmail__search_threads')).toBe('json');
    expect(kindForTool('WebSearch')).toBe('prose');
  });
});

describe('compactJsonDeep', () => {
  test('converts html strings, drops empty fields, minifies', () => {
    const src = JSON.stringify({ id: 'x', subject: 'Hello', body: email, cc: [], bcc: null, meta: {} }, null, 2);
    const r = compactJsonDeep(src);
    expect(r.transforms.sort()).toEqual(['drop-empty', 'html-text', 'json-minified']);
    const j = JSON.parse(r.text);
    expect(Object.keys(j)).toEqual(['id', 'subject', 'body']);
    expect(j.body).toContain('Hi Marco,');
  });
  test('tabulates a dominant nested array and keeps the envelope', () => {
    const threads = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, snippet: `message number ${i} with some text`, unread: i % 2 === 0, labels: [] }));
    const src = JSON.stringify({ nextPageToken: 'abc', resultCountEstimate: '10', threads });
    const r = compactJsonDeep(src);
    expect(r.transforms).toContain('json-table');
    const [envelope, ...rest] = r.text.split('\n');
    expect(JSON.parse(envelope).threads).toBe('[see table below: 10 rows]');
    expect(rest[0]).toBe('[table: 10 rows]');
    expect(rest[1]).toBe('id | snippet | unread');
    expect(rest.length).toBe(12);
  });
  test('leaves non-json alone', () => {
    expect(compactJsonDeep('hello').transforms).toEqual([]);
  });
});

describe('character budgets', () => {
  test('cuts a single very long line by characters', () => {
    const one = 'x'.repeat(50_000);
    const r = truncate(one, { maxLines: 300, maxChars: 10_000, archivePath: '/a' });
    expect(r.omitted).toBe(40_000);
    expect(r.text.length).toBeLessThan(10_200);
    expect(r.text).toContain('[promptreduce: 40000 chars omitted. Full output: /a]');
  });
  test('shrinks the line budget when lines are long', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ` + 'y'.repeat(300));
    const r = truncate(lines.join('\n'), { maxLines: 160, maxChars: 8_000 });
    expect(r.omitted).toBeGreaterThan(50);
    expect(r.text.length).toBeLessThan(9_000);
    expect(r.text.startsWith('line 0 ')).toBe(true);
    expect(r.text.endsWith('line 99 ' + 'y'.repeat(300))).toBe(true);
  });
});

describe('compress integration', () => {
  test('mcp result with html email bodies shrinks a lot without truncation', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, from: 'a@b.c', body: email.repeat(3), attachments: [] }));
    const r = compress(JSON.stringify({ value: msgs }), { kind: 'json' });
    expect(r.transforms).toContain('html-text');
    expect(r.transforms.some((t) => t.startsWith('truncate'))).toBe(false);
    expect(r.after.chars).toBeLessThan(r.before.chars * 0.4);
  });
  test('bash output that is json gets minified but not tabulated', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `pkg${i}`, version: '1.0.0', deps: [] }));
    const r = compress(JSON.stringify(rows, null, 2), { kind: 'bash' });
    expect(r.transforms).toContain('json-minified');
    expect(r.transforms).not.toContain('json-table');
  });
  test('mcp prose answer is treated as prose', () => {
    const md = Array.from({ length: 50 }, (_, i) => `## Section ${i}\n\nSome markdown text here that is not json at all.`).join('\n\n');
    const r = compress(md, { kind: 'json' });
    expect(r.transforms).not.toContain('json-minified');
  });
});
