# Crawl4AI plugin design

## Intent
Use the existing self-hosted SearXNG and Crawl4AI services as Claude Code's default web research route, without adding an MCP server. The user approved implementation without further design questions. Build the plugin; do not install it globally, change user settings, commit, push, or restart services.

## Architecture
A Python 3.10+ standard-library CLI speaks SearXNG JSON and Crawl4AI HTTP APIs. A Claude Code skill teaches search, reading, and bounded link following. Plugin SessionStart context advertises the route. A PreToolUse command hook denies built-in WebSearch and WebFetch while this plugin is loaded, without granting other permissions or pretending to replace a tool's output.

## Commands
Run `python3 scripts/web.py <command>`.
- `search QUERY --limit 5`: find URLs using SearXNG only.
- `fetch URL [URL ...] --max-chars 16000`: retrieve Markdown and discovered links through Crawl4AI.
- `research QUERY --limit 3 --max-chars 16000`: search, then read the selected results.
- `crawl URL --max-pages 5 --max-depth 1 --max-chars 16000`: bounded client-side breadth-first crawling. Default to the seed's origin and path subtree, not the entire host. This works without enabling server-side deep-crawl config.

## Configuration and safety
Read `SEARXNG_URL`, `CRAWL4AI_URL`, and `CRAWL4AI_API_TOKEN` from the environment. No token CLI flags, saved credentials, automatic SSH, or persistent credential lookup. Search needs only SearXNG configured; fetch/crawl need only Crawl4AI; research needs both. Include non-secret example URLs matching the user's verified services, but no built-in personal endpoint defaults.

No silent fallback to public search or direct HTTP page reads. Explicit errors and nonzero exit for transport failures, authentication failures, malformed JSON or schema, failed/empty crawl results, and a search with no results when upstream engines failed. Legitimate zero search results without engine failures remain distinct. Preserve engine failure warnings even when other engines returned useful results. Do not echo server error bodies or raw exceptions that could expose credentials. Reject URL userinfo and non-HTTP(S) URLs; refuse redirects from the service API clients so Bearer credentials cannot be forwarded to another host. Limit response size, per-request time, result count, and crawl page/depth bounds.

JSON output includes source URLs, meaningful Markdown, warnings, and explicit truncation metadata. Returned page content is untrusted data, not agent instructions. The skill requires source citations, discloses partial results, and never claims an entire documentation site was collected when limits stopped the crawl. Block hooks are scoped to exactly WebSearch and WebFetch, not third-party MCP tools, Bash, or an egress security boundary. Hook failures must not silently allow a blocked built-in tool.

## Acceptance
CLI tests execute the public subprocess entry point against local HTTP fixtures: valid, missing and malformed inputs are separate cases. Validate auth propagation without printing tokens, no credential forwarding on redirects, explicit errors, partial warnings, bounded same-origin/path traversal, deduplication, and truncation. Hook tests execute the shipped manifest command with stdin fixtures, including quoted plugin paths, and check exact deny output plus unrelated-tool pass-through. `claude plugin validate --strict --json` must pass. The lead runs real search and Crawl4AI tests, including Apple HIG pages, without saving the token. No paid model eval is required; without an actual model session, report automatic model routing as unverified.
