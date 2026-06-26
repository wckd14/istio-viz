/**
 * Loader: walks file/dir paths, parses multi-document YAML, classifies the
 * four recognized kinds, and records a source location (file + line) for
 * every resource, http route entry, and route destination.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { LineCounter, parseAllDocuments, isMap, isSeq, type Node, type Document } from "yaml";
import { findKustomizationFile, kustomizeBuild } from "./kustomize.js";
import type {
  DestinationRuleResource,
  GatewayResource,
  HTTPRoute,
  LoadResult,
  Resource,
  ServiceResource,
  SourceLoc,
  VirtualServiceResource,
} from "./types.js";

const RECOGNIZED = new Set(["Gateway", "VirtualService", "Service", "DestinationRule"]);

export function collectFiles(paths: string[], warnings: string[] = []): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const st = fs.statSync(p); // throws ENOENT for explicitly-named bad paths — surfaced by CLI
    if (st.isDirectory()) {
      walk(p, files, warnings);
    } else {
      files.push(p);
    }
  }
  return files;
}

function walk(dir: string, out: string[], warnings: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A single unreadable subdirectory (permissions, special fs) must not abort
    // the whole scan — skip it with a warning, like a YAML parse error does.
    warnings.push(`cannot read directory ${dir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message} (skipped)`);
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, warnings);
    else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
}

export interface LoadOpts {
  /** suppress "unrecognized kind" warnings (kustomize output is full of them by design) */
  quietUnrecognized?: boolean;
}

export function loadPaths(paths: string[]): LoadResult {
  const result: LoadResult = { resources: [], warnings: [] };
  for (const p of paths) {
    const kfile = findKustomizationFile(p);
    if (kfile) {
      const dir = path.dirname(path.resolve(kfile));
      const built = kustomizeBuild(dir); // throws on build failure — surfaced by caller
      loadText(built.text, built.label, result, { quietUnrecognized: true });
    } else {
      for (const file of collectFiles([p], result.warnings)) loadFile(file, result);
    }
  }
  return result;
}

export function loadFile(file: string, result: LoadResult, opts: LoadOpts = {}): void {
  loadText(fs.readFileSync(file, "utf8"), file, result, opts);
}

/** Parse a (possibly multi-document) YAML string; `file` is the name used in source locations. */
export function loadText(text: string, file: string, result: LoadResult, opts: LoadOpts = {}): void {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter });
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      result.warnings.push(`${file}: YAML parse error: ${doc.errors[0]!.message.split("\n")[0]}`);
      continue;
    }
    const js = doc.toJS() as Record<string, unknown> | null;
    if (js == null || typeof js !== "object") continue;
    handleDoc(js, { file, text, doc, lineCounter, basePath: [] }, result, opts);
  }
}

/**
 * Classify one document, transparently unwrapping Kubernetes `List` objects
 * (the shape produced by `kubectl get … -o yaml`): each entry of `.items` is
 * processed as if it were its own document, with `basePath` keeping its
 * file:line accurate against the original stream. Non-network kinds inside a
 * List are dropped quietly, like kustomize build output.
 */
function handleDoc(js: Record<string, unknown>, ctx: DocCtx, result: LoadResult, opts: LoadOpts): void {
  const kind = typeof js.kind === "string" ? js.kind : undefined;
  if (kind && kind.endsWith("List") && Array.isArray(js.items)) {
    (js.items as unknown[]).forEach((item, i) => {
      if (item && typeof item === "object") {
        handleDoc(item as Record<string, unknown>, { ...ctx, basePath: [...ctx.basePath, "items", i] }, result, {
          ...opts,
          quietUnrecognized: true,
        });
      }
    });
    return;
  }
  const res = classify(js, ctx, result.warnings, opts);
  if (res) result.resources.push(res);
}

interface DocCtx {
  file: string;
  text: string;
  doc: Document;
  lineCounter: LineCounter;
  /** AST path to the current resource's root (non-empty when unwrapped from a List). */
  basePath: (string | number)[];
}

function nodeLoc(ctx: DocCtx, node: Node | null | undefined): SourceLoc | undefined {
  if (!node || !node.range) return undefined;
  return { file: ctx.file, line: ctx.lineCounter.linePos(node.range[0]).line };
}

/** Get the yaml AST node at a path like ["spec","http",0], relative to the resource root. */
function getNode(ctx: DocCtx, p: (string | number)[]): Node | null {
  let cur: unknown = ctx.doc.contents;
  for (const key of [...ctx.basePath, ...p]) {
    if (isMap(cur)) {
      const pair = cur.items.find((it) => (it.key as { value?: unknown } | null)?.value === key);
      cur = pair?.value ?? null;
    } else if (isSeq(cur) && typeof key === "number") {
      cur = cur.items[key] ?? null;
    } else {
      return null;
    }
    if (cur == null) return null;
  }
  return cur as Node;
}

function fragmentAt(ctx: DocCtx, node: Node | null): string {
  if (!node?.range) return "";
  return dedent(ctx.text.slice(node.range[0], node.range[1]).replace(/\s+$/, ""));
}

