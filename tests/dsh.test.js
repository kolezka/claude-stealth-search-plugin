import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../dsh/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "stealth-dsh-test-"));
const originalHome = process.env.DSH_HOME;

beforeAll(() => { process.env.DSH_HOME = home; });
afterAll(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function resolveRuntime(adapterDirectory) {
  try {
    return createRequire(join(adapterDirectory, "index.js")).resolve("claude-plugin-dsh/package.json");
  } catch {
    throw new Error("DSH runtime dependency cannot be resolved");
  }
}

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
  test("uses the installed pinned runtime and rejects an unresolved dependency", () => {
    const adapterDirectory = join(root, "dsh");
    const manifest = JSON.parse(readFileSync(join(adapterDirectory, "package.json"), "utf8"));
    expect(manifest.dependencies?.["claude-plugin-dsh"]).toBe("0.2.0");
    expect(readFileSync(join(adapterDirectory, "index.js"), "utf8")).toContain("from 'claude-plugin-dsh'");
    expect(existsSync(join(adapterDirectory, "claude-compat.js"))).toBe(false);
    const resolved = resolveRuntime(adapterDirectory);
    expect(resolved).toContain("/dsh/node_modules/claude-plugin-dsh/");
    expect(JSON.parse(readFileSync(resolved, "utf8")).version).toBe("0.2.0");
    expect(() => resolveRuntime(home)).toThrow("DSH runtime dependency cannot be resolved");
  });

  test("loads the installed dependency in an isolated plugin tree", () => {
    const fixture = mkdtempSync(join(tmpdir(), "stealth-dsh-standalone-"));
    try {
      for (const path of [".claude-plugin", "dsh", "hooks", "scripts", "skills"]) {
        cpSync(join(root, path), join(fixture, path), {
          recursive: true,
          filter: (source) => !source.split("/").includes("node_modules"),
        });
      }
      const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
        cwd: join(fixture, "dsh"), encoding: "utf8",
      });
      expect(install.status).toBe(0);
      const probe = `
        import { createRequire } from 'node:module';
        import { pathToFileURL } from 'node:url';
        import { join } from 'node:path';
        import { readFileSync } from 'node:fs';
        import assert from 'node:assert/strict';
        const adapter = join(process.cwd(), 'dsh/index.js');
        let resolved;
        try { resolved = createRequire(adapter).resolve('claude-plugin-dsh/package.json'); }
        catch { throw new Error('DSH runtime dependency cannot be resolved'); }
        assert.ok(resolved.startsWith(join(process.cwd(), 'dsh/node_modules/claude-plugin-dsh/')));
        const entry = createRequire(adapter).resolve('claude-plugin-dsh');
        assert.ok(entry.startsWith(join(process.cwd(), 'dsh/node_modules/claude-plugin-dsh/')));
        const version = JSON.parse(readFileSync(resolved, 'utf8')).version;
        assert.equal(version, '0.2.0');
        const { default: plugin } = await import(pathToFileURL(adapter));
        const providers = [], listeners = {};
        const ctx = {
          skills: { registerProvider: create => providers.push(create({ signal: new AbortController().signal, invalidate() {} })) },
          logger: { warn() {} },
          inject(names, callback) { if (names.every(name => ctx[name] !== undefined)) callback(ctx); },
          on(event, callback) { (listeners[event] ??= []).push(callback); },
          effect() {},
        };
        plugin.apply(ctx, {});
        const crawl = (await providers[0].list()).find(item => item.name === 'crawl');
        assert.ok(crawl, 'crawl skill is registered');
        const skill = await providers[0].get(crawl);
        assert.match(skill.content, /scripts\\/web\\.ts/);
        assert.ok(listeners['agent/created']?.length, 'session hook is registered');
        assert.ok(listeners['tools/pre-execute']?.length, 'web guard is registered');
        console.log(JSON.stringify({ resolved, entry, version, skill: crawl.name, content: 'scripts/web.ts', events: Object.keys(listeners) }));
      `;
      const run = () => spawnSync("node", ["--input-type=module", "-e", probe], {
        cwd: fixture, encoding: "utf8",
      });
      const positive = run();
      expect(positive.status).toBe(0);
      const output = JSON.parse(positive.stdout);
      expect(output.resolved).toContain("/dsh/node_modules/claude-plugin-dsh/");
      expect(output.skill).toBe("crawl");
      expect(output.content).toBe("scripts/web.ts");
      expect(output.events).toContain("tools/pre-execute");
      console.log(`Standalone adapter: ${positive.stdout.trim()}`);
      const dependency = join(fixture, "dsh/node_modules/claude-plugin-dsh");
      renameSync(dependency, `${dependency}.disabled`);
      const negative = run();
      expect(negative.status).not.toBe(0);
      expect(negative.stderr).toContain("DSH runtime dependency cannot be resolved");
      console.log(`Missing dependency control: exit ${negative.status}, DSH runtime dependency cannot be resolved`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30000);

  test("registers the crawl skill with its usable instructions", async () => {
    const { providers } = setup();
    const candidates = await providers[0].list();
    const crawl = candidates.find((candidate) => candidate.name === "crawl");
    expect(crawl).toBeDefined();
    const skill = await providers[0].get(crawl);
    expect(skill.content).toContain("scripts/web.ts");
    expect(skill.content).toContain("SearXNG");
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

  test.each(["web_search", "web_fetch"])("denies %s when the hook process fails", async (name) => {
    const bin = join(home, `failing-${name}`);
    mkdirSync(bin);
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const { listeners, agent } = setup();
      const denied = await listeners["tools/pre-execute"][0](
        { name, arguments: {}, callId: "failing-hook", agent },
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
