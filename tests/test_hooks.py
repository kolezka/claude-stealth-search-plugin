import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class HookTests(unittest.TestCase):
    def invoke(self, event, payload, root=ROOT):
        manifest = json.loads((ROOT / "hooks" / "hooks.json").read_text())
        entry = manifest["hooks"][event][0]["hooks"][0]
        self.assertEqual(entry["type"], "command")
        self.assertEqual(entry["command"], "python3")
        arguments = [arg.replace("${CLAUDE_PLUGIN_ROOT}", str(root)) for arg in entry["args"]]
        return subprocess.run([sys.executable, *arguments], input=payload, capture_output=True, text=True, timeout=5)

    def test_session_start_advertises_real_cli_without_network(self):
        result = self.invoke("SessionStart", "{}")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        context = output.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn("/crawl4ai:crawl", context)
        self.assertIn(str(ROOT / "scripts" / "web.py"), context)
        self.assertIn("SearXNG", context)
        self.assertIn("Crawl4AI", context)

    def test_shipped_hook_denies_both_builtins(self):
        for tool in ("WebSearch", "WebFetch"):
            with self.subTest(tool=tool):
                result = self.invoke("PreToolUse", json.dumps({"tool_name": tool, "tool_input": {}}))
                self.assertEqual(result.returncode, 0, result.stderr)
                output = json.loads(result.stdout)
                decision = output.get("hookSpecificOutput", {})
                self.assertEqual(decision.get("permissionDecision"), "deny")
                self.assertEqual(decision.get("hookEventName"), "PreToolUse")
                self.assertIn("/crawl4ai:crawl", decision.get("permissionDecisionReason", ""))

    def test_routing_messages_offer_short_crawl_alias(self):
        cases = [("SessionStart", "{}"), ("PreToolUse", '{"tool_name":"WebSearch"}')]
        for event, payload in cases:
            with self.subTest(event=event):
                result = self.invoke(event, payload)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = json.loads(result.stdout)["hookSpecificOutput"]
                text = output.get("additionalContext", output.get("permissionDecisionReason", ""))
                self.assertIn("/crawl", text)
                self.assertIn("/crawl4ai:crawl", text)

    def test_unrelated_tools_are_not_approved_or_blocked(self):
        for tool in ("Bash", "Read", "mcp__exa__web_search_exa", "OtherWebSearch"):
            result = self.invoke("PreToolUse", json.dumps({"tool_name": tool}))
            self.assertEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout), {})

    def test_missing_and_malformed_input_fail_closed(self):
        for payload in ("", "not-json", "[]", "{}", '{"tool_name":null}'):
            with self.subTest(payload=payload):
                result = self.invoke("PreToolUse", payload)
                self.assertEqual(result.returncode, 2)
                self.assertIn("invalid_hook_input", result.stderr)

    def test_exec_form_handles_plugin_paths_with_shell_characters(self):
        with tempfile.TemporaryDirectory(prefix="selfhosted web ' $ ") as folder:
            root = Path(folder)
            (root / "scripts").mkdir()
            shutil.copyfile(ROOT / "scripts" / "hooks.py", root / "scripts" / "hooks.py")
            result = self.invoke("PreToolUse", '{"tool_name":"WebSearch"}', root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout).get("hookSpecificOutput", {}).get("permissionDecision"), "deny")

    def test_no_network_configuration_is_needed_for_guard(self):
        result = self.invoke("PreToolUse", '{"tool_name":"WebFetch"}')
        self.assertEqual(result.returncode, 0)
        self.assertIn("deny", result.stdout)


if __name__ == "__main__":
    unittest.main()
