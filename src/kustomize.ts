/**
 * Kustomize integration: detect overlay roots, render them with
 * `kustomize build` (or `kubectl kustomize`), and extract referenced
 * directories so watch mode can follow bases outside the overlay.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

const KUSTOMIZATION_NAMES = ["kustomization.yaml", "kustomization.yml", "Kustomization"];

/** If p is a kustomize root (or the kustomization file itself), return the kustomization file path. */
export function findKustomizationFile(p: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  if (st.isFile()) {
    return KUSTOMIZATION_NAMES.includes(path.basename(p)) ? p : null;
  }
  if (st.isDirectory()) {
    for (const name of KUSTOMIZATION_NAMES) {
      const candidate = path.join(p, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface KustomizeBuildResult {
  text: string;
  /** virtual file name used for source locations */
  label: string;
  /** the command that produced the output, for diagnostics */
  command: string;
}

/** Render an overlay directory. Throws with kustomize's stderr on failure. */
export function kustomizeBuild(dir: string): KustomizeBuildResult {
  const attempts: [string, string[]][] = [
    ["kustomize", ["build", dir]],
    ["kubectl", ["kustomize", dir]],
  ];
  let lastErr = "no kustomize or kubectl binary found on PATH";
  for (const [cmd, args] of attempts) {
    const proc = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    if (proc.status === 0) {
      return { text: proc.stdout, label: `${dir} (kustomize build)`, command: `${cmd} ${args.join(" ")}` };
    }
    lastErr = (proc.stderr || proc.error?.message || `exit code ${proc.status}`).trim();
    break; // the binary exists but the build failed — don't retry with the fallback
  }
  throw new Error(`kustomize build of ${dir} failed: ${lastErr}`);
}

/**
 * Directories to watch for an overlay: the overlay root plus every existing
 * relative path referenced by resources/bases/components/patches.
 */
export function kustomizeWatchDirs(kustomizationFile: string): string[] {
  const root = path.dirname(path.resolve(kustomizationFile));
  const dirs = new Set<string>([root]);
  let doc: Record<string, unknown>;
  try {
    doc = parse(fs.readFileSync(kustomizationFile, "utf8")) as Record<string, unknown>;
  } catch {
    return [...dirs];
  }
  if (doc == null || typeof doc !== "object") return [...dirs];

  const refs: string[] = [];
  for (const key of ["resources", "bases", "components", "patchesStrategicMerge"]) {
    const v = doc[key];
    if (Array.isArray(v)) for (const e of v) if (typeof e === "string") refs.push(e);
  }
  const patches = doc["patches"];
  if (Array.isArray(patches)) {
    for (const e of patches) {
      if (typeof e === "string") refs.push(e);
      else if (e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string") {
        refs.push((e as { path: string }).path);
      }
    }
  }

  for (const ref of refs) {
    if (/^[a-z]+:\/\//.test(ref)) continue; // remote bases can't be watched
    const resolved = path.resolve(root, ref);
    try {
      const st = fs.statSync(resolved);
      dirs.add(st.isDirectory() ? resolved : path.dirname(resolved));
    } catch {
      // referenced path missing — kustomize build will report it
    }
  }
  return [...dirs];
}
