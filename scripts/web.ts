#!/usr/bin/env bun
// Self-hosted search and page retrieval, with JSON output.
import { posix } from "node:path";
import { parseArgs } from "node:util";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const USER_AGENT = "stealth-search-plugin/0.2.0";

type Json = Record<string, unknown>;

interface Page {
  requested_url: string;
  url: string;
  title: string;
  markdown: string;
  original_chars: number;
  truncated: boolean;
  links: string[];
}

interface PageOptions {
  maxChars: number;
  cssSelector?: string;
  waitFor?: string;
}

export class WebError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Json = {},
  ) {
    super(message);
  }
}

class UsageError extends Error {}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validUrl(value: unknown, code = "invalid_url"): string {
  const fail = () =>
    new WebError(code, "Expected an absolute HTTP(S) URL without credentials, whitespace or an invalid port.");
  if (typeof value !== "string" || !value || /[\s\x00-\x1f\\]/.test(value)) throw fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw fail();
  url.hash = "";
  return url.href;
}

function endpoint(name: string): string {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) throw new WebError("configuration_error", "Set " + name + " in the environment.");
  const value = validUrl(raw, "configuration_error");
  if (new URL(value).search) throw new WebError("configuration_error", name + " must be a base URL without a query.");
  return value.replace(/\/+$/, "");
}

async function readCapped(response: Response, service: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new WebError("response_too_large", service + " exceeded the 8 MiB response limit.");
      }
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

async function requestJson(url: string, service: string, token?: string, data?: unknown): Promise<Json> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (token !== undefined) headers.Authorization = "Bearer " + token;
  let body: string | undefined;
  if (data !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(data);
  }
  let raw: Uint8Array;
  try {
    // Redirects are refused so the Bearer token cannot be forwarded to another host.
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new WebError(
        "http_error",
        service + " returned HTTP " + response.status + ". Redirects are not followed; check the endpoint and credentials.",
      );
    }
    raw = await readCapped(response, service);
  } catch (error) {
    if (error instanceof WebError) throw error;
    throw new WebError("transport_error", service + " could not be reached or timed out.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new WebError("invalid_response", service + " returned invalid JSON.");
  }
  if (!isObject(decoded)) throw new WebError("invalid_response", service + " must return a JSON object.");
  return decoded;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function plainText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>|<![^>]*>|<\?[^>]*>/g, "")
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
      if (entity[0] !== "#") return NAMED_ENTITIES[entity] ?? match;
      const point = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    });
}

async function search(base: string, query: string, limit: number): Promise<Json> {
  const response = await requestJson(base + "/search?" + new URLSearchParams({ q: query, format: "json" }), "SearXNG");
  if (!Array.isArray(response.results)) throw new WebError("invalid_response", "SearXNG results must be an array.");
  const failures = response.unresponsive_engines === undefined ? [] : response.unresponsive_engines;
  if (
    !Array.isArray(failures) ||
    failures.some((item) => !Array.isArray(item) || item.length !== 2 || !item.every((part) => typeof part === "string"))
  ) {
    throw new WebError("invalid_response", "SearXNG engine warnings are malformed.");
  }
  const warnings = (failures as [string, string][]).map(([engine, error]) => "SearXNG " + engine + ": " + error);
  const results: Json[] = [];
  const seen = new Set<string>();
  for (const item of response.results) {
    if (!isObject(item) || !["url", "title", "content"].every((key) => typeof item[key] === "string")) {
      throw new WebError("invalid_response", "SearXNG result fields must be strings.");
    }
    const url = validUrl(item.url, "invalid_response");
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, title: item.title, snippet: plainText(item.content as string) });
  }
  if (!results.length && warnings.length) {
    throw new WebError("search_unavailable", "SearXNG returned no results and reported engine failures.", { warnings });
  }
  return { ok: true, query, results: results.slice(0, limit), warnings };
}

function crawlCredentials(): [string, string] {
  const base = endpoint("CRAWL4AI_API_URL");
  const token = (process.env.CRAWL4AI_API_TOKEN ?? "").trim();
  if (!token || /[^\x20-\x7e]/.test(token)) {
    throw new WebError("configuration_error", "Set a nonempty ASCII CRAWL4AI_API_TOKEN without control characters.");
  }
  return [base, token];
}

