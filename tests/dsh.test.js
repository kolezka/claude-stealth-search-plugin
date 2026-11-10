import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../dsh/index.js";

const home = mkdtempSync(join(tmpdir(), "stealth-dsh-test-"));
const originalHome = process.env.DSH_HOME;

beforeAll(() => { process.env.DSH_HOME = home; });
afterAll(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function setup() {
  const listeners = {};
  const providers = [];
  const ctx = {
    skills: { registerProvider: (create) => providers.push(create({ signal: new AbortController().signal, invalidate() {} })) },
    logger: { warn() {} },
    inject(names, callback) { if (names.every((name) => ctx[name] !== undefined)) callback(ctx); },
    on(event, callback) { (listeners[event] ??= []).push(callback); },
    effect() {},
  };
  plugin.apply(ctx, {});
  const injected = [];
  const agent = {
    session: { header: { id: "test-session", cwd: home }, ownEvents: () => [] },
    inject: (message) => injected.push(message),
  };
  return { listeners, providers, agent, injected };
}

describe("DSH adapter", () => {
  test("registers the crawl skill with its usable instructions", async () => {
    const { providers } = setup();
    const candidates = await providers[0].list();
    const crawl = candidates.find((candidate) => candidate.name === "crawl");
    expect(crawl).toBeDefined();
    const skill = await providers[0].get(crawl);
    expect(skill.content).toContain("scripts/web.ts");
  });

  test("injects the search instructions at session start", async () => {
    const { listeners, agent, injected } = setup();
    await listeners["agent/created"][0]({ agent, source: "startup" });
    expect(injected).toHaveLength(1);
    expect(injected[0].content[0].text).toContain("/stealth-search:crawl");
    expect(injected[0].content[0].text).toContain("scripts/web.ts");
  });

  test.each(["web_search", "web_fetch"])("denies %s but permits an unrelated tool", async (name) => {
    const { listeners, agent } = setup();
    const pre = listeners["tools/pre-execute"][0];
    const next = async () => ({ kind: "allow" });
    const denied = await pre({ name, arguments: {}, callId: name, agent }, next);
    expect(denied.kind).toBe("deny");
    expect(denied.reason).toContain("/stealth-search:crawl");
    expect(await pre({ name: "read", arguments: {}, callId: "read", agent }, next)).toEqual({ kind: "allow" });
  });

  test("denies web search when the hook process fails", async () => {
    const bin = join(home, "failing-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const { listeners, agent } = setup();
      const denied = await listeners["tools/pre-execute"][0](
        { name: "web_search", arguments: {}, callId: "failing-hook", agent },
        async () => ({ kind: "allow" }),
      );
      expect(denied.kind).toBe("deny");
      expect(denied.reason).toContain('onFailure is "block"');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
