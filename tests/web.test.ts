import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "scripts/web.ts");
const TOKEN = "fixture-token-only";
const SEED = "https://docs.example/guide";

type Json = Record<string, any>;
type Recorded = { method: string; path: string; headers: Record<string, string>; body?: Json };

function page(url = SEED, text = "Meaningful guide content", links: string[] = [], extra: Json = {}): Json {
  return {
    success: true,
    results: [
      {
        url,
        redirected_url: null,
        success: true,
        status_code: 200,
        metadata: { title: "Guide" },
        markdown: { raw_markdown: text },
        links: { internal: links.map((href) => ({ href })), external: [] },
        ...extra,
      },
    ],
  };
}

let state: {
  requests: Recorded[];
  search: unknown;
  pages: Record<string, unknown>;
  redirect?: string;
  stream?: string;
  md?: unknown;
  llm?: { status: number; body: unknown };
};

// What /crawl/stream sends for one page: the result line, then the completion marker.
function streamOf(value: Json): string {
  return value.results.map((item: Json) => JSON.stringify(item) + "\n").join("") + JSON.stringify({ status: "completed" });
}
let env: Record<string, string | undefined>;
let server: ReturnType<typeof Bun.serve>;
let endpoint: string;

function respond(value: unknown, status = 200): Response {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = Object.fromEntries(request.headers.entries());
      if (request.method === "GET") {
        state.requests.push({ method: "GET", path: url.pathname + url.search, headers });
        if (state.redirect) return new Response(null, { status: 302, headers: { Location: state.redirect } });
        if (url.pathname.startsWith("/llm/")) {
          if (request.headers.get("authorization") !== "Bearer " + TOKEN) return respond({ detail: "Unauthorized" }, 401);
          return respond(state.llm?.body ?? { answer: "Fixture answer" }, state.llm?.status ?? 200);
        }
        return respond(state.search);
      }
      const body = (await request.json()) as Json;
      state.requests.push({ method: "POST", path: url.pathname, headers, body });
      if (request.headers.get("authorization") !== "Bearer " + TOKEN) return respond({ detail: "Unauthorized" }, 401);
      if (state.redirect) return new Response(null, { status: 307, headers: { Location: state.redirect } });
      if (url.pathname === "/md") return respond(state.md ?? { url: body.url, filter: body.f, query: body.q ?? null, cache: "0", markdown: "Fit markdown", success: true });
      const target = body.urls[0] as string;
      const result = state.pages[target] ?? page(target);
      if (url.pathname === "/crawl/stream") {
        return new Response(state.stream ?? streamOf(result as Json), { headers: { "Content-Type": "application/x-ndjson" } });
      }
      return respond(result);
    },
  });
  endpoint = "http://127.0.0.1:" + server.port;
});

afterAll(() => server.stop(true));

beforeEach(() => {
  state = {
    requests: [],
    search: { results: [{ url: SEED, title: "Guide", content: "A <b>useful</b> guide &amp; more" }], unresponsive_engines: [] },
    pages: {},
  };
  env = { ...process.env, SEARXNG_URL: endpoint, CRAWL4AI_API_URL: endpoint, CRAWL4AI_API_TOKEN: TOKEN };
  delete env.CRAWL4AI_URL;
});

async function runRaw(...args: string[]) {
  const child = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 10_000);
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, status };
}

async function runCli(...args: string[]) {
  const result = await runRaw(...args);
  expect(result.stdout + result.stderr).not.toContain(TOKEN);
  return { ...result, payload: JSON.parse(result.stdout) as Json };
}

async function expectError(args: string[], code: string) {
  const { status, payload, stdout } = await runCli(...args);
  expect(status, stdout).toBe(1);
  expect(payload.ok).toBe(false);
  expect(payload.error.code).toBe(code);
}

