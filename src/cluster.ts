/**
 * Cluster backend: fetch Gateway, VirtualService, Service, and DestinationRule
 * resources from a live Kubernetes cluster via kubectl and return them in the
 * same LoadResult format used by the file loader.
 *
 * All cluster I/O is delegated to the kubectl binary already expected on PATH.
 * No k8s client library is needed.
 */
import { spawnSync } from "node:child_process";
import { loadText } from "./loader.js";
import type { LoadResult, Resource } from "./types.js";

export interface ClusterOpts {
  /** kubeconfig context to use (default: current-context) */
  context?: string;
  /** restrict to one namespace (default: all namespaces) */
  namespace?: string;
  /** path to kubeconfig file (default: KUBECONFIG env / ~/.kube/config) */
  kubeconfig?: string;
}

// Use fully-qualified resource type names to disambiguate from gateway.networking.k8s.io
// when both Istio and the Kubernetes Gateway API CRDs are installed.
const ISTIO_TYPES = [
  "gateways.networking.istio.io",
  "virtualservices.networking.istio.io",
  "destinationrules.networking.istio.io",
];
const CORE_TYPES = ["services"];

/**
 * Fetch Istio/k8s resources from a live cluster.
 *
 * Returns a LoadResult identical in shape to what loadPaths() produces.
 * Throws on fatal errors (kubectl not found, cluster unreachable).
 * Missing Istio CRDs are demoted to warnings so the tool still renders
 * the Service topology even on a cluster where Istio isn't installed.
 */
export function fetchFromCluster(opts: ClusterOpts = {}): LoadResult {
  const context = opts.context ?? resolveCurrentContext(opts.kubeconfig);
  const merged: LoadResult = { resources: [], warnings: [] };

  // Try to fetch all types in one round-trip.
  const all = [...ISTIO_TYPES, ...CORE_TYPES].join(",");
  const first = kubectl(["get", all, "--output", "yaml", ...namespaceArgs(opts), ...authArgs(opts)]);

  if (first.ok) {
    const label = clusterLabel(context);
    loadText(first.stdout, label, merged, { quietUnrecognized: true });
    patchTopLevelLocs(merged.resources, context);
    return merged;
  }

  // If the combined fetch failed because some Istio CRDs aren't installed,
  // fall back to fetching each group individually and collect partial results.
  if (isCRDError(first.stderr)) {
    fetchGroup(ISTIO_TYPES, context, opts, merged);
    fetchGroup(CORE_TYPES, context, opts, merged);
    patchTopLevelLocs(merged.resources, context);
    return merged;
  }

  // Real failure (auth, unreachable, context not found).
  throwKubectlError(first, context);
}

/**
 * Merge a cluster LoadResult into a file LoadResult.
 * File resources always win: a cluster resource with the same kind/namespace/name
 * as a file resource is dropped (so local manifests override live state).
 */
export function mergeClusterIntoFiles(files: LoadResult, cluster: LoadResult): LoadResult {
  const fileKeys = new Set(files.resources.map(resourceKey));
  return {
    resources: [...files.resources, ...cluster.resources.filter((r) => !fileKeys.has(resourceKey(r)))],
    warnings: [...files.warnings, ...cluster.warnings],
  };
}

/* ---------- internals ---------- */

interface KubectlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function kubectl(args: string[]): KubectlResult {
  const proc = spawnSync("kubectl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("kubectl not found on PATH — install kubectl or add it to PATH to use --cluster");
    }
    throw new Error(`kubectl spawn failed: ${proc.error.message}`);
  }

  return {
    ok: proc.status === 0,
    stdout: proc.stdout ?? "",
    stderr: (proc.stderr ?? "").trim(),
  };
}

function fetchGroup(types: string[], context: string, opts: ClusterOpts, into: LoadResult): void {
  for (const t of types) {
    const r = kubectl(["get", t, "--output", "yaml", ...namespaceArgs(opts), ...authArgs(opts)]);
    if (r.ok) {
      loadText(r.stdout, clusterLabel(context), into, { quietUnrecognized: true });
    } else if (isCRDError(r.stderr)) {
      into.warnings.push(`cluster://${context}: resource type "${t}" not found — is Istio installed?`);
    } else {
      // Non-fatal: warn and continue so other types still load.
      into.warnings.push(`cluster://${context}: kubectl get ${t} failed: ${r.stderr}`);
    }
  }
}

function namespaceArgs(opts: ClusterOpts): string[] {
  return opts.namespace ? ["--namespace", opts.namespace] : ["--all-namespaces"];
}

function authArgs(opts: ClusterOpts): string[] {
  const args: string[] = [];
  if (opts.context) args.push("--context", opts.context);
  if (opts.kubeconfig) args.push("--kubeconfig", opts.kubeconfig);
  return args;
}

function clusterLabel(context: string): string {
  return `cluster://${context}`;
}

/**
 * Replace the top-level source location on every resource with a human-readable
 * cluster path: cluster://<context>/<namespace>/<Kind>/<name>.
 * Sub-element locs (individual HTTPRoute lines) retain the label:lineNumber form.
 */
function patchTopLevelLocs(resources: Resource[], context: string): void {
  for (const r of resources) {
    r.loc = { file: `cluster://${context}/${r.namespace}/${r.kind}/${r.name}`, line: 1 };
  }
}

function resourceKey(r: Resource): string {
  return `${r.kind}/${r.namespace}/${r.name}`;
}

/**
 * Returns true when kubectl stderr indicates a CRD is not registered on the cluster
 * (as opposed to an auth/connectivity failure).
 */
function isCRDError(stderr: string): boolean {
  return (
    stderr.includes("doesn't have a resource type") ||
    stderr.includes("the server could not find the requested resource") ||
    stderr.includes("no matches for kind")
  );
}

function throwKubectlError(r: KubectlResult, context: string): never {
  throw new Error(`kubectl get failed (context: ${context}):\n${r.stderr}`);
}

/**
 * Resolve the active kubeconfig context name for use in source labels.
 * Falls back to "current" on any error — the main kubectl call will surface real failures.
 */
function resolveCurrentContext(kubeconfig?: string): string {
  const args = ["config", "current-context"];
  if (kubeconfig) args.push("--kubeconfig", kubeconfig);
  const proc = spawnSync("kubectl", args, { encoding: "utf8" });
  return proc.status === 0 && proc.stdout ? proc.stdout.trim() : "current";
}

/**
 * Produce a stable string that changes whenever the resource set changes.
 * Used by watch mode to avoid unnecessary re-renders on poll ticks.
 */
export function clusterHash(resources: Resource[]): string {
  return resources
    .map((r) => `${r.kind}/${r.namespace}/${r.name}\n${r.yaml}`)
    .sort()
    .join("\0");
}
