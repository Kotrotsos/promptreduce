import { looksLikeHtml } from './detect.ts';
/**
 * Layer 1: structure-aware transforms. These fold repetition the model does
 * not need line by line (passing tests, library stack frames, pretty-printed
 * JSON) and truncate very long outputs while keeping the head, the tail, and
 * any line that looks like a problem. Truncation always leaves a marker that
 * says how much was dropped and, when available, where the full text lives.
 */

export const FLAG = /\b(error|errors|fail|failed|failure|exception|traceback|warning|fatal|panic|denied|refused|not found|cannot|unable|timeout|timed out|segfault|core dumped|unhandled|rejected|invalid|missing)\b/i;

export interface TruncateOptions {
  maxLines: number;
  /** Character budget; when lines are long this is what bites. */
  maxChars?: number;
  /** Fraction of the budget that goes to the head. */
  headFraction?: number;
  maxFlagged?: number;
  archivePath?: string;
}

function marker(omitted: string, opts: TruncateOptions, flagged = 0): string {
  const where = opts.archivePath ? ` Full output: ${opts.archivePath}` : '';
  const kept = flagged ? `, ${flagged} flagged lines kept` : '';
  return `[promptreduce: ${omitted} omitted${kept}.${where}]`;
}

export function truncate(text: string, opts: TruncateOptions): { text: string; omitted: number } {
  const lines = text.split('\n');
  const maxChars = opts.maxChars ?? Infinity;
  const headFrac = opts.headFraction ?? 0.6;
  if (lines.length <= opts.maxLines && text.length <= maxChars) return { text, omitted: 0 };

  // Long lines: cut inside the text by characters, at line boundaries when there are any.
  if (lines.length <= opts.maxLines && text.length > maxChars) {
    if (lines.length < 4) {
      const headChars = Math.floor(maxChars * headFrac);
      const tailChars = Math.max(0, maxChars - headChars);
      const cut = text.length - headChars - tailChars;
      const out = `${text.slice(0, headChars)}\n${marker(`${cut} chars`, opts)}\n${tailChars ? text.slice(-tailChars) : ''}`;
      return { text: out, omitted: cut };
    }
    let budget = lines.length;
    const joinedLen = (n: number) => {
      const h = Math.max(1, Math.floor(n * headFrac));
      const t = Math.max(1, n - h);
      return lines.slice(0, h).join('\n').length + lines.slice(lines.length - t).join('\n').length;
    };
    while (budget > 4 && joinedLen(budget) > maxChars) budget = Math.floor(budget * 0.8);
    opts = { ...opts, maxLines: Math.min(opts.maxLines, budget) };
  }
  const head = Math.max(1, Math.floor(opts.maxLines * headFrac));
  const tail = Math.max(1, opts.maxLines - head);
  const middle = lines.slice(head, lines.length - tail);
  const maxFlagged = opts.maxFlagged ?? 20;
  const flagged: string[] = [];
  for (const l of middle) {
    if (flagged.length >= maxFlagged) break;
    if (FLAG.test(l)) flagged.push(l);
  }
  const omitted = middle.length;
  const out = [...lines.slice(0, head), marker(`${omitted} lines`, opts, flagged.length), ...flagged, ...lines.slice(lines.length - tail)];
  return { text: out.join('\n'), omitted };
}

/** Very long single lines with almost no whitespace are blobs (base64, minified bundles). */
export function cutBlobLines(text: string, maxLen = 3000, keep = 300): string {
  if (text.length < maxLen) return text;
  return text
    .split('\n')
    .map((l) => {
      if (l.length < maxLen) return l;
      const spaces = (l.match(/\s/g) ?? []).length;
      if (spaces / l.length > 0.02) return l;
      return `${l.slice(0, keep)}[promptreduce: +${l.length - keep} chars of blob cut]`;
    })
    .join('\n');
}

