# promptreduce

A local proxy for the Anthropic Messages API that shrinks what the model reads without changing what the client sees. Point any Anthropic client at it with `ANTHROPIC_BASE_URL` and every tool result in every request is compressed on its way to the API. Claude Code, the SDKs, Cursor, Cline, Aider and Continue all honor that variable.

Deterministic, cache-safe, fails open, keeps the untouched original on disk.

## Why the proxy shape, and what it targets

Measured over 40 real Claude Code sessions (19,311 model calls, usage fields from the API):

| Billed input volume | Share |
|---|---|
| Cache reads (context re-sent every turn) | 95.4% |
| Cache creation | 3.9% |
| Fresh, uncached input | 0.3% |

Of the content that enters a transcript once, tool results are 45%, the model's own Write and Edit bodies 38%, and typed user prompts 12% (median 31 tokens). Compressing the typed prompt is pointless. Compressing tool results at the moment they enter context is the lever: every token kept in context is re-billed on every later turn, so a result that enters early in a long session is paid for hundreds of times.

Two consequences shape the design:

- **Never churn the prefix.** Prompt caching is prefix based. A result must render to identical bytes on every request that carries it, so every transform is a pure function of the content. No timestamps, no counters, no model calls.
- **Never rewrite history.** Only the content of `tool_result` blocks changes. `tool_use_id`, `is_error` and `cache_control` are passed through untouched, images and documents are left alone, and error results are never compressed.

## Install

Pick one:

- **Binary.** Download `promptreduce-macos-arm64`, `promptreduce-macos-x64`, `promptreduce-windows-x64.exe` or `promptreduce-linux-x64` from the releases page and run it. Or use the installer, which picks the file, puts it on your PATH and clears the macOS quarantine flag:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/Kotrotsos/promptreduce/main/install.sh | sh    # macOS, Linux
  irm https://raw.githubusercontent.com/Kotrotsos/promptreduce/main/install.ps1 | iex          # Windows PowerShell
  ```

  The installers read from GitHub releases. Set `PROMPTREDUCE_REPO=owner/repo` to install from a fork.

- **From source.** With Bun installed: `git clone`, `bun install`, then `bun run build` for the binaries in `dist/`, or run everything through `bun run <command>` as below.

Then let setup do the wiring:

```sh
promptreduce setup --all              # Claude Code settings + start the proxy at login
promptreduce setup --all --dry-run    # print the changes, write nothing
promptreduce setup --claude-code --project   # only ./.claude/settings.json
promptreduce setup --undo             # revert what setup wrote
```

`--claude-code` writes `env.ANTHROPIC_BASE_URL` into `~/.claude/settings.json` (a timestamped backup is kept beside it; a foreign base URL is left alone unless you pass `--force`). `--service` registers the proxy as a launchd agent on macOS, a systemd user unit on Linux, or a Task Scheduler logon task on Windows, logging to `~/.promptreduce/proxy.log`. The service runs whatever started setup: the binary itself, or `bun src/cli.ts` when run from source.

## Quick start

```sh
bun install
bun run proxy            # http://localhost:8788 -> https://api.anthropic.com
```

Point a client at it:

```sh
export ANTHROPIC_BASE_URL=http://localhost:8788
claude                   # Claude Code with a subscription login works; the bearer token passes through
```

Or in Claude Code's settings, so it applies per project or globally:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:8788" } }
```

Eval page and corpus:

```sh
bun run extract          # builds a private corpus from ~/.claude/projects transcripts into ~/.promptreduce/corpus
bun run eval             # http://localhost:8789
```

The page lets you paste any tool result or pick a real one from the corpus, choose the kind and level, and compare before and after with token counts. "Run whole corpus" reports savings per kind and per tool. The proxy panel shows requests seen, tokens removed, and the exact usage numbers the API returned.

Analyze your own setup:

```sh
bun run analyze                  # transcripts modified in the last 30 days
bun run analyze -- --all         # everything
bun run analyze -- --eur 0.92    # totals in euros at that rate
bun run analyze -- --json        # the facts and the lever estimates as JSON
```

It reads `~/.claude/projects`, counts each response's usage once (the transcript repeats the usage object on every content-block line, so naive sums overstate the bill two to three times), prices the models seen at list prices with cache writes split by TTL, and prints:

- where the money goes: cache reads, cache rebuilds, cache appends, thinking, visible output, fresh input
- the cost of cache rebuilds and how many followed an idle gap over an hour
- your context shape: average request size, cold-start prefix (system prompt plus tool definitions), share of tool results, the long tail
- what the compressor removes when run on a sample of your own tool results, by tool
- savings per $1,000 for every lever, built and planned, each with its basis, and the multiplicative stack

Excerpt from this machine, last 30 days:

```
WHERE THE MONEY GOES  (LIST PRICES, USD)
  cache reads                   $1,579   43%   context re-read on every turn
  cache rebuilds                $1,266   35%   402 events, 186 after an idle gap over 1h
  cache appends                   $329    9%   new content written once
  thinking                        $243    7%   reasoning tokens, never shown
  visible output and edits        $181    5%   text you read, files it writes
  fresh input                      $60    2%   uncached tokens

PER $1,000 SPENT
  built  Tool-result compression           $34 to $59   measured here
  next   Cache rebuild guard             $138 to $208   estimate
  next   Effort control, medium          $150 to $300   Anthropic's runs
  next   Tool-definition slimming          $54 to $71   estimate
  stack of compression, rebuild-guard, effort-medium, tool-slimming: $330 to $515 per $1,000
```

## Binaries

One self-contained executable per platform, built from the same TypeScript, no runtime to install:

```sh
bun run build      # dist/promptreduce-macos-arm64, -macos-x64, -windows-x64.exe, -linux-x64
```

