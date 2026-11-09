# Crawl4AI for Claude Code

An unofficial Claude Code plugin that uses your SearXNG instance for discovery and your Crawl4AI instance for rendered page content. No MCP server, extra model, or Python package installation.

## Requirements

- Python 3.10 or newer.
- Claude Code 2.1.319 or newer (validated version; hooks use exec-form arguments and onFailure).
- SearXNG reachable from the machine running Claude Code, with JSON search enabled.
- Crawl4AI 0.9.5-compatible `/crawl` API and its local Bearer token.

## Start for one session

From Bash or zsh, set non-secret addresses and read the token without saving it to history or a file:

```bash
source /absolute/plugin/path/config.example.sh
printf 'Crawl4AI token: '
read -r -s CRAWL4AI_API_TOKEN
printf '\n'
export CRAWL4AI_API_TOKEN
claude --plugin-dir /absolute/plugin/path
```

Replace `/absolute/plugin/path` with the directory containing this README. For this working copy it is `/Users/me/Development/selfhosted-web-worktree`. The example URLs are the owner's existing LAN services; change them for your environment. Never put the token in config.example.sh, CLAUDE.md, a committed `.env`, hook JSON, or plugin metadata. The token is the password to your own Crawl4AI service, not a cloud subscription key.

`--plugin-dir` loads the plugin for that session only. It does not install it globally or modify your settings. Close that session and launch Claude without the flag to stop using it. An already-running Claude process does not inherit environment variables exported later in another shell.

Once loaded, ask normally, or invoke the skill explicitly:

```text
/crawl Find Apple's recommendations for navigation and cite the source pages.
/crawl Read the HIG buttons page, selecting main content.
/crawl Collect up to 5 HIG pages, starting at its index, within that documentation subtree.
```

The short `/crawl` name invokes this skill when no other command owns that name. If there is a collision, use the full `/crawl4ai:crawl` name. The skill directory and frontmatter are both named `crawl`.

## Default routing

A SessionStart hook tells Claude to use the plugin's skill. A PreToolUse hook denies exactly `WebSearch` and `WebFetch`, and explains how to call the local CLI instead. The hook grants no Bash permissions. Hook failures block the matching built-in tool rather than silently permitting it.

This is not a replacement implementation of Claude's built-in tools: the model chooses CLI calls after receiving the skill and hook instructions. It is not a network-egress firewall, and does not intercept arbitrary curl commands or unrelated MCP search tools. The skill tells Claude not to route around the guard. Other plugins that require a specific web provider can conflict with this policy; enable this plugin only in sessions where you want the self-hosted route.

Neither the CLI nor hooks silently falls back to a public search API. If a service is unavailable, you get an explicit error. SearXNG itself still queries the upstream search engines configured on your server. Model analysis still goes to the provider used by your Claude Code session; self-hosting the crawler does not make the model local.

## CLI

```bash
python3 -I scripts/web.py search 'Apple interface navigation' --limit 5
python3 -I scripts/web.py research 'Apple interface navigation' --limit 3
python3 -I scripts/web.py fetch 'https://developer.apple.com/design/human-interface-guidelines/buttons' \
  --css-selector main --wait-for css:main
python3 -I scripts/web.py crawl 'https://developer.apple.com/design/human-interface-guidelines' \
  --css-selector main --wait-for css:main --max-pages 5 --max-depth 1
```

`search` needs SEARXNG_URL only. `fetch` and `crawl` need CRAWL4AI_URL and CRAWL4AI_API_TOKEN only. `research` needs all three. Base URLs may include a deployment path prefix. HTTP(S) only; no credentials in URLs. API redirects are refused so a redirect cannot forward the Bearer token elsewhere. Use HTTPS if your LAN is not trusted: the example Crawl4AI address uses plaintext HTTP.

Successful requests write JSON with `ok: true`; operational failures write `ok: false`, a structured `error`, and exit 1. Argument errors use argparse diagnostics and exit 2. SearXNG results have `url`, `title`, and `snippet`. Retrieved pages have `requested_url`, final `url`, `title`, `markdown`, `links`, `original_chars`, and `truncated`. Research includes both results and pages. Engine errors remain in `warnings`. Zero results alongside engine failures is an error, not a clean no-results answer.

A crawl stays in the seed's origin and path subtree. Final redirected URLs are checked before accepting a page; browser-side redirects can already have been requested by Crawl4AI, so this is not an SSRF boundary. Fragments are removed for deduplication. Page and depth limits produce `complete: false` and a warning. A mid-crawl error retains collected pages and reports failure. It does not claim to have archived the whole website. The server's deep-crawl flag need not be enabled because the client follows discovered links itself.

Defaults: 5 search results, 3 research results, 5 crawl pages, depth 1, and 16000 Markdown characters per page. Bounds: 20 results/fetch URLs, 100 crawl pages, depth 10, 200000 characters per page. Response bodies over 8 MiB fail explicitly. Requests have a 60-second socket timeout; a multi-page operation can take longer. No files or caches are written by the CLI.

## Verification

```bash
python3 -m unittest discover -s tests -v
claude plugin validate --strict --json /absolute/plugin/path
```

Tests use real local HTTP fixtures and subprocess CLI/hook entry points. They cover valid results, separate missing/malformed inputs, auth rejection and propagation, redirect refusal, engine warnings, bounded path traversal, explicit truncation, malformed hook input, and plugin paths containing shell characters. Test fixtures use fake credentials, never the real service token.

A loaded-model session is a separate acceptance check from CLI/hook tests and manifest validation. Do not infer that an AI selected the route from a passing unit test alone.
