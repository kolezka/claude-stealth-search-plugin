import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleHook } from "../scripts/hooks.js";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8"));

function invoke(event, input, pluginRoot = root, options = {}) {
  const entry = manifest.hooks[event][0].hooks[0];
  const args = entry.args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot));
  return spawnSync(entry.command, args, { input, encoding: "utf8", timeout: 5000, ...options });
}

describe("hook logic", () => {
  test("SessionStart advertises the real Python CLI and crawl skill", () => {
    const output = handleHook("session-start", {}).hookSpecificOutput;
    expect(output.hookEventName).toBe("SessionStart");
    expect(output.additionalContext).toContain("/crawl (full name: /crawl4ai:crawl)");
    expect(output.additionalContext).toContain(`python3 -I ${join(root, "scripts/web.py")}`);
    expect(output.additionalContext).toContain("SearXNG");
    expect(output.additionalContext).toContain("Crawl4AI");
  });

  test.each(["WebSearch", "WebFetch"])("denies %s", (tool) => {
    const output = handleHook("pre-tool", { tool_name: tool }).hookSpecificOutput;
    expect(output.hookEventName).toBe("PreToolUse");
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("/crawl (full name: /crawl4ai:crawl)");
    expect(output.permissionDecisionReason).toContain("python3 -I");
  });

  test.each(["Bash", "Read", "mcp__exa__web_search_exa", "OtherWebSearch"])("leaves %s undecided", (tool) => {
    expect(handleHook("pre-tool", { tool_name: tool })).toEqual({});
  });

  for (const event of ["session-start", "pre-tool"]) {
    test.each([null, [], true, 42, "text"].map((payload) => [payload]))(`${event} rejects a non-object payload: %j`, (payload) => {
      expect(() => handleHook(event, payload)).toThrow("invalid_hook_input");
    });
  }

  test.each([{}, { tool_name: null }, { tool_name: 123 }])("rejects invalid tool names: %j", (payload) => {
    expect(() => handleHook("pre-tool", payload)).toThrow("invalid_hook_input");
  });

  test("rejects unknown events", () => {
    expect(() => handleHook("unknown", {})).toThrow("invalid_hook_input");
  });
});

describe("shipped hook entry points", () => {
  test("both hooks run with Bun alone and no service configuration", () => {
    const bin = mkdtempSync(join(tmpdir(), "crawl-bun-"));
    try {
      symlinkSync(process.execPath, join(bin, "bun"));
      const options = { env: { PATH: bin } };
      const control = spawnSync("bun", ["--version"], { ...options, encoding: "utf8" });
      expect(control.status).toBe(0);
      expect(control.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(spawnSync("python3", ["--version"], options).error?.code).toBe("ENOENT");
      for (const [event, input] of [["SessionStart", "{}"], ["PreToolUse", '{"tool_name":"WebSearch"}'], ["PreToolUse", '{"tool_name":"WebFetch"}']]) {
        expect(manifest.hooks[event][0].hooks[0].command).toBe("bun");
        const result = invoke(event, input, root, options);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const output = JSON.parse(result.stdout).hookSpecificOutput;
        expect(output.hookEventName).toBe(event);
        if (event === "PreToolUse") expect(output.permissionDecision).toBe("deny");
        else expect(output.additionalContext).toContain("/crawl4ai:crawl");
      }
      expect(manifest.hooks.PreToolUse[0].hooks[0].onFailure).toBe("block");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  for (const event of ["SessionStart", "PreToolUse"]) {
    test.each(["", "not-json", "[]", "null", "true", "42", '"text"'])(`${event} rejects invalid stdin: %j`, (input) => {
      const result = invoke(event, input);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("crawl4ai: invalid_hook_input\n");
    });
  }

  test.each(["{}", '{"tool_name":null}', '{"tool_name":123}'])("PreToolUse rejects invalid tool input: %s", (input) => {
    const result = invoke("PreToolUse", input);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("crawl4ai: invalid_hook_input\n");
  });

  test.each(["Bash", "Read", "mcp__exa__web_search_exa", "OtherWebSearch"])("entry point leaves %s undecided", (tool) => {
    const result = invoke("PreToolUse", JSON.stringify({ tool_name: tool }));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  test("rejects invalid UTF-8 instead of accepting replacement characters", () => {
    const result = invoke("PreToolUse", Buffer.from('{"tool_name":"WebS\xffearch"}', "latin1"));
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("crawl4ai: invalid_hook_input\n");
  });

  test("rejects missing, unknown and extra event arguments", () => {
    const entry = manifest.hooks.SessionStart[0].hooks[0];
    const script = entry.args[0].replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
    for (const args of [[], ["unknown"], ["session-start", "extra"]]) {
      const result = spawnSync(entry.command, [script, ...args], { input: "{}", encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("crawl4ai: invalid_hook_input\n");
    }
  });

  test("exec-form and advertised commands preserve paths containing shell characters", () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "crawl Ż ' $ ")));
    try {
      mkdirSync(join(folder, "scripts"));
      copyFileSync(join(root, "scripts/hooks.js"), join(folder, "scripts/hooks.js"));
      const bin = join(folder, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "python3"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      for (const [event, input] of [["SessionStart", "{}"], ["PreToolUse", '{"tool_name":"WebSearch"}'], ["PreToolUse", '{"tool_name":"WebFetch"}']]) {
        const result = invoke(event, input, folder);
        expect(result.status).toBe(0);
        const output = JSON.parse(result.stdout).hookSpecificOutput;
        const command = event === "SessionStart"
          ? output.additionalContext.split("CLI: ")[1].split(";")[0]
          : output.permissionDecisionReason.split("Run ")[1].split(" or fetch")[0];
        const executed = spawnSync("/bin/sh", ["-c", command], { env: { PATH: bin }, encoding: "utf8", timeout: 5000 });
        expect(executed.status).toBe(0);
        expect(executed.stdout.trimEnd().split("\n")).toEqual(["-I", join(folder, "scripts/web.py"), "search", "QUERY"]);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
