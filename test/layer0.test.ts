import { describe, expect, test } from 'bun:test';
import { stripAnsi, resolveCarriageReturns, collapseRepeatedLines, collapseBlankRuns, shortenRules, layer0 } from '../src/compress/layer0.ts';

describe('layer0', () => {
  test('strips ANSI color and cursor sequences', () => {
    const s = '\x1b[38;2;186;33;33m"key"\x1b[39m: \x1b[1mvalue\x1b[0m\x1b[2K';
    expect(stripAnsi(s)).toBe('"key": value');
  });
  test('strips OSC hyperlinks', () => {
    expect(stripAnsi('\x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe('link');
  });
  test('keeps the last redraw of a progress bar', () => {
    const s = 'Downloading [==    ] 20%\rDownloading [====  ] 60%\rDownloading [======] 100%\ndone';
    expect(resolveCarriageReturns(s)).toBe('Downloading [======] 100%\ndone');
  });
  test('treats CRLF as a newline', () => {
    expect(resolveCarriageReturns('a\r\nb\r\n')).toBe('a\nb\n');
  });
  test('collapses repeated lines with a count', () => {
    expect(collapseRepeatedLines('x\nx\nx\ny')).toBe('x  [repeated x3]\ny');
  });
  test('does not collapse blank lines as repeats', () => {
    expect(collapseRepeatedLines('a\n\n\nb')).toBe('a\n\n\nb');
  });
  test('collapses blank runs to one blank line', () => {
    expect(collapseBlankRuns('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
  test('shortens long rules, leaves short ones', () => {
    expect(shortenRules('====================\n---\nx')).toBe('========\n---\nx');
  });
  test('reports which transforms applied', () => {
    const r = layer0('a  \nb\nb\nb');
    expect(r.applied).toEqual(['trailing-ws', 'repeated-lines']);
    expect(r.text).toBe('a\nb  [repeated x3]');
  });
});
