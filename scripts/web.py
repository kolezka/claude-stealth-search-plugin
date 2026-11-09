#!/usr/bin/env python3
"""Self-hosted search and page retrieval, with JSON output."""

import argparse
from collections import deque
from html.parser import HTMLParser
import json
import os
import posixpath
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class WebError(Exception):
    def __init__(self, code, message, **context):
        super().__init__(message)
        self.code = code
        self.context = context


def valid_url(value, code="invalid_url"):
    try:
        if not isinstance(value, str) or not value or any(char.isspace() or ord(char) < 32 for char in value):
            raise ValueError
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None or parts.password is not None:
            raise ValueError
        parts.port
        if "\\" in value:
            raise ValueError
        return urlunsplit(parts._replace(fragment=""))
    except ValueError:
        raise WebError(code, "Expected an absolute HTTP(S) URL without credentials, whitespace or an invalid port.") from None


def endpoint(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise WebError("configuration_error", "Set " + name + " in the environment.")
    value = valid_url(value, "configuration_error")
    if urlsplit(value).query:
        raise WebError("configuration_error", name + " must be a base URL without a query.")
    return value.rstrip("/")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def request_json(url, service, token=None, data=None):
    headers = {"Accept": "application/json", "User-Agent": "crawl4ai-plugin/0.1.0"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    body = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data).encode("utf-8")
    try:
        request = Request(url, data=body, headers=headers)
        with build_opener(NoRedirect()).open(request, timeout=60) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise WebError("response_too_large", service + " exceeded the 8 MiB response limit.")
    except HTTPError as error:
        raise WebError("http_error", service + " returned HTTP " + str(error.code) + ". Redirects are not followed; check the endpoint and credentials.") from None
    except (URLError, TimeoutError, socket.timeout, OSError):
        raise WebError("transport_error", service + " could not be reached or timed out.") from None
    except (ValueError, UnicodeError):
        raise WebError("configuration_error", service + " URL or request headers are invalid.") from None
    try:
        decoded = json.loads(raw)
    except (ValueError, UnicodeError):
        raise WebError("invalid_response", service + " returned invalid JSON.") from None
    if not isinstance(decoded, dict):
        raise WebError("invalid_response", service + " must return a JSON object.")
    return decoded


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def search(base, query, limit):
    response = request_json(base + "/search?" + urlencode({"q": query, "format": "json"}), "SearXNG")
    if not isinstance(response.get("results"), list):
        raise WebError("invalid_response", "SearXNG results must be an array.")
    failures = response.get("unresponsive_engines", [])
    if not isinstance(failures, list) or any(not isinstance(item, list) or len(item) != 2 or not all(isinstance(part, str) for part in item) for item in failures):
        raise WebError("invalid_response", "SearXNG engine warnings are malformed.")
    warnings = ["SearXNG " + engine + ": " + error for engine, error in failures]
    results = []
    seen = set()
    for item in response["results"]:
        if not isinstance(item, dict) or not all(isinstance(item.get(key), str) for key in ("url", "title", "content")):
            raise WebError("invalid_response", "SearXNG result fields must be strings.")
        url = valid_url(item["url"], "invalid_response")
        if url in seen:
            continue
        seen.add(url)
        text = PlainText()
        text.feed(item["content"])
        results.append({"url": url, "title": item["title"], "snippet": "".join(text.parts)})
    if not results and warnings:
        raise WebError("search_unavailable", "SearXNG returned no results and reported engine failures.", warnings=warnings)
    return {"ok": True, "query": query, "results": results[:limit], "warnings": warnings}


def crawl_credentials():
    base = endpoint("CRAWL4AI_URL")
    token = os.environ.get("CRAWL4AI_API_TOKEN", "").strip()
    if not token or any(ord(char) < 32 or ord(char) > 126 for char in token):
        raise WebError("configuration_error", "Set a nonempty ASCII CRAWL4AI_API_TOKEN without control characters.")
    return base, token


def fetch_page(base, token, url, max_chars, css_selector=None, wait_for=None):
    request = {"urls": [url]}
    params = {}
    if css_selector:
        params["css_selector"] = css_selector
    if wait_for:
        params["wait_for"] = wait_for
    if params:
        request["crawler_config"] = {"type": "CrawlerRunConfig", "params": params}
    response = request_json(base + "/crawl", "Crawl4AI", token, request)
    results = response.get("results")
    if response.get("success") is not True or not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
        raise WebError("invalid_response", "Crawl4AI must return one successful page for the requested URL.")
    result = results[0]
    status = result.get("status_code")
    if result.get("success") is not True or (status is not None and (type(status) is not int or not 200 <= status < 300)):
        raise WebError("crawl_failed", "Crawl4AI reported an unsuccessful page.")
    returned_url = valid_url(result.get("url"), "invalid_response")
    final = result.get("redirected_url")
    final_url = returned_url if final is None else valid_url(final, "invalid_response")
    markdown = result.get("markdown")
    markdown = markdown.get("raw_markdown") if isinstance(markdown, dict) else markdown
    if not isinstance(markdown, str) or not markdown.strip():
        raise WebError("invalid_response", "Crawl4AI returned no meaningful Markdown.")
    metadata = result.get("metadata")
    if metadata is None:
        metadata = {}
    if not isinstance(metadata, dict) or not isinstance(metadata.get("title", ""), str):
        raise WebError("invalid_response", "Crawl4AI page metadata is malformed.")
    link_groups = result.get("links")
    if not isinstance(link_groups, dict):
        raise WebError("invalid_response", "Crawl4AI page links must be an object.")
    links = []
    seen = set()
    for group in ("internal", "external"):
        items = link_groups.get(group, [])
        if not isinstance(items, list):
            raise WebError("invalid_response", "Crawl4AI link groups must be arrays.")
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("href"), str):
                raise WebError("invalid_response", "Crawl4AI links must include a string href.")
            href = urljoin(final_url, item["href"])
            try:
                href = valid_url(href)
            except WebError:
                continue  # Mail, script and credential-bearing links are not crawl targets.
            if href not in seen:
                links.append(href)
                seen.add(href)
    return {"requested_url": url, "url": final_url, "title": metadata.get("title", ""), "markdown": markdown[:max_chars], "original_chars": len(markdown), "truncated": len(markdown) > max_chars, "links": links}


