import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPaths } from "../src/loader.js";
import { resolve } from "../src/resolve.js";
import type { RoutingModel } from "../src/types.js";

export const FIXTURES = path.join(import.meta.dirname, "..", "testdata");

export function buildModel(...paths: string[]): RoutingModel {
  const loaded = loadPaths(paths.map((p) => path.join(FIXTURES, p)));
  return resolve(loaded.resources);
}

/** Write yaml content to a temp file and build a model from it. */
export function buildFromYaml(yamlByFile: Record<string, string>): { model: RoutingModel; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "istio-viz-test-"));
  for (const [name, content] of Object.entries(yamlByFile)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const loaded = loadPaths([dir]);
  return { model: resolve(loaded.resources), dir };
}
