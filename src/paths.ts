/**
 * Network-path view: collapses the object graph (Gateway/VirtualService/...)
 * into pure  host → match → service  paths, consolidated per unique host name.
 *
 * The output is canonical and implementation-independent: entries are
 * deduplicated and sorted (host, then match), destinations and modifiers are
 * normalized and sorted, so two manifest sets that express the same routing —
 * however differently structured — produce byte-identical text (diff-able).
 */
import type {
  DestNode,
  HTTPMatchRequest,
  HostBinding,
  RoutingModel,
  RuleNode,
  StringMatch,
} from "./types.js";

export interface PathEntry {
  /** canonical match: "/api/v2*", "/login", "~^/v[0-9]+", "*", plus "{...}" extras */
  match: string;
  /** raw URI value for prefix filtering ("" for catch-all) */
  uriVal: string;
  uriIsRegex: boolean;
  /** canonical destination descriptors, weight-sorted */
  dests: string[];
  /** graph node ids backing each dests entry (parallel array), for the HTML side panel */
  destIds: string[];
  /** canonical modifier descriptors, sorted */
  mods: string[];
  /** one representative rule id (for the HTML side panel) */
  ruleId: string;
  /** ns/name of every VirtualService contributing this entry */
  sources: string[];
}

export interface HostPaths {
  host: string;
  /** sorted listeners serving this host: "ns/gateway:port" or "mesh" */
  via: string[];
  /** VS namespaces involved (for filtering) */
  namespaces: string[];
  /** gateway names involved (for filtering) */
  gateways: string[];
  entries: PathEntry[];
}

export function buildNetworkPaths(model: RoutingModel): HostPaths[] {
  const groups = new Map<
    string,
    { via: Set<string>; namespaces: Set<string>; gateways: Set<string>; entries: Map<string, PathEntry> }
  >();

  const ensure = (host: string) => {
    let g = groups.get(host);
    if (!g) {
      g = { via: new Set(), namespaces: new Set(), gateways: new Set(), entries: new Map() };
      groups.set(host, g);
    }
    return g;
  };

  const addBinding = (b: HostBinding, via: string, gateway?: string) => {
    for (const host of b.hostNode.hosts) {
      const g = ensure(host);
      g.via.add(via);
      g.namespaces.add(b.hostNode.vsNamespace);
      if (gateway) g.gateways.add(gateway);
      for (const rid of b.ruleIds) {
        const rule = model.nodes.get(rid) as RuleNode;
        addRuleEntries(g.entries, model, rule);
      }
    }
  };

  for (const section of model.sections) {
    const l = section.listener;
    const via = `${l.namespace}/${l.gateway}:${l.port}`;
    for (const b of section.bindings) addBinding(b, via, l.gateway);
  }
  for (const b of model.mesh.bindings) addBinding(b, "mesh");

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, g]) => ({
      host,
      via: [...g.via].sort(),
      namespaces: [...g.namespaces].sort(),
      gateways: [...g.gateways].sort(),
      entries: [...g.entries.values()].sort((a, b) => a.match.localeCompare(b.match)),
    }));
}

/** One entry per OR match block (each is an independently reachable path). */
function addRuleEntries(entries: Map<string, PathEntry>, model: RoutingModel, rule: RuleNode): void {
  const { texts: dests, ids: destIds } = canonicalDests(model, rule);
  const mods = canonicalMods(model, rule);
  const source = `${rule.vsNamespace}/${rule.vsName}`;
  const blocks: (HTTPMatchRequest | undefined)[] = rule.raw.match?.length ? rule.raw.match : [undefined];
  for (const m of blocks) {
    const { uri, uriVal, uriIsRegex, extras } = canonicalMatch(m);
    const match = extras.length ? `${uri} {${extras.join(", ")}}` : uri;
    const key = `${match} -> ${dests.join(" ")}${mods.length ? ` [${mods.join(", ")}]` : ""}`;
    const existing = entries.get(key);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      entries.set(key, { match, uriVal, uriIsRegex, dests, destIds, mods, ruleId: rule.id, sources: [source] });
    }
  }
}

