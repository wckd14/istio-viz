import { test } from "node:test";
import assert from "node:assert/strict";
import { trace } from "../src/trace.js";
import { buildModel, buildFromYaml } from "./helpers.js";

/* Acceptance 3: canary trace selects the right rule with skip reasons. */
test("trace: canary header selects rule #1", () => {
  const model = buildModel("shop");
  const result = trace(model, {
    host: "shop.example.com",
    path: "/api/v2/items",
    method: "GET",
    headers: { "x-canary": "true" },
  });
  assert.ok(result.winner);
  assert.equal(result.winner.index, 0);
  assert.equal(result.destIds.length, 2); // 90/10 split
  assert.match(result.outcome, /rule #1/);
});

test("trace: skip reasons explain every earlier non-matching rule", () => {
  const model = buildModel("shop");
  const result = trace(model, {
    host: "shop.example.com",
    path: "/cart",
    method: "POST",
    headers: {},
  });
  assert.ok(result.winner);
  assert.equal(result.winner.index, 3); // the prefix / fallback
  const skipped = result.steps.filter((s) => !s.matched);
  assert.equal(skipped.length, 3);
  assert.match(skipped[0]!.reasons[0]!, /URI \/cart does not match prefix "\/api\/v2"/);
  assert.match(skipped[1]!.reasons[0]!, /URI \/cart does not match prefix "\/api"/);
  assert.match(skipped[2]!.reasons[0]!, /URI \/cart does not match exact "\/old"/);
});

test("trace: header mismatch is explained when URI matches", () => {
  const model = buildModel("shop");
  const result = trace(model, {
    host: "shop.example.com",
    path: "/api/v2/items",
    method: "GET",
    headers: { "x-canary": "false" },
  });
  assert.ok(result.winner);
  assert.equal(result.winner.index, 1); // falls to plain /api rule
  assert.match(result.steps[0]!.reasons[0]!, /header x-canary="false" does not match exact "true"/);
});

test("trace: port selects the listener; unknown host 404s", () => {
  const model = buildModel("shop");
  const onHttp = trace(model, { host: "shop.example.com", path: "/", method: "GET", headers: {}, port: 80 });
  assert.ok(onHttp.listenerId?.includes("#1"), "picks the :80 server (index 1)");

  const miss = trace(model, { host: "nope.example.net", path: "/", method: "GET", headers: {} });
  assert.equal(miss.winner, undefined);
  assert.match(miss.outcome, /404/);
});

test("trace: falls back to mesh routing for cluster-internal hosts", () => {
  const model = buildModel("shop");
  const result = trace(model, { host: "orders", path: "/v1/list", method: "GET", headers: {} });
  assert.ok(result.winner);
  assert.equal(result.winner.index, 1);
  assert.equal(result.listenerId, undefined);
  assert.match(result.steps[0]!.reasons[0]!, /URI \/v1\/list does not match prefix "\/v2"/);
});

test("trace: merges all VirtualServices bound to the same host+gateway (first-match-wins across VS)", () => {
  // Mirrors the real-world case: VS #1 ("a-gateway") only matches a
  // different authority, so a request must fall through to VS #2's catch-all
  // rather than 404'ing inside the first VS. File names order the load so
  // a-gateway binds before b-fallback.
  const { model } = buildFromYaml({
    "0-gateway.yaml": `apiVersion: networking.istio.io/v1
kind: Gateway
metadata: {name: gw, namespace: d}
spec:
  selector: {istio: ingressgateway}
  servers:
  - port: {number: 80, name: http, protocol: HTTP}
    hosts: ["api.example.com", "gw.example.com"]
`,
    "a-gateway.yaml": `apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: a-gateway, namespace: d}
spec:
  hosts: ["api.example.com", "gw.example.com"]
  gateways: [gw]
  http:
  - match:
    - uri: {prefix: /collateral}
      authority: {regex: "^gw\\\\.example\\\\.com$"}
    route: [{destination: {host: gateway-svc, port: {number: 7000}}}]
`,
    "b-fallback.yaml": `apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: b-fallback, namespace: d}
spec:
  hosts: ["api.example.com"]
  gateways: [gw]
  http:
  - match:
    - uri: {prefix: /}
    route: [{destination: {host: fallback-svc, port: {number: 2000}}}]
`,
    "svc.yaml": `apiVersion: v1
kind: Service
metadata: {name: gateway-svc, namespace: d}
spec: {ports: [{port: 7000}]}
---
apiVersion: v1
kind: Service
metadata: {name: fallback-svc, namespace: d}
spec: {ports: [{port: 2000}]}
`,
  });

  // /collateral on api.example.com: a-gateway's authority guard fails, so it
  // must fall through to b-fallback's catch-all (was: 404 inside a-gateway).
  const fell = trace(model, { host: "api.example.com", path: "/collateral", method: "GET", headers: {} });
  assert.ok(fell.winner, "should match after falling through to the second VS");
  assert.equal(fell.winner!.vsName, "b-fallback");
  assert.match(fell.outcome, /b-fallback matches/);
  assert.ok(
    fell.steps.some((s) => s.vsName === "a-gateway" && !s.matched),
    "the first VS's non-matching rule must still appear in the decision log",
  );

  // On gw.example.com the first VS's guard passes, so first-match-wins keeps it.
  const direct = trace(model, { host: "gw.example.com", path: "/collateral", method: "GET", headers: {} });
  assert.equal(direct.winner?.vsName, "a-gateway");
});

test("trace: regex, query params, method and multiple OR blocks", () => {
  const { model } = buildFromYaml({
    "vs.yaml": `apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: t, namespace: d}
spec:
  hosts: [t]
  http:
  - match:
    - uri: {regex: "/v[0-9]+/items"}
      method: {exact: POST}
    - queryParams:
        version: {exact: beta}
    route: [{destination: {host: a, port: {number: 80}}}]
  - route: [{destination: {host: b, port: {number: 80}}}]
`,
    "svc.yaml": `apiVersion: v1
kind: Service
metadata: {name: a, namespace: d}
spec: {ports: [{port: 80}]}
---
apiVersion: v1
kind: Service
metadata: {name: b, namespace: d}
spec: {ports: [{port: 80}]}
`,
  });
  // OR block 2 matches via query param even though block 1 fails on method
  const viaQuery = trace(model, { host: "t", path: "/other?version=beta", method: "GET", headers: {} });
  assert.equal(viaQuery.winner?.index, 0);

  // regex is anchored: full path must match
  const regexHit = trace(model, { host: "t", path: "/v2/items", method: "POST", headers: {} });
  assert.equal(regexHit.winner?.index, 0);
  const regexMiss = trace(model, { host: "t", path: "/v2/items/extra", method: "POST", headers: {} });
  assert.equal(regexMiss.winner?.index, 1, "unanchored substring must not match");
});
