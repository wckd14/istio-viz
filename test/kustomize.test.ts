import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { findKustomizationFile, kustomizeWatchDirs } from "../src/kustomize.js";
import { loadPaths } from "../src/loader.js";
import { resolve } from "../src/resolve.js";
import { FIXTURES } from "./helpers.js";

const OVERLAY = path.join(FIXTURES, "kustomize", "overlays", "prod");

const hasKustomize =
  spawnSync("kustomize", ["version"], { encoding: "utf8" }).status === 0 ||
  spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status === 0;

test("findKustomizationFile detects roots and files, ignores plain dirs", () => {
  assert.ok(findKustomizationFile(OVERLAY)?.endsWith("kustomization.yaml"));
  assert.ok(findKustomizationFile(path.join(OVERLAY, "kustomization.yaml")));
  assert.equal(findKustomizationFile(path.join(FIXTURES, "bookinfo")), null);
  assert.equal(findKustomizationFile(path.join(FIXTURES, "nope")), null);
});

test("kustomizeWatchDirs includes the overlay root and referenced base", () => {
  const dirs = kustomizeWatchDirs(path.join(OVERLAY, "kustomization.yaml"));
  assert.ok(dirs.includes(path.resolve(OVERLAY)));
  assert.ok(dirs.includes(path.resolve(FIXTURES, "kustomize", "base")));
});

test("overlay builds, filters non-network kinds silently, applies patches", { skip: !hasKustomize }, () => {
  const loaded = loadPaths([OVERLAY]);
  // Deployment/PVC/ConfigMap are in the build output but produce no warnings
  assert.deepEqual(loaded.warnings, []);
  const kinds = [...new Set(loaded.resources.map((r) => r.kind))].sort();
  assert.deepEqual(kinds, ["Gateway", "Service", "VirtualService"]);
  // namespace transformer applied
  assert.ok(loaded.resources.every((r) => r.namespace === "prod"));
  // source locations point at the generated stream
  assert.match(loaded.resources[0]!.loc.file, /\(kustomize build\)$/);

  const model = resolve(loaded.resources);
  assert.equal(model.findings.length, 0);
  const section = model.sections[0]!;
  assert.equal(section.listener.gateway, "shop-gateway");
  // canary patch: 80/20 weighted split present
  const weights = model.edges.filter((e) => e.kind === "routes" && e.weight !== undefined).map((e) => e.weight);
  assert.deepEqual(weights.sort((a, b) => b! - a!), [100, 80, 20]);
});

test("broken overlay surfaces kustomize's error", { skip: !hasKustomize }, () => {
  const dir = fs.mkdtempSync(path.join(import.meta.dirname, "..", "testdata", ".tmp-broken-"));
  try {
    fs.writeFileSync(path.join(dir, "kustomization.yaml"), "resources:\n  - does-not-exist.yaml\n");
    assert.throws(() => loadPaths([dir]), /kustomize build .* failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
