/**
 * Self-contained HTML report: inline SVG diagrams + vanilla-JS interactivity
 * (hover path highlighting, click side panel with YAML + file:line, filters,
 * warnings-only toggle, trace decision log). No network access required.
 */
import type { Finding, RoutingModel, RuleNode, TraceResult } from "../types.js";
import { buildNetworkPaths, type HostPaths } from "../paths.js";
import { layoutModel, layoutPathsGroups, modBadge, type PathsGroupLayout } from "./layout.js";
import { SVG_CSS, esc, indexFindings, renderSectionSvg } from "./svg.js";
import { matchSummary } from "./text.js";

/** Inline brand mark (the node-triangle from site/logo.svg) shown in the report header. */
const LOGO_SVG =
  '<svg class="brand-logo" width="32" height="30" viewBox="0 2 32 30" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="istio-viz">' +
  '<g stroke="#1A8F85" stroke-width="2.5" stroke-linecap="round">' +
  '<line x1="16" y1="6" x2="4" y2="28"/><line x1="16" y1="6" x2="28" y2="28"/><line x1="4" y1="28" x2="28" y2="28"/></g>' +
  '<g fill="#1A8F85"><circle cx="16" cy="6" r="4"/><circle cx="4" cy="28" r="4"/><circle cx="28" cy="28" r="4"/></g>' +
  "</svg>";

/** Favicon (matches site/favicon.svg), URL-encoded for an inline data URI. */
const FAVICON_DATA_URI =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<g stroke="#1A8F85" stroke-width="4" stroke-linecap="round">' +
      '<line x1="32" y1="14" x2="12" y2="48"/><line x1="32" y1="14" x2="52" y2="48"/><line x1="12" y1="48" x2="52" y2="48"/></g>' +
      '<g fill="#1A8F85"><circle cx="32" cy="14" r="7"/><circle cx="12" cy="48" r="7"/><circle cx="52" cy="48" r="7"/></g>' +
      "</svg>",
  );

interface PanelInfo {
  title: string;
  kind: string;
  rows: [string, string][];
  yaml?: string;
  loc?: string;
  findings: { id: string; severity: string; message: string; loc?: string }[];
  /** rules only: declared URI exact/prefix values and regex sources, for the path filter */
  uriVals?: string[];
  uriRegexes?: string[];
}

