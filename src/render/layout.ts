/**
 * Layered left-to-right layout: Client → Listener → Host → Rules → Destinations.
 * Column widths adapt to content per section (long hostnames get room; the
 * page scrolls horizontally rather than truncating everything).
 * Pure geometry; consumed by the SVG renderer (static export and HTML embed).
 */
import type { DestNode, GraphEdge, HostBinding, ListenerSection, RoutingModel, RuleNode } from "../types.js";

export interface TextLine {
  text: string;
  cls: string; // css class hint: title, match, regex, or, badge, sub, dim, err
}

export interface LayoutNode {
  id: string;
  kind: "client" | "listener" | "host" | "rule" | "dest";
  x: number;
  y: number;
  w: number;
  h: number;
  lines: TextLine[];
  /** full untruncated content for native tooltips */
  tooltip?: string;
  /** evaluation-order badge for rules */
  badge?: string;
  unreachable?: boolean;
  destType?: DestNode["type"];
  serviceFound?: boolean;
}

export interface LayoutEdge {
  fromId: string;
  toId: string;
  kind: GraphEdge["kind"];
  label?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SectionLayout {
  key: string;
  title: string;
  /** filter metadata */
  gateway?: string;
  namespaces: string[];
  hosts: string[];
  ruleCount: number;
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

const LINE_H = 14;
const PAD = 7;
const GAP = 10; // between rule bands
const BIND_GAP = 18; // between bindings (visual chunking)
const CHAR_W = 6.4;
const BADGE_INSET = 18; // first rule line shifts right of the order badge

// columns: client, listener, host, rule, dest
const MIN_W = [62, 130, 150, 200, 170];
const MAX_W = [62, 240, 360, 430, 380];
const COL_GAP = [36, 48, 56, 56];

interface Cols {
  x: number[];
  w: number[];
}

const MOD_BADGE: Record<string, string> = {
  retries: "↻",
  timeout: "⏱",
  rewrite: "✂",
  redirect: "⤳",
  mirror: "🪞",
  fault: "⚡",
  headers: "≡",
  cors: "◌",
  directResponse: "▣",
};

export function modBadge(kind: string): string {
  return MOD_BADGE[kind] ?? "•";
}

export function layoutModel(model: RoutingModel): SectionLayout[] {
  const sections: SectionLayout[] = [];
  for (const s of model.sections) {
    sections.push(layoutSection(model, s));
  }
  if (model.mesh.bindings.length > 0) {
    sections.push(layoutMesh(model, model.mesh.bindings));
  }
  return sections;
}

function textWidth(lines: TextLine[], extra = 0): number {
  if (lines.length === 0) return 0;
  return Math.max(...lines.map((l) => l.text.length)) * CHAR_W + 2 * PAD + extra;
}

function clampW(col: number, desired: number): number {
  return Math.max(MIN_W[col]!, Math.min(MAX_W[col]!, Math.ceil(desired)));
}

function fitLines(lines: TextLine[], width: number, firstLineInset = 0): TextLine[] {
  return lines.map((l, i) => {
    const avail = width - 2 * PAD - (i === 0 ? firstLineInset : 0);
    const maxChars = Math.floor(avail / CHAR_W);
    return l.text.length > maxChars
      ? { ...l, text: l.text.slice(0, Math.max(1, maxChars - 1)) + "…" }
      : l;
  });
}

function tooltipOf(lines: TextLine[]): string {
  return lines.map((l) => l.text).join("\n");
}

/** Measure content of every column for one section's bindings, then derive x/w. */
function computeCols(model: RoutingModel, bindings: HostBinding[], listenerLines: TextLine[]): Cols {
  let hostW = 0;
  let ruleW = 0;
  let destW = 0;
  const seenDest = new Set<string>();
  for (const b of bindings) {
    hostW = Math.max(hostW, textWidth(hostContentLines(b)));
    for (const rid of b.ruleIds) {
      const rule = model.nodes.get(rid) as RuleNode;
      ruleW = Math.max(ruleW, textWidth(ruleContentLines(rule), BADGE_INSET));
      for (const e of model.edges) {
        if (e.from !== rid || (e.kind !== "routes" && e.kind !== "mirrors") || seenDest.has(e.to)) continue;
        seenDest.add(e.to);
        destW = Math.max(destW, textWidth(destLines(model.nodes.get(e.to) as DestNode)));
      }
    }
  }
  const w = [
    MIN_W[0]!,
    clampW(1, textWidth(listenerLines)),
    clampW(2, hostW),
    clampW(3, ruleW),
    clampW(4, destW),
  ];
  const x: number[] = [10];
  for (let i = 1; i < 5; i++) x[i] = x[i - 1]! + w[i - 1]! + COL_GAP[i - 1]!;
  return { x, w };
}

function layoutSection(model: RoutingModel, section: ListenerSection): SectionLayout {
  const l = section.listener;
  const listenerLines: TextLine[] = [
    { text: `${l.namespace}/${l.gateway}`, cls: "title" },
    { text: `:${l.port} ${l.protocol}${l.tlsMode ? ` (${l.tlsMode} TLS)` : ""}`, cls: "sub" },
    ...l.hosts.map((h) => ({ text: h, cls: "dim" })),
  ];
  const cols = computeCols(model, section.bindings, listenerLines);
  const out = baseLayout(model, section.bindings, cols);
  placeAnchors(out, cols, listenerLines, l.id);
  out.key = l.id;
  out.title = `gateway ${l.namespace}/${l.gateway} — :${l.port} ${l.protocol}${l.tlsMode ? ` (${l.tlsMode} TLS)` : ""}`;
  out.gateway = l.gateway;
  return out;
}

function layoutMesh(model: RoutingModel, bindings: HostBinding[]): SectionLayout {
  const listenerLines: TextLine[] = [
    { text: "mesh", cls: "title" },
    { text: "(sidecar routing)", cls: "sub" },
  ];
  const cols = computeCols(model, bindings, listenerLines);
  const out = baseLayout(model, bindings, cols);
  placeAnchors(out, cols, listenerLines, "mesh:listener");
  out.key = "mesh";
  out.title = "mesh routing (no gateway)";
  return out;
}

function hostContentLines(b: HostBinding): TextLine[] {
  return [
    ...b.hostNode.hosts.map((h) => ({ text: h, cls: "title" })),
    { text: `vs: ${b.hostNode.vsName} · ${b.hostNode.vsNamespace}`, cls: "sub" },
  ];
}

/** Lays out hosts/rules/dests; listener+client anchors added afterwards. */
function baseLayout(model: RoutingModel, bindings: HostBinding[], cols: Cols): SectionLayout {
  const out: SectionLayout = {
    key: "",
    title: "",
    namespaces: [],
    hosts: [],
    ruleCount: 0,
    width: cols.x[4]! + cols.w[4]! + 16,
    height: 0,
    nodes: [],
    edges: [],
  };
  let y = 10;
  const placedDest = new Map<string, LayoutNode>();

  for (const b of bindings) {
    if (!out.namespaces.includes(b.hostNode.vsNamespace)) out.namespaces.push(b.hostNode.vsNamespace);
    for (const h of b.hostNode.hosts) if (!out.hosts.includes(h)) out.hosts.push(h);

    const ruleNodes: LayoutNode[] = [];
    const bindingTop = y;

    for (const rid of b.ruleIds) {
      out.ruleCount++;
      const rule = model.nodes.get(rid) as RuleNode;
      const ruleLines = ruleContentLines(rule);
      const ruleH = ruleLines.length * LINE_H + 2 * PAD;

      // destinations owned by this rule that aren't placed yet
      const destEdges = model.edges.filter((e) => e.from === rid && (e.kind === "routes" || e.kind === "mirrors"));
      const newDests = destEdges.map((e) => e.to).filter((id, i, a) => a.indexOf(id) === i && !placedDest.has(id));
      const destHeights = newDests.map((id) => destLines(model.nodes.get(id) as DestNode).length * LINE_H + 2 * PAD);
      const destsTotal = destHeights.reduce((a, h) => a + h + GAP, 0) - (destHeights.length ? GAP : 0);

      const band = Math.max(ruleH, destsTotal);
      // place new dests stacked, centered in band
      let dy = y + Math.max(0, (band - destsTotal) / 2);
      newDests.forEach((id, i) => {
        const dn = model.nodes.get(id) as DestNode;
        const lines = destLines(dn);
        const node: LayoutNode = {
          id,
          kind: "dest",
          x: cols.x[4]!,
          y: dy,
          w: cols.w[4]!,
          h: destHeights[i]!,
          lines: fitLines(lines, cols.w[4]!),
          tooltip: tooltipOf(lines),
          destType: dn.type,
          serviceFound: dn.serviceFound,
        };
        out.nodes.push(node);
        placedDest.set(id, node);
        dy += destHeights[i]! + GAP;
      });

      const ruleNode: LayoutNode = {
        id: rid,
        kind: "rule",
        x: cols.x[3]!,
        y: y + (band - ruleH) / 2,
        w: cols.w[3]!,
        h: ruleH,
        lines: fitLines(ruleLines, cols.w[3]!, BADGE_INSET),
        tooltip: tooltipOf(ruleLines),
        badge: `#${rule.index + 1}`,
        unreachable: rule.unreachable,
      };
      out.nodes.push(ruleNode);
      ruleNodes.push(ruleNode);

      for (const e of destEdges) {
        const dn = placedDest.get(e.to)!;
        out.edges.push({
          fromId: rid,
          toId: e.to,
          kind: e.kind,
          label: e.kind === "mirrors" ? (e.label ?? "mirror") : e.label,
          x1: ruleNode.x + ruleNode.w,
          y1: ruleNode.y + ruleNode.h / 2,
          x2: dn.x,
          y2: dn.y + dn.h / 2,
        });
      }
      y += band + GAP;
    }

    // host node spans its rules
    const hostLines = hostContentLines(b);
    const hostH = hostLines.length * LINE_H + 2 * PAD;
    const rulesMid =
      ruleNodes.length > 0
        ? (ruleNodes[0]!.y + ruleNodes[ruleNodes.length - 1]!.y + ruleNodes[ruleNodes.length - 1]!.h) / 2
        : bindingTop + hostH / 2;
    const hostNode: LayoutNode = {
      id: b.hostNode.id,
      kind: "host",
      x: cols.x[2]!,
      y: Math.max(bindingTop, rulesMid - hostH / 2),
      w: cols.w[2]!,
      h: hostH,
      lines: fitLines(hostLines, cols.w[2]!),
      tooltip: tooltipOf(hostLines),
    };
    out.nodes.push(hostNode);
    for (const rn of ruleNodes) {
      out.edges.push({
        fromId: hostNode.id,
        toId: rn.id,
        kind: "evaluates",
        x1: hostNode.x + hostNode.w,
        y1: hostNode.y + hostNode.h / 2,
        x2: rn.x,
        y2: rn.y + rn.h / 2,
      });
    }
    y = Math.max(y, hostNode.y + hostNode.h + GAP) + (BIND_GAP - GAP);
  }

  out.height = y + 10;
  return out;
}

/** Add listener + client nodes centered on the host column, plus their edges. */
function placeAnchors(out: SectionLayout, cols: Cols, listenerLines: TextLine[], listenerId: string): void {
  const hosts = out.nodes.filter((n) => n.kind === "host");
  const mid =
    hosts.length > 0
      ? (Math.min(...hosts.map((h) => h.y)) + Math.max(...hosts.map((h) => h.y + h.h))) / 2
      : out.height / 2;
  const lH = listenerLines.length * LINE_H + 2 * PAD;
  const listener: LayoutNode = {
    id: listenerId,
    kind: "listener",
    x: cols.x[1]!,
    y: Math.max(10, mid - lH / 2),
    w: cols.w[1]!,
    h: lH,
    lines: fitLines(listenerLines, cols.w[1]!),
    tooltip: tooltipOf(listenerLines),
  };
  const client: LayoutNode = {
    id: `${listenerId}/client`,
    kind: "client",
    x: cols.x[0]!,
    y: Math.max(10, mid - 17),
    w: cols.w[0]!,
    h: 34,
    lines: [{ text: "Client", cls: "title" }],
  };
  out.nodes.push(listener, client);
  out.height = Math.max(out.height, listener.y + listener.h + 10);
  out.edges.push({
    fromId: client.id,
    toId: listenerId,
    kind: "accepts",
    x1: client.x + client.w,
    y1: client.y + client.h / 2,
    x2: listener.x,
    y2: listener.y + listener.h / 2,
  });
  for (const h of hosts) {
    out.edges.push({
      fromId: listenerId,
      toId: h.id,
      kind: "accepts",
      x1: listener.x + listener.w,
      y1: listener.y + listener.h / 2,
      x2: h.x,
      y2: h.y + h.h / 2,
    });
  }
}

function ruleContentLines(rule: RuleNode): TextLine[] {
  const lines: TextLine[] = [];
  if (rule.matchBlocks.length === 0) {
    lines.push({ text: "/* (catch-all)", cls: "match" });
  } else {
    rule.matchBlocks.forEach((b, bi) => {
      if (bi > 0) lines.push({ text: "OR", cls: "or" });
      if (b.exprs.length === 0) {
        lines.push({ text: "any request", cls: "match" });
      }
      b.exprs.forEach((e, ei) => {
        const prefix = ei > 0 ? "AND " : "";
        lines.push({ text: prefix + e.text, cls: e.regex ? "regex" : "match" });
      });
    });
  }
  if (rule.modifiers.length > 0) {
    const badges = rule.modifiers.map((m) => `${modBadge(m.kind)} ${m.summary}`).join("  ");
    lines.push({ text: badges, cls: "badge" });
  }
  return lines;
}

function destLines(n: DestNode): TextLine[] {
  if (n.type === "redirect" || n.type === "direct") {
    return [{ text: n.host, cls: "title" }];
  }
  const lines: TextLine[] = [
    { text: `${n.shortHost ?? n.host}${n.port ? ":" + n.port : ""}`, cls: "title" },
  ];
  if (n.subset) {
    const labels = n.subsetLabels
      ? ` (${Object.entries(n.subsetLabels).map(([k, v]) => `${k}=${v}`).join(",")})`
      : "";
    lines.push({ text: `subset: ${n.subset}${labels}`, cls: "sub" });
  }
  if (!n.serviceFound) lines.push({ text: "service not found", cls: "err" });
  return lines;
}

/* ---------------- Paths-view graph (host → match → service) ---------------- */

import type { HostPaths, PathEntry } from "../paths.js";

export interface PathsGroupLayout {
  host: string;
  gateways: string[];
  namespaces: string[];
  layout: SectionLayout;
  /** match-node id → its entry, for client-side filtering and panel aliasing */
  matchNodes: { id: string; entry: PathEntry }[];
  /** dest-node id → backing model dest node id, for panel aliasing */
  destNodes: { id: string; destId: string }[];
}

/** Strip canonical weight/missing suffixes to get the service identity. */
function destServiceText(d: string): { text: string; weight?: string; missing: boolean } {
  let text = d;
  const missing = text.endsWith("!missing");
  if (missing) text = text.slice(0, -"!missing".length);
  let weight: string | undefined;
  const m = /=(\d+%)$/.exec(text);
  if (m) {
    weight = m[1];
    text = text.slice(0, -m[0].length);
  }
  return { text, weight, missing };
}

export function layoutPathsGroups(groups: HostPaths[]): PathsGroupLayout[] {
  return groups.map(layoutPathsGroup);
}

function layoutPathsGroup(g: HostPaths): PathsGroupLayout {
  const PMIN = [160, 190, 170];
  const PMAX = [360, 480, 380];
  const PGAP = [52, 56];

  const hostLines: TextLine[] = [
    { text: g.host, cls: "title" },
    ...g.via.map((v) => ({ text: `via ${v}`, cls: "dim" })),
  ];
  const matchLinesOf = (e: PathEntry): TextLine[] => {
    const lines: TextLine[] = [{ text: e.match, cls: e.uriIsRegex ? "regex" : "match" }];
    if (e.mods.length) lines.push({ text: e.mods.join("  "), cls: "badge" });
    return lines;
  };
  const destLinesOf = (d: string): TextLine[] => {
    const { text, missing } = destServiceText(d);
    const lines: TextLine[] = [{ text, cls: "title" }];
    if (missing) lines.push({ text: "service not found", cls: "err" });
    return lines;
  };

  // adaptive widths
  let mW = 0;
  let dW = 0;
  for (const e of g.entries) {
    mW = Math.max(mW, textWidth(matchLinesOf(e)));
    for (const d of e.dests) dW = Math.max(dW, textWidth(destLinesOf(d)));
  }
  const w = [
    Math.max(PMIN[0]!, Math.min(PMAX[0]!, Math.ceil(textWidth(hostLines)))),
    Math.max(PMIN[1]!, Math.min(PMAX[1]!, Math.ceil(mW))),
    Math.max(PMIN[2]!, Math.min(PMAX[2]!, Math.ceil(dW))),
  ];
  const x = [10, 10 + w[0]! + PGAP[0]!, 10 + w[0]! + PGAP[0]! + w[1]! + PGAP[1]!];

  const out: SectionLayout = {
    key: `paths:${g.host}`,
    title: g.host,
    namespaces: g.namespaces,
    hosts: [g.host],
    ruleCount: g.entries.length,
    width: x[2]! + w[2]! + 16,
    height: 0,
    nodes: [],
    edges: [],
  };
  const matchNodes: PathsGroupLayout["matchNodes"] = [];
  const destNodes: PathsGroupLayout["destNodes"] = [];
  const placedDest = new Map<string, LayoutNode>();
  let y = 10;
  const matchLayoutNodes: LayoutNode[] = [];

  g.entries.forEach((e, i) => {
    const mid = `pm:${g.host}#${i}`;
    const mLines = matchLinesOf(e);
    const mH = mLines.length * LINE_H + 2 * PAD;

    const destsOfEntry = e.dests.map((d, j) => {
      const { text, weight, missing } = destServiceText(d);
      return { key: text, weight, missing, destId: e.destIds[j] ?? "", lines: destLinesOf(d) };
    });
    const newDests = destsOfEntry.filter((d, j, a) => a.findIndex((o) => o.key === d.key) === j && !placedDest.has(d.key));
    const destHeights = newDests.map((d) => d.lines.length * LINE_H + 2 * PAD);
    const destsTotal = destHeights.reduce((a, h) => a + h + GAP, 0) - (destHeights.length ? GAP : 0);
    const band = Math.max(mH, destsTotal);

    let dy = y + Math.max(0, (band - destsTotal) / 2);
    newDests.forEach((d, j) => {
      const id = `pd:${g.host}:${d.key}`;
      const node: LayoutNode = {
        id,
        kind: "dest",
        x: x[2]!,
        y: dy,
        w: w[2]!,
        h: destHeights[j]!,
        lines: fitLines(d.lines, w[2]!),
        tooltip: tooltipOf(d.lines),
        destType: d.key.startsWith("redirect:") ? "redirect" : d.key.startsWith("direct:") ? "direct" : "service",
        serviceFound: !d.missing,
      };
      out.nodes.push(node);
      placedDest.set(d.key, node);
      destNodes.push({ id, destId: d.destId });
      dy += destHeights[j]! + GAP;
    });

    const mNode: LayoutNode = {
      id: mid,
      kind: "rule",
      x: x[1]!,
      y: y + (band - mH) / 2,
      w: w[1]!,
      h: mH,
      lines: fitLines(mLines, w[1]!),
      tooltip: tooltipOf(mLines) + `\nfrom ${e.sources.join(", ")}`,
    };
    out.nodes.push(mNode);
    matchLayoutNodes.push(mNode);
    matchNodes.push({ id: mid, entry: e });

    for (const d of destsOfEntry) {
      const dn = placedDest.get(d.key)!;
      out.edges.push({
        fromId: mid,
        toId: dn.id,
        kind: "routes",
        label: d.weight,
        x1: mNode.x + mNode.w,
        y1: mNode.y + mNode.h / 2,
        x2: dn.x,
        y2: dn.y + dn.h / 2,
      });
    }
    y += band + GAP;
  });

  // host node spans all entries
  const hH = hostLines.length * LINE_H + 2 * PAD;
  const mid =
    matchLayoutNodes.length > 0
      ? (matchLayoutNodes[0]!.y +
          matchLayoutNodes[matchLayoutNodes.length - 1]!.y +
          matchLayoutNodes[matchLayoutNodes.length - 1]!.h) /
        2
      : 10 + hH / 2;
  const hostNode: LayoutNode = {
    id: `ph:${g.host}`,
    kind: "host",
    x: x[0]!,
    y: Math.max(10, mid - hH / 2),
    w: w[0]!,
    h: hH,
    lines: fitLines(hostLines, w[0]!),
    tooltip: tooltipOf(hostLines),
  };
  out.nodes.push(hostNode);
  for (const mn of matchLayoutNodes) {
    out.edges.push({
      fromId: hostNode.id,
      toId: mn.id,
      kind: "evaluates",
      x1: hostNode.x + hostNode.w,
      y1: hostNode.y + hostNode.h / 2,
      x2: mn.x,
      y2: mn.y + mn.h / 2,
    });
  }
  out.height = Math.max(y, hostNode.y + hostNode.h + GAP) + 10;
  return { host: g.host, gateways: g.gateways, namespaces: g.namespaces, layout: out, matchNodes, destNodes };
}