async function fetchPage(base: string, token: string, url: string, options: PageOptions): Promise<Page> {
  const request: Json = { urls: [url] };
  const params: Json = {};
  if (options.cssSelector) params.css_selector = options.cssSelector;
  if (options.waitFor) params.wait_for = options.waitFor;
  if (Object.keys(params).length) request.crawler_config = { type: "CrawlerRunConfig", params };
  const response = await requestJson(base + "/crawl", "Crawl4AI", token, request);
  const results = response.results;
  if (response.success !== true || !Array.isArray(results) || results.length !== 1 || !isObject(results[0])) {
    throw new WebError("invalid_response", "Crawl4AI must return one successful page for the requested URL.");
  }
  const result = results[0];
  const status = result.status_code;
  if (
    result.success !== true ||
    (status !== undefined && status !== null && (!Number.isInteger(status) || (status as number) < 200 || (status as number) >= 300))
  ) {
    throw new WebError("crawl_failed", "Crawl4AI reported an unsuccessful page.");
  }
  const returnedUrl = validUrl(result.url, "invalid_response");
  const final = result.redirected_url;
  const finalUrl = final === undefined || final === null ? returnedUrl : validUrl(final, "invalid_response");
  const rawMarkdown = isObject(result.markdown) ? result.markdown.raw_markdown : result.markdown;
  if (typeof rawMarkdown !== "string" || !rawMarkdown.trim()) {
    throw new WebError("invalid_response", "Crawl4AI returned no meaningful Markdown.");
  }
  const metadata = result.metadata === undefined || result.metadata === null ? {} : result.metadata;
  if (!isObject(metadata) || (metadata.title !== undefined && typeof metadata.title !== "string")) {
    throw new WebError("invalid_response", "Crawl4AI page metadata is malformed.");
  }
  const linkGroups = result.links;
  if (!isObject(linkGroups)) throw new WebError("invalid_response", "Crawl4AI page links must be an object.");
  const links: string[] = [];
  const seen = new Set<string>();
  for (const group of ["internal", "external"]) {
    const items = linkGroups[group] === undefined ? [] : linkGroups[group];
    if (!Array.isArray(items)) throw new WebError("invalid_response", "Crawl4AI link groups must be arrays.");
    for (const item of items) {
      if (!isObject(item) || typeof item.href !== "string") {
        throw new WebError("invalid_response", "Crawl4AI links must include a string href.");
      }
      let href: string;
      try {
        href = validUrl(new URL(item.href, finalUrl).href);
      } catch {
        continue; // Mail, script and credential-bearing links are not crawl targets.
      }
      if (!seen.has(href)) {
        links.push(href);
        seen.add(href);
      }
    }
  }
  // Count code points, not UTF-16 units, so truncation never splits a character.
  const chars = Array.from(rawMarkdown);
  return {
    requested_url: url,
    url: finalUrl,
    title: (metadata.title as string | undefined) ?? "",
    markdown: chars.slice(0, options.maxChars).join(""),
    original_chars: chars.length,
    truncated: chars.length > options.maxChars,
    links,
  };
}

function scopeKey(value: string): [string, string] {
  const url = new URL(value);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname || "/");
  } catch {
    path = url.pathname || "/";
  }
  path = posix.normalize(path);
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return [url.protocol + "//" + url.hostname + ":" + port, path];
}

export function inScope(seed: string, candidate: string): boolean {
  const [origin, path] = scopeKey(seed);
  const [candidateOrigin, candidatePath] = scopeKey(candidate);
  return (
    origin === candidateOrigin &&
    (path === "/" || candidatePath === path || candidatePath.startsWith(path.replace(/\/+$/, "") + "/"))
  );
}

async function crawl(base: string, token: string, seed: string, options: PageOptions & { maxPages: number; maxDepth: number }): Promise<Json> {
  const queue: [string, number][] = [[seed, 0]];
  const seen = new Set([seed]);
  const pages: Page[] = [];
  let limited = false;
  while (queue.length && pages.length < options.maxPages) {
    const [url, depth] = queue.shift()!;
    let current: Page;
    try {
      current = await fetchPage(base, token, url, options);
      if (!inScope(seed, current.url)) {
        throw new WebError("out_of_scope", "Crawled page redirected outside the seed origin or path subtree.");
      }
    } catch (error) {
      if (error instanceof WebError) Object.assign(error.context, { pages, complete: false });
      throw error;
    }
    pages.push(current);
    for (const link of current.links) {
      if (seen.has(link) || !inScope(seed, link)) continue;
      if (depth === options.maxDepth) {
        limited = true;
        continue;
      }
      seen.add(link);
      queue.push([link, depth + 1]);
    }
  }
  limited ||= queue.length > 0;
  return {
    ok: true,
    pages,
    complete: !limited,
    warnings: limited ? ["Crawl stopped at the configured page or depth limit; this is not a complete site archive."] : [],
  };
}

