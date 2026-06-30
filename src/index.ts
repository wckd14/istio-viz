#!/usr/bin/env node
/** istio-viz CLI: render | trace | lint */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import { loadPaths } from "./loader.js";
import { fetchFromCluster, mergeClusterIntoFiles, type ClusterOpts } from "./cluster.js";
import { renderPathsText } from "./paths.js";
import { filterModel, resolve } from "./resolve.js";
import { trace } from "./trace.js";
import { renderText, renderTraceText, formatFinding } from "./render/text.js";
import { renderDot } from "./render/dot.js";
import { layoutModel } from "./render/layout.js";
import { renderSvgDocument } from "./render/svg.js";
import { renderHtml } from "./render/html.js";
import { startWatchServer } from "./watch.js";
import type { RoutingModel, TraceRequest } from "./types.js";

// Version is stamped at bundle time via esbuild `--define` (see scripts/bundle.mjs).
// In dev (tsx) and locally-linked builds it falls back to package.json, then a dev marker.
declare const __ISTIO_VIZ_VERSION__: string | undefined;
function resolveVersion(): string {
  if (typeof __ISTIO_VIZ_VERSION__ === "string" && __ISTIO_VIZ_VERSION__.length > 0) {
    return __ISTIO_VIZ_VERSION__;
  }
  try {
    return createRequire(import.meta.url)("../package.json").version as string;
  } catch {
    return "0.0.0-dev";
  }
}

const program = new Command();
program
  .name("istio-viz")
  .description("Visualize effective Istio L7 routing from Gateway/VirtualService/Service/DestinationRule manifests")
  .version(resolveVersion());

program
  .command("render")
  .description("render the routing topology")
  .argument("[paths...]", "YAML files or directories (optional when --cluster is set)")
  .option("-o, --out <file>", "output file (default: stdout for text/dot, routes.html otherwise)")
  .option("--format <fmt>", "html|svg|png|dot|text|paths", "html")
  .option("--gateway <name>", "only show this gateway")
  .option("--host <pattern>", "only show hosts matching this pattern")
  .option("--namespace <ns>", "only show VirtualServices in this namespace")
  .option("--uri <prefix>", "only show rules with a URI condition under this path prefix")
  .option("--service <name>", "only show rules routing to services whose name contains this string")
  .option("--strict", "exit non-zero if any error-severity finding is emitted", false)
  .option("--cluster", "fetch resources from the active Kubernetes cluster via kubectl")
  .option("--context <ctx>", "kubeconfig context to use (implies --cluster)")
  .option("--kubeconfig <path>", "path to kubeconfig file (implies --cluster)")
  .action((paths: string[], opts) => {
    const { model, warnings } = build(paths, clusterOpts(opts));
    const filtered = filterModel(model, {
      gateway: opts.gateway,
      host: opts.host,
      namespace: opts.namespace,
      uri: opts.uri,
      service: opts.service,
    });
    emitWarnings(warnings);

    const fmt = String(opts.format).toLowerCase();
    switch (fmt) {
      case "text": {
        const text = renderText(filtered, { color: !opts.out && process.stdout.isTTY });
        writeOut(text, opts.out);
        break;
      }
      case "dot":
        writeOut(renderDot(filtered), opts.out);
        break;
      case "paths":
        writeOut(renderPathsText(filtered), opts.out);
        break;
      case "svg":
        writeOut(renderSvgDocument(filtered, layoutModel(filtered)), opts.out ?? "routes.svg", true);
        break;
      case "png": {
        const svg = renderSvgDocument(filtered, layoutModel(filtered));
        renderPng(svg, opts.out ?? "routes.png");
        break;
      }
      case "html":
        writeOut(renderHtml(filtered), opts.out ?? "routes.html", true);
        break;
      default:
        fail(`unknown --format "${opts.format}" (expected html|svg|png|dot|text|paths)`);
    }
    finish(model, opts.strict);
  });

program
  .command("trace")
  .description("trace a synthetic request through the routing model")
  .argument("[paths...]", "YAML files or directories (optional when --cluster is set)")
  .requiredOption("--host <host>", "request :authority / Host")
  .requiredOption("--path <path>", "request path (may include ?query)")
  .option("--method <m>", "HTTP method", "GET")
  .option("--header <k=v...>", "request header, repeatable", collectKV, {})
  .option("--port <n>", "gateway listener port", (v) => parseInt(v, 10))
  .option("-o, --out <file>", "write HTML with the winning path highlighted")
  .option("--format <fmt>", "text|html", "text")
  .option("--cluster", "fetch resources from the active Kubernetes cluster via kubectl")
  .option("--context <ctx>", "kubeconfig context to use (implies --cluster)")
  .option("--kubeconfig <path>", "path to kubeconfig file (implies --cluster)")
  .action((paths: string[], opts) => {
    const { model, warnings } = build(paths, clusterOpts(opts));
    emitWarnings(warnings);
    const req: TraceRequest = {
      host: opts.host,
      path: opts.path,
      method: String(opts.method).toUpperCase(),
      headers: opts.header,
      port: opts.port,
    };
    const result = trace(model, req);
    const wantHtml = opts.out || String(opts.format).toLowerCase() === "html";
    if (wantHtml) {
      writeOut(renderHtml(model, { trace: result, title: "istio-viz — trace" }), opts.out ?? "trace.html", true);
      process.stdout.write(renderTraceText(model, result));
    } else {
      process.stdout.write(renderTraceText(model, result));
    }
    process.exitCode = result.winner ? 0 : 1;
  });