// Passing-test line shapes across common runners.
const PASS_LINE = [
  /^\s*\S+::\S+\s+PASSED(\s|$)/,                 // pytest verbose
  /^\s*PASSED\s+\S+::/,                          // pytest -rA style
  /^\s*[✓✔√]\s/,                                 // jest, vitest, mocha
  /^\s*PASS\s+\S+\.(test|spec)\.[jt]sx?/,        // jest per-file
  /^\s*--- PASS:/,                               // go test
  /^\s*test \S+ \.\.\. ok$/,                     // cargo test
  /^\s*ok\s+\S+\s+[\d.]+s$/,                     // go package ok
  /^\s*\[\s*OK\s*\]/i,
  /^\s*\d+\)\s.*\bok\b$/i,
];

export function collapseTestOutput(text: string, minRun = 3): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && PASS_LINE.some((re) => re.test(lines[j]))) j++;
    const run = j - i;
    if (run >= minRun) {
      out.push(`[promptreduce: ${run} passing test lines collapsed]`);
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

const PY_LIB_FRAME = /^\s*File "[^"]*(site-packages|dist-packages|lib\/python\d[^"]*\/(?!site-packages))[^"]*", line \d+/;
const NODE_LIB_FRAME = /^\s*at .*(node_modules|node:internal|internal\/)/;
const NODE_ANY_FRAME = /^\s*at /;

/** Runs of stack frames inside dependencies fold into one line; project frames stay. */
export function foldStackFrames(text: string, minRun = 2): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (PY_LIB_FRAME.test(lines[i])) {
      let j = i;
      let frames = 0;
      while (j < lines.length && PY_LIB_FRAME.test(lines[j])) {
        frames++;
        j++;
        // The source line that follows a Python frame.
        if (j < lines.length && /^\s{4,}\S/.test(lines[j]) && !/^\s*File "/.test(lines[j])) j++;
      }
      if (frames >= minRun) {
        out.push(`  [promptreduce: ${frames} frames inside site-packages folded]`);
      } else {
        for (let k = i; k < j; k++) out.push(lines[k]);
      }
      i = j;
      continue;
    }
    if (NODE_LIB_FRAME.test(lines[i])) {
      let j = i;
      while (j < lines.length && NODE_LIB_FRAME.test(lines[j])) j++;
      const run = j - i;
      if (run >= minRun) out.push(`    [promptreduce: ${run} frames inside node_modules folded]`);
      else for (let k = i; k < j; k++) out.push(lines[k]);
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

const EMPTY = (v: unknown) =>
  v === null || v === undefined || v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Pretty-printed JSON becomes minified JSON. An array of similar objects
 * becomes a pipe-delimited table with one header row: keys are written once
 * instead of once per row, and columns that are empty everywhere are dropped.
 */
export function compactJson(text: string): { text: string; mode: 'table' | 'minified' | null } {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return { text, mode: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { text, mode: null };
  }
  if (Array.isArray(parsed) && parsed.length >= 3 && parsed.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    const rows = parsed as Record<string, unknown>[];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    const nonEmpty = keys.filter((k) => rows.some((r) => !EMPTY(r[k])));
    const dropped = keys.filter((k) => !nonEmpty.includes(k));
    // Only tabulate when keys are shared broadly; otherwise rows are heterogenous.
    const coverage = nonEmpty.reduce((acc, k) => acc + rows.filter((r) => k in r).length, 0) / (nonEmpty.length * rows.length || 1);
    if (nonEmpty.length > 0 && coverage >= 0.6) {
      const header = `[table: ${rows.length} rows${dropped.length ? `; empty columns dropped: ${dropped.join(', ')}` : ''}]`;
      const lines = [header, nonEmpty.join(' | '), ...rows.map((r) => nonEmpty.map((k) => cell(r[k])).join(' | '))];
      const table = lines.join('\n');
      const minified = JSON.stringify(parsed);
      if (table.length < minified.length) return { text: table, mode: 'table' };
      return { text: minified, mode: 'minified' };
    }
  }
  const minified = JSON.stringify(parsed);
  if (minified.length < trimmed.length) return { text: minified, mode: 'minified' };
  return { text, mode: null };
}

/** Level 2 only: runs of inner spaces (column alignment) become one space. Leading indentation is kept. */
export function collapseInnerSpaces(text: string): string {
  return text.replace(/^(\s*)(.*)$/gm, (_m, lead: string, rest: string) => lead + rest.replace(/[ \t]{2,}/g, ' '));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', copy: '(c)', reg: '(R)', trade: '(TM)', zwnj: '', zwj: '', shy: '' };

/** Markup to the text a mail client would show. Deterministic, dependency-free. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|section|article|header|footer|table|ul|ol|dd|dt)\s*>/gi, '\n');
  s = s.replace(/<\/(td|th)\s*>/gi, '\t');
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const t = inner.replace(/<[^>]+>/g, '').trim();
    if (!t || /^(https?:\/\/|mailto:)/i.test(t) || href.startsWith('#')) return t || '';
    return `${t} (${href})`;
  });
  s = s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, alt: string) => (alt.trim() ? `[image: ${alt.trim()}]` : ''));
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return e.toLowerCase() in ENTITIES ? ENTITIES[e.toLowerCase()] : m;
  });
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

function isFlatRowArray(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.length >= 3 && v.every((r) => r && typeof r === 'object' && !Array.isArray(r));
}

function renderTable(rows: Record<string, unknown>[]): string | null {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const nonEmpty = keys.filter((k) => rows.some((r) => !isEmpty(r[k])));
  if (!nonEmpty.length) return null;
  const coverage = nonEmpty.reduce((acc, k) => acc + rows.filter((r) => k in r).length, 0) / (nonEmpty.length * rows.length);
  if (coverage < 0.6) return null;
  const dropped = keys.filter((k) => !nonEmpty.includes(k));
  const header = `[table: ${rows.length} rows${dropped.length ? `; empty columns dropped: ${dropped.join(', ')}` : ''}]`;
  return [header, nonEmpty.join(' | '), ...rows.map((r) => nonEmpty.map((k) => cell(r[k])).join(' | '))].join('\n');
}

export interface DeepJsonOptions { dropEmpty?: boolean; html?: boolean; tables?: boolean }

/**
 * Structured results, deeply: HTML string values become text, fields that are
 * empty go away, and the one array of records that dominates the payload is
 * rendered once as a table instead of repeating every key on every row.
 */
export function compactJsonDeep(text: string, opts: DeepJsonOptions = {}): { text: string; transforms: string[] } {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return { text, transforms: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return { text, transforms: [] }; }
  const transforms = new Set<string>();

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (opts.html !== false && looksLikeHtml(v)) { transforms.add('html-text'); return htmlToText(v); }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const w = walk(x);
        if (opts.dropEmpty !== false && isEmpty(w)) { transforms.add('drop-empty'); continue; }
        out[k] = w;
      }
      return out;
    }
    return v;
  };
  const cleaned = walk(parsed);
  const minified = JSON.stringify(cleaned);

  if (opts.tables !== false) {
    // Find the largest array of records anywhere; tabulate it when it dominates.
    let best: { path: string[]; rows: Record<string, unknown>[]; size: number } | null = null;
    const find = (v: unknown, path: string[]) => {
      if (isFlatRowArray(v)) { const size = JSON.stringify(v).length; if (!best || size > best.size) best = { path, rows: v, size }; }
      if (Array.isArray(v)) v.forEach((x, i) => find(x, [...path, String(i)]));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) find(x, [...path, k]);
    };
    find(cleaned, []);
    const b = best as { path: string[]; rows: Record<string, unknown>[]; size: number } | null;
    if (b && b.size * 2 >= minified.length) {
      const table = renderTable(b.rows);
      if (table && table.length < b.size) {
        transforms.add('json-table');
        if (b.path.length === 0) return { text: table, transforms: [...transforms] };
        // Keep the envelope, point at the table.
        const clone = JSON.parse(minified);
        let node: any = clone;
        for (const k of b.path.slice(0, -1)) node = node[k];
        node[b.path[b.path.length - 1]] = `[see table below: ${b.rows.length} rows]`;
        return { text: `${JSON.stringify(clone)}\n${table}`, transforms: [...transforms] };
      }
    }
  }
  if (minified.length < trimmed.length) { transforms.add('json-minified'); return { text: minified, transforms: [...transforms] }; }
  return transforms.size ? { text: minified, transforms: [...transforms] } : { text, transforms: [] };
}
