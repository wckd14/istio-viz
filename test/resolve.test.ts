import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, buildFromYaml } from "./helpers.js";
import type { DestNode, RuleNode } from "../src/types.js";

/* Acceptance 1: Bookinfo renders with no errors. */
test("bookinfo: gateway, ordered rules, reviews subsets, no errors", () => {
  const model = buildModel("bookinfo");
  assert.equal(model.findings.filter((f) => f.severity === "error").length, 0);

  // ingress section exists with the bookinfo VS bound on host *
  assert.equal(model.sections.length, 1);
  const section = model.sections[0]!;
  assert.equal(section.listener.gateway, "bookinfo-gateway");
  assert.equal(section.listener.port, 8080);
  assert.equal(section.bindings.length, 1);
  assert.deepEqual(section.bindings[0]!.hostNode.hosts, ["*"]);

  // mesh section carries the reviews VS with v1/v2/v3 subset routing in order
  assert.equal(model.mesh.bindings.length, 1);
  const reviews = model.mesh.bindings[0]!;
  assert.equal(reviews.ruleIds.length, 2);
  const r1 = model.nodes.get(reviews.ruleIds[0]!) as RuleNode;
  assert.equal(r1.index, 0);
  assert.match(r1.matchBlocks[0]!.exprs[0]!.text, /end-user exact jason/);

  const subsets = [...model.nodes.values()]
    .filter((n): n is DestNode => n.kind === "dest" && n.host === "reviews.default.svc.cluster.local")
    .map((n) => n.subset)
    .sort();
  assert.deepEqual(subsets, ["v1", "v2", "v3"]);
  // subset labels joined from the DestinationRule
  const v2 = [...model.nodes.values()].find(
    (n): n is DestNode => n.kind === "dest" && n.subset === "v2",
  )!;
  assert.deepEqual(v2.subsetLabels, { version: "v2" });
});

/* Acceptance 5: multi-doc file == same content split across files. */
test("multi-doc file parses identically to split files", () => {
  const gw = `apiVersion: networking.istio.io/v1
kind: Gateway
metadata: {name: gw, namespace: ns1}
spec:
  servers:
  - port: {number: 80, name: http, protocol: HTTP}
    hosts: ["*"]
`;
  const vs = `apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: vs, namespace: ns1}
spec:
  hosts: ["a.example.com"]
  gateways: [gw]
  http:
  - route:
    - destination: {host: svc-a, port: {number: 80}}
`;
  const svc = `apiVersion: v1
kind: Service
metadata: {name: svc-a, namespace: ns1}
spec:
  ports: [{port: 80}]
`;
  const combined = buildFromYaml({ "all.yaml": [gw, vs, svc].join("---\n") });
  const split = buildFromYaml({ "gw.yaml": gw, "vs.yaml": vs, "svc.yaml": svc });

  const summarize = (m: typeof combined.model) => ({
    sections: m.sections.map((s) => ({
      listener: { gw: s.listener.gateway, port: s.listener.port },
      bindings: s.bindings.map((b) => ({ hosts: b.hostNode.hosts, rules: b.ruleIds.length })),
    })),
    findings: m.findings.map((f) => f.id),
    nodeKinds: [...m.nodes.values()].map((n) => n.kind).sort(),
  });
  assert.deepEqual(summarize(combined.model), summarize(split.model));
});