describe("search", () => {
  test("uses SearXNG and encodes the query", async () => {
    delete env.CRAWL4AI_API_TOKEN;
    delete env.CRAWL4AI_API_URL;
    const { status, payload, stderr } = await runCli("search", "Apple & accessibility", "--limit", "1");
    expect(status, stderr).toBe(0);
    expect(payload.results).toEqual([{ url: SEED, title: "Guide", snippet: "A useful guide & more" }]);
    const request = state.requests[0]!;
    const query = new URL(request.path, endpoint).searchParams;
    expect([...query.entries()]).toEqual([["q", "Apple & accessibility"], ["format", "json"]]);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["user-agent"]).toBe("stealth-search-plugin/0.2.0");
  });

  test("preserves engine warnings", async () => {
    (state.search as Json).unresponsive_engines = [["engine", "CAPTCHA"]];
    const { status, payload } = await runCli("search", "guide");
    expect(status).toBe(0);
    expect(JSON.stringify(payload.warnings)).toContain("CAPTCHA");
  });

  test("valid zero results differ from unavailable engines", async () => {
    (state.search as Json).results = [];
    const { status, payload } = await runCli("search", "none");
    expect(status).toBe(0);
    expect(payload.results).toEqual([]);
    (state.search as Json).unresponsive_engines = [["engine", "timeout"]];
    await expectError(["search", "none"], "search_unavailable");
  });

  test("malformed responses fail explicitly", async () => {
    const valid = state.search;
    const cases = [
      "not-json",
      {},
      { results: null },
      { results: {} },
      { results: [null] },
      { results: [{ url: SEED, title: 2, content: "valid" }] },
      { results: [{ url: "file:///etc/passwd", title: "valid", content: "valid" }] },
      { results: [], unresponsive_engines: [["only-one"]] },
    ];
    for (const bad of cases) {
      state.search = bad;
      await expectError(["search", "guide"], "invalid_response");
    }
    state.search = valid;
    expect((await runCli("search", "guide")).status).toBe(0);
  });

  test("missing configuration is not an empty success", async () => {
    delete env.SEARXNG_URL;
    await expectError(["search", "guide"], "configuration_error");
  });

  test("empty query is rejected", async () => {
    await expectError(["search", "   "], "invalid_query");
    expect(state.requests).toEqual([]);
  });
});

