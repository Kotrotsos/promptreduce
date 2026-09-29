import type { CompressOptions, CompressResult, Kind, Level } from './types.ts';
import { estimateTokens } from './tokens.ts';
import { layer0 } from './layer0.ts';
import { truncate, cutBlobLines, collapseTestOutput, foldStackFrames, compactJsonDeep, collapseInnerSpaces, htmlToText } from './layer1.ts';
import { looksLikeJson, looksLikeHtml } from './detect.ts';

export type { CompressOptions, CompressResult, Kind, Level } from './types.ts';
export { estimateTokens } from './tokens.ts';
export { kindForTool } from './detect.ts';

/** Below this size nothing is worth doing and edge cases are not worth risking. */
const MIN_CHARS = 120;

interface Limits { maxLines: number; maxChars: number; headFraction: number }

function limits(kind: Kind, level: Level): Limits | null {
  if (level === 0) return null;
  const t = level === 2 ? 0.5 : 1;
  switch (kind) {
    case 'bash':    return { maxLines: 160 * t, maxChars: 16_000 * t, headFraction: 0.55 };
    case 'grep':    return { maxLines: 200 * t, maxChars: 12_000 * t, headFraction: 0.85 };
    case 'prose':   return { maxLines: 400 * t, maxChars: 30_000 * t, headFraction: 0.7 };
    case 'json':    return { maxLines: 300 * t, maxChars: 30_000 * t, headFraction: 0.7 };
    case 'generic': return { maxLines: 300 * t, maxChars: 20_000 * t, headFraction: 0.6 };
    case 'read':    return null;
  }
}

function measure(text: string) {
  return { chars: text.length, tokens: estimateTokens(text) };
}

/**
 * Deterministic: the same input with the same options always yields the same
 * output. The proxy relies on this so that a result already sent in earlier
 * requests renders to identical bytes in later ones and the prompt cache holds.
 */
export function compress(input: string, options: CompressOptions = {}): CompressResult {
  const kind: Kind = options.kind ?? 'generic';
  const level: Level = options.level ?? 1;
  const before = measure(input);
  const done = (text: string, transforms: string[]): CompressResult => ({
    text, changed: text !== input, kind, level, before, after: measure(text), transforms,
  });

  if (options.isError || kind === 'read' || input.length < MIN_CHARS) return done(input, []);

  const transforms: string[] = [];
  let text = input;
  const step = (name: string, next: string) => { if (next !== text) { text = next; transforms.push(name); } };

  const l0 = layer0(text, { repeatedLines: true, blankRuns: true, rules: true });
  text = l0.text;
  transforms.push(...l0.applied);

  if (level >= 1) {
    const isJson = looksLikeJson(text);
    // MCP tools that answered with markup or plain text are prose, whatever their name says.
    const effective: Kind = kind === 'json' && !isJson ? 'prose' : kind;

    if (isJson) {
      const j = compactJsonDeep(text, { dropEmpty: true, html: true, tables: effective !== 'bash' });
      if (j.transforms.length) { text = j.text; transforms.push(...j.transforms); }
    } else if ((effective === 'prose' || effective === 'generic') && looksLikeHtml(text)) {
      step('html-text', htmlToText(text));
    }
    if (effective === 'bash' || effective === 'generic') {
      step('tests', collapseTestOutput(text));
      step('stack-frames', foldStackFrames(text));
    }
    step('blob-lines', cutBlobLines(text));
    if (level === 2 && (effective === 'bash' || effective === 'grep')) step('inner-spaces', collapseInnerSpaces(text));

    const lim = limits(effective, level);
    if (lim) {
      const over = text.split('\n').length > lim.maxLines || text.length > lim.maxChars;
      const archivePath = over ? options.archive?.(input) : undefined;
      const tr = truncate(text, { maxLines: lim.maxLines, maxChars: lim.maxChars, headFraction: lim.headFraction, archivePath });
      if (tr.omitted > 0) { text = tr.text; transforms.push(`truncate(${tr.omitted})`); }
    }
  }

  // Never emit something larger than what came in.
  if (text.length >= input.length) return done(input, []);
  return done(text, transforms);
}
