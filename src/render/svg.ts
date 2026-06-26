/** SVG emitter for section layouts. Used standalone (--format svg/png) and inside the HTML report. */
import type { Finding, RoutingModel, TraceResult } from "../types.js";
import type { LayoutEdge, LayoutNode, SectionLayout } from "./layout.js";

export interface SvgOpts {
  /** add data-* attributes + css hook classes for the interactive HTML */
  interactive?: boolean;
  trace?: TraceResult;
  findingsByNode?: Map<string, Finding[]>;
}

export const SVG_CSS = `
  .node rect { fill: #fff; stroke: #94a3b8; stroke-width: 1.2; rx: 6; }
  .node.client rect { fill: #f1f5f9; stroke: #64748b; }
  .node.listener rect { fill: #eef2ff; stroke: #6366f1; }
  .node.host rect { fill: #ecfdf5; stroke: #10b981; }
  .node.rule rect { fill: #fffbeb; stroke: #f59e0b; }
  .node.dest rect { fill: #f0f9ff; stroke: #0ea5e9; }
  .node.dest.terminal rect { fill: #faf5ff; stroke: #a855f7; stroke-dasharray: 4 2; }
  .node.dest.missing rect { stroke: #dc2626; stroke-width: 1.6; }
  .node.unreachable { opacity: 0.45; }
  .node text { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #0f172a; }
  .node text.title { font-weight: 700; }
  .node text.sub { fill: #475569; }
  .node text.dim { fill: #94a3b8; }
  .node text.or { fill: #9333ea; font-weight: 700; font-size: 9px; }
  .node text.match {}
  .node text.regex { fill: #be185d; font-style: italic; }
  .node text.badge { fill: #92400e; font-size: 10px; }
  .node text.err { fill: #dc2626; font-weight: 700; }
  .badge-circle { fill: #f59e0b; }
  .badge-text { font: 700 10px ui-monospace, monospace; fill: #fff; }
  .edge { fill: none; stroke: #94a3b8; stroke-width: 1.3; }
  .edge.mirrors { stroke-dasharray: 5 3; stroke: #a855f7; }
  .edge-label { font: 9.5px ui-monospace, monospace; fill: #475569; }
  .edge-label.mirrors { fill: #a855f7; }
  .arrow { fill: #94a3b8; }
  .finding-dot { stroke: #fff; stroke-width: 1; }
  .finding-dot.error { fill: #dc2626; }
  .finding-dot.warn { fill: #f59e0b; }
  .finding-dot.info { fill: #3b82f6; }
  .trace-win rect { stroke: #16a34a !important; stroke-width: 2.5 !important; }
  .edge.trace-win { stroke: #16a34a; stroke-width: 2.5; }
  .trace-skip { opacity: 0.5; }
  .trace-skip rect { stroke-dasharray: 3 3; }
`;

// must match layout.ts metrics
const LINE_H = 14;
const PAD = 7;

export function renderSectionSvg(section: SectionLayout, opts: SvgOpts = {}): string {
  const parts: string[] = [];
  const tracePath = opts.trace ? tracePathIds(opts.trace) : undefined;

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${section.width}" height="${section.height}" ` +
      `viewBox="0 0 ${section.width} ${section.height}" data-section="${esc(section.key)}">`,
  );
  if (!opts.interactive) parts.push(`<style>${SVG_CSS}</style>`);
  parts.push(`<defs><marker id="arr-${hash(section.key)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="arrow"/></marker></defs>`);

  for (const e of section.edges) {
    parts.push(edgeSvg(e, section.key, tracePath));
  }
  for (const n of section.nodes) {
    parts.push(nodeSvg(n, opts, tracePath));
  }
  parts.push("</svg>");
  return parts.join("\n");
}

function tracePathIds(t: TraceResult): Set<string> {
  const ids = new Set<string>();
  if (t.listenerId) ids.add(t.listenerId);
  if (t.hostNodeId) ids.add(t.hostNodeId);
  if (t.winner) ids.add(t.winner.ruleId);
  for (const d of t.destIds) ids.add(d);
  return ids;
}

