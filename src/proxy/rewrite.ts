import { compress, kindForTool, estimateTokens, type Level } from '../compress/index.ts';

const DEDUPE_MIN_CHARS = 500;

export interface ToolStat { n: number; rewritten: number; before: number; after: number }
export interface RewriteReport {
  results: number;
  rewritten: number;
  tokensBefore: number;
  tokensAfter: number;
  byTool: Record<string, ToolStat>;
}

export interface RewriteOptions {
  level: Level;
  archive?: (original: string) => string | undefined;
  contextEdit?: boolean;
  /** Replace results that repeat an earlier identical result in the same request. Default on. */
  dedupe?: boolean;
}

type Block = Record<string, unknown> & { type?: string };

/**
 * Rewrites tool_result blocks in a Messages API request body in place.
 * Only the `content` of a tool_result changes; tool_use_id, is_error and
 * cache_control stay exactly as the client sent them. Non-text blocks
 * (images, documents) are left alone.
 */
export function rewriteRequest(body: Record<string, unknown>, opts: RewriteOptions): RewriteReport {
  const report: RewriteReport = { results: 0, rewritten: 0, tokensBefore: 0, tokensAfter: 0, byTool: {} };
  const messages = body.messages;
  if (!Array.isArray(messages)) return report;

  const toolUses = new Map<string, { name: string; input?: Record<string, unknown> }>();
  for (const m of messages as Array<Record<string, unknown>>) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        toolUses.set(b.id, { name: String(b.name ?? ''), input: b.input as Record<string, unknown> | undefined });
      }
    }
  }

  // Identical results seen earlier in the same request become a pointer to the first copy.
  // The pointer for message k depends only on messages before k, so the prefix stays stable.
  const seen = new Map<string, { id: string; chars: number }>();
  const textOf = (b: Block): string | null => {
    if (typeof b.content === 'string') return b.content;
    if (Array.isArray(b.content)) {
      const parts = (b.content as Block[]).filter((x) => x.type === 'text' && typeof x.text === 'string');
      if (parts.length && parts.length === (b.content as Block[]).length) return parts.map((x) => x.text as string).join('\n');
    }
    return null;
  };

  for (const m of messages as Array<Record<string, unknown>>) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) {
      if (b.type !== 'tool_result') continue;
      report.results++;
      const use = toolUses.get(String(b.tool_use_id));
      const tool = use?.name ?? 'unknown';
      const kind = kindForTool(use?.name, use?.input);
      const isError = b.is_error === true;
      const stat = (report.byTool[tool] ??= { n: 0, rewritten: 0, before: 0, after: 0 });
      stat.n++;

      if (opts.dedupe !== false && !isError) {
        const t = textOf(b);
        if (t && t.length >= DEDUPE_MIN_CHARS) {
          const key = new Bun.CryptoHasher('sha256').update(t).digest('hex');
          const prev = seen.get(key);
          if (prev) {
            const tokens = estimateTokens(t);
            const stub = `[promptreduce: identical to the result of tool call ${prev.id} above (${prev.chars} chars); not repeated]`;
            report.tokensBefore += tokens; report.tokensAfter += estimateTokens(stub);
            stat.before += tokens; stat.after += estimateTokens(stub);
            b.content = stub; report.rewritten++; stat.rewritten++;
            continue;
          }
          seen.set(key, { id: String(b.tool_use_id), chars: t.length });
        }
      }

      const apply = (text: string) => {
        const r = compress(text, { kind, level: opts.level, isError, archive: opts.archive });
        report.tokensBefore += r.before.tokens;
        report.tokensAfter += r.after.tokens;
        stat.before += r.before.tokens;
        stat.after += r.after.tokens;
        return r;
      };

      if (typeof b.content === 'string') {
        const r = apply(b.content);
        if (r.changed) { b.content = r.text; report.rewritten++; stat.rewritten++; }
      } else if (Array.isArray(b.content)) {
        let changed = false;
        for (const inner of b.content as Block[]) {
          if (inner.type === 'text' && typeof inner.text === 'string') {
            const r = apply(inner.text);
            if (r.changed) { inner.text = r.text; changed = true; }
          }
        }
        if (changed) { report.rewritten++; stat.rewritten++; }
      }
    }
  }

  if (opts.contextEdit) {
    const cm = (body.context_management ??= { edits: [] }) as { edits?: Array<{ type: string }> };
    if (!Array.isArray(cm.edits)) cm.edits = [];
    if (!cm.edits.some((e) => e && e.type === 'clear_tool_uses_20250919')) cm.edits.push({ type: 'clear_tool_uses_20250919' });
  }
  return report;
}

export const CONTEXT_EDIT_BETA = 'context-management-2025-06-27';