export function renderHtml(model: RoutingModel, opts: { trace?: TraceResult; title?: string } = {}): string {
  const sections = layoutModel(model);
  const findingsByNode = indexFindings(model);
  const panels = buildPanelData(model, findingsByNode);

  const sectionHtml = sections
    .map((s) => {
      const svg = renderSectionSvg(s, { interactive: true, findingsByNode, trace: opts.trace });
      const hostCount = s.nodes.filter((n) => n.kind === "host").length;
      return (
        `<section class="diagram-section" data-key="${esc(s.key)}" data-gateway="${esc(s.gateway ?? "")}" ` +
        `data-namespaces="${esc(s.namespaces.join(","))}" data-hosts="${esc(s.hosts.join(","))}">` +
        `<h2 title="click to collapse/expand"><span class="chev">▾</span>${esc(s.title)}` +
        `<span class="count">${hostCount} host${hostCount === 1 ? "" : "s"} · ${s.ruleCount} rule${s.ruleCount === 1 ? "" : "s"}</span></h2>` +
        `<div class="svg-wrap">${svg}</div></section>`
      );
    })
    .join("\n");

  const gateways = [...new Set(sections.map((s) => s.gateway).filter((g): g is string => Boolean(g)))];
  const namespaces = [...new Set(sections.flatMap((s) => s.namespaces))];
  const hosts = [...new Set(sections.flatMap((s) => s.hosts))];

  const findingsHtml = model.findings
    .map((f, i) => {
      const loc = f.loc ? `<span class="floc">${esc(f.loc.file)}:${f.loc.line}</span>` : "";
      return (
        `<li class="finding ${f.severity}" data-nodes="${esc(f.nodeIds.join(","))}" data-idx="${i}">` +
        `<span class="fid">${f.id}</span> ${esc(f.message)} ${loc}</li>`
      );
    })
    .join("\n");

  const traceHtml = opts.trace ? buildTraceHtml(model, opts.trace) : "";
  const pathsGroups = buildNetworkPaths(model);
  const pathsLayouts = layoutPathsGroups(pathsGroups);
  const pathsTableHtml = buildPathsTableHtml(pathsGroups);
  const pathsGraphHtml = pathsLayouts
    .map(
      (pg) =>
        `<div class="pgroup-g" data-host="${esc(pg.host)}" data-gws="${esc(pg.gateways.join(","))}" ` +
        `data-ns="${esc(pg.namespaces.join(","))}">` +
        `<div class="svg-wrap">${renderSectionSvg(pg.layout, { interactive: true })}</div></div>`,
    )
    .join("\n");
  // make paths-graph nodes open the matching rule/destination panels
  for (const pg of pathsLayouts) {
    for (const mn of pg.matchNodes) if (panels[mn.entry.ruleId]) panels[mn.id] = panels[mn.entry.ruleId]!;
    for (const dn of pg.destNodes) if (panels[dn.destId]) panels[dn.id] = panels[dn.destId]!;
  }
  const pathNodes = pathsLayouts.flatMap((pg) =>
    pg.matchNodes.map((mn) => ({
      id: mn.id,
      host: pg.host,
      uri: mn.entry.uriVal,
      rx: mn.entry.uriIsRegex ? 1 : 0,
      dests: mn.entry.dests.join(" ").toLowerCase(),
    })),
  );
  const l4Html = model.l4Notes.length
    ? `<details class="l4"><summary>L4 routes not diagrammed (${model.l4Notes.length})</summary><ul>${model.l4Notes
        .map((n) => `<li>${esc(n)}</li>`)
        .join("")}</ul></details>`
    : "";

  const data = JSON.stringify({
    panels,
    edges: model.edges.map((e) => [e.from, e.to, e.kind]),
    pathNodes,
  }).replace(/<\//g, "<\\/");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
<title>${esc(opts.title ?? "istio-viz — L7 routing")}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px ui-sans-serif, system-ui, sans-serif; background: #f8fafc; color: #0f172a; }
  header { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid #e2e8f0;
           padding: 8px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { margin: 0; display: flex; align-items: center; }
  header h1 .brand-logo { height: 22px; width: auto; display: block; }
  header label { font-size: 12px; color: #475569; display: flex; gap: 5px; align-items: center; }
  header select, header input[type=text] { font: 12px ui-monospace, monospace; padding: 3px 6px;
           border: 1px solid #cbd5e1; border-radius: 5px; background: #fff; }
  main { display: grid; grid-template-columns: 1fr 380px; gap: 0; }
  body.aside-hidden main { grid-template-columns: 1fr 12px; }
  body.aside-hidden aside { display: none; }
  #aside-wrap { position: sticky; top: 41px; height: calc(100vh - 41px); overflow: visible;
                border-left: 1px solid #e2e8f0; }
  #toggle-aside { position: absolute; left: -12px; top: 50%; transform: translateY(-50%);
                  width: 24px; height: 24px; border-radius: 50%; border: 1px solid #cbd5e1;
                  background: #fff; cursor: pointer; display: flex; align-items: center;
                  justify-content: center; z-index: 20;
                  box-shadow: -1px 1px 4px rgba(0,0,0,.12); padding: 0; color: #64748b; }
  #toggle-aside:hover { background: #f1f5f9; color: #4f46e5; border-color: #a5b4fc; }
  #left { min-width: 0; }
  #diagrams { padding: 14px 16px; overflow-x: auto; min-width: 0; }
  /* view switcher */
  .viewsw button { font: 12px ui-sans-serif, system-ui; border: 1px solid #cbd5e1; background: #fff;
                   padding: 3px 10px; cursor: pointer; }
  .viewsw button:first-child { border-radius: 5px 0 0 5px; }
  .viewsw button:last-child { border-radius: 0 5px 5px 0; border-left: none; }
  .viewsw button.active { background: #4f46e5; color: #fff; border-color: #4f46e5; }
  /* paths view */
  #paths-view { display: none; padding: 14px 16px; }
  body.paths-mode #diagrams { display: none; }
  body.paths-mode #paths-view { display: block; }
  .paths-toolbar { margin-bottom: 10px; }
  #paths-table { display: none; }
  #paths-view.mode-table #paths-table { display: block; }
  #paths-view.mode-table #paths-graph { display: none; }
  .pgroup-g { margin-bottom: 14px; }
  .pgroup-g.hidden { display: none; }
  .pgroup { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; }
  .pgroup.hidden { display: none; }
  .pgroup h3 { margin: 0 0 2px; font-size: 14px; font-family: ui-monospace, monospace; }
  .pgroup .via { font: 11px ui-monospace, monospace; color: #94a3b8; margin-bottom: 6px; }
  .pgroup table { border-collapse: collapse; width: 100%; }
  .pgroup tr[data-rule] { cursor: pointer; }
  .pgroup tr[data-rule]:hover { background: #f1f5f9; }
  .pgroup tr.hidden { display: none; }
  .pgroup td { padding: 3px 10px 3px 0; font: 12px ui-monospace, monospace; vertical-align: top; }
  .pgroup td.pmatch { color: #92400e; white-space: nowrap; }
  .pgroup td.parrow { color: #94a3b8; }
  .pgroup td.pdests { color: #0c4a6e; }
  .pgroup td.pdests .missing { color: #dc2626; font-weight: 700; }
  .pgroup td.pmods { color: #64748b; }
  .diagram-section { margin-bottom: 22px; }
  .diagram-section h2 { font-size: 14px; margin: 0 0 6px; color: #334155; cursor: pointer; user-select: none; }
  .diagram-section h2 .chev { display: inline-block; width: 16px; color: #94a3b8; transition: transform .12s; }
  .diagram-section.collapsed h2 .chev { transform: rotate(-90deg); }
  .diagram-section.collapsed .svg-wrap { display: none; }
  .diagram-section h2 .count { margin-left: 10px; font-weight: 400; font-size: 12px; color: #94a3b8; }
  .diagram-section.hidden { display: none; }
  .zoom { display: flex; gap: 4px; align-items: center; margin-left: auto; }
  .zoom button { font: 12px ui-monospace, monospace; border: 1px solid #cbd5e1; background: #fff;
                 border-radius: 5px; padding: 2px 8px; cursor: pointer; }
  .zoom button:hover { background: #f1f5f9; }
  .zoom #z-pct { font: 12px ui-monospace, monospace; color: #475569; min-width: 42px; text-align: center; }
  .svg-wrap { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px; overflow-x: auto; }
  aside { background: #fff; display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  #findings-section { flex: 1; overflow-y: auto; min-height: 0; padding: 14px; }
  #details-section { flex-shrink: 0; border-top: 1px solid #e2e8f0; padding: 10px 14px 14px;
                     max-height: 45%; overflow-y: auto; }
  aside h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  #panel { font-size: 13px; }
  #panel .ptitle { font-weight: 700; font-size: 14px; margin-bottom: 6px; word-break: break-all; }
  #panel table { border-collapse: collapse; width: 100%; margin: 6px 0; }
  #panel td { padding: 2px 6px 2px 0; vertical-align: top; font-size: 12px; }
  #panel td:first-child { color: #64748b; white-space: nowrap; }
  #panel pre { background: #0f172a; color: #e2e8f0; padding: 10px; border-radius: 8px; font-size: 11px;
               overflow-x: auto; max-height: 320px; white-space: pre; }
  #panel .loc { font: 11px ui-monospace, monospace; color: #64748b; }
  .finding { list-style: none; padding: 6px 8px; margin: 4px 0; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .finding.error { background: #fef2f2; border-left: 3px solid #dc2626; }
  .finding.warn { background: #fffbeb; border-left: 3px solid #f59e0b; }
  .finding.info { background: #eff6ff; border-left: 3px solid #3b82f6; }
  .finding .fid { font-weight: 700; font-family: ui-monospace, monospace; }
  .finding .floc { display: block; color: #94a3b8; font-family: ui-monospace, monospace; font-size: 11px; }
  ul#findings { padding: 0; margin: 0 0 16px; }
  .l4 { font-size: 12px; color: #64748b; margin-bottom: 14px; }
  .trace-log { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px;
               font: 12px ui-monospace, monospace; margin-bottom: 14px; }
  .trace-log .skip { color: #b91c1c; }
  .trace-log .win { color: #15803d; font-weight: 700; }
  ${SVG_CSS}
  .node { cursor: pointer; }
  .node.hl rect { stroke-width: 2.4; filter: drop-shadow(0 0 3px rgba(99,102,241,.6)); }
  .fade { opacity: 0.18; }
  .filter-fade { opacity: 0.12; }
  .node.selected rect { stroke: #4f46e5 !important; stroke-width: 2.6 !important; }
  body.warnonly #diagrams .node:not(.has-finding):not(.trace-win) { opacity: .18; }
  .empty { color: #94a3b8; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>${LOGO_SVG}</h1>
  <span class="viewsw">
    <button id="v-diagram" class="active" title="object diagram view">diagram</button><button id="v-paths" title="consolidated host → match → service view">paths</button>
  </span>
  <label>gateway <select id="f-gw"><option value="">all</option>${gateways
    .map((g) => `<option>${esc(g)}</option>`)
    .join("")}</select></label>
  <label>namespace <select id="f-ns"><option value="">all</option>${namespaces
    .map((n) => `<option>${esc(n)}</option>`)
    .join("")}</select></label>
  <label>host <select id="f-host"><option value="">all</option>${hosts
    .map((h) => `<option>${esc(h)}</option>`)
    .join("")}</select></label>
  <label>path <input type="text" id="f-uri" placeholder="/api/v2" size="12"
    title="show only rules with a URI condition under this prefix"></label>
  <label>service <input type="text" id="f-svc" placeholder="api-gateway" size="12"
    title="show only rules routing to services whose name contains this text"></label>
  <label><input type="checkbox" id="f-warn"> warnings only</label>
  <span class="zoom">
    <button id="z-out" title="zoom out">−</button><span id="z-pct">100%</span><button id="z-in" title="zoom in">+</button>
    <button id="z-fit" title="scale each diagram to fit the window width">fit</button>
    <button id="z-reset" title="reset zoom">1:1</button>
  </span>
</header>
<main>
  <div id="left">
    <div id="diagrams">
    ${traceHtml}
    ${sectionHtml || '<p class="empty">No gateway listeners or mesh routes found in the input set.</p>'}
    </div>
    <div id="paths-view">
      <div class="paths-toolbar"><span class="viewsw">
        <button id="p-graph" class="active" title="host → match → service diagram">graph</button><button id="p-table" title="compact table">table</button>
      </span></div>
      <div id="paths-graph">${pathsGraphHtml || '<p class="empty">No network paths found in the input set.</p>'}</div>
      <div id="paths-table">${pathsTableHtml || '<p class="empty">No network paths found in the input set.</p>'}</div>
    </div>
  </div>
  <div id="aside-wrap">
    <button id="toggle-aside" aria-label="toggle findings panel" title="show/hide findings panel" aria-expanded="true">
      <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline id="toggle-chev" points="6,1 1,7 6,13"/></svg>
    </button>
    <aside>
      <div id="findings-section">
        ${l4Html}
        <h3>Findings (${model.findings.length})</h3>
        <ul id="findings">${findingsHtml || '<li class="empty">none</li>'}</ul>
      </div>
      <div id="details-section">
        <h3>Details</h3>
        <div id="panel"><p class="empty">Click a node for details; hover to trace its path.</p></div>
      </div>
    </aside>
  </div>
</main>
<script type="application/json" id="model-data">${data}</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById("model-data").textContent);
  const panels = data.panels;

  // adjacency over edges (both graph edges and visual client/listener links)
  const fwd = new Map(), rev = new Map();
  function addEdge(a, b) {
    if (!fwd.has(a)) fwd.set(a, []);
    if (!rev.has(b)) rev.set(b, []);
    fwd.get(a).push(b); rev.get(b).push(a);
  }
  document.querySelectorAll("path.edge").forEach((p) => addEdge(p.dataset.from, p.dataset.to));

  function reach(start, adj) {
    const seen = new Set([start]); const q = [start];
    while (q.length) {
      const cur = q.shift();
      for (const nxt of adj.get(cur) || []) if (!seen.has(nxt)) { seen.add(nxt); q.push(nxt); }
    }
    return seen;
  }

  const allNodes = document.querySelectorAll(".node");
  const allEdges = document.querySelectorAll("path.edge, text.edge-label");

  // mark nodes carrying findings (for warnings-only toggle)
  const findingNodes = new Set();
  document.querySelectorAll("#findings .finding").forEach((li) => {
    (li.dataset.nodes || "").split(",").filter(Boolean).forEach((id) => findingNodes.add(id));
  });
  allNodes.forEach((n) => { if (findingNodes.has(n.dataset.id)) n.classList.add("has-finding"); });

  // hover: highlight upstream + downstream within the whole document
  allNodes.forEach((node) => {
    node.addEventListener("mouseenter", () => {
      const id = node.dataset.id;
      const keep = new Set([...reach(id, fwd), ...reach(id, rev)]);
      allNodes.forEach((n) => {
        const inPath = keep.has(n.dataset.id);
        n.classList.toggle("hl", inPath && n.dataset.id === id);
        n.classList.toggle("fade", !inPath);
      });
      allEdges.forEach((e) => {
        const from = e.dataset.from, to = e.dataset.to;
        if (from === undefined) return;
        e.classList.toggle("fade", !(keep.has(from) && keep.has(to)));
      });
    });
    node.addEventListener("mouseleave", () => {
      allNodes.forEach((n) => n.classList.remove("hl", "fade"));
      allEdges.forEach((e) => e.classList.remove("fade"));
    });
    node.addEventListener("click", () => showPanel(node.dataset.id, node));
  });

  function showPanel(id, nodeEl) {
    document.querySelectorAll(".node.selected").forEach((n) => n.classList.remove("selected"));
    if (nodeEl) nodeEl.classList.add("selected");
    const p = panels[id];
    const el = document.getElementById("panel");
    if (!p) { el.innerHTML = '<p class="empty">No details for this node.</p>'; return; }
    let html = '<div class="ptitle">' + escapeHtml(p.title) + "</div>";
    if (p.rows.length) {
      html += "<table>" + p.rows.map((r) => "<tr><td>" + escapeHtml(r[0]) + "</td><td>" + escapeHtml(r[1]) + "</td></tr>").join("") + "</table>";
    }
    if (p.findings.length) {
      html += p.findings.map((f) =>
        '<li class="finding ' + f.severity + '"><span class="fid">' + f.id + "</span> " + escapeHtml(f.message) +
        (f.loc ? '<span class="floc">' + escapeHtml(f.loc) + "</span>" : "") + "</li>").join("");
    }
    if (p.loc) html += '<div class="loc">source: ' + escapeHtml(p.loc) + "</div>";
    if (p.yaml) html += "<pre>" + escapeHtml(p.yaml) + "</pre>";
    el.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // findings list → highlight node
  document.querySelectorAll("#findings .finding").forEach((li) => {
    li.addEventListener("click", () => {
      const ids = (li.dataset.nodes || "").split(",").filter(Boolean);
      if (!ids.length) return;
      const target = document.querySelector('.node[data-id="' + CSS.escape(ids[0]) + '"]');
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        showPanel(ids[0], target);
      }
    });
  });

  // filters
  const fGw = document.getElementById("f-gw");
  const fNs = document.getElementById("f-ns");
  const fHost = document.getElementById("f-host");
  const fUri = document.getElementById("f-uri");
  const fSvc = document.getElementById("f-svc");
  const fWarn = document.getElementById("f-warn");

  // graph-edge index: rule id -> downstream destination panel titles (for the service filter)
  const edgesFrom = new Map();
  data.edges.forEach((e) => {
    if (!edgesFrom.has(e[0])) edgesFrom.set(e[0], []);
    edgesFrom.get(e[0]).push(e);
  });
  function ruleDestNames(id) {
    return (edgesFrom.get(id) || [])
      .filter((e) => e[2] === "routes" || e[2] === "mirrors")
      .map((e) => ((panels[e[1]] && panels[e[1]].title) || "").toLowerCase());
  }
  function ruleOk(id, prefix, svc) {
    const p = panels[id];
    if (!p) return false;
    const uriOk = !prefix ||
      (p.uriVals || []).some((v) => v.startsWith(prefix)) ||
      (p.uriRegexes || []).some((r) => r.includes(prefix));
    const svcOk = !svc || ruleDestNames(id).some((t) => t.includes(svc));
    return uriOk && svcOk;
  }

  /** Fade non-matching nodes everywhere; returns which sections / path hosts contain matches. */
  function applyNodeFilters(prefix, svc) {
    allNodes.forEach((n) => n.classList.remove("filter-fade"));
    allEdges.forEach((e) => e.classList.remove("filter-fade"));
    const res = { sections: new Set(), pathHosts: new Set() };
    if (!prefix && !svc) return res;
    const keep = new Set();
    const grow = (id) => {
      reach(id, fwd).forEach((x) => keep.add(x));
      reach(id, rev).forEach((x) => keep.add(x));
    };
    document.querySelectorAll("#diagrams .node.rule").forEach((n) => {
      if (ruleOk(n.dataset.id, prefix, svc)) {
        res.sections.add(n.closest(".diagram-section").dataset.key);
        grow(n.dataset.id);
      }
    });
    (data.pathNodes || []).forEach((pn) => {
      const uriOk = !prefix || (pn.rx ? pn.uri.includes(prefix) : pn.uri.startsWith(prefix));
      const svcOk = !svc || pn.dests.includes(svc);
      if (uriOk && svcOk) {
        res.pathHosts.add(pn.host);
        grow(pn.id);
      }
    });
    allNodes.forEach((n) => n.classList.toggle("filter-fade", !keep.has(n.dataset.id)));
    allEdges.forEach((e) => {
      if (e.dataset.from === undefined) return;
      e.classList.toggle("filter-fade", !(keep.has(e.dataset.from) && keep.has(e.dataset.to)));
    });
    return res;
  }

  function applyFilters() {
    const gw = fGw.value, ns = fNs.value, host = fHost.value;
    let prefix = fUri.value.trim();
    if (prefix && !prefix.startsWith("/")) prefix = "/" + prefix;
    const svc = fSvc.value.trim().toLowerCase();
    const active = prefix !== "" || svc !== "";
    const matched = applyNodeFilters(prefix, svc);
    document.querySelectorAll(".diagram-section").forEach((sec) => {
      const okGw = !gw || sec.dataset.gateway === gw;
      const okNs = !ns || (sec.dataset.namespaces || "").split(",").includes(ns);
      const okHost = !host || (sec.dataset.hosts || "").split(",").includes(host);
      const okF = !active || matched.sections.has(sec.dataset.key);
      sec.classList.toggle("hidden", !(okGw && okNs && okHost && okF));
    });
    // paths graph groups
    document.querySelectorAll("#paths-graph .pgroup-g").forEach((g) => {
      const okGw = !gw || (g.dataset.gws || "").split(",").includes(gw);
      const okNs = !ns || (g.dataset.ns || "").split(",").includes(ns);
      const okHost = !host || g.dataset.host === host;
      const okF = !active || matched.pathHosts.has(g.dataset.host);
      g.classList.toggle("hidden", !(okGw && okNs && okHost && okF));
    });
    // paths table rows
    document.querySelectorAll("#paths-table .pgroup").forEach((g) => {
      const okGw = !gw || (g.dataset.gws || "").split(",").includes(gw);
      const okNs = !ns || (g.dataset.ns || "").split(",").includes(ns);
      const okHost = !host || g.dataset.host === host;
      let anyRow = false;
      g.querySelectorAll("tr[data-rule]").forEach((tr) => {
        const v = tr.dataset.uri || "";
        const okUri = !prefix || (tr.dataset.regex === "1" ? v.includes(prefix) : v.startsWith(prefix));
        const okSvc = !svc || (tr.dataset.dests || "").includes(svc);
        tr.classList.toggle("hidden", !(okUri && okSvc));
        if (okUri && okSvc) anyRow = true;
      });
      g.classList.toggle("hidden", !(okGw && okNs && okHost && anyRow));
    });
    document.body.classList.toggle("warnonly", fWarn.checked);
  }
  [fGw, fNs, fHost].forEach((s) => s.addEventListener("change", applyFilters));
  fWarn.addEventListener("change", applyFilters);
  let typeTimer;
  [fUri, fSvc].forEach((el) => {
    el.addEventListener("input", () => { clearTimeout(typeTimer); typeTimer = setTimeout(applyFilters, 150); });
    el.addEventListener("change", applyFilters);
  });

  // section collapse
  document.querySelectorAll(".diagram-section h2").forEach((h2) => {
    h2.addEventListener("click", () => h2.parentElement.classList.toggle("collapsed"));
  });

  // view switcher: diagram (objects) vs paths (host → match → service)
  const vDiagram = document.getElementById("v-diagram");
  const vPaths = document.getElementById("v-paths");
  function setView(paths) {
    document.body.classList.toggle("paths-mode", paths);
    vPaths.classList.toggle("active", paths);
    vDiagram.classList.toggle("active", !paths);
  }
  vDiagram.addEventListener("click", () => setView(false));
  vPaths.addEventListener("click", () => setView(true));

  // paths sub-view: graph (default) vs table
  const pGraph = document.getElementById("p-graph");
  const pTable = document.getElementById("p-table");
  function setPathsMode(table) {
    document.getElementById("paths-view").classList.toggle("mode-table", table);
    pTable.classList.toggle("active", table);
    pGraph.classList.toggle("active", !table);
  }
  pGraph.addEventListener("click", () => setPathsMode(false));
  pTable.addEventListener("click", () => setPathsMode(true));

  // paths-view rows open the rule's detail panel
  document.querySelectorAll("#paths-view tr[data-rule]").forEach((tr) => {
    tr.addEventListener("click", () => showPanel(tr.dataset.rule, null));
  });

  // toggle the findings/details side panel — circle chevron on the pane edge
  const toggleAside = document.getElementById("toggle-aside");
  const toggleChev = document.getElementById("toggle-chev");
  toggleAside.addEventListener("click", () => {
    const hidden = document.body.classList.toggle("aside-hidden");
    toggleAside.setAttribute("aria-expanded", String(!hidden));
    // ‹ (left) when panel open = click to close; › (right) when closed = click to open
    toggleChev.setAttribute("points", hidden ? "2,1 7,7 2,13" : "6,1 1,7 6,13");
  });

  // zoom: scale the inline SVGs by width (viewBox keeps the aspect ratio)
  const svgs = Array.from(document.querySelectorAll(".svg-wrap > svg"));
  svgs.forEach((s) => { s.dataset.ow = s.getAttribute("width"); s.removeAttribute("height"); });
  let zoom = 1;
  function applyZoom() {
    svgs.forEach((s) => s.setAttribute("width", String(Math.max(1, Math.round(s.dataset.ow * zoom)))));
    document.getElementById("z-pct").textContent = Math.round(zoom * 100) + "%";
  }
  function setZoom(z) { zoom = Math.min(2, Math.max(0.25, z)); applyZoom(); }
  document.getElementById("z-in").addEventListener("click", () => setZoom(zoom * 1.2));
  document.getElementById("z-out").addEventListener("click", () => setZoom(zoom / 1.2));
  document.getElementById("z-reset").addEventListener("click", () => setZoom(1));
  document.getElementById("z-fit").addEventListener("click", () => {
    // fit whatever diagrams are currently visible (object view or paths graph)
    const fits = svgs
      .filter((s) => s.getBoundingClientRect().width > 0)
      .map((s) => (s.closest(".svg-wrap").clientWidth - 18) / Number(s.dataset.ow));
    if (fits.length) setZoom(Math.min(1, ...fits));
  });
  applyZoom();
})();
</script>
</body>
</html>
`;
}

function buildPanelData(model: RoutingModel, findingsByNode: Map<string, Finding[]>): Record<string, PanelInfo> {
  const panels: Record<string, PanelInfo> = {};
  const fmtLoc = (loc?: { file: string; line: number }) => (loc ? `${loc.file}:${loc.line}` : undefined);
  const fmtFindings = (id: string) =>
    (findingsByNode.get(id) ?? []).map((f) => ({
      id: f.id,
      severity: f.severity,
      message: f.message,
      loc: fmtLoc(f.loc),
    }));

  for (const [id, n] of model.nodes) {
    if (n.kind === "listener") {
      panels[id] = {
        title: `gateway ${n.namespace}/${n.gateway}`,
        kind: "listener",
        rows: [
          ["port", `${n.port}${n.portName ? ` (${n.portName})` : ""}`],
          ["protocol", n.protocol],
          ...(n.tlsMode ? ([["TLS mode", n.tlsMode]] as [string, string][]) : []),
          ["hosts", n.hosts.join(", ")],
        ],
        loc: fmtLoc(n.loc),
        findings: fmtFindings(id),
      };
    } else if (n.kind === "host") {
      panels[id] = {
        title: n.hosts.join(", "),
        kind: "host",
        rows: [
          ["VirtualService", `${n.vsNamespace}/${n.vsName}`],
          ["effective hosts", n.hosts.join(", ")],
        ],
        loc: fmtLoc(n.loc),
        findings: fmtFindings(id),
      };
    } else if (n.kind === "rule") {
      const r = n as RuleNode;
      const uriVals: string[] = [];
      const uriRegexes: string[] = [];
      for (const m of r.raw.match ?? []) {
        if (m.uri?.exact !== undefined) uriVals.push(m.uri.exact);
        if (m.uri?.prefix !== undefined) uriVals.push(m.uri.prefix);
        if (m.uri?.regex !== undefined) uriRegexes.push(m.uri.regex);
      }
      panels[id] = {
        uriVals,
        uriRegexes,
        title: `rule #${r.index + 1} of ${r.vsNamespace}/${r.vsName}${r.name ? ` (${r.name})` : ""}`,
        kind: "rule",
        rows: [
          ["evaluation order", `#${r.index + 1} (first match wins)`],
          ["match", matchSummary(r)],
          ...r.modifiers.map((m) => [`${modBadge(m.kind)} ${m.kind}`, m.detail] as [string, string]),
          ...(r.unreachable ? ([["⚠", "unreachable: shadowed by an earlier rule"]] as [string, string][]) : []),
        ],
        yaml: r.yaml,
        loc: fmtLoc(r.loc),
        findings: fmtFindings(id),
      };
    } else if (n.kind === "dest") {
      panels[id] = {
        title: n.type === "service" || n.type === "unknown" ? n.host : n.host,
        kind: "dest",
        rows: [
          ["type", n.type === "unknown" ? "service (NOT FOUND)" : n.type],
          ...(n.port ? ([["port", String(n.port)]] as [string, string][]) : []),
          ...(n.subset ? ([["subset", n.subset]] as [string, string][]) : []),
          ...(n.subsetLabels
            ? ([["subset labels", Object.entries(n.subsetLabels).map(([k, v]) => `${k}=${v}`).join(", ")]] as [
                string,
                string,
              ][])
            : []),
        ],
        loc: fmtLoc(n.loc),
        findings: fmtFindings(id),
      };
    }
  }
  return panels;
}

/** Consolidated host → match → service table, grouped per unique host. */
function buildPathsTableHtml(groups: HostPaths[]): string {
  if (groups.length === 0) return "";
  return groups
    .map((g) => {
      const rows = g.entries
        .map((e) => {
          const dests = e.dests
            .map((d) => (d.endsWith("!missing") ? `<span class="missing">${esc(d)}</span>` : esc(d)))
            .join(" ");
          return (
            `<tr data-rule="${esc(e.ruleId)}" data-uri="${esc(e.uriVal)}" data-regex="${e.uriIsRegex ? 1 : 0}" ` +
            `data-dests="${esc(e.dests.join(" ").toLowerCase())}" title="from ${esc(e.sources.join(", "))}">` +
            `<td class="pmatch">${esc(e.match)}</td><td class="parrow">→</td>` +
            `<td class="pdests">${dests || "(no destination)"}</td>` +
            `<td class="pmods">${esc(e.mods.join(", "))}</td></tr>`
          );
        })
        .join("\n");
      return (
        `<div class="pgroup" data-host="${esc(g.host)}" data-gws="${esc(g.gateways.join(","))}" ` +
        `data-ns="${esc(g.namespaces.join(","))}">` +
        `<h3>${esc(g.host)}</h3><div class="via">via ${esc(g.via.join(", "))}</div>` +
        `<table>${rows}</table></div>`
      );
    })
    .join("\n");
}

function buildTraceHtml(model: RoutingModel, t: TraceResult): string {
  const req = t.request;
  const lines: string[] = [];
  lines.push(
    `<div><b>trace:</b> ${esc(req.method)} ${esc(req.path)} host=${esc(req.host)}${req.port ? ` port=${req.port}` : ""}` +
      Object.entries(req.headers)
        .map(([k, v]) => ` ${esc(k)}:${esc(v)}`)
        .join("") +
      "</div>",
  );
  const multiVs = new Set(t.steps.map((s) => s.vsName)).size > 1;
  const ruleLabel = (s: TraceResult["steps"][number]) =>
    multiVs ? `${esc(s.vsName)} rule #${s.index + 1}` : `rule #${s.index + 1}`;
  for (const step of t.steps) {
    if (step.matched) {
      lines.push(`<div class="win">✔ ${ruleLabel(step)} MATCHED — ${esc(step.reasons[0] ?? "")}</div>`);
    } else {
      for (const r of step.reasons) {
        lines.push(`<div class="skip">✘ ${ruleLabel(step)} skipped: ${esc(r)}</div>`);
      }
    }
  }
  lines.push(`<div><b>result:</b> ${esc(t.outcome)}</div>`);
  return `<div class="trace-log">${lines.join("\n")}</div>`;
}
