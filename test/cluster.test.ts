/**
 * Tests for the cluster backend.
 *
 * These tests do NOT require a live Kubernetes cluster. They mock kubectl by
 * manipulating PATH so it points to a tiny shell script that echoes canned
 * YAML output. This keeps the tests hermetic and fast.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchFromCluster, mergeClusterIntoFiles, clusterHash } from "../src/cluster.js";
import { loadText } from "../src/loader.js";
import type { LoadResult, Resource } from "../src/types.js";

/* ---------- helpers ---------- */

/**
 * Write a minimal kubectl stub to a temp dir, put that dir first on PATH,
 * and return a cleanup function.
 */
function stubKubectl(onGet: (args: string[]) => { stdout: string; exitCode?: number }): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "istio-viz-cluster-test-"));

  // Write the stub script
  const stubPath = path.join(dir, "kubectl");
  const scriptLines = [
    "#!/bin/sh",
    // Emit stdout from a file placed by the test
    `cat "${dir}/kubectl-stdout.txt" 2>/dev/null || true`,
    `exit $(cat "${dir}/kubectl-exit.txt" 2>/dev/null || echo 0)`,
  ];
  fs.writeFileSync(stubPath, scriptLines.join("\n"), { mode: 0o755 });

  // Write a stub for "kubectl config current-context" too — same binary handles both
  // by inspecting args. We use a different approach: a separate wrapper.
  const wrapperPath = path.join(dir, "kubectl");
  const wrapperLines = [
    "#!/bin/sh",
    `ARGS="$*"`,
    `if echo "$ARGS" | grep -q "current-context"; then`,
    `  echo "test-context"; exit 0`,
    `fi`,
    `cat "${dir}/kubectl-stdout.txt" 2>/dev/null || true`,
    `exit $(cat "${dir}/kubectl-exit.txt" 2>/dev/null || echo 0)`,
  ];
  fs.writeFileSync(wrapperPath, wrapperLines.join("\n"), { mode: 0o755 });

  const origPath = process.env.PATH;
  process.env.PATH = `${dir}:${origPath}`;

  const apply = (stdout: string, exitCode = 0): void => {
    fs.writeFileSync(path.join(dir, "kubectl-stdout.txt"), stdout);
    fs.writeFileSync(path.join(dir, "kubectl-exit.txt"), String(exitCode));
  };

  const r = onGet([]);
  apply(r.stdout, r.exitCode ?? 0);

  return () => {
    process.env.PATH = origPath;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

const GATEWAY_YAML = `apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: prod-gw
  namespace: istio-system
spec:
  selector:
    istio: ingressgateway
  servers:
  - hosts:
    - default/shop.example.com
    port:
      name: http
      number: 80
      protocol: HTTP
`;

const VS_YAML = `apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: shop-vs
  namespace: default
spec:
  gateways:
  - istio-system/prod-gw
  hosts:
  - shop.example.com
  http:
  - route:
    - destination:
        host: shop-svc
        port:
          number: 8080
`;

const SVC_YAML = `apiVersion: v1
kind: Service
metadata:
  name: shop-svc
  namespace: default
spec:
  ports:
  - port: 8080
`;

// kubectl list output wrapping all three resources
const LIST_YAML = `apiVersion: v1
kind: List
items:
- ${GATEWAY_YAML.split("\n").join("\n  ")}
- ${VS_YAML.split("\n").join("\n  ")}
- ${SVC_YAML.split("\n").join("\n  ")}
`;

/* ---------- tests ---------- */

test("fetchFromCluster: parses kubectl List output into resources", () => {
  const cleanup = stubKubectl(() => ({ stdout: LIST_YAML }));
  try {
    const result = fetchFromCluster({ context: "test-context" });
    assert.ok(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(", ")}`);
    const kinds = result.resources.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ["Gateway", "Service", "VirtualService"]);
  } finally {
    cleanup();
  }
});

test("fetchFromCluster: patches top-level loc to cluster:// path", () => {
  const cleanup = stubKubectl(() => ({ stdout: LIST_YAML }));
  try {
    const result = fetchFromCluster({ context: "prod-ctx" });
    const gw = result.resources.find((r) => r.kind === "Gateway");
    assert.ok(gw, "Gateway not loaded");
    assert.equal(gw!.loc.file, "cluster://prod-ctx/istio-system/Gateway/prod-gw");
    assert.equal(gw!.loc.line, 1);

    const vs = result.resources.find((r) => r.kind === "VirtualService");
    assert.ok(vs, "VirtualService not loaded");
    assert.equal(vs!.loc.file, "cluster://prod-ctx/default/VirtualService/shop-vs");
  } finally {
    cleanup();
  }
});

test("fetchFromCluster: warns on CRD-not-found and falls back to per-type fetching", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "istio-viz-cluster-crd-"));
  const origPath = process.env.PATH;

  // Stub that fails for the combined call but succeeds for "services" alone
  const wrapperPath = path.join(dir, "kubectl");
  const wrapperLines = [
    "#!/bin/sh",
    `ARGS="$*"`,
    `if echo "$ARGS" | grep -q "current-context"; then echo "test-ctx"; exit 0; fi`,
    // fail combined or any Istio type
    `if echo "$ARGS" | grep -q "gateways.networking.istio.io"; then`,
    `  echo "error: the server doesn't have a resource type" >&2`,
    `  exit 1`,
    `fi`,
    `if echo "$ARGS" | grep -q "virtualservices.networking.istio.io"; then`,
    `  echo "error: the server doesn't have a resource type" >&2`,
    `  exit 1`,
    `fi`,
    `if echo "$ARGS" | grep -q "destinationrules.networking.istio.io"; then`,
    `  echo "error: the server doesn't have a resource type" >&2`,
    `  exit 1`,
    `fi`,
    // succeed for services
    `echo '${SVC_YAML.replace(/'/g, "'\\''")}'`,
    `exit 0`,
  ];
  fs.writeFileSync(wrapperPath, wrapperLines.join("\n"), { mode: 0o755 });
  process.env.PATH = `${dir}:${origPath}`;

  try {
    const result = fetchFromCluster({ context: "test-ctx" });
    // Only Service should be loaded (Istio CRDs not installed)
    const kinds = result.resources.map((r) => r.kind);
    assert.ok(kinds.includes("Service"), "Service must be loaded");
    assert.ok(!kinds.includes("Gateway"), "Gateway should not be loaded");
    // Must have warnings about missing CRDs
    assert.ok(result.warnings.length >= 3, `expected CRD warnings, got: ${result.warnings.join(", ")}`);
    assert.ok(
      result.warnings.some((w) => w.includes("not found")),
      "should warn about missing resource type",
    );
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeClusterIntoFiles: file resources win on conflict", () => {
  const makeResource = (kind: string, ns: string, name: string, yaml: string): Resource => {
    const base = { name, namespace: ns, loc: { file: "test", line: 1 }, yaml };
    if (kind === "Service") return { kind: "Service", ...base, ports: [], selector: undefined };
    if (kind === "Gateway")
      return { kind: "Gateway", ...base, servers: [], selector: undefined };
    if (kind === "VirtualService")
      return {
        kind: "VirtualService",
        ...base,
        hosts: [],
        gateways: ["mesh"],
        http: [],
        hasTcp: false,
        hasTls: false,
      };
    throw new Error("unknown kind " + kind);
  };

  const fileSvc = makeResource("Service", "default", "shop-svc", "# from-file");
  const clusterSvc = makeResource("Service", "default", "shop-svc", "# from-cluster");
  const clusterOnly = makeResource("Service", "default", "other-svc", "# cluster-only");

  const files: LoadResult = { resources: [fileSvc], warnings: [] };
  const cluster: LoadResult = { resources: [clusterSvc, clusterOnly], warnings: [] };

  const merged = mergeClusterIntoFiles(files, cluster);
  assert.equal(merged.resources.length, 2);

  const shop = merged.resources.find((r) => r.name === "shop-svc");
  assert.equal(shop?.yaml, "# from-file", "file resource must win");

  const other = merged.resources.find((r) => r.name === "other-svc");
  assert.equal(other?.yaml, "# cluster-only", "cluster-only resource must be included");
});

test("mergeClusterIntoFiles: merges warnings from both sources", () => {
  const files: LoadResult = { resources: [], warnings: ["file-warning"] };
  const cluster: LoadResult = { resources: [], warnings: ["cluster-warning"] };
  const merged = mergeClusterIntoFiles(files, cluster);
  assert.deepEqual(merged.warnings, ["file-warning", "cluster-warning"]);
});

test("clusterHash: same resources produce same hash regardless of order", () => {
  const r = (name: string): Resource => ({
    kind: "Service",
    name,
    namespace: "default",
    loc: { file: "x", line: 1 },
    yaml: `name: ${name}`,
    ports: [],
  });
  const a = [r("alpha"), r("beta")];
  const b = [r("beta"), r("alpha")];
  assert.equal(clusterHash(a), clusterHash(b));
});

test("clusterHash: different yaml produces different hash", () => {
  const r = (yaml: string): Resource => ({
    kind: "Service",
    name: "s",
    namespace: "default",
    loc: { file: "x", line: 1 },
    yaml,
    ports: [],
  });
  assert.notEqual(clusterHash([r("v1")]), clusterHash([r("v2")]));
});
