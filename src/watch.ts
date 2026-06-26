/**
 * Live mode: serve the HTML report over a local HTTP server, watch the input
 * paths (including kustomize overlay roots and their referenced bases), and
 * push a reload to connected browsers on every rebuild.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { loadPaths } from "./loader.js";
import { fetchFromCluster, mergeClusterIntoFiles, clusterHash, type ClusterOpts } from "./cluster.js";
import { findKustomizationFile, kustomizeWatchDirs } from "./kustomize.js";
import { filterModel, resolve, type FilterOpts } from "./resolve.js";
import { renderHtml } from "./render/html.js";

export interface WatchOpts {
  port?: number; // 0 = ephemeral
  filter?: FilterOpts;
  log?: (msg: string) => void;
  /** When set, poll the cluster on each tick and re-render on diff. */
  clusterOpts?: ClusterOpts;
  /** Seconds between cluster polls (default: 30). */
  pollInterval?: number;
}

export interface WatchHandle {
  server: http.Server;
  url: string;
  /** force a rebuild (also used by tests) */
  rebuild: () => void;
  close: () => Promise<void>;
}

/** Injected into the served page: auto-reload via SSE + filter-state persistence. */
const LIVE_CLIENT = `<script>
(function () {
  // restore filter state saved before the previous reload
  try {
    var saved = JSON.parse(sessionStorage.getItem("istio-viz-filters") || "{}");
    ["f-gw", "f-ns", "f-host", "f-uri", "f-svc"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && saved[id] !== undefined) {
        el.value = saved[id];
        el.dispatchEvent(new Event("change"));
      }
    });
    var warn = document.getElementById("f-warn");
    if (warn && saved["f-warn"]) { warn.checked = true; warn.dispatchEvent(new Event("change")); }
  } catch (e) {}
  function save() {
    var state = {};
    ["f-gw", "f-ns", "f-host", "f-uri", "f-svc"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) state[id] = el.value;
    });
    var warn = document.getElementById("f-warn");
    if (warn) state["f-warn"] = warn.checked;
    sessionStorage.setItem("istio-viz-filters", JSON.stringify(state));
  }
  ["f-gw", "f-ns", "f-host", "f-uri", "f-svc", "f-warn"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", save);
  });
  var es = new EventSource("/__events");
  es.addEventListener("reload", function () { location.reload(); });
})();
</script>`;

