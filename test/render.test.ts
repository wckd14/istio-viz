import { test } from "node:test";
import assert from "node:assert/strict";
import { renderText, renderTraceText } from "../src/render/text.js";
import { renderDot } from "../src/render/dot.js";
import { renderHtml } from "../src/render/html.js";
import { layoutModel } from "../src/render/layout.js";
import { renderSvgDocument } from "../src/render/svg.js";
import { trace } from "../src/trace.js";
import { buildModel } from "./helpers.js";

test("text: tree shape, ordering, modifiers, finding markers", () => {
  const model = buildModel("shop");
  const out = renderText(model);
  assert.match(out, /gateway prod\/shop-gateway :443 \(HTTPS, SIMPLE TLS\)/);
  assert.match(out, /└─|├─/);
  assert.match(out, /#1 {2}URI prefix \/api\/v2 AND header x-canary exact true/);
  assert.match(out, /\[timeout 5s, retry 3x\]/);
  assert.match(out, /90%/);
  assert.match(out, /✖ E002/);
  assert.match(out, /\(unreachable\)/);
  assert.match(out, /mesh routing \(no gateway\)/);
  // rules listed in evaluation order
  const i1 = out.indexOf("#1 ");
  const i4 = out.indexOf("#4 ");
  assert.ok(i1 >= 0 && i4 > i1);
});

test("dot: valid-looking graphviz with clusters, weights and dashed mirrors", () => {
  const model = buildModel("shop");
  const out = renderDot(model);
  assert.match(out, /^digraph istio_routes \{/);
  assert.match(out, /rankdir=LR/);
  assert.match(out, /subgraph cluster_\d+/);
  assert.match(out, /label="90%"/);
  assert.match(out, /style=dashed/);
  assert.equal((out.match(/\{/g) ?? []).length, (out.match(/\}/g) ?? []).length);
});

test("svg: standalone document with all sections", () => {
  const model = buildModel("shop");
  const svg = renderSvgDocument(model, layoutModel(model));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /mesh routing/);
  assert.match(svg, /service not found/);
  assert.ok(svg.includes("90%"));
});

test("svg layout: no overlapping nodes within a section", () => {
  const model = buildModel("shop");
  for (const section of layoutModel(model)) {
    const nodes = section.nodes;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!,
          b = nodes[j]!;
        const overlap =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!overlap, `nodes ${a.id} and ${b.id} overlap in section ${section.key}`);
      }
    }
  }
});

/* Acceptance 6 (static part): self-contained HTML, no network references. */
test("html: self-contained, no external resources, embeds yaml and source locations", () => {
  const model = buildModel("shop");
  const html = renderHtml(model);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(!/src\s*=\s*"https?:|href\s*=\s*"https?:|@import|url\(https?:/.test(html), "no external refs");
  assert.ok(html.includes("shop.yaml:"), "source file:line present");
  assert.ok(html.includes("prefix: /api/v2"), "yaml fragment embedded");
  assert.ok(html.includes('id="f-gw"') && html.includes('id="f-warn"'), "filter controls present");
  assert.ok(html.includes("E002"), "findings listed");
  // embedded JSON survives parsing
  const m = /<script type="application\/json" id="model-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m);
  const data = JSON.parse(m[1]!.replace(/<\\\//g, "</"));
  assert.ok(Object.keys(data.panels).length > 0);
});

test("html trace: decision log and highlighted path baked in", () => {
  const model = buildModel("shop");
  const result = trace(model, { host: "shop.example.com", path: "/cart", method: "GET", headers: {} });
  const html = renderHtml(model, { trace: result });
  assert.ok(html.includes("trace-log"));
  assert.match(html, /rule #1 skipped: URI \/cart does not match prefix/);
  assert.ok(html.includes("trace-win"));

  const text = renderTraceText(model, result);
  assert.match(text, /✔ rule #4 MATCHED/);
});