const COMMANDS = ["search", "research", "fetch", "crawl"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `usage: web.ts {search,research,fetch,crawl} ...

  search QUERY [--limit 1-20 (default 5)]
  research QUERY [--limit 1-20 (default 3)] [page options]
  fetch URL [URL ...] [page options]
  crawl URL [--max-pages 1-100 (default 5)] [--max-depth 0-10 (default 1)] [page options]

page options: --max-chars 1-200000 (default 16000), --css-selector SELECTOR, --wait-for CONDITION`;

function boundedInteger(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const number = /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : NaN;
  if (Number.isInteger(number) && number >= minimum && number <= maximum) return number;
  throw new UsageError("argument --" + name + ": must be between " + minimum + " and " + maximum);
}

interface Args extends PageOptions {
  command: Command;
  positionals: string[];
  limit: number;
  maxPages: number;
  maxDepth: number;
}

export function parseCommandLine(argv: string[]): Args | "help" {
  if (argv[0] === "-h" || argv[0] === "--help") return "help";
  const command = argv[0] as Command;
  if (!COMMANDS.includes(command)) throw new UsageError("choose a command: " + COMMANDS.join(", "));
  const options: Record<string, { type: "string" | "boolean"; short?: string }> = { help: { type: "boolean", short: "h" } };
  if (command === "search" || command === "research") options.limit = { type: "string" };
  if (command !== "search") {
    options["max-chars"] = { type: "string" };
    options["css-selector"] = { type: "string" };
    options["wait-for"] = { type: "string" };
  }
  if (command === "crawl") {
    options["max-pages"] = { type: "string" };
    options["max-depth"] = { type: "string" };
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv.slice(1), options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help) return "help";
  const positionals = parsed.positionals;
  if (command === "fetch" ? positionals.length < 1 : positionals.length !== 1) {
    throw new UsageError(command === "fetch" ? "fetch needs at least one URL" : command + " needs exactly one argument");
  }
  const text = (name: string) => values[name] as string | undefined;
  return {
    command,
    positionals,
    limit: boundedInteger("limit", text("limit"), command === "search" ? 5 : 3, 1, 20),
    maxChars: boundedInteger("max-chars", text("max-chars"), 16000, 1, 200000),
    maxPages: boundedInteger("max-pages", text("max-pages"), 5, 1, 100),
    maxDepth: boundedInteger("max-depth", text("max-depth"), 1, 0, 10),
    cssSelector: text("css-selector"),
    waitFor: text("wait-for"),
  };
}

async function run(args: Args): Promise<Json> {
  const searchBase = args.command === "search" || args.command === "research" ? endpoint("SEARXNG_URL") : undefined;
  const credentials = args.command !== "search" ? crawlCredentials() : undefined;
  const query = args.positionals[0]!;
  if (args.command === "search") {
    if (!query.trim()) throw new WebError("invalid_query", "Search query must not be empty.");
    return search(searchBase!, query, args.limit);
  }
  const [base, token] = credentials!;
  if (args.command === "crawl") return crawl(base, token, validUrl(query), args);
  let output: Json;
  let urls: string[];
  if (args.command === "research") {
    if (!query.trim()) throw new WebError("invalid_query", "Search query must not be empty.");
    output = await search(searchBase!, query, args.limit);
    urls = (output.results as Json[]).map((item) => item.url as string);
  } else {
    output = { ok: true, warnings: [] };
    if (args.positionals.length > 20) throw new WebError("invalid_input", "Fetch accepts at most 20 URLs per invocation.");
    urls = [...new Set(args.positionals.map((url) => validUrl(url)))];
  }
  const pages: Page[] = [];
  output.pages = pages;
  for (const url of urls) {
    try {
      pages.push(await fetchPage(base, token, url, args));
    } catch (error) {
      if (error instanceof WebError) Object.assign(error.context, { pages, warnings: output.warnings, complete: false });
      throw error;
    }
  }
  return output;
}

async function main(): Promise<number> {
  let args: Args | "help";
  try {
    args = parseCommandLine(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(USAGE + "\nweb.ts: error: " + error.message);
    return 2;
  }
  if (args === "help") {
    console.log(USAGE);
    return 0;
  }
  let output: Json;
  let status = 0;
  try {
    output = await run(args);
  } catch (error) {
    if (!(error instanceof WebError)) throw error;
    output = { ok: false, error: { code: error.code, message: error.message }, ...error.context };
    status = 1;
  }
  let serialized = JSON.stringify(output);
  const token = process.env.CRAWL4AI_API_TOKEN ?? "";
  if (token) serialized = serialized.replaceAll(token, "<REDACTED>");
  console.log(serialized);
  return status;
}

if (import.meta.main) process.exitCode = await main();
