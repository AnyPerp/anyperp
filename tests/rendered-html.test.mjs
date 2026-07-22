import assert from "node:assert/strict";
import test from "node:test";

async function render(url = "http://localhost/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(url, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the AnyPerp public landing surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>AnyPerp \| Any token\. A perp\. Today\.<\/title>/i);
  assert.match(html, /AnyPerp|Any token/i);
  assert.match(html, /anyperp-hero\.svg/i);
  assert.match(html, />Docs<\/button>/i);
  assert.match(html, /Create/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
  // Anti-LARP brand lock: old codename must not ship in production HTML.
  assert.doesNotMatch(html, /Longtail Perps|longtail-hero|ltUSD/i);
});
