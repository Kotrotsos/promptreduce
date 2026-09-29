import type { Kind } from './types.ts';

/** Map a tool name (as it appears in a tool_use block) to a content kind. */
export function kindForTool(toolName: string | undefined, input?: Record<string, unknown>): Kind {
  const n = (toolName ?? '').toLowerCase();
  if (n === 'read' || n === 'notebookread') return 'read';
  // MCP tools answer with JSON far more often than not; non-JSON answers fall back to prose in compress().
  if (n.startsWith('mcp__')) return 'json';
  if (n === 'bash' || n === 'bashoutput' || n === 'taskoutput') return 'bash';
  if (n === 'grep' || n === 'glob' || n === 'ls') return 'grep';
  if (n === 'webfetch' || n === 'websearch' || n.includes('fetch') || n.includes('search') || n.includes('transcript')) return 'prose';
  if (input && typeof input.command === 'string') return 'bash';
  return 'generic';
}

export function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return (t.startsWith('{') || t.startsWith('[')) && /[}\]]\s*$/.test(text);
}

const HTML_STRONG = /<!doctype html|<html[\s>]|<body[\s>]|<head[\s>]/i;
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g;

/** True when a string is markup rather than text that happens to mention a tag. */
export function looksLikeHtml(s: string): boolean {
  if (s.length < 40 || !s.includes('<')) return false;
  if (HTML_STRONG.test(s)) return true;
  const tags = s.match(HTML_TAG);
  return !!tags && tags.length >= 5 && tags.length * 20 >= s.length / 50;
}