export function startWatchServer(paths: string[], opts: WatchOpts = {}): Promise<WatchHandle> {
  const log = opts.log ?? ((m: string) => process.stderr.write(m + "\n"));
  let html = "";
  let generation = 0;
  const clients = new Set<http.ServerResponse>();

  // Last seen cluster hash — used to skip re-renders when nothing changed on poll.
  let lastClusterHash = "";

  const rebuild = (clusterResources?: import("./types.js").Resource[]): void => {
    generation++;
    try {
      const fileLoaded = paths.length > 0 ? loadPaths(paths) : { resources: [], warnings: [] };
      const clusterLoaded =
        clusterResources !== undefined
          ? { resources: clusterResources, warnings: [] }
          : opts.clusterOpts
            ? fetchFromCluster(opts.clusterOpts)
            : { resources: [], warnings: [] };
      const loaded = opts.clusterOpts
        ? mergeClusterIntoFiles(fileLoaded, clusterLoaded)
        : fileLoaded;
      for (const w of loaded.warnings) log(`warning: ${w}`);
      const model = filterModel(resolve(loaded.resources), opts.filter ?? {});
      html = renderHtml(model, { title: "istio-viz — live" })
        .replace("</header>", `</header>${warningsBanner(loaded.warnings)}`)
        .replace("</body>", `${LIVE_CLIENT}</body>`);
      log(`rebuilt (#${generation}): ${model.findings.length} finding(s)`);
    } catch (err) {
      const msg = (err as Error).message;
      log(`rebuild failed: ${msg}`);
      html = errorPage(msg);
    }
    for (const res of clients) res.write(`event: reload\ndata: ${generation}\n\n`);
  };

  rebuild();

  const server = http.createServer((req, res) => {
    if (req.url === "/__events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${generation}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
  });

  // ---- file watching ----
  const watchDirs = new Set<string>();
  const kustomizeRoots: string[] = [];
  for (const p of paths) {
    const kfile = findKustomizationFile(p);
    if (kfile) {
      kustomizeRoots.push(path.dirname(path.resolve(kfile)));
      for (const d of kustomizeWatchDirs(kfile)) watchDirs.add(d);
    } else {
      try {
        const st = fs.statSync(p);
        watchDirs.add(st.isDirectory() ? path.resolve(p) : path.dirname(path.resolve(p)));
      } catch {
        // surfaced by the initial rebuild
      }
    }
  }

  let timer: NodeJS.Timeout | undefined;
  const onChange = (dir: string, filename: string | null): void => {
    const full = filename ? path.join(dir, filename) : dir;
    const insideKustomize = kustomizeRoots.some((r) => full.startsWith(r + path.sep) || full === r);
    // generators may consume arbitrary files inside a kustomize root; elsewhere only YAML matters
    if (!insideKustomize && filename && !/\.ya?ml$/i.test(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 250);
  };

  const watchers: fs.FSWatcher[] = [];
  for (const dir of watchDirs) {
    try {
      const w = fs.watch(dir, { recursive: true }, (_event, filename) => onChange(dir, filename));
      watchers.push(w);
    } catch (err) {
      log(`warning: cannot watch ${dir}: ${(err as Error).message}`);
    }
  }
  if (watchers.length > 0) {
    log(`watching: ${[...watchDirs].join(", ")}`);
  }

  // ---- cluster polling ----
  let pollTimer: NodeJS.Timeout | undefined;
  if (opts.clusterOpts) {
    const intervalMs = Math.max(5, opts.pollInterval ?? 30) * 1000;
    const poll = (): void => {
      let fetched: import("./types.js").Resource[] = [];
      try {
        const result = fetchFromCluster(opts.clusterOpts!);
        for (const w of result.warnings) log(`warning: ${w}`);
        fetched = result.resources;
      } catch (err) {
        log(`cluster poll failed: ${(err as Error).message}`);
        return;
      }
      const h = clusterHash(fetched);
      if (h === lastClusterHash) return; // nothing changed
      lastClusterHash = h;
      log("cluster state changed — rebuilding");
      rebuild(fetched);
    };
    pollTimer = setInterval(poll, intervalMs);
    log(`polling cluster every ${intervalMs / 1000}s`);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    server.on("error", rejectPromise);
    server.listen(opts.port ?? 4400, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      const url = `http://127.0.0.1:${port}/`;
      log(`serving ${url}`);
      resolvePromise({
        server,
        url,
        rebuild,
        close: () =>
          new Promise<void>((done) => {
            clearTimeout(timer);
            clearInterval(pollTimer);
            for (const w of watchers) w.close();
            for (const res of clients) res.end();
            clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Banner shown under the header when the inputs loaded with warnings (parse errors, ignored docs). */
function warningsBanner(warnings: string[]): string {
  if (warnings.length === 0) return "";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const items = warnings.map((w) => `<li>${esc(w)}</li>`).join("");
  return (
    `<div style="background:#fffbeb;border-bottom:1px solid #fcd34d;padding:8px 16px;` +
    `font:12px ui-monospace,monospace;color:#92400e">` +
    `<b>⚠ ${warnings.length} load warning(s)</b><ul style="margin:4px 0 0;padding-left:20px">${items}</ul></div>`
  );
}

function errorPage(msg: string): string {
  const esc = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>istio-viz — build error</title>
<style>body{font:14px ui-sans-serif,system-ui;background:#fef2f2;color:#0f172a;padding:40px}
pre{background:#fff;border:1px solid #fca5a5;border-radius:8px;padding:16px;white-space:pre-wrap}</style>
</head><body><h2>⚠ rebuild failed — fix the input and save again</h2><pre>${esc}</pre>${LIVE_CLIENT}</body></html>`;
}