function edgeSvg(e: LayoutEdge, sectionKey: string, tracePath?: Set<string>): string {
  const dx = Math.max(28, (e.x2 - e.x1) / 2);
  const d = `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`;
  const classes = ["edge", e.kind];
  if (tracePath?.has(e.fromId) && tracePath.has(e.toId)) classes.push("trace-win");
  let s =
    `<path class="${classes.join(" ")}" d="${d}" marker-end="url(#arr-${hash(sectionKey)})" ` +
    `data-from="${esc(e.fromId)}" data-to="${esc(e.toId)}"/>`;
  if (e.label) {
    const mx = (e.x1 + e.x2) / 2;
    const my = (e.y1 + e.y2) / 2 - 4;
    s += `<text class="edge-label ${e.kind}" x="${mx}" y="${my}" text-anchor="middle">${esc(e.label)}</text>`;
  }
  return s;
}

function nodeSvg(n: LayoutNode, opts: SvgOpts, tracePath?: Set<string>): string {
  const classes = ["node", n.kind];
  if (n.kind === "dest" && (n.destType === "redirect" || n.destType === "direct")) classes.push("terminal");
  if (n.kind === "dest" && n.serviceFound === false) classes.push("missing");
  if (n.unreachable) classes.push("unreachable");
  if (tracePath) {
    if (tracePath.has(n.id)) classes.push("trace-win");
    else if (n.kind === "rule" && opts.trace?.steps.some((s) => s.ruleId === n.id && !s.matched)) {
      classes.push("trace-skip");
    }
  }
  const parts: string[] = [];
  parts.push(`<g class="${classes.join(" ")}" data-id="${esc(n.id)}" data-kind="${n.kind}">`);
  if (n.tooltip) parts.push(`<title>${esc(n.tooltip)}</title>`);
  parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6"/>`);
  n.lines.forEach((line, i) => {
    const tx = n.x + PAD + (n.kind === "rule" && i === 0 ? 18 : 0);
    const ty = n.y + PAD + (i + 1) * LINE_H - 4;
    parts.push(`<text class="${line.cls}" x="${tx}" y="${ty}">${esc(line.text)}</text>`);
  });
  if (n.badge) {
    parts.push(`<circle class="badge-circle" cx="${n.x + 12}" cy="${n.y + 13}" r="9"/>`);
    parts.push(
      `<text class="badge-text" x="${n.x + 12}" y="${n.y + 16.5}" text-anchor="middle">${esc(n.badge.replace("#", ""))}</text>`,
    );
  }
  const findings = opts.findingsByNode?.get(n.id) ?? [];
  if (findings.length > 0) {
    const sev = findings.some((f) => f.severity === "error")
      ? "error"
      : findings.some((f) => f.severity === "warn")
        ? "warn"
        : "info";
    parts.push(`<circle class="finding-dot ${sev}" cx="${n.x + n.w - 6}" cy="${n.y + 6}" r="5.5"/>`);
  }
  parts.push("</g>");
  return parts.join("");
}

/** Standalone full-document SVG (all sections stacked) for --format svg/png. */
export function renderSvgDocument(model: RoutingModel, sections: SectionLayout[], opts: SvgOpts = {}): string {
  const findingsByNode = indexFindings(model);
  const titleH = 26;
  let y = 10;
  const blocks: { section: SectionLayout; y: number }[] = [];
  let width = 0;
  for (const s of sections) {
    blocks.push({ section: s, y });
    y += titleH + s.height + 18;
    width = Math.max(width, s.width);
  }
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 20}" height="${y}" viewBox="0 0 ${width + 20} ${y}">`,
  );
  parts.push(`<style>${SVG_CSS} .section-title { font: 700 13px ui-sans-serif, system-ui; fill: #0f172a; }</style>`);
  parts.push(`<rect width="100%" height="100%" fill="#f8fafc"/>`);
  for (const b of blocks) {
    parts.push(`<text class="section-title" x="14" y="${b.y + 16}">${esc(b.section.title)}</text>`);
    const inner = renderSectionSvg(b.section, { ...opts, findingsByNode, interactive: false })
      .replace(/^<svg[^>]*>/, "")
      .replace(/<\/svg>$/, "")
      .replace(/<style>[\s\S]*?<\/style>/, "");
    parts.push(`<g transform="translate(10, ${b.y + titleH})">${inner}</g>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}

export function indexFindings(model: RoutingModel): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of model.findings) {
    for (const id of f.nodeIds) {
      const arr = map.get(id) ?? [];
      arr.push(f);
      map.set(id, arr);
    }
  }
  return map;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
