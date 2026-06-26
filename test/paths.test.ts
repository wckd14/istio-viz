import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNetworkPaths, renderPathsText } from "../src/paths.js";
import { renderHtml } from "../src/render/html.js";
import { buildModel, buildFromYaml } from "./helpers.js";

const GW = `apiVersion: networking.istio.io/v1
kind: Gateway
metadata: {name: gw, namespace: d}
spec:
  servers:
  - port: {number: 443, name: https, protocol: HTTPS}
    tls: {mode: SIMPLE}
    hosts: ["shop.example.com"]
`;
const SVCS = `apiVersion: v1
kind: Service
metadata: {name: api, namespace: d}
spec: {ports: [{port: 8080}]}
---
apiVersion: v1
kind: Service
metadata: {name: web, namespace: d}
spec: {ports: [{port: 80}]}
`;

test("paths text is identical whether rules live in one VS or are split across many", () => {
  const combined = buildFromYaml({
    "all.yaml": `${GW}---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: everything, namespace: d}
spec:
  hosts: [shop.example.com]
  gateways: [gw]
  http:
  - match: [{uri: {prefix: /api}}]
    route: [{destination: {host: api, port: {number: 8080}}}]
  - match: [{uri: {prefix: /}}]
    route: [{destination: {host: web, port: {number: 80}}}]
---
${SVCS}`,
  });
  const split = buildFromYaml({
    "all.yaml": `${GW}---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: web-part, namespace: d}
spec:
  hosts: [shop.example.com]
  gateways: [gw]
  http:
  - match: [{uri: {prefix: /}}]
    route: [{destination: {host: web, port: {number: 80}}}]
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: api-part, namespace: d}
spec:
  hosts: [shop.example.com]
  gateways: [gw]
  http:
  - match: [{uri: {prefix: /api}}]
    route: [{destination: {host: api, port: {number: 8080}}}]
---
${SVCS}`,
  });
  assert.equal(renderPathsText(combined.model), renderPathsText(split.model));
  assert.match(renderPathsText(combined.model), /shop\.example\.com via d\/gw:443/);
});

test("paths: consolidation, canonical match/dest/mod formatting", () => {
  const model = buildModel("shop");
  const groups = buildNetworkPaths(model);
  const shop = groups.find((g) => g.host === "shop.example.com")!;
  // both listeners consolidated under one host group
  assert.deepEqual(shop.via, ["prod/shop-gateway:443", "prod/shop-gateway:80"]);
  // entries deduped across the two listeners and sorted by match
  const matches = shop.entries.map((e) => e.match);
  assert.deepEqual([...matches].sort((a, b) => a.localeCompare(b)), matches);
  const canary = shop.entries.find((e) => e.match.startsWith("/api/v2*"))!;
  assert.match(canary.match, /\{header x-canary=true\}/);
  assert.deepEqual(canary.dests, ["api.prod:8080(v2)=90%", "api.prod:8080(v1)=10%"]);
  assert.ok(canary.mods.includes("retry 3x") && canary.mods.includes("timeout 5s"));
  // redirect + mirror canonical forms
  const text = renderPathsText(model);
  assert.match(text, /\/old -> redirect:301:\/new/);
  assert.match(text, /mirror api-shadow\.prod:8080/);
  // mesh host present with via mesh; missing service marked
  assert.match(text, /^orders via mesh$/m);
  assert.match(text, /debug-svc\.prod:8080!missing/);
});

test("paths text has no timestamps and is stable across runs", () => {
  const a = renderPathsText(buildModel("shop"));
  const b = renderPathsText(buildModel("shop"));
  assert.equal(a, b);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a), "no dates in output");
});

test("html embeds the paths view with the view switcher", () => {
  const html = renderHtml(buildModel("shop"));
  assert.ok(html.includes('id="v-paths"') && html.includes('id="v-diagram"'));
  assert.ok(html.includes('id="paths-view"'));
  assert.ok(html.includes('class="pgroup"'));
  assert.match(html, /data-host="shop.example.com"/);
});

test("filterModel --service keeps only rules routing to matching services", async () => {
  const { filterModel } = await import("../src/resolve.js");
  const model = buildModel("shop");
  const filtered = filterModel(model, { service: "api" });
  const binding = filtered.sections[0]!.bindings.find((b) => b.hostNode.vsName === "shop-routes")!;
  // rules #1 and #2 route/mirror to api / api-shadow; redirect & web rules drop
  assert.equal(binding.ruleIds.length, 2);
  // case-insensitive substring
  const upper = filterModel(model, { service: "API" });
  assert.equal(upper.sections[0]!.bindings.find((b) => b.hostNode.vsName === "shop-routes")!.ruleIds.length, 2);
  // no match anywhere -> sections collapse
  const none = filterModel(model, { service: "does-not-exist" });
  assert.equal(none.sections.length, 0);
  assert.equal(none.mesh.bindings.length, 0);
});

test("html embeds the paths graph with match/dest nodes and panel aliases", () => {
  const html = renderHtml(buildModel("shop"));
  assert.ok(html.includes('id="paths-graph"') && html.includes('id="paths-table"'));
  assert.ok(html.includes('id="p-graph"') && html.includes('id="p-table"'));
  assert.ok(html.includes('id="f-svc"'), "service filter input present");
  assert.match(html, /data-id="pm:shop.example.com#\d+"/, "match nodes rendered");
  assert.match(html, /data-id="pd:shop.example.com:[^"]+"/, "service nodes rendered");
  const m = /<script type="application\/json" id="model-data">([\s\S]*?)<\/script>/.exec(html)!;
  const data = JSON.parse(m[1]!.replace(/<\\\//g, "</"));
  assert.ok(Array.isArray(data.pathNodes) && data.pathNodes.length > 0);
  const pmIds = data.pathNodes.map((p) => p.id);
  // every match node has an aliased panel resolving to its rule's panel
  for (const id of pmIds) assert.ok(data.panels[id], `panel alias for ${id}`);
});
