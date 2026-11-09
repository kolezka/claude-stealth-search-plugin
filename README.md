# Stealth Search for Claude Code

Let Claude Code search and read the web through your own servers instead of its built-in web tools.

Stealth Search sends searches to your SearXNG and page reads to your Crawl4AI. Claude gets clean Markdown from fully rendered pages, including JavaScript-heavy docs, and cites the sources it used.

> [!IMPORTANT]
> **You must run SearXNG and Crawl4AI yourself.**
> This plugin includes no search engine or crawler and calls no hosted service. It only connects Claude Code to a [SearXNG](https://docs.searxng.org/) instance and a [Crawl4AI](https://docs.crawl4ai.com/) server that you already run, on your machine, your LAN or your own server. Without both, the plugin does nothing useful.

## What you get

- **Search** the web through your SearXNG.
- **Read** any page through Crawl4AI, with the rendered page turned into Markdown.
- **Research**: search, then read the top results, in one step.
- **Crawl** a documentation section page by page, kept inside that section.
- **No silent fallback.** Claude's built-in `WebSearch` and `WebFetch` are blocked while the plugin is on. If one of your servers is down, you get a clear error, not a quiet switch to a public API.

No MCP server, no extra API key, no dependencies to install. Everything runs on [Bun](https://bun.sh/).

## Before you start

| You need | What it's for |
| --- | --- |
| **Your own SearXNG**, with JSON output enabled (`search.formats` includes `json`) | Finding pages |
| **Your own Crawl4AI server** (0.9.5 compatible API: `/crawl`, `/crawl/stream`, `/md`, `/llm`) and its API token | Opening and rendering pages |
| [Bun](https://bun.sh/) on your `PATH` | Running the plugin |
| Claude Code 2.1.319 or newer | Loading the plugin |

Both servers must be reachable from the machine where Claude Code runs.

## Set up

1. Get the plugin:

   ```bash
   git clone https://github.com/kolezka/claude-stealth-search-plugin.git
   cd claude-stealth-search-plugin
   ```

2. Point it at your servers. Edit the two URLs in `config.example.sh`, or export them yourself:

   ```bash
   export SEARXNG_URL='http://searxng.example.lan'
   export CRAWL4AI_API_URL='http://crawl4ai.example.lan:11235'
   ```

3. Start Claude Code with the plugin. You type the token in, so it never lands in your shell history or a file:

   ```bash
   source ./config.example.sh
   printf 'Crawl4AI token: '; read -r -s CRAWL4AI_API_TOKEN; printf '\n'
   export CRAWL4AI_API_TOKEN
   claude --plugin-dir "$PWD"
   ```

`--plugin-dir` turns the plugin on for that session only. Nothing is installed globally. Start Claude without the flag and it's off again.

Keep the token out of `config.example.sh`, `CLAUDE.md`, `.env` files and anything you commit. It's the password to your own Crawl4AI server.

### DeepSeek Harness

The same tree also runs in [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). The `dsh/` directory holds a small adapter built on [claude-plugins-dsh](https://github.com/kolezka/claude-plugins-dsh). It loads the `crawl` skill and both hooks, so DSH's `web_search` and `web_fetch` are blocked the same way. Claude Code never reads `dsh/`.

Export the same three variables in the shell that starts DSH, then add the adapter through DSH's plugin manager:

```bash
dsh plugin --profile web add "file:$PWD/dsh"
```

Or turn it on for every profile with a row in `~/.dsh/cordis.patch.yml`:

```yaml
- insert:
    - id: claude-compat-stealth-search
      name: "file:///abs/path/to/claude-stealth-search-plugin/dsh/index.js"
```

In DSH the skill is called `crawl`, not `stealth-search:crawl`. Hooks need `bun` on the `PATH` and a POSIX shell.

## Use it

Ask Claude to look something up and it will use your servers. You can also call the skill directly:

```text
/crawl What changed in the latest Python release? Cite sources.
/crawl Read https://developer.apple.com/design/human-interface-guidelines/buttons
/crawl Collect up to 5 pages from the Apple HIG and summarise the navigation guidance.
```

If another plugin already uses `/crawl`, use the full name `/stealth-search:crawl`.

## Good to know

- **Your servers, your engines.** SearXNG still sends your queries to whichever upstream engines you enabled on it.
- **The model isn't local.** Search and crawling run on your servers, but the page text still goes to the model provider your Claude Code session uses.
- **A guard, not a firewall.** The plugin blocks Claude's two built-in web tools and points Claude at your servers. It doesn't block other MCP search tools or `curl`. A plugin that needs a specific web provider may clash with it, so turn this one on only when you want this setup.
- **Crawls are bounded.** By default a crawl reads up to 5 pages, one link deep, inside the starting section. Claude tells you when it stopped early or cut a long page short.
- **Use HTTPS if your network isn't trusted.** The token goes to Crawl4AI with every page read.

## Command line

Claude calls a small CLI for you, and you can run it yourself:

```bash
bun scripts/web.ts search 'self-hosted search engines' --limit 5
bun scripts/web.ts fetch 'https://example.com/docs/page' --css-selector main
bun scripts/web.ts research 'self-hosted search engines' --limit 3
bun scripts/web.ts crawl 'https://example.com/docs/' --max-pages 5 --max-depth 1
bun scripts/web.ts fetch 'https://example.com/app' --endpoint stream
bun scripts/web.ts fetch 'https://example.com/docs/page' --endpoint md --filter bm25 --query 'install'
bun scripts/web.ts ask 'https://example.com/docs/page' 'Which versions are supported?'
```

`search` needs only `SEARXNG_URL`. `fetch`, `crawl` and `ask` need `CRAWL4AI_API_URL` and `CRAWL4AI_API_TOKEN`. `research` needs all three. Run `bun scripts/web.ts --help` for every option.

`--endpoint` picks the Crawl4AI API that reads the page: `crawl` (batch, default), `stream` (`/crawl/stream`) or `md` (`/md`, with `--filter fit|raw|bm25|llm` and `--query`). `md` returns no title or links, so `crawl` accepts only `crawl` and `stream`. `ask` uses `/llm`, which needs an LLM provider configured on the Crawl4AI server; without one the server returns HTTP 500 and the command fails. An empty Markdown body or answer is reported as `empty_content`, never as a page.

Every command prints JSON. Success has `"ok": true`. A failure has `"ok": false` and an `error` object, and exits with code 1. Bad arguments exit with code 2.

<details>
<summary>Limits and edge cases</summary>

- Defaults: 5 search results, 3 research results, 5 crawl pages, depth 1, 16,000 Markdown characters per page.
- Maximums: 20 results or fetch URLs, 100 crawl pages, depth 10, 200,000 characters per page.
- Responses over 8 MiB fail. Each request times out after 60 seconds.
- API redirects are refused, so the token can't be forwarded to another host.
- A crawl stays on the starting site and path. Hitting a limit gives `complete: false` and a warning. If a crawl fails partway, the error output still includes the pages collected so far.
- Final page URLs are checked, but Crawl4AI may already have followed a browser redirect by then. This is not SSRF protection.
- SearXNG engine problems (CAPTCHA, timeouts) show up in `warnings`. Zero results while engines are failing is an error, not "nothing found".
- The CLI writes no files or caches. The token is masked in all output.

</details>

## Development

```bash
bun install          # TypeScript and Bun types, for the type check only
bun test
bun run typecheck
claude plugin validate --strict --json .
```

Tests run against a local HTTP fixture with a fake token. Passing tests show the hooks and CLI behave correctly. They don't show that a live Claude session picks this route, so check that by hand.

`dsh/claude-compat.js` is a vendored copy of the claude-plugins-dsh runtime. Don't edit it. From a checkout of that repo, after `pnpm run build`:

```bash
node dist/bin/cli.js sync /path/to/claude-stealth-search-plugin          # refresh the copy
node dist/bin/cli.js sync --check /path/to/claude-stealth-search-plugin  # fail on drift
node dist/bin/cli.js inspect /path/to/claude-stealth-search-plugin       # list what DSH gets
```

## Disclaimer

Unofficial plugin. Not affiliated with Anthropic, SearXNG or Crawl4AI.