def scope_key(url):
    parts = urlsplit(url)
    origin = (parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    path = posixpath.normpath(unquote(parts.path or "/"))
    return origin, path


def in_scope(seed, candidate):
    origin, path = scope_key(seed)
    candidate_origin, candidate_path = scope_key(candidate)
    return origin == candidate_origin and (path == "/" or candidate_path == path or candidate_path.startswith(path.rstrip("/") + "/"))


def crawl(base, token, seed, args):
    queue = deque([(seed, 0)])
    seen = {seed}
    pages = []
    limited = False
    while queue and len(pages) < args.max_pages:
        url, depth = queue.popleft()
        try:
            current = fetch_page(base, token, url, args.max_chars, args.css_selector, args.wait_for)
            if not in_scope(seed, current["url"]):
                raise WebError("out_of_scope", "Crawled page redirected outside the seed origin or path subtree.")
        except WebError as error:
            error.context.update(pages=pages, complete=False)
            raise
        pages.append(current)
        for link in current["links"]:
            if link in seen or not in_scope(seed, link):
                continue
            if depth == args.max_depth:
                limited = True
                continue
            seen.add(link)
            queue.append((link, depth + 1))
    limited = limited or bool(queue)
    return {"ok": True, "pages": pages, "complete": not limited, "warnings": ["Crawl stopped at the configured page or depth limit; this is not a complete site archive."] if limited else []}


def bounded_integer(minimum, maximum):
    def parse(value):
        try:
            number = int(value)
            if minimum <= number <= maximum:
                return number
        except ValueError:
            pass
        raise argparse.ArgumentTypeError("must be between " + str(minimum) + " and " + str(maximum))
    return parse


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    for name in ("search", "research", "fetch", "crawl"):
        command = commands.add_parser(name)
        if name in ("search", "research"):
            command.add_argument("query")
            command.add_argument("--limit", type=bounded_integer(1, 20), default=5 if name == "search" else 3)
        else:
            command.add_argument("urls" if name == "fetch" else "url", nargs="+" if name == "fetch" else None)
        if name != "search":
            command.add_argument("--max-chars", type=bounded_integer(1, 200000), default=16000)
            command.add_argument("--css-selector")
            command.add_argument("--wait-for")
        if name == "crawl":
            command.add_argument("--max-pages", type=bounded_integer(1, 100), default=5)
            command.add_argument("--max-depth", type=bounded_integer(0, 10), default=1)
    return result


def run(args):
    search_base = endpoint("SEARXNG_URL") if args.command in ("search", "research") else None
    credentials = crawl_credentials() if args.command != "search" else None
    if args.command == "search":
        if not args.query.strip():
            raise WebError("invalid_query", "Search query must not be empty.")
        return search(search_base, args.query, args.limit)
    base, token = credentials
    if args.command == "crawl":
        return crawl(base, token, valid_url(args.url), args)
    if args.command == "research":
        if not args.query.strip():
            raise WebError("invalid_query", "Search query must not be empty.")
        output = search(search_base, args.query, args.limit)
        urls = [item["url"] for item in output["results"]]
    else:
        output = {"ok": True, "warnings": []}
        if len(args.urls) > 20:
            raise WebError("invalid_input", "Fetch accepts at most 20 URLs per invocation.")
        urls = list(dict.fromkeys(valid_url(url) for url in args.urls))
    output["pages"] = []
    for url in urls:
        try:
            output["pages"].append(fetch_page(base, token, url, args.max_chars, args.css_selector, args.wait_for))
        except WebError as error:
            error.context.update(pages=output["pages"], warnings=output["warnings"], complete=False)
            raise
    return output


def main():
    args = parser().parse_args()
    try:
        output = run(args)
        status = 0
    except WebError as error:
        output = {"ok": False, "error": {"code": error.code, "message": str(error)}, **error.context}
        status = 1
    serialized = json.dumps(output, ensure_ascii=False)
    token = os.environ.get("CRAWL4AI_API_TOKEN", "")
    if token:
        serialized = serialized.replace(token, "<REDACTED>")
    print(serialized)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
