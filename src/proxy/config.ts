import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Level } from '../compress/types.ts';

export interface Config {
  port: number;
  evalPort: number;
  upstream: string;
  home: string;
  level: Level;
  /** Opt-in: add the API's own clear_tool_uses context edit to every request. */
  contextEdit: boolean;
  /** Opt-in: keep the last seen auth headers in memory so the eval page can call count_tokens. */
  countViaProxy: boolean;
  verbose: boolean;
  /** Opt-in: save every rewritten request (and any upstream error body) under home/requests for replay and debugging. */
  record: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const level = Number(env.PROMPTREDUCE_LEVEL ?? '1');
  return {
    port: Number(env.PROMPTREDUCE_PORT ?? '8788'),
    evalPort: Number(env.PROMPTREDUCE_EVAL_PORT ?? '8789'),
    upstream: (env.PROMPTREDUCE_UPSTREAM ?? 'https://api.anthropic.com').replace(/\/+$/, ''),
    home: env.PROMPTREDUCE_HOME ?? join(homedir(), '.promptreduce'),
    level: (level === 0 || level === 2 ? level : 1) as Level,
    contextEdit: env.PROMPTREDUCE_CONTEXT_EDIT === '1',
    countViaProxy: env.PROMPTREDUCE_COUNT_VIA_PROXY === '1',
    verbose: env.PROMPTREDUCE_VERBOSE === '1',
    record: env.PROMPTREDUCE_RECORD === '1',
  };
}

export function paths(cfg: Config) {
  return {
    archive: join(cfg.home, 'archive'),
    corpus: join(cfg.home, 'corpus'),
    stats: join(cfg.home, 'stats.jsonl'),
    requests: join(cfg.home, 'requests'),
    reports: join(cfg.home, 'reports'),
    known: join(cfg.home, 'known-ids.tsv'),
  };
}