describe("fetch", () => {
  test("uses the Bearer token and passes article options", async () => {
    delete env.SEARXNG_URL;
    const { status, payload, stdout } = await runCli("fetch", SEED, "--css-selector", "main", "--wait-for", "css:main");
    expect(status, stdout).toBe(0);
    expect(payload.pages[0].markdown).toBe("Meaningful guide content");
    const request = state.requests[0]!;
    expect(request.headers.authorization).toBe("Bearer " + TOKEN);
    expect(request.body!.crawler_config).toEqual({
      type: "CrawlerRunConfig",
      params: { css_selector: "main", wait_for: "css:main" },
    });
  });

  test("truncation is explicit and counts characters, not UTF-16 units", async () => {
    state.pages[SEED] = page(SEED, "ab😀defghij");
    const { status, payload } = await runCli("fetch", SEED, "--max-chars", "3");
    expect(status).toBe(0);
    expect(payload.pages[0].markdown).toBe("ab😀");
    expect(payload.pages[0].truncated).toBe(true);
    expect(payload.pages[0].original_chars).toBe(10);
  });

  test("rejects malformed or failed results", async () => {
    const valid = page();
    const cases: unknown[] = ["bad-json", {}, { success: true, results: [] }, { success: true, results: null }];
    const fields: [string, unknown][] = [
      ["success", false],
      ["markdown", {}],
      ["markdown", { raw_markdown: "  " }],
      ["links", []],
      ["url", null],
      ["status_code", 500],
      ["metadata", { title: 5 }],
    ];
    for (const [field, value] of fields) {
      const bad = structuredClone(valid);
      bad.results[0][field] = value;
      cases.push(bad);
    }
    for (const bad of cases) {
      state.pages[SEED] = bad;
      const { status, payload } = await runCli("fetch", SEED);
      expect(status).toBe(1);
      expect(payload.ok).toBe(false);
      expect(payload.error).toBeDefined();
    }
    state.pages[SEED] = valid;
    expect((await runCli("fetch", SEED)).status).toBe(0);
  });

  test("reads the base URL from CRAWL4AI_API_URL only", async () => {
    delete env.CRAWL4AI_API_URL;
    env.CRAWL4AI_URL = endpoint;
    const { status, payload } = await runCli("fetch", SEED);
    expect(status).toBe(1);
    expect(payload.error.code).toBe("configuration_error");
    expect(payload.error.message).toContain("CRAWL4AI_API_URL");
  });

  test("missing and wrong tokens are errors", async () => {
    delete env.CRAWL4AI_API_TOKEN;
    await expectError(["fetch", SEED], "configuration_error");
    env.CRAWL4AI_API_TOKEN = "incorrect-fixture-token";
    await expectError(["fetch", SEED], "http_error");
  });

  test("the token never appears in output, even when echoed back", async () => {
    state.pages[SEED] = page(SEED, "leaked " + TOKEN);
    const { status, payload } = await runCli("fetch", SEED);
    expect(status).toBe(0);
    expect(payload.pages[0].markdown).toBe("leaked <REDACTED>");
  });

  test("backend redirects are not followed", async () => {
    state.redirect = endpoint + "/credential-trap";
    await expectError(["fetch", SEED], "http_error");
    expect(state.requests.length).toBe(1);
    state.requests = [];
    await expectError(["search", "guide"], "http_error");
    expect(state.requests.length).toBe(1);
  });

  test("invalid URLs are rejected before any request", async () => {
    for (const url of [
      "file:///etc/passwd",
      "https://user:password@docs.example/guide",
      "https://docs.example:bad/guide",
      "https://docs.example/with space",
    ]) {
      await expectError(["fetch", url], "invalid_url");
    }
    expect(state.requests).toEqual([]);
  });

  test("more than 20 URLs is rejected", async () => {
    const urls = Array.from({ length: 21 }, (_, index) => SEED + "/" + index);
    await expectError(["fetch", ...urls], "invalid_input");
    expect(state.requests).toEqual([]);
  });

  test("relative links resolve against the final URL", async () => {
    state.pages[SEED] = page(SEED, undefined, ["child", "#part", "mailto:someone@docs.example"], { redirected_url: SEED + "/" });
    const { status, payload } = await runCli("fetch", SEED);
    expect(status).toBe(0);
    expect(payload.pages[0].url).toBe(SEED + "/");
    expect(payload.pages[0].links).toEqual([SEED + "/child", SEED + "/"]);
  });
});

describe("research", () => {
  test("combines selected sources and pages", async () => {
    const { status, payload, stdout } = await runCli("research", "guide", "--limit", "1");
    expect(status, stdout).toBe(0);
    expect(payload.results[0].url).toBe(SEED);
    expect(payload.pages[0].requested_url).toBe(SEED);
    expect(state.requests.map((item) => item.method)).toEqual(["GET", "POST"]);
  });
});

describe("crawl", () => {
  test("follows only the subtree and drops fragments", async () => {
    const child = SEED + "/child";
    state.pages[SEED] = page(SEED, undefined, [
      child + "#one",
      child + "#two",
      SEED + "#top",
      "https://other.example/guide",
      "https://docs.example/guide-other",
      "https://docs.example/guide/%2e%2e/outside",
    ]);
    state.pages[child] = page(child);
    const { status, payload, stdout } = await runCli("crawl", SEED, "--max-pages", "5", "--max-depth", "2");
    expect(status, stdout).toBe(0);
    expect(state.requests.map((item) => item.body!.urls[0])).toEqual([SEED, child]);
    expect(payload.pages.map((item: Json) => item.url)).toEqual([SEED, child]);
    expect(payload.complete).toBe(true);
  });

  test("page and depth limits are visible", async () => {
    state.pages[SEED] = page(SEED, undefined, [SEED + "/a", SEED + "/b"]);
    let result = await runCli("crawl", SEED, "--max-pages", "1");
    expect(result.status).toBe(0);
    expect(state.requests.length).toBe(1);
    expect(result.payload.complete).toBe(false);
    expect(result.payload.warnings.length).toBeGreaterThan(0);
    state.requests = [];
    result = await runCli("crawl", SEED, "--max-depth", "0");
    expect(result.status).toBe(0);
    expect(state.requests.length).toBe(1);
    expect(result.payload.complete).toBe(false);
  });

  test("an out-of-scope redirect is refused and keeps collected pages", async () => {
    state.pages[SEED] = page(SEED, undefined, [], { redirected_url: "https://other.example/outside" });
    await expectError(["crawl", SEED], "out_of_scope");
    state.pages[SEED] = page(SEED, undefined, [], { redirected_url: "https://docs.example/other" });
    await expectError(["crawl", SEED], "out_of_scope");

    const child = SEED + "/child";
    state.pages[SEED] = page(SEED, undefined, [child]);
    state.pages[child] = page(child, undefined, [], { redirected_url: "https://other.example/" });
    const { payload } = await runCli("crawl", SEED);
    expect(payload.ok).toBe(false);
    expect(payload.complete).toBe(false);
    expect(payload.pages.map((item: Json) => item.url)).toEqual([SEED]);
  });
});

