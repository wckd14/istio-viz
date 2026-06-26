import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPaths } from "../src/loader.js";

/* A single unreadable subdirectory must not abort the whole scan: it should be
 * skipped with a warning while the rest of the tree still loads. (Root bypasses
 * permission bits, so the assertion is skipped when running as uid 0.) */
test("loader: skips unreadable subdirectories with a warning", { skip: process.getuid?.() === 0 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "istio-viz-perm-"));
  fs.writeFileSync(
    path.join(dir, "good.yaml"),
    `apiVersion: networking.istio.io/v1
kind: Gateway
metadata: {name: gw, namespace: d}
spec: {servers: [{port: {number: 80, protocol: HTTP}, hosts: ["*"]}]}
`,
  );
  const secret = path.join(dir, "secret");
  fs.mkdirSync(secret);
  fs.chmodSync(secret, 0o000);
  try {
    const loaded = loadPaths([dir]);
    assert.equal(loaded.resources.length, 1, "the readable Gateway still loads");
    assert.ok(
      loaded.warnings.some((w) => w.includes("cannot read directory") && w.includes("secret")),
      "a skip warning is emitted for the unreadable directory",
    );
  } finally {
    fs.chmodSync(secret, 0o755);
  }
});

/* `kubectl get … -o yaml` wraps resources in a v1 List; the loader must unwrap
 * it, classify the nested items, drop non-network kinds quietly, and keep
 * file:line accurate against the original stream. */
test("loader: unwraps kubectl List dumps with accurate file:line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "istio-viz-list-"));
  const yaml = `apiVersion: v1
kind: List
items:
- apiVersion: v1
  kind: ServiceAccount
  metadata: {name: sa, namespace: d}
- apiVersion: networking.istio.io/v1
  kind: VirtualService
  metadata: {name: vs, namespace: d}
  spec:
    hosts: [a]
    gateways: [gw]
    http:
    - route:
      - destination: {host: a, port: {number: 80}}
- apiVersion: v1
  kind: Service
  metadata: {name: a, namespace: d}
  spec: {ports: [{port: 80}]}
metadata: {}
`;
  fs.writeFileSync(path.join(dir, "dump.yaml"), yaml);
  const loaded = loadPaths([dir]);

  const kinds = loaded.resources.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["Service", "VirtualService"], "network kinds unwrapped, ServiceAccount dropped");
  // ServiceAccount must be dropped silently (List items behave like kustomize output).
  assert.equal(loaded.warnings.filter((w) => w.includes("unrecognized")).length, 0);

  const vs = loaded.resources.find((r) => r.kind === "VirtualService")!;
  assert.equal(vs.loc.line, 7, "VirtualService line points inside the List, not at the List root");
});

/* An explicitly-named missing path is still a hard error (ENOENT), not a warning. */
test("loader: missing explicit path throws ENOENT", () => {
  assert.throws(() => loadPaths(["/no/such/path/at/all"]), /ENOENT/);
});