function canonicalMatch(m: HTTPMatchRequest | undefined): {
  uri: string;
  uriVal: string;
  uriIsRegex: boolean;
  extras: string[];
} {
  let uri = "*";
  let uriVal = "";
  let uriIsRegex = false;
  if (m?.uri) {
    if (m.uri.exact !== undefined) {
      uri = m.uri.exact;
      uriVal = m.uri.exact;
    } else if (m.uri.prefix !== undefined) {
      uri = m.uri.prefix === "/" ? "/*" : `${m.uri.prefix}*`;
      uriVal = m.uri.prefix;
    } else if (m.uri.regex !== undefined) {
      uri = `~${m.uri.regex}`;
      uriVal = m.uri.regex;
      uriIsRegex = true;
    }
  }
  const extras: string[] = [];
  if (!m) return { uri, uriVal, uriIsRegex, extras };
  const sm = (v: StringMatch): string =>
    v.exact !== undefined ? `=${v.exact}` : v.prefix !== undefined ? `^=${v.prefix}` : v.regex !== undefined ? `~${v.regex}` : "";
  if (m.method) extras.push(`method${sm(m.method)}`);
  if (m.scheme) extras.push(`scheme${sm(m.scheme)}`);
  if (m.authority) extras.push(`authority${sm(m.authority)}`);
  for (const [k, v] of Object.entries(m.headers ?? {})) {
    const s = sm(v);
    extras.push(s ? `header ${k}${s}` : `header ${k}`);
  }
  for (const [k, v] of Object.entries(m.withoutHeaders ?? {})) {
    const s = sm(v);
    extras.push(s ? `!header ${k}${s}` : `!header ${k}`);
  }
  for (const [k, v] of Object.entries(m.queryParams ?? {})) {
    extras.push(`?${k}${sm(v)}`);
  }
  if (m.port !== undefined) extras.push(`port=${m.port}`);
  for (const [k, v] of Object.entries(m.sourceLabels ?? {})) extras.push(`sourceLabel ${k}=${v}`);
  if (m.gateways?.length) extras.push(`gateway∈{${[...m.gateways].sort().join(",")}}`);
  extras.sort();
  return { uri, uriVal, uriIsRegex, extras };
}

function canonicalDests(model: RoutingModel, rule: RuleNode): { texts: string[]; ids: string[] } {
  if (rule.raw.redirect) {
    const r = rule.raw.redirect;
    const target = `${r.scheme ? r.scheme + "://" : ""}${r.authority ?? ""}${r.uri ?? ""}` || "(same)";
    return { texts: [`redirect:${r.redirectCode ?? 301}:${target}`], ids: [`${rule.id}/redirect`] };
  }
  if (rule.raw.directResponse) {
    return { texts: [`direct:${rule.raw.directResponse.status ?? "?"}`], ids: [`${rule.id}/direct`] };
  }
  const out: { text: string; id: string; weight: number }[] = [];
  for (const e of model.edges) {
    if (e.from !== rule.id || e.kind !== "routes") continue;
    const n = model.nodes.get(e.to) as DestNode | undefined;
    if (!n || n.kind !== "dest" || n.type === "redirect" || n.type === "direct") continue;
    let text = `${n.shortHost ?? n.host}${n.port ? ":" + n.port : ""}`;
    if (n.subset) text += `(${n.subset})`;
    const weight = e.weight ?? 100;
    if (e.label) text += `=${weight}%`;
    if (!n.serviceFound) text += "!missing";
    out.push({ text, id: n.id, weight });
  }
  out.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  return { texts: out.map((d) => d.text), ids: out.map((d) => d.id) };
}

function canonicalMods(model: RoutingModel, rule: RuleNode): string[] {
  const mods: string[] = [];
  for (const m of rule.modifiers) {
    if (m.kind === "redirect" || m.kind === "directResponse" || m.kind === "mirror") continue;
    mods.push(m.summary);
  }
  for (const e of model.edges) {
    if (e.from !== rule.id || e.kind !== "mirrors") continue;
    const n = model.nodes.get(e.to) as DestNode | undefined;
    if (!n) continue;
    const pct = e.label && e.label !== "mirror" ? `=${e.label.replace("mirror ", "")}` : "";
    mods.push(`mirror ${n.shortHost ?? n.host}${n.port ? ":" + n.port : ""}${pct}`);
  }
  return mods.sort();
}

/**
 * Diff-friendly plain-text rendering: stable sort, no alignment padding, no
 * timestamps. Intended to be committed/compared with plain `diff`.
 */
export function renderPathsText(model: RoutingModel): string {
  const groups = buildNetworkPaths(model);
  const out: string[] = [
    "# istio-viz network paths",
    "# host → match → service; canonically sorted and deduplicated for diffing",
    "",
  ];
  for (const g of groups) {
    out.push(`${g.host} via ${g.via.join(", ")}`);
    for (const e of g.entries) {
      let line = `  ${e.match} -> ${e.dests.join(" ") || "(no destination)"}`;
      if (e.mods.length) line += ` [${e.mods.join(", ")}]`;
      out.push(line);
    }
    out.push("");
  }
  if (groups.length === 0) out.push("(no network paths found)", "");
  return out.join("\n");
}
