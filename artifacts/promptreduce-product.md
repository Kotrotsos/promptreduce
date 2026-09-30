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

## Install and use

1. Get the binary: download it from the releases page, or `curl -fsSL https://raw.githubusercontent.com/Kotrotsos/promptreduce/main/install.sh | sh` (macOS, Linux) or `irm https://raw.githubusercontent.com/Kotrotsos/promptreduce/main/install.ps1 | iex` (Windows), or build from source with `bun install && bun run build`.
2. `promptreduce setup --all` writes ANTHROPIC_BASE_URL into Claude Code's settings (backup kept) and registers the proxy as a login service (launchd, systemd user unit, Task Scheduler). `--dry-run` shows the changes, `--project` scopes to one project, `--undo` reverts.
3. Other clients: `export ANTHROPIC_BASE_URL=http://localhost:8788`, or the base URL field in Cursor, Cline, Aider, Continue.
4. Check: `curl http://localhost:8788/__promptreduce/health`, `promptreduce analyze`, `promptreduce eval` (port 8789), `promptreduce extract`.

## Benefits

- Works with every Anthropic client: Claude Code, the SDKs, Cursor, Cline, Aider, Continue
- Cache-safe by construction: no timestamps, no counters, no model calls in the transform path
- Fails open: any error forwards the original request; other endpoints and streaming pass through
- Nothing is lost: truncated results end with the path of the archived original
- Visible: the eval page shows before and after with exact counts and the API's own usage numbers
- Private: runs locally; the corpus built from your transcripts never leaves your machine

## Measured

Level 0 lossless 1.1%, level 1 structural 24.8%, level 2 aggressive 32.1%. By kind at level 1: JSON from MCP tools 46%, generic 23%, Bash 12.5%, prose 6%, Read 0% by design. Outlook and Gmail messages with HTML bodies: 55%.

## Where the money goes

Three hundred transcripts from the last 30 days, 11,907 model calls, usage counted once per response, list prices, one-hour cache (writes cost 2x input): cache reads 43%, cache rebuilds 35%, cache appends 9%, thinking 7%, visible output and edits 5%, fresh input 2%. 402 rebuild calls; 81% of rebuild tokens followed an idle gap over an hour. Roughly half of billed output tokens are thinking. `bun run analyze` prints this for any machine.

## Every lever, priced (per €1,000 spent)

- Tool-result compression (built): €35 to €60. Measured on 3,000 of this machine's results: level 1 removes 10%, level 2 17% (25% and 32% on a corpus weighted to large results).
- Result dedupe (built): €1 to €2.
- Cache rebuild guard (next): €140 to €210. Rebuilds are 35% of the bill, 81% of their tokens after idle gaps; assumes 40 to 60% avoidable.
- Effort control (next): €150 to €300 at medium, €330 to €500 at low. Anthropic's runs.
- Verbosity setting (next): €15 to €25. Visible output is 5% of the bill.
- Tool-definition slimming (next): €55 to €70. Cold-start prefix median 50k tokens, 15% of a request, 15 MCP servers.
- Stale-result eviction (later): €80 to €150, estimate.
- Long-result summarization (later): €90 to €175, estimate.
- Model routing for subagents (later): €125 to €200, estimate.

Stack of the built proxy, rebuild guard, medium effort and slimming: €330 to €500 back per €1,000. A team at €5,000 a month: €175 to €300 back with the built proxy, €1,650 to €2,500 with the next four levers.

## Potential future

- Model-assisted summarization of very long results, with a persisted memo so the cache holds
- Eviction of stale results from history, batched so one cache rebuild buys many cheap turns
- Opt-in slimming of tool definitions, which on a busy machine are the largest single cost
- An OpenAI-compatible endpoint so non-Anthropic clients get the same treatment
- Per-project profiles and rules for company-specific tool outputs
- A fidelity eval: an LLM judge answering questions from original versus compressed results
- A team dashboard and a CI gate that fails a change when corpus savings regress