describe("fetch --endpoint stream", () => {
  test("reads the page from /crawl/stream with the same options", async () => {
    const { status, payload, stdout } = await runCli("fetch", SEED, "--endpoint", "stream", "--wait-for", "css:main");
    expect(status, stdout).toBe(0);
    expect(payload.pages[0].markdown).toBe("Meaningful guide content");
    expect(payload.pages[0].title).toBe("Guide");
    const request = state.requests[0]!;
    expect(request.path).toBe("/crawl/stream");
    expect(request.headers.authorization).toBe("Bearer " + TOKEN);
    expect(request.body!.crawler_config.params).toEqual({ wait_for: "css:main" });
  });

  test("rejects a truncated, failed or malformed stream", async () => {
    const line = JSON.stringify(page().results[0]);
    const cases: [string, string][] = [
      [line + "\n", "invalid_response"],
      [line + "\n" + JSON.stringify({ status: "error", error: "Crawl exceeded the time limit" }), "crawl_failed"],
      [JSON.stringify({ error: "Serialization error", url: SEED }) + "\n" + JSON.stringify({ status: "completed" }), "crawl_failed"],
      [JSON.stringify({ status: "completed" }), "invalid_response"],
      [line + "\n" + line + "\n" + JSON.stringify({ status: "completed" }), "invalid_response"],
      ["not-json\n" + JSON.stringify({ status: "completed" }), "invalid_response"],
      [JSON.stringify({ status: "completed" }) + "\n" + line, "invalid_response"],
    ];
    for (const [stream, code] of cases) {
      state.stream = stream;
      await expectError(["fetch", SEED, "--endpoint", "stream"], code);
    }
    const empty = structuredClone(page());
    empty.results[0].markdown = { raw_markdown: " " };
    state.stream = streamOf(empty);
    await expectError(["fetch", SEED, "--endpoint", "stream"], "invalid_response");
    state.stream = undefined;
    expect((await runCli("fetch", SEED, "--endpoint", "stream")).status).toBe(0);
  });

  test("crawl follows links found through the stream endpoint", async () => {
    const child = SEED + "/child";
    state.pages[SEED] = page(SEED, undefined, [child]);
    const { status, payload } = await runCli("crawl", SEED, "--endpoint", "stream");
    expect(status).toBe(0);
    expect(state.requests.map((item) => item.path)).toEqual(["/crawl/stream", "/crawl/stream"]);
    expect(payload.pages.map((item: Json) => item.url)).toEqual([SEED, child]);
  });
});