/* Acceptance 2 / W002: rule after a catch-all is flagged and marked unreachable. */
test("W002: rule after prefix / catch-all is unreachable", () => {
  const model = buildModel("shop");
  const w002 = model.findings.filter((f) => f.id === "W002");
  assert.equal(w002.length, 1);
  assert.match(w002[0]!.message, /rule #5 is unreachable/);
  const rule = model.nodes.get(w002[0]!.nodeIds[0]!) as RuleNode;
  assert.equal(rule.unreachable, true);
  assert.equal(rule.index, 4);
});

test("W002 not raised for sibling prefixes or narrower-first ordering", () => {
  const { model } = buildFromYaml({
    "vs.yaml": `apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: t, namespace: d}
spec:
  hosts: [t]
  http:
  - match: [{uri: {prefix: /api/v2}}]
    route: [{destination: {host: a}}]
  - match: [{uri: {prefix: /api}}]
    route: [{destination: {host: a}}]
  - match: [{uri: {prefix: /api}, headers: {x: {exact: y}}}]
    route: [{destination: {host: a}}]
`,
    "svc.yaml": `apiVersion: v1
kind: Service
metadata: {name: a, namespace: d}
spec: {ports: [{port: 80}]}
`,
  });
  // rule 3 (prefix /api AND header) IS shadowed by rule 2 (prefix /api alone)
  const w002 = model.findings.filter((f) => f.id === "W002");
  assert.equal(w002.length, 1);
  assert.match(w002[0]!.message, /rule #3/);
});

/* Acceptance 4 / E002: missing Service flagged with the referencing VS's file/line. */
test("E002: removing a Service produces a finding at the referencing destination", () => {
  const model = buildModel("shop");
  const e002 = model.findings.filter((f) => f.id === "E002");
  assert.equal(e002.length, 1);
  assert.match(e002[0]!.message, /debug-svc/);
  assert.ok(e002[0]!.loc, "finding carries a source location");
  assert.match(e002[0]!.loc!.file, /shop\.yaml$/);
  assert.ok(e002[0]!.loc!.line > 1);
  // attaches to the destination node, which is marked not-found
  const dest = e002[0]!.nodeIds
    .map((id) => model.nodes.get(id))
    .find((n): n is DestNode => n?.kind === "dest");
  assert.ok(dest);
  assert.equal(dest.serviceFound, false);
});

test("E001/E003/E004/W001/W003/I001 from the shop fixture", () => {
  const model = buildModel("shop");
  const ids = (id: string) => model.findings.filter((f) => f.id === id);
  assert.match(ids("E001")[0]!.message, /missing-gateway/);
  assert.match(ids("E003")[0]!.message, /port 9999/);
  assert.match(ids("E004")[0]!.message, /missing-subset/);
  assert.match(ids("W001")[0]!.message, /lonely/);
  assert.match(ids("W003")[0]!.message, /sum to 90/);
  // shop-routes has a `prefix /` catch-all at #4, so no I001 for it
  assert.equal(ids("I001").filter((f) => f.message.includes("shop-routes")).length, 0);
});

test("W004: two VirtualServices claiming the same host on the same gateway", () => {
  const { model } = buildFromYaml({
    "all.yaml": `apiVersion: networking.istio.io/v1
kind: Gateway
metadata: {name: gw, namespace: d}
spec:
  servers:
  - port: {number: 80, name: http, protocol: HTTP}
    hosts: ["shop.example.com"]
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata: {name: vs1, namespace: d}
spec:
  hosts: [shop.example.com]
  gateways: [gw]
  http:
  - route: [{destination: {host: a, port: {number: 80}}}]
---
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata: {name: vs2, namespace: d}
spec:
  hosts: [shop.example.com]
  gateways: [gw]
  http:
  - route: [{destination: {host: a, port: {number: 80}}}]
---
apiVersion: v1
kind: Service
metadata: {name: a, namespace: d}
spec: {ports: [{port: 80}]}
`,
  });
  const w004 = model.findings.filter((f) => f.id === "W004");
  assert.equal(w004.length, 1);
  assert.match(w004[0]!.message, /vs1.*vs2|vs2.*vs1/);
});

test("gateway host namespace qualifier restricts binding", () => {
  const { model } = buildFromYaml({
    "all.yaml": `apiVersion: networking.istio.io/v1
kind: Gateway
metadata: {name: gw, namespace: gwns}
spec:
  servers:
  - port: {number: 80, name: http, protocol: HTTP}
    hosts: ["allowed/shop.example.com"]
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: vs-denied, namespace: other}
spec:
  hosts: [shop.example.com]
  gateways: [gwns/gw]
  http:
  - route: [{destination: {host: a, port: {number: 80}}}]
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: vs-allowed, namespace: allowed}
spec:
  hosts: [shop.example.com]
  gateways: [gwns/gw]
  http:
  - route: [{destination: {host: a, port: {number: 80}}}]
---
apiVersion: v1
kind: Service
metadata: {name: a, namespace: other}
spec: {ports: [{port: 80}]}
---
apiVersion: v1
kind: Service
metadata: {name: a, namespace: allowed}
spec: {ports: [{port: 80}]}
`,
  });
  const bound = model.sections[0]!.bindings.map((b) => b.hostNode.vsName);
  assert.deepEqual(bound, ["vs-allowed"]);
  // the denied VS gets W001
  assert.ok(model.findings.some((f) => f.id === "W001" && f.message.includes("vs-denied")));
});

test("unrecognized kinds are ignored with a warning; all istio apiVersions accepted", () => {
  const { model } = buildFromYaml({
    "all.yaml": `apiVersion: apps/v1
kind: Deployment
metadata: {name: dep, namespace: d}
spec: {}
---
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata: {name: vs, namespace: d}
spec:
  hosts: [a]
  http:
  - route: [{destination: {host: a, port: {number: 80}}}]
---
apiVersion: v1
kind: Service
metadata: {name: a, namespace: d}
spec: {ports: [{port: 80}]}
`,
  });
  assert.equal(model.mesh.bindings.length, 1);
  assert.equal(model.findings.filter((f) => f.severity === "error").length, 0);
});

test("filterModel --uri keeps only rules under the path prefix", async () => {
  const { filterModel } = await import("../src/resolve.js");
  const model = buildModel("shop");
  const filtered = filterModel(model, { uri: "/api" });
  // shop-routes keeps rules #1 (/api/v2) and #2 (/api); redirect/fallback/unreachable drop out
  const binding = filtered.sections[0]!.bindings.find((b) => b.hostNode.vsName === "shop-routes")!;
  assert.deepEqual(binding.ruleIds.map((id) => (filtered.nodes.get(id) as RuleNode).index), [0, 1]);
  // shop-debug has no /api rules -> binding gone; mesh orders VS has /v2 only -> gone
  assert.ok(!filtered.sections[0]!.bindings.some((b) => b.hostNode.vsName === "shop-debug"));
  assert.equal(filtered.mesh.bindings.length, 0);
  // prefix without leading slash is normalized
  const norm = filterModel(model, { uri: "api" });
  assert.equal(norm.sections[0]!.bindings.find((b) => b.hostNode.vsName === "shop-routes")!.ruleIds.length, 2);
  // unfiltered model untouched
  assert.equal(model.sections[0]!.bindings.find((b) => b.hostNode.vsName === "shop-routes")!.ruleIds.length, 5);
});