Double-clicking or running the binary with no arguments runs the analysis (on Windows it waits for Enter before closing); every other command works as `promptreduce proxy`, `promptreduce eval`, `promptreduce compress` and `promptreduce help`. The eval page is embedded, so the binary is the whole product. Sizes are 60 to 120 MB because each one carries the Bun runtime; that is the trade for a single codebase in which the analyzer measures with the exact compressor the proxy runs. A Rust port would be a few megabytes but would need a second implementation of the compressor kept in lockstep, which is the one thing this project must not drift on.

macOS may refuse an unsigned download the first time; `xattr -d com.apple.quarantine promptreduce-macos-arm64` or right-click Open clears it.

Single file from the command line:

```sh
bun src/cli.ts compress build.log --kind bash --level 1
```

## What it does to a result

Kinds are inferred from the tool name in the matching `tool_use` block: `bash`, `read`, `grep`, `json` (MCP tools), `prose` (web fetch and search), `generic`.

Level 0, lossless, applied to everything except `read`:

- ANSI escape sequences, carriage-return redraws (progress bars keep their final state), trailing whitespace, runs of blank lines, rows of `=====`
- consecutive identical lines become one line with a count

Level 1, structural (default):

- **JSON, deeply:** HTML string values (email bodies, pages) become plain text, empty fields are dropped, the output is minified, and the one array of records that dominates the payload is rendered once as a pipe table instead of repeating every key on every row
- **Bash:** runs of passing test lines collapse to a count, stack frames inside `site-packages` or `node_modules` fold, JSON output is minified
- **Blobs:** lines over 3,000 characters with no whitespace (base64, minified bundles) are cut
- **Budgets:** past a line or character budget per kind, the head and tail are kept together with any middle line that looks like an error, and a marker says how much was dropped and where the full text lives
- **Dedupe:** a result identical to an earlier result in the same request becomes a one-line pointer to it, for every kind including `read`

Level 2, aggressive: half the budgets, plus collapsing of inner column-alignment spaces in shell output.

`read` results are passed through unchanged because line numbers must survive for later edits. A truncated result ends with `[promptreduce: N lines omitted. Full output: ~/.promptreduce/archive/<hash>.txt]`, so a model that needs a dropped line can read the file.

## Measured on a real corpus

399 tool results sampled from this machine's transcripts, stratified by kind, local token estimate:

| Level | Saved |
|---|---|
| 0 lossless | 1.1% |
| 1 structural | 24.8% |
| 2 aggressive | 32.1% |

At level 1 by kind: JSON results 46%, generic 23%, Bash 12%, prose 6%, read 0% by design. That corpus is stratified toward large results; on a representative sample of 3,000 results from the last 30 days on the same machine, where file reads and shell output dominate, level 1 removes 10% and level 2 17% (shell output 13% and 25%). `bun run analyze` reports the representative figure for any machine. The single biggest win is Outlook and Gmail messages arriving as single-line JSON with HTML bodies: 55% off. Dedupe is not part of this number since it works across a request, not within one result.

For calibration: cheap lossless cleanup alone is worth about 2% on Bash output, and head-and-tail truncation alone about 13%. The long tail is where tokens are: results over 1,000 tokens are 10% of calls but 62% of tool-result tokens.

## Guarantees and limits

- **Fail open.** Any error while rewriting forwards the original body. Any other endpoint, including `count_tokens` and streaming, is passed through byte for byte. Upstream error bodies are logged.
- **Streaming** passes through untouched; usage is read from `message_start` and `message_delta` events on the way by.
- **Token numbers in the proxy are estimates.** Exact counts come from the API's `count_tokens` endpoint, which the eval page uses when `ANTHROPIC_API_KEY` is set or when the proxy runs with `PROMPTREDUCE_COUNT_VIA_PROXY=1` and reuses the credentials it last forwarded (in memory only).
- **The tools array and system prompt are not touched.** On a machine with many MCP servers the tool definitions alone can be 130k to 270k tokens per request. That is cached, but it is the largest single cost and it is not something a proxy should silently edit. Disable MCP servers you do not use.
- **Not done yet:** model-assisted summarization of very long results, and eviction of stale results from history. Both change bytes in the cached prefix and need a batching policy to pay off. The API's own `clear_tool_uses` context edit can be requested with `PROMPTREDUCE_CONTEXT_EDIT=1` as an experiment.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PROMPTREDUCE_PORT` | `8788` | proxy port |
| `PROMPTREDUCE_EVAL_PORT` | `8789` | eval page port |
| `PROMPTREDUCE_UPSTREAM` | `https://api.anthropic.com` | where requests go |
| `PROMPTREDUCE_LEVEL` | `1` | `0` lossless, `1` structural, `2` aggressive |
| `PROMPTREDUCE_HOME` | `~/.promptreduce` | archive, corpus, stats, recordings |
| `PROMPTREDUCE_CONTEXT_EDIT` | off | `1` adds the API's `clear_tool_uses_20250919` context edit |
| `PROMPTREDUCE_COUNT_VIA_PROXY` | off | `1` lets the eval page count exact tokens with forwarded credentials |
| `PROMPTREDUCE_RECORD` | off | `1` saves each rewritten request and any upstream error under `home/requests` |
| `PROMPTREDUCE_VERBOSE` | off | `1` logs every rewrite |

## Layout

```
src/compress/   pure, deterministic compressor: layer0 (lossless), layer1 (structural), detect, tokens
src/proxy/      Bun server, request rewriting, archive, usage capture, stats
src/eval/       eval server, API and page
src/analyze/    transcript scanner, pricing, lever estimates, report
scripts/        corpus extractor
test/           bun test
```

```sh
bun test
bun run typecheck
```
