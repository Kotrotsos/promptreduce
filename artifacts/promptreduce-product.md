# promptreduce

A local proxy that makes every Anthropic client spend fewer tokens.

## Hero

Point any client at it with one environment variable. Every tool result in every request is compressed on its way to the API. The client sees nothing different, the model reads less, the bill shrinks. Deterministic, cache-safe, fails open, and the untouched original stays on disk.

- 24.8% of tool-result tokens removed at the default level, measured on 399 real results
- 32.1% at the aggressive level
- 0 changes to the client

## Description

Most of an agent's bill is not what you type. Measured over 40 real Claude Code sessions, 95.4% of billed input volume is context re-sent on every turn, and tool results are 45% of everything that enters a transcript. A tool result that enters early in a long session is paid for hundreds of times.

promptreduce sits between the client and the API as a proxy on localhost. It parses each request, rewrites the content of tool_result blocks with pure, deterministic transforms, and forwards the rest byte for byte. Because the same content always renders to the same bytes, the API's prompt cache keeps matching across turns.

## Usage

1. bun install, bun run proxy (port 8788)
2. export ANTHROPIC_BASE_URL=http://localhost:8788, or set it in Claude Code's settings env block
3. bun run extract and bun run eval for the corpus and the eval page (port 8789)

## Benefits

- Works with every Anthropic client: Claude Code, the SDKs, Cursor, Cline, Aider, Continue
- Cache-safe by construction: no timestamps, no counters, no model calls in the transform path
- Fails open: any error forwards the original request; other endpoints and streaming pass through
- Nothing is lost: truncated results end with the path of the archived original
- Visible: the eval page shows before and after with exact counts and the API's own usage numbers
- Private: runs locally; the corpus built from your transcripts never leaves your machine

## Measured

Level 0 lossless 1.1%, level 1 structural 24.8%, level 2 aggressive 32.1%. By kind at level 1: JSON from MCP tools 46%, generic 23%, Bash 12.5%, prose 6%, Read 0% by design. Outlook and Gmail messages with HTML bodies: 55%.

## Potential future

- Model-assisted summarization of very long results, with a persisted memo so the cache holds
- Eviction of stale results from history, batched so one cache rebuild buys many cheap turns
- Opt-in slimming of tool definitions, which on a busy machine are the largest single cost
- An OpenAI-compatible endpoint so non-Anthropic clients get the same treatment
- Per-project profiles and rules for company-specific tool outputs
- A fidelity eval: an LLM judge answering questions from original versus compressed results
- A team dashboard and a CI gate that fails a change when corpus savings regress
