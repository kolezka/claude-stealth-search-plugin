import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "web.py"
TOKEN = "fixture-token-only"
SEED = "https://docs.example/guide"


def page(url=SEED, text="Meaningful guide content", links=None, **extra):
    result = {
        "url": url,
        "redirected_url": None,
        "success": True,
        "status_code": 200,
        "metadata": {"title": "Guide"},
        "markdown": {"raw_markdown": text},
        "links": {"internal": [{"href": link} for link in (links or [])], "external": []},
    }
    result.update(extra)
    return {"success": True, "results": [result]}


class WebTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = {}
        state = cls.state

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_GET(self):
                state["requests"].append(("GET", self.path, dict(self.headers)))
                if state.get("redirect"):
                    self.send_response(302)
                    self.send_header("Location", state["redirect"])
                    self.end_headers()
                    return
                self.respond(state["search"])

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                state["requests"].append(("POST", self.path, dict(self.headers), body))
                if self.headers.get("Authorization") != "Bearer " + TOKEN:
                    self.respond({"detail": "Unauthorized"}, 401)
                    return
                if state.get("redirect"):
                    self.send_response(307)
                    self.send_header("Location", state["redirect"])
                    self.end_headers()
                    return
                url = body["urls"][0]
                self.respond(state["pages"].get(url, page(url)), state.get("status", 200))

            def respond(self, value, status=200):
                body = value if isinstance(value, bytes) else json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.state.clear()
        self.state.update({
            "requests": [],
            "search": {"results": [{"url": SEED, "title": "Guide", "content": "A <b>useful</b> guide"}], "unresponsive_engines": []},
            "pages": {},
        })
        self.env = dict(os.environ)
        for key in ("SEARXNG_URL", "CRAWL4AI_URL", "CRAWL4AI_API_TOKEN"):
            self.env.pop(key, None)
        self.env.update(SEARXNG_URL=self.endpoint, CRAWL4AI_URL=self.endpoint, CRAWL4AI_API_TOKEN=TOKEN)

    def run_cli(self, *args, env=None):
        result = subprocess.run([sys.executable, "-I", str(CLI), *args], env=env or self.env, capture_output=True, text=True, timeout=10)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        return result, payload

    def assert_error(self, args, code):
        result, payload = self.run_cli(*args)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIs(payload["ok"], False)
        self.assertEqual(payload["error"]["code"], code)

    def test_search_uses_searxng_and_encodes_query(self):
        self.env.pop("CRAWL4AI_API_TOKEN")
        self.env.pop("CRAWL4AI_URL")
        result, payload = self.run_cli("search", "Apple & accessibility", "--limit", "1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(payload["results"], [{"url": SEED, "title": "Guide", "snippet": "A useful guide"}])
        request = self.state["requests"][0]
        self.assertEqual(parse_qs(urlsplit(request[1]).query), {"q": ["Apple & accessibility"], "format": ["json"]})
        self.assertNotIn("Authorization", request[2])
        self.assertEqual(request[2]["User-Agent"], "crawl4ai-plugin/0.1.0")

    def test_search_preserves_engine_warnings(self):
        self.state["search"]["unresponsive_engines"] = [["engine", "CAPTCHA"]]
        result, payload = self.run_cli("search", "guide")
        self.assertEqual(result.returncode, 0)
        self.assertTrue(payload["warnings"])
        self.assertIn("CAPTCHA", json.dumps(payload["warnings"]))

    def test_valid_zero_results_differ_from_unavailable_engines(self):
        self.state["search"]["results"] = []
        result, payload = self.run_cli("search", "none")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["results"], [])
        self.state["search"]["unresponsive_engines"] = [["engine", "timeout"]]
        self.assert_error(("search", "none"), "search_unavailable")

    def test_malformed_search_responses_fail_explicitly(self):
        valid = copy.deepcopy(self.state["search"])
        cases = [b"not-json", {}, {"results": None}, {"results": {}}, {"results": [None]}, {"results": [{"url": SEED, "title": 2, "content": "valid"}]}, {"results": [{"url": "file:///etc/passwd", "title": "valid", "content": "valid"}]}]
        for bad in cases:
            with self.subTest(response=bad):
                self.state["search"] = bad
                self.assert_error(("search", "guide"), "invalid_response")
        self.state["search"] = valid
        self.assertEqual(self.run_cli("search", "guide")[0].returncode, 0)

    def test_missing_configuration_is_not_empty_success(self):
        self.env.pop("SEARXNG_URL")
        self.assert_error(("search", "guide"), "configuration_error")

    def test_fetch_uses_bearer_and_propagates_article_options(self):
        self.env.pop("SEARXNG_URL")
        result, payload = self.run_cli("fetch", SEED, "--css-selector", "main", "--wait-for", "css:main")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(payload["pages"][0]["markdown"], "Meaningful guide content")
        request = self.state["requests"][0]
        self.assertEqual(request[2]["Authorization"], "Bearer " + TOKEN)
        self.assertEqual(request[3]["crawler_config"], {"type": "CrawlerRunConfig", "params": {"css_selector": "main", "wait_for": "css:main"}})

    def test_fetch_truncation_is_explicit(self):
        self.state["pages"][SEED] = page(text="abcdefghij")
        result, payload = self.run_cli("fetch", SEED, "--max-chars", "5")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["pages"][0]["markdown"], "abcde")
        self.assertIs(payload["pages"][0]["truncated"], True)
        self.assertEqual(payload["pages"][0]["original_chars"], 10)

    def test_fetch_rejects_malformed_or_failed_result(self):
        valid = page()
        cases = [b"bad-json", {}, {"success": True, "results": []}, {"success": True, "results": None}]
        for field, value in [("success", False), ("markdown", {}), ("markdown", {"raw_markdown": "  "}), ("links", []), ("url", None), ("status_code", 500)]:
            bad = copy.deepcopy(valid)
            bad["results"][0][field] = value
            cases.append(bad)
        for bad in cases:
            with self.subTest(response=bad):
                self.state["pages"][SEED] = bad
                result, payload = self.run_cli("fetch", SEED)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(payload["ok"])
                self.assertIn("error", payload)
        self.state["pages"][SEED] = valid
        self.assertEqual(self.run_cli("fetch", SEED)[0].returncode, 0)

    def test_fetch_missing_and_invalid_token_are_errors(self):
        self.env.pop("CRAWL4AI_API_TOKEN")
        self.assert_error(("fetch", SEED), "configuration_error")
        self.env["CRAWL4AI_API_TOKEN"] = "incorrect-fixture-token"
        self.assert_error(("fetch", SEED), "http_error")

    def test_backend_redirects_are_not_followed(self):
        self.state["redirect"] = self.endpoint + "/credential-trap"
        self.assert_error(("fetch", SEED), "http_error")
        self.assertEqual(len(self.state["requests"]), 1)
        self.state["requests"].clear()
        self.assert_error(("search", "guide"), "http_error")
        self.assertEqual(len(self.state["requests"]), 1)

    def test_invalid_urls_are_rejected_before_network(self):
        for url in ("file:///etc/passwd", "https://user:password@docs.example/guide", "https://docs.example:bad/guide", "https://docs.example/with space"):
            with self.subTest(url=url):
                self.assert_error(("fetch", url), "invalid_url")
        self.assertEqual(self.state["requests"], [])

    def test_research_combines_selected_sources_and_pages(self):
        result, payload = self.run_cli("research", "guide", "--limit", "1")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(payload["results"][0]["url"], SEED)
        self.assertEqual(payload["pages"][0]["requested_url"], SEED)
        self.assertEqual([item[0] for item in self.state["requests"]], ["GET", "POST"])

    def test_crawl_follows_only_subtree_and_deduplicates_fragments(self):
        child = SEED + "/child"
        self.state["pages"][SEED] = page(links=[child + "#one", child + "#two", SEED + "#top", "https://other.example/guide", "https://docs.example/guide-other", "https://docs.example/guide/%2e%2e/outside"])
        self.state["pages"][child] = page(child)
        result, payload = self.run_cli("crawl", SEED, "--max-pages", "5", "--max-depth", "2")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual([item[3]["urls"][0] for item in self.state["requests"]], [SEED, child])
        self.assertEqual([item["url"] for item in payload["pages"]], [SEED, child])
        self.assertTrue(payload["complete"])

    def test_crawl_page_and_depth_limits_are_visible(self):
        self.state["pages"][SEED] = page(links=[SEED + "/a", SEED + "/b"])
        result, payload = self.run_cli("crawl", SEED, "--max-pages", "1")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(self.state["requests"]), 1)
        self.assertFalse(payload["complete"])
        self.assertTrue(payload["warnings"])
        self.state["requests"].clear()
        result, payload = self.run_cli("crawl", SEED, "--max-depth", "0")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(self.state["requests"]), 1)
        self.assertFalse(payload["complete"])

    def test_crawl_does_not_accept_out_of_scope_redirect(self):
        self.state["pages"][SEED] = page(redirected_url="https://other.example/outside")
        self.assert_error(("crawl", SEED), "out_of_scope")
        self.state["pages"][SEED] = page(redirected_url="https://docs.example/other")
        self.assert_error(("crawl", SEED), "out_of_scope")

    def test_fetch_resolves_relative_links_against_final_url(self):
        self.state["pages"][SEED] = page(redirected_url=SEED + "/", links=["child", "#part"])
        result, payload = self.run_cli("fetch", SEED)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["pages"][0]["url"], SEED + "/")
        self.assertIn(SEED + "/child", payload["pages"][0]["links"])

    def test_invalid_limits_do_not_send_requests(self):
        for args in [("search", "guide", "--limit", "0"), ("crawl", SEED, "--max-pages", "101"), ("crawl", SEED, "--max-depth", "-1")]:
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, "-I", str(CLI), *args], env=self.env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state["requests"], [])


if __name__ == "__main__":
    unittest.main()
