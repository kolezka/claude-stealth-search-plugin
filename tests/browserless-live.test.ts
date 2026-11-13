// Runs the in-browser Markdown converter on a real Browserless. Skipped unless
// BROWSERLESS_E2E_URL is set; BROWSERLESS_E2E_HOST is how the browser reaches this machine.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "scripts/web.ts");
const browserless = process.env.BROWSERLESS_E2E_URL;
const host = process.env.BROWSERLESS_E2E_HOST ?? "host.docker.internal";

const HTML = `<!doctype html><html><head><title>Live fixture</title></head><body>
<nav><a href="/outside">Outside</a></nav>
<main><h2>Guide</h2>
<p>foo<b> bar</b> baz <a href="/docs/a">link</a> end</p>
<ul><li>First<ul><li>Nested</li></ul></li><li>Step<pre><code>line1
  line2</code></pre></li></ul>
<blockquote><pre>q1
q2</pre></blockquote>
<table><tr><th>K</th><th>V</th></tr><tr><td>a|b</td><td>1</td></tr></table>
<p hidden>Hidden text</p><div id="late"></div></main>
<script>setTimeout(() => { document.getElementById("late").innerHTML = "<p>Late content</p>"; }, 1500);</script>
</body></html>`;

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response(HTML, { headers: { "content-type": "text/html" } }) });
});
afterAll(() => server?.stop(true));

test.skipIf(!browserless)("Browserless renders the page into Markdown", async () => {
  const base = "http://" + host + ":" + server.port;
  const child = Bun.spawn(
    ["bun", CLI, "fetch", base + "/docs/", "--css-selector", "main", "--wait-for", "js:() => document.querySelector('#late p') !== null"],
    { env: { ...process.env, STEALTH_SEARCH_READER: "browserless", BROWSERLESS_API_URL: browserless }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(status, stdout).toBe(0);
  const page = JSON.parse(stdout).pages[0];
  expect(page.title).toBe("Live fixture");
  expect(page.links).toEqual([base + "/docs/a"]);
  expect(page.markdown).toBe(
    [
      "## Guide",
      "",
      "foo **bar** baz [link](" + base + "/docs/a) end",
      "",
      "- First",
      "  - Nested",
      "- Step",
      "  ```",
      "  line1",
      "    line2",
      "  ```",
      "",
      "> ```",
      "> q1",
      "> q2",
      "> ```",
      "",
      "| K | V |",
      "| --- | --- |",
      "| a\\|b | 1 |",
      "",
      "Late content",
    ].join("\n"),
  );
}, 90_000);