function dedent(s: string): string {
  const lines = s.split("\n");
  if (lines.length < 2) return s;
  let min = Infinity;
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const indent = l.length - l.trimStart().length;
    if (indent < min) min = indent;
  }
  if (!isFinite(min) || min === 0) return s;
  return [lines[0], ...lines.slice(1).map((l) => l.slice(min))].join("\n");
}

function classify(js: Record<string, unknown>, ctx: DocCtx, warnings: string[], opts: LoadOpts = {}): Resource | null {
  const kind = typeof js.kind === "string" ? js.kind : undefined;
  const apiVersion = typeof js.apiVersion === "string" ? js.apiVersion : "";
  const rootNode = getNode(ctx, []);
  const rootLoc = nodeLoc(ctx, rootNode) ?? { file: ctx.file, line: 1 };
  if (!kind) {
    warnings.push(`${ctx.file}:${rootLoc.line}: document without kind ignored`);
    return null;
  }
  if (!RECOGNIZED.has(kind)) {
    if (!opts.quietUnrecognized) warnings.push(`${ctx.file}:${rootLoc.line}: unrecognized kind ${kind} ignored`);
    return null;
  }
  const istioKind = kind !== "Service";
  if (istioKind && !/^networking\.istio\.io\/(v1alpha3|v1beta1|v1)$/.test(apiVersion)) {
    // e.g. gateway.networking.k8s.io Gateways — a different API, expected in kustomize output
    if (!opts.quietUnrecognized) {
      warnings.push(`${ctx.file}:${rootLoc.line}: ${kind} with unsupported apiVersion "${apiVersion}" ignored`);
    }
    return null;
  }
  if (!istioKind && apiVersion !== "v1") {
    if (!opts.quietUnrecognized) {
      warnings.push(`${ctx.file}:${rootLoc.line}: Service with apiVersion "${apiVersion}" ignored`);
    }
    return null;
  }

  const meta = (js.metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.name === "string" ? meta.name : "";
  const namespace = typeof meta.namespace === "string" ? meta.namespace : "default";
  if (!name) {
    warnings.push(`${ctx.file}:${rootLoc.line}: ${kind} without metadata.name ignored`);
    return null;
  }
  const spec = (js.spec ?? {}) as Record<string, unknown>;
  const base = {
    name,
    namespace,
    loc: rootLoc,
    yaml: fragmentAt(ctx, rootNode),
  };

  switch (kind) {
    case "Gateway": {
      const servers = asArray(spec.servers).map((s, i) => {
        const sv = s as Record<string, unknown>;
        const port = (sv.port ?? {}) as Record<string, unknown>;
        return {
          port: {
            number: Number(port.number ?? 0),
            name: port.name as string | undefined,
            protocol: String(port.protocol ?? ""),
          },
          hosts: asArray(sv.hosts).map(String),
          tls: sv.tls as { mode?: string } | undefined,
          loc: nodeLoc(ctx, getNode(ctx, ["spec", "servers", i])) ?? rootLoc,
        };
      });
      const gw: GatewayResource = {
        kind: "Gateway",
        ...base,
        selector: spec.selector as Record<string, string> | undefined,
        servers,
      };
      return gw;
    }
    case "VirtualService": {
      const rawGateways = asArray(spec.gateways).map(String);
      const http: HTTPRoute[] = asArray(spec.http).map((h, i) => {
        const node = getNode(ctx, ["spec", "http", i]);
        const route = h as HTTPRoute;
        route.loc = nodeLoc(ctx, node) ?? rootLoc;
        route.yaml = fragmentAt(ctx, node);
        for (let d = 0; d < (route.route?.length ?? 0); d++) {
          const dn = getNode(ctx, ["spec", "http", i, "route", d]);
          route.route![d]!.loc = nodeLoc(ctx, dn) ?? route.loc;
        }
        return route;
      });
      const vs: VirtualServiceResource = {
        kind: "VirtualService",
        ...base,
        hosts: asArray(spec.hosts).map(String),
        gateways: rawGateways.length > 0 ? rawGateways : ["mesh"],
        http,
        hasTcp: asArray(spec.tcp).length > 0,
        hasTls: asArray(spec.tls).length > 0,
        gatewaysLoc: nodeLoc(ctx, getNode(ctx, ["spec", "gateways"])) ?? rootLoc,
      };
      return vs;
    }
    case "Service": {
      const svc: ServiceResource = {
        kind: "Service",
        ...base,
        ports: asArray(spec.ports).map((p) => {
          const pp = p as Record<string, unknown>;
          return {
            name: pp.name as string | undefined,
            port: Number(pp.port ?? 0),
            protocol: pp.protocol as string | undefined,
            targetPort: pp.targetPort as number | string | undefined,
          };
        }),
        selector: spec.selector as Record<string, string> | undefined,
      };
      return svc;
    }
    case "DestinationRule": {
      const dr: DestinationRuleResource = {
        kind: "DestinationRule",
        ...base,
        host: String(spec.host ?? ""),
        subsets: asArray(spec.subsets).map((s, i) => {
          const ss = s as Record<string, unknown>;
          return {
            name: String(ss.name ?? ""),
            labels: ss.labels as Record<string, string> | undefined,
            loc: nodeLoc(ctx, getNode(ctx, ["spec", "subsets", i])) ?? rootLoc,
          };
        }),
      };
      return dr;
    }
  }
  return null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