describe("fetch --endpoint md", () => {
  test("sends the filter and query and returns the Markdown", async () => {
    const { status, payload, stdout } = await runCli("fetch", SEED, "--endpoint", "md", "--filter", "bm25", "--query", "guide");
    expect(status, stdout).toBe(0);
    expect(state.requests[0]!.path).toBe("/md");
    expect(state.requests[0]!.body).toEqual({ url: SEED, f: "bm25", q: "guide" });
    expect(payload.pages[0]).toEqual({
      requested_url: SEED,
      url: SEED,
      title: "",
      markdown: "Fit markdown",
      original_chars: 12,
      truncated: false,
      links: [],
    });
  });

  test("defaults to the fit filter without a query", async () => {
    expect((await runCli("fetch", SEED, "--endpoint", "md")).status).toBe(0);
    expect(state.requests[0]!.body).toEqual({ url: SEED, f: "fit" });
  });

  test("an empty Markdown body with success true is an error, not a page", async () => {
    state.md = { url: SEED, filter: "llm", query: "q", cache: "0", markdown: "\n", success: true };
    const { payload } = await runCli("fetch", SEED, "--endpoint", "md", "--filter", "llm", "--query", "q");
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("empty_content");
    expect(payload.error.message).toContain("LLM provider");
    for (const bad of [{ ...(state.md as Json), success: false, markdown: "text" }, { success: true, url: SEED }, "bad-json"]) {
      state.md = bad;
      const result = await runCli("fetch", SEED, "--endpoint", "md");
      expect(result.status).toBe(1);
      expect(result.payload.ok).toBe(false);
    }
  });

  test("research reads the found sources through /md", async () => {
    const { status, payload } = await runCli("research", "guide", "--limit", "1", "--endpoint", "md");
    expect(status).toBe(0);
    expect(state.requests.map((item) => item.path.split("?")[0])).toEqual(["/search", "/md"]);
    expect(payload.pages[0].markdown).toBe("Fit markdown");
  });
});

describe("ask", () => {
  test("sends the URL in the path and the question as q", async () => {
    const target = SEED + "?page=2&q=trap";
    const { status, payload, stdout } = await runCli("ask", target, "What & why?");
    expect(status, stdout).toBe(0);
    expect(payload).toEqual({ ok: true, url: target, question: "What & why?", answer: "Fixture answer" });
    const request = state.requests[0]!;
    expect(request.headers.authorization).toBe("Bearer " + TOKEN);
    const sent = new URL(request.path, endpoint);
    expect(decodeURIComponent(sent.pathname)).toBe("/llm/" + target);
    expect([...sent.searchParams.entries()]).toEqual([["q", "What & why?"]]);
  });

  test("a server without an LLM provider is an error, as is an empty answer", async () => {
    state.llm = { status: 500, body: { error: "Internal server error" } };
    await expectError(["ask", SEED, "question"], "http_error");
    for (const body of [{ answer: "  " }, { answer: null }, {}]) {
      state.llm = { status: 200, body };
      await expectError(["ask", SEED, "question"], "empty_content");
    }
  });

  test("invalid URLs and empty questions are rejected before any request", async () => {
    await expectError(["ask", "file:///etc/passwd", "question"], "invalid_url");
    await expectError(["ask", SEED, "   "], "invalid_query");
    expect(state.requests).toEqual([]);
  });
});

describe("arguments", () => {
  const badArguments: string[][] = [
    ["search", "guide", "--limit", "0"],
    ["search", "guide", "--limit", "five"],
    ["crawl", SEED, "--max-pages", "101"],
    ["crawl", SEED, "--max-depth", "-1"],
    ["search", "guide", "--max-chars", "10"],
    ["fetch"],
    ["search", "a", "b"],
    ["unknown"],
    ["fetch", SEED, "--endpoint", "html"],
    ["crawl", SEED, "--endpoint", "md"],
    ["fetch", SEED, "--endpoint", "md", "--css-selector", "main"],
    ["fetch", SEED, "--endpoint", "md", "--wait-for", "css:main"],
    ["fetch", SEED, "--endpoint", "md", "--filter", "summary"],
    ["fetch", SEED, "--endpoint", "md", "--query", "guide"],
    ["fetch", SEED, "--endpoint", "md", "--filter", "fit", "--query", "guide"],
    ["fetch", SEED, "--filter", "bm25"],
    ["fetch", SEED, "--endpoint", "stream", "--query", "guide"],
    ["search", "guide", "--endpoint", "md"],
    ["ask", SEED],
    ["ask", SEED, "question", "--endpoint", "md"],
  ];
  test.each(badArguments.map((args) => [args] as const))("rejects %j with exit 2 and no request", async (args) => {
    const result = await runRaw(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage:");
    expect(state.requests).toEqual([]);
  });

  test("--help prints usage and exits 0", async () => {
    const result = await runRaw("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage:");
  });
});
