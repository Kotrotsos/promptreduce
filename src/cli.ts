#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { loadConfig, paths } from './proxy/config.ts';

const argv = process.argv.slice(2);
const bare = argv.length === 0;
// Flags with no command (`promptreduce --days 7`) mean analyze; help keeps its own switches.
const flagsOnly = argv.length > 0 && argv[0].startsWith('-') && !['--help', '-h'].includes(argv[0]);
const [cmd, ...rest] = bare || flagsOnly ? ['analyze', ...argv] : argv;

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

switch (cmd) {
  case 'proxy': {
    const { startProxy } = await import('./proxy/server.ts');
    startProxy();
    break;
  }
  case 'eval': {
    const { startEval } = await import('./eval/server.ts');
    startEval();
    break;
  }
  case 'extract': {
    const { extractCorpus } = await import('../scripts/extract-corpus.ts');
    const cfg = loadConfig();
    const r = extractCorpus({ outDir: paths(cfg).corpus, maxFiles: Number(flag('files') ?? 80) });
    console.log(`scanned ${r.files} transcripts, ${r.candidates} tool results, wrote ${r.written} samples to ${paths(cfg).corpus}`);
    console.log('candidates by kind:', r.byKind);
    break;
  }
  case 'compress': {
    const { compress } = await import('./compress/index.ts');
    const file = rest.find((a) => !a.startsWith('--') && rest[rest.indexOf(a) - 1]?.startsWith('--') !== true);
    const text = file && file !== '-' ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
    const level = Number(flag('level') ?? 1) as 0 | 1 | 2;
    const r = compress(text, { kind: (flag('kind') as any) ?? 'bash', level });
    process.stdout.write(r.text + (r.text.endsWith('\n') ? '' : '\n'));
    console.error(`[promptreduce] ${r.kind} L${r.level}: ${r.before.tokens} -> ${r.after.tokens} est tokens (${r.before.tokens ? Math.round(100 * (1 - r.after.tokens / r.before.tokens)) : 0}% saved) ${r.transforms.join(', ') || 'no change'}`);
    break;
  }
  case 'analyze': {
    const { scanTranscripts } = await import('./analyze/scan.ts');
    const { renderReport, reportJson } = await import('./analyze/report.ts');
    const all = rest.includes('--all');
    const facts = scanTranscripts({
      projectsDir: flag('projects'),
      days: all ? 0 : Number(flag('days') ?? 30),
      maxFiles: Number(flag('files') ?? 300),
      sampleResults: Number(flag('sample') ?? 3000),
    });
    if (rest.includes('--json')) console.log(JSON.stringify(reportJson(facts), null, 1));
    else console.log(renderReport(facts, { eurRate: flag('eur') ? Number(flag('eur')) : undefined }));
    if (bare) {
      console.log('\nRun `promptreduce help` for the proxy, the eval page and the other commands.');
      if (process.platform === 'win32' && process.stdout.isTTY) prompt('Press Enter to close');
    }
    break;
  }
  case 'help':
  case '--help':
  case '-h':
  default:
    console.log(`promptreduce <command>   (no command runs analyze)

  proxy      start the compressing proxy   (PROMPTREDUCE_PORT, default 8788)
  eval       start the eval page + API     (PROMPTREDUCE_EVAL_PORT, default 8789)
  extract    build the private eval corpus from ~/.claude/projects transcripts
  compress   compress a file or stdin:  promptreduce compress out.txt --kind bash --level 1
  analyze    read your Claude Code transcripts and show what promptreduce would save
             flags: --days 30 | --all, --files 300, --sample 3000, --eur 0.92, --json, --projects <dir>

Environment:
  PROMPTREDUCE_UPSTREAM            default https://api.anthropic.com
  PROMPTREDUCE_LEVEL               0 lossless, 1 structural (default), 2 aggressive
  PROMPTREDUCE_HOME                default ~/.promptreduce (archive, corpus, stats)
  PROMPTREDUCE_CONTEXT_EDIT=1      also request the API's clear_tool_uses context edit (experimental)
  PROMPTREDUCE_COUNT_VIA_PROXY=1   let the eval page count exact tokens with the credentials the proxy forwards
  PROMPTREDUCE_VERBOSE=1           log each rewrite`);
}
