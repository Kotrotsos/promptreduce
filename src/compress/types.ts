/** Content categories the compressor knows how to treat differently. */
export type Kind =
  | 'bash'     // shell output: logs, test runs, build output
  | 'read'     // line-numbered file contents: passthrough, line numbers must survive
  | 'grep'     // search results: uniform lines, head-heavy truncation
  | 'json'     // structured API/MCP results
  | 'prose'    // web pages, documents, search results
  | 'generic'; // anything else

/**
 * 0 = lossless only (never drops information)
 * 1 = structural (default): folds repetition, truncates with an archive pointer
 * 2 = aggressive: tighter limits, inner whitespace collapse
 */
export type Level = 0 | 1 | 2;

export interface CompressOptions {
  kind?: Kind;
  level?: Level;
  /** Called with the original text when a truncation happens; returns a path the model can read. */
  archive?: (original: string) => string | undefined;
  /** Error results are never compressed. */
  isError?: boolean;
}

export interface Measure { chars: number; tokens: number }

export interface CompressResult {
  text: string;
  changed: boolean;
  kind: Kind;
  level: Level;
  before: Measure;
  after: Measure;
  /** Names of the transforms that actually altered the text, in order. */
  transforms: string[];
}
