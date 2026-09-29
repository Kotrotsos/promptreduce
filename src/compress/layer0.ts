/**
 * Layer 0: lossless cleanup. Every transform here removes bytes a terminal
 * would not have shown, or repetition that carries no information beyond a
 * count. Safe for any kind except 'read' (line numbering must stay intact).
 */

// CSI sequences, OSC sequences, and single-character escapes.
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>NOM78]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/** Progress bars redraw a line with \r; keep what the terminal would show last. */
export function resolveCarriageReturns(s: string): string {
  if (!s.includes('\r')) return s;
  return s
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r');
      // A trailing \r before \n is just CRLF.
      const last = parts[parts.length - 1] === '' && parts.length > 1 ? parts[parts.length - 2] : parts[parts.length - 1];
      return last;
    })
    .join('\n');
}

export function trimTrailingWhitespace(s: string): string {
  return s.replace(/[ \t]+$/gm, '');
}

export function collapseBlankRuns(s: string, max = 1): string {
  const re = new RegExp(`\\n{${max + 2},}`, 'g');
  return s.replace(re, '\n'.repeat(max + 1));
}

/** Rows of ====== or ------ longer than 8 chars carry no more meaning than 8. */
export function shortenRules(s: string): string {
  return s.replace(/^([=\-_*#~])\1{7,}$/gm, (m) => m.slice(0, 8));
}

/** Consecutive identical non-blank lines become one line with a count. */
export function collapseRepeatedLines(s: string, minRun = 2): string {
  const lines = s.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j] === line && line.trim() !== '') j++;
    const run = j - i;
    if (run >= minRun && line.trim() !== '') {
      out.push(`${line}  [repeated x${run}]`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out.join('\n');
}

export interface Layer0Options {
  repeatedLines?: boolean;
  blankRuns?: boolean;
  rules?: boolean;
}

export function layer0(s: string, opts: Layer0Options = {}): { text: string; applied: string[] } {
  const applied: string[] = [];
  let t = s;
  const step = (name: string, f: (x: string) => string) => {
    const n = f(t);
    if (n !== t) applied.push(name);
    t = n;
  };
  step('ansi', stripAnsi);
  step('cr', resolveCarriageReturns);
  step('trailing-ws', trimTrailingWhitespace);
  if (opts.blankRuns !== false) step('blank-runs', (x) => collapseBlankRuns(x, 1));
  if (opts.rules !== false) step('rules', shortenRules);
  if (opts.repeatedLines !== false) step('repeated-lines', (x) => collapseRepeatedLines(x, 2));
  return { text: t, applied };
}
