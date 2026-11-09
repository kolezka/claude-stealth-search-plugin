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

let state: { requests: Recorded[]; search: unknown; pages: Record<string, unknown>; redirect?: string };
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
        return respond(state.search);
      }
      const body = (await request.json()) as Json;
      state.requests.push({ method: "POST", path: url.pathname, headers, body });
      if (request.headers.get("authorization") !== "Bearer " + TOKEN) return respond({ detail: "Unauthorized" }, 401);
      if (state.redirect) return new Response(null, { status: 307, headers: { Location: state.redirect } });
      const target = body.urls[0] as string;
      return respond(state.pages[target] ?? page(target));
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