program
  .command("lint")
  .description("emit findings only, no diagram")
  .argument("[paths...]", "YAML files or directories (optional when --cluster is set)")
  .option("--strict", "exit non-zero on error-severity findings", false)
  .option("--cluster", "fetch resources from the active Kubernetes cluster via kubectl")
  .option("--context <ctx>", "kubeconfig context to use (implies --cluster)")
  .option("--kubeconfig <path>", "path to kubeconfig file (implies --cluster)")
  .action((paths: string[], opts) => {
    const { model, warnings } = build(paths, clusterOpts(opts));
    emitWarnings(warnings);
    if (model.findings.length === 0) {
      process.stdout.write("no findings\n");
    } else {
      for (const f of model.findings) process.stdout.write(formatFinding(f) + "\n");
    }
    finish(model, opts.strict);
  });

program
  .command("watch")
  .description("serve the HTML report and re-render live on file changes (supports kustomize overlays)")
  .argument("[paths...]", "YAML files, directories, or kustomize overlay directories (optional when --cluster is set)")
  .option("--port <n>", "listen port (0 = random)", (v) => parseInt(v, 10), 4400)
  .option("--gateway <name>", "only show this gateway")
  .option("--host <pattern>", "only show hosts matching this pattern")
  .option("--namespace <ns>", "only show VirtualServices in this namespace")
  .option("--uri <prefix>", "only show rules with a URI condition under this path prefix")
  .option("--service <name>", "only show rules routing to services whose name contains this string")
  .option("--cluster", "fetch resources from the active Kubernetes cluster via kubectl")
  .option("--context <ctx>", "kubeconfig context to use (implies --cluster)")
  .option("--kubeconfig <path>", "path to kubeconfig file (implies --cluster)")
  .option("--poll-interval <n>", "seconds between cluster re-fetches in watch mode", (v) => parseInt(v, 10), 30)
  .action(async (paths: string[], opts) => {
    try {
      await startWatchServer(paths, {
        port: opts.port,
        filter: {
          gateway: opts.gateway,
          host: opts.host,
          namespace: opts.namespace,
          uri: opts.uri,
          service: opts.service,
        },
        clusterOpts: clusterOpts(opts),
        pollInterval: opts.pollInterval,
      });
      // keep running until interrupted
    } catch (err) {
      fail((err as Error).message);
    }
  });

program.parse();

/* ---------------- helpers ---------------- */

function clusterOpts(opts: Record<string, unknown>): ClusterOpts | undefined {
  if (!opts.cluster && !opts.context && !opts.kubeconfig) return undefined;
  return {
    context: opts.context as string | undefined,
    namespace: opts.namespace as string | undefined,
    kubeconfig: opts.kubeconfig as string | undefined,
  };
}

function build(paths: string[], cluster?: ClusterOpts): { model: RoutingModel; warnings: string[] } {
  if (paths.length === 0 && !cluster) {
    fail("provide at least one path argument, or use --cluster to fetch from a live cluster");
  }
  try {
    const fileLoaded = paths.length > 0 ? loadPaths(paths) : { resources: [], warnings: [] };
    const clusterLoaded = cluster ? fetchFromCluster(cluster) : { resources: [], warnings: [] };
    const loaded = cluster ? mergeClusterIntoFiles(fileLoaded, clusterLoaded) : fileLoaded;
    return { model: resolve(loaded.resources), warnings: loaded.warnings };
  } catch (err) {
    fail((err as Error).message);
  }
}

function emitWarnings(warnings: string[]): void {
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
}

function writeOut(content: string, out?: string, announce = false): void {
  if (out) {
    fs.writeFileSync(out, content);
    if (announce) process.stderr.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(content);
  }
}

function renderPng(svg: string, out: string): void {
  import("@resvg/resvg-js")
    .then(({ Resvg }) => {
      const png = new Resvg(svg, { fitTo: { mode: "zoom", value: 2 } }).render().asPng();
      fs.writeFileSync(out, png);
      process.stderr.write(`wrote ${out}\n`);
    })
    .catch(() => {
      fail("png export requires the optional @resvg/resvg-js dependency (npm install @resvg/resvg-js), or use --format svg");
    });
}

function finish(model: RoutingModel, strict: boolean): void {
  if (strict && model.findings.some((f) => f.severity === "error")) {
    process.exitCode = 2;
  }
}

function collectKV(value: string, acc: Record<string, string>): Record<string, string> {
  const idx = value.indexOf("=");
  if (idx === -1) fail(`--header expects k=v, got "${value}"`);
  acc[value.slice(0, idx)] = value.slice(idx + 1);
  return acc;
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}
