import { describe, expect, test } from 'bun:test';
import { truncate, collapseTestOutput, foldStackFrames, compactJson, cutBlobLines, collapseInnerSpaces } from '../src/compress/layer1.ts';

describe('truncate', () => {
  const lines = Array.from({ length: 300 }, (_, i) => (i === 150 ? 'Error: boom at 150' : `line ${i}`));
  const text = lines.join('\n');
  test('leaves short text alone', () => {
    expect(truncate('a\nb', { maxLines: 10 })).toEqual({ text: 'a\nb', omitted: 0 });
  });
  test('keeps head, tail, flagged middle lines and a marker', () => {
    const r = truncate(text, { maxLines: 100, archivePath: '/tmp/x.txt' });
    const out = r.text.split('\n');
    expect(out[0]).toBe('line 0');
    expect(out[out.length - 1]).toBe('line 299');
    expect(r.text).toContain('Error: boom at 150');
    expect(r.text).toContain('[promptreduce: 200 lines omitted, 1 flagged lines kept. Full output: /tmp/x.txt]');
    expect(r.omitted).toBe(200);
    expect(out.length).toBe(102);
  });
});

describe('collapseTestOutput', () => {
  test('collapses pytest PASSED runs, keeps FAILED', () => {
    const s = ['tests/a.py::t1 PASSED', 'tests/a.py::t2 PASSED', 'tests/a.py::t3 PASSED', 'tests/a.py::t4 FAILED', '=== 1 failed, 3 passed ==='].join('\n');
    expect(collapseTestOutput(s)).toBe('[promptreduce: 3 passing test lines collapsed]\ntests/a.py::t4 FAILED\n=== 1 failed, 3 passed ===');
  });
  test('collapses jest ticks', () => {
    const s = ['  ✓ renders (3 ms)', '  ✓ updates', '  ✓ unmounts', '  ✕ crashes'].join('\n');
    expect(collapseTestOutput(s)).toBe('[promptreduce: 3 passing test lines collapsed]\n  ✕ crashes');
  });
  test('leaves runs below the threshold', () => {
    const s = '--- PASS: TestA\n--- PASS: TestB';
    expect(collapseTestOutput(s)).toBe(s);
  });
});

describe('foldStackFrames', () => {
  test('folds python site-packages frames and keeps project frames', () => {
    const s = [
      'Traceback (most recent call last):',
      '  File "/app/main.py", line 10, in <module>',
      '    run()',
      '  File "/venv/lib/python3.12/site-packages/click/core.py", line 1157, in __call__',
      '    return self.main(*args, **kwargs)',
      '  File "/venv/lib/python3.12/site-packages/click/core.py", line 1078, in main',
      '    rv = self.invoke(ctx)',
      '  File "/app/cmd.py", line 5, in cmd',
      '    raise ValueError("x")',
      'ValueError: x',
    ].join('\n');
    const out = foldStackFrames(s);
    expect(out).toContain('/app/main.py');
    expect(out).toContain('/app/cmd.py');
    expect(out).toContain('[promptreduce: 2 frames inside site-packages folded]');
    expect(out).not.toContain('click/core.py');
  });
  test('folds node_modules frames', () => {
    const s = ['Error: x', '    at f (/p/src/a.ts:1:1)', '    at g (/p/node_modules/x/i.js:1:1)', '    at h (/p/node_modules/y/i.js:2:2)', '    at node:internal/main:1:1'].join('\n');
    expect(foldStackFrames(s)).toBe('Error: x\n    at f (/p/src/a.ts:1:1)\n    [promptreduce: 3 frames inside node_modules folded]');
  });
});

describe('compactJson', () => {
  test('tabulates arrays of similar objects and drops empty columns', () => {
    const rows = [
      { id: 1, name: 'a', note: null, tags: [] },
      { id: 2, name: 'b', note: null, tags: [] },
      { id: 3, name: 'c|d', note: null, tags: [] },
    ];
    const r = compactJson(JSON.stringify(rows, null, 2));
    expect(r.mode).toBe('table');
    expect(r.text).toBe('[table: 3 rows; empty columns dropped: note, tags]\nid | name\n1 | a\n2 | b\n3 | c\\|d');
  });
  test('minifies other JSON', () => {
    const r = compactJson(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
    expect(r).toEqual({ text: '{"a":1,"b":[1,2]}', mode: 'minified' });
  });
  test('ignores non-JSON', () => {
    expect(compactJson('{not json')).toEqual({ text: '{not json', mode: null });
  });
});

describe('blobs and spaces', () => {
  test('cuts long whitespace-free lines', () => {
    const blob = 'A'.repeat(5000);
    const out = cutBlobLines(`x\n${blob}\ny`);
    expect(out).toBe(`x\n${'A'.repeat(300)}[promptreduce: +4700 chars of blob cut]\ny`);
  });
  test('keeps long lines that contain prose', () => {
    const line = 'word '.repeat(1000);
    expect(cutBlobLines(line)).toBe(line);
  });
  test('collapses inner spaces but keeps indentation', () => {
    expect(collapseInnerSpaces('  a    b\t\tc')).toBe('  a b c');
  });
});
