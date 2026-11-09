# Crawl4AI Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Provide a Claude Code plugin for self-hosted search and page retrieval without MCP.

**Architecture:** A Python standard-library CLI implements search/fetch/research/bounded crawl. Plugin-scoped command hooks advertise the skill and deny built-in WebSearch/WebFetch. Configuration is environment-only, without persisted tokens or global settings edits.

**Tech Stack:** Bun hooks and bun:test, Python 3.10+ CLI, unittest, urllib, Claude Code 2.1.319 plugin validator.

**Spec:** `docs/superpowers/specs/2026-11-09-selfhosted-web-design.md`

## Global Constraints
- No MCP, dependencies, saved secrets, public-service fallback, global install, settings changes, commits, pushes, or service mutations.
- English files and identifiers, plain comments, no long dashes.
- Work only in `/Users/me/Development/selfhosted-web-worktree`, branch `feat/selfhosted-web` (unborn, no baseline commit).
- Read the target before editing. Scope tests while iterating; full suite once before handoff.

## Review Focus
- A 200 response with malformed/empty fields must not look like a useful search or page.
- Service redirects must never forward the Crawl4AI token.
- Link following must stay in the seed origin and path subtree and obey limits even with redirects/fragments.
- Hook errors and unusual plugin path characters must not silently disable the WebSearch/WebFetch guard.
- Engine failures and per-page failures must remain visible rather than be reported as complete success.

### Task 1: HTTP CLI

**Files:** Create `scripts/web.py`, `tests/test_web.py`, `.gitignore`.

**Interfaces:** `python3 scripts/web.py search QUERY --limit 5`; `fetch URL [URL ...] --max-chars 16000`; `research QUERY --limit 3 --max-chars 16000`; `crawl URL --max-pages 5 --max-depth 1 --max-chars 16000`. Success is JSON on stdout, errors are structured and exit nonzero. Hooks do not import the HTTP client.

- [ ] Write subprocess-facing unittest fixtures with a local HTTP server. Use a valid result as positive control. Corrupt each relevant field independently, including absent/malformed result arrays, invalid Markdown, successful outer response with failed result, and refused auth. Include valid zero-result and zero-with-engine-errors cases.
- [ ] Run a targeted RED case after creating only the minimum runnable entry point, failing on its contract assertion rather than import/setup failure. Retain the failing output and exit code outside the repository.
- [ ] Implement strict JSON transport and environment validation. Forbid API redirects. Propagate Bearer auth only to Crawl4AI. Strip HTML from SearXNG snippets without changing source URLs. Retain useful engine warnings. Report truncation explicitly.
- [ ] Implement bounded client-side crawl using discovered links. Stay in the seed's origin and path subtree, normalize fragments for deduplication, and validate followed/final URLs before returning them as in-scope. Bound pages, depth, and requests; partial completion is explicit.
- [ ] Run focused tests covering each CLI mode, configuration independence, encoded queries, valid/empty/malformed responses, redirects/auth handling, links and limits. Restore and rerun after any narrow negative control.

### Task 2: Plugin hooks and skill

**Files:** Create `.claude-plugin/plugin.json`, `hooks/hooks.json`, `scripts/hooks.js`, `skills/crawl/SKILL.md`, `tests/hooks.test.js`, `README.md`, `config.example.sh`.

**Interfaces:** hook JSON stdin; SessionStart returns `hookSpecificOutput.additionalContext`; PreToolUse for WebSearch/WebFetch returns `permissionDecision: deny` and points to `/crawl` (full name `/stealth-search:crawl`). Unrelated tools get no decision. Invalid hook input returns exit 2 with a diagnostic.

- [ ] Write subprocess tests for SessionStart, both blocked tools, unrelated tools, absent/malformed hook input and a plugin path containing spaces/quotes.
- [ ] Implement manifest and hooks using exec-form command `bun` with `args`, supported by the installed schema; `onFailure: block` on the PreToolUse handler. Do not also declare hooks/hooks.json in plugin.json, avoiding duplicate loading.
- [ ] Write the skill with safe CLI invocation, citation and untrusted-content rules, no silent fallback, and clear distinction between search, fetch and bounded crawl.
- [ ] Write setup instructions using environment-only credentials and `claude --plugin-dir /absolute/plugin/path`. Explain that this does not install globally, enable permission bypasses, fully archive a site, or keep model analysis local.
- [ ] Run hook tests and `claude plugin validate --strict --json /Users/me/Development/selfhosted-web-worktree`. Negative-control an invalid manifest key against the real validator in an isolated copy, not the source tree.

### Task 3: Lead verification and handoff

- [ ] Independently run the full unittest suite and plugin validator against the final files.
- [ ] Test actual SearXNG search at `http://search.app.lan` and authenticated Crawl4AI at `http://192.168.50.15:11235`, using a token fetched into process memory only. Verify decoded Apple HIG page text, not response volume. Retain stderr/exit codes.
- [ ] Run an independent read-only cross-family review, verify actionable findings, fix and rerun affected tests.
- [ ] Check final git state and complete file inventory; do not commit or install. Record actual completion and remaining model-routing verification boundary in Outline. Provide local path and launch instructions.

## Execution
The user explicitly said to act without further design questions. Execute in this session with one bounded implementation worker. Main owns live checks, independent integration verification and durable records. Do not ask for another plan approval.
