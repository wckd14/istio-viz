/**
 * Resolver/Evaluator: joins Gateway↔VirtualService (host intersection with
 * wildcard semantics), resolves destinations to Services/subsets, builds the
 * typed routing graph, and emits lint findings. Pure — no I/O.
 */
import {
  expandHost,
  hostMatches,
  intersectHosts,
  parseGatewayHost,
  shortHost,
  splitClusterLocal,
} from "./hosts.js";
import type {
  DestNode,
  DestinationRuleResource,
  Finding,
  GatewayResource,
  GraphEdge,
  GraphNode,
  HTTPRoute,
  HostBinding,
  HostNode,
  ListenerNode,
  ListenerSection,
  MatchBlock,
  MatchExpr,
  Modifier,
  Resource,
  RoutingModel,
  RuleNode,
  ServiceResource,
  StringMatch,
  VirtualServiceResource,
} from "./types.js";

const HTTP_PROTOCOLS = new Set(["HTTP", "HTTPS", "HTTP2", "GRPC", "GRPC-WEB"]);

export function resolve(resources: Resource[]): RoutingModel {
  const model: RoutingModel = {
    nodes: new Map(),
    edges: [],
    sections: [],
    mesh: { bindings: [] },
    findings: [],
    l4Notes: [],
    resources,
  };

  const gateways = resources.filter((r): r is GatewayResource => r.kind === "Gateway");
  const vss = resources.filter((r): r is VirtualServiceResource => r.kind === "VirtualService");
  const services = resources.filter((r): r is ServiceResource => r.kind === "Service");
  const drs = resources.filter((r): r is DestinationRuleResource => r.kind === "DestinationRule");

  // ---- Listener nodes, one per gateway server ----
  const sectionsByListener = new Map<string, ListenerSection>();
  for (const gw of gateways) {
    gw.servers.forEach((server, i) => {
      const id = `listener:${gw.namespace}/${gw.name}#${i}`;
      const listener: ListenerNode = {
        id,
        kind: "listener",
        gateway: gw.name,
        namespace: gw.namespace,
        port: server.port.number,
        portName: server.port.name,
        protocol: server.port.protocol,
        tlsMode: server.tls?.mode,
        hosts: server.hosts.map((h) => parseGatewayHost(h, gw.namespace).host),
        loc: server.loc ?? gw.loc,
      };
      model.nodes.set(id, listener);
      const section: ListenerSection = { listener, bindings: [] };
      sectionsByListener.set(id, section);
      model.sections.push(section);
      if (!HTTP_PROTOCOLS.has(server.port.protocol.toUpperCase())) {
        model.l4Notes.push(
          `gateway ${gw.namespace}/${gw.name} server :${server.port.number} (${server.port.protocol}) is not HTTP — VirtualService http routes will not bind to it`,
        );
      }
    });
  }

  // ---- Rule + destination nodes, once per VirtualService ----
  const rulesByVS = new Map<VirtualServiceResource, RuleNode[]>();
  for (const vs of vss) {
    if (vs.hasTcp || vs.hasTls) {
      model.l4Notes.push(
        `VirtualService ${vs.namespace}/${vs.name} contains tcp/tls route blocks (L4, not diagrammed)`,
      );
    }
    const rules: RuleNode[] = [];
    vs.http.forEach((route, idx) => {
      const ruleId = `rule:${vs.namespace}/${vs.name}#${idx}`;
      const matchBlocks = buildMatchBlocks(route);
      const rule: RuleNode = {
        id: ruleId,
        kind: "rule",
        index: idx,
        name: route.name,
        vsName: vs.name,
        vsNamespace: vs.namespace,
        matchBlocks,
        isCatchAll: isCatchAll(matchBlocks),
        modifiers: buildModifiers(route),
        loc: route.loc,
        yaml: route.yaml,
        raw: route,
      };
      model.nodes.set(ruleId, rule);
      rules.push(rule);
      buildDestinations(model, vs, rule, route, services, drs);
    });
    rulesByVS.set(vs, rules);
    lintRuleShadowing(model, vs, rules);
    lintWeights(model, vs, rules);
  }

  // ---- Gateway ↔ VS binding ----
  const gwIndex = new Map<string, GatewayResource>();
  for (const gw of gateways) gwIndex.set(`${gw.namespace}/${gw.name}`, gw);

  // (gatewayKey + concrete host) -> VS names, for W004
  const hostClaims = new Map<string, { vs: VirtualServiceResource; hostNodeId: string }[]>();

  for (const vs of vss) {
    const rules = rulesByVS.get(vs)!;
    for (const gwRef of vs.gateways) {
      if (gwRef === "mesh") {
        if (rules.length === 0) continue;
        const hostNode: HostNode = {
          id: `host:mesh/${vs.namespace}/${vs.name}`,
          kind: "host",
          hosts: vs.hosts,
          vsName: vs.name,
          vsNamespace: vs.namespace,
          loc: vs.loc,
        };
        model.nodes.set(hostNode.id, hostNode);
        addBinding(model, model.mesh.bindings, hostNode, rules);
        continue;
      }
      const gw = lookupGateway(gwIndex, gwRef, vs.namespace);
      if (!gw) {
        model.findings.push({
          id: "E001",
          severity: "error",
          message: `VirtualService ${vs.namespace}/${vs.name} references gateway "${gwRef}" which is not in the input set`,
          loc: vs.gatewaysLoc ?? vs.loc,
          nodeIds: rules.map((r) => r.id),
        });
        continue;
      }
      let boundAnywhere = false;
      gw.servers.forEach((server, i) => {
        if (!HTTP_PROTOCOLS.has(server.port.protocol.toUpperCase())) return;
        const listenerId = `listener:${gw.namespace}/${gw.name}#${i}`;
        const section = sectionsByListener.get(listenerId)!;
        // honor "ns/host" qualifiers on the gateway server
        const allowedHosts = server.hosts
          .map((h) => parseGatewayHost(h, gw.namespace))
          .filter((g) => g.namespace === undefined || g.namespace === vs.namespace)
          .map((g) => g.host);
        const effective = intersectHosts(vs.hosts, allowedHosts);
        if (effective.length === 0) return;
        boundAnywhere = true;
        const hostNode: HostNode = {
          id: `host:${listenerId}/${vs.namespace}/${vs.name}`,
          kind: "host",
          hosts: effective,
          vsName: vs.name,
          vsNamespace: vs.namespace,
          loc: vs.loc,
        };
        model.nodes.set(hostNode.id, hostNode);
        model.edges.push({ from: listenerId, to: hostNode.id, kind: "accepts" });
        addBinding(model, section.bindings, hostNode, rules);
        for (const h of effective) {
          const key = `${gw.namespace}/${gw.name}|${h}`;
          const claims = hostClaims.get(key) ?? [];
          claims.push({ vs, hostNodeId: hostNode.id });
          hostClaims.set(key, claims);
        }
        if (rules.length > 0 && !rules.some((r) => r.isCatchAll)) {
          pushUnique(model.findings, {
            id: "I001",
            severity: "info",
            message: `${vs.namespace}/${vs.name}: no catch-all rule — unmatched requests will get 404`,
            loc: vs.loc,
            nodeIds: [hostNode.id],
          });
        }
      });
      if (!boundAnywhere) {
        model.findings.push({
          id: "W001",
          severity: "warn",
          message:
            `VirtualService ${vs.namespace}/${vs.name} hosts [${vs.hosts.join(", ")}] have empty intersection ` +
            `with gateway ${gw.namespace}/${gw.name} hosts — its rules can never receive traffic via this gateway`,
          loc: vs.loc,
          nodeIds: rules.map((r) => r.id),
        });
      }
    }
  }

  // W004: multiple VS define the same host on the same gateway
  for (const [key, claims] of hostClaims) {
    const distinct = [...new Set(claims.map((c) => `${c.vs.namespace}/${c.vs.name}`))];
    if (distinct.length > 1) {
      const [gwKey, host] = key.split("|") as [string, string];
      model.findings.push({
        id: "W004",
        severity: "warn",
        message: `host ${host} on gateway ${gwKey} is defined by multiple VirtualServices (${distinct.join(", ")}) — merge order is ambiguous`,
        nodeIds: claims.map((c) => c.hostNodeId),
      });
    }
  }

  // I001 for mesh bindings
  for (const b of model.mesh.bindings) {
    const anyCatchAll = b.ruleIds.some((rid) => (model.nodes.get(rid) as RuleNode).isCatchAll);
    if (b.ruleIds.length > 0 && !anyCatchAll) {
      pushUnique(model.findings, {
        id: "I001",
        severity: "info",
        message: `mesh routing ${b.hostNode.vsNamespace}/${b.hostNode.vsName}: no catch-all rule — unmatched requests fall through to default service routing`,
        loc: b.hostNode.loc,
        nodeIds: [b.hostNode.id],
      });
    }
  }

  sortFindings(model.findings);
  return model;
}

function addBinding(model: RoutingModel, bindings: HostBinding[], hostNode: HostNode, rules: RuleNode[]): void {
  bindings.push({ hostNode, ruleIds: rules.map((r) => r.id) });
  rules.forEach((r) => {
    model.edges.push({ from: hostNode.id, to: r.id, kind: "evaluates", label: `order ${r.index + 1}` });
  });
}

function lookupGateway(
  index: Map<string, GatewayResource>,
  ref: string,
  vsNamespace: string,
): GatewayResource | undefined {
  if (ref.includes("/")) {
    const [ns, name] = ref.split("/") as [string, string];
    return index.get(`${ns}/${name}`);
  }
  if (ref.includes(".")) {
    // legacy "name.namespace[.svc.cluster.local]" form
    const [name, ns] = ref.split(".") as [string, string];
    return index.get(`${ns}/${name}`);
  }
  return index.get(`${vsNamespace}/${ref}`);
}

/* ---------------- Destinations ---------------- */

function buildDestinations(
  model: RoutingModel,
  vs: VirtualServiceResource,
  rule: RuleNode,
  route: HTTPRoute,
  services: ServiceResource[],
  drs: DestinationRuleResource[],
): void {
  if (route.redirect) {
    const r = route.redirect;
    const code = r.redirectCode ?? 301;
    const target = `${r.scheme ? r.scheme + "://" : ""}${r.authority ?? ""}${r.uri ?? ""}` || "(same)";
    const id = `${rule.id}/redirect`;
    const node: DestNode = {
      id, kind: "dest", type: "redirect",
      host: `HTTP ${code} → ${target}`,
      serviceFound: true, loc: rule.loc,
    };
    model.nodes.set(id, node);
    model.edges.push({ from: rule.id, to: id, kind: "routes" });
  }
  if (route.directResponse) {
    const id = `${rule.id}/direct`;
    const node: DestNode = {
      id, kind: "dest", type: "direct",
      host: `direct response ${route.directResponse.status ?? "?"}`,
      serviceFound: true, loc: rule.loc,
    };
    model.nodes.set(id, node);
    model.edges.push({ from: rule.id, to: id, kind: "routes" });
  }

  const dests = route.route ?? [];
  const multi = dests.length > 1;
  for (const rd of dests) {
    const d = rd.destination;
    if (!d?.host) continue;
    const fqdn = expandHost(d.host, vs.namespace);
    const { node, found } = ensureServiceDest(model, fqdn, d.port?.number, d.subset, services, drs, rd.loc);
    const weight = rd.weight ?? (multi ? 0 : 100);
    model.edges.push({
      from: rule.id, to: node.id, kind: "routes",
      label: multi || rd.weight !== undefined ? `${weight}%` : undefined,
      weight,
    });
    lintDestination(model, vs, rule, fqdn, d, rd.loc, node, found, services, drs);
  }

  const mirrors: { host: string; subset?: string; port?: number; pct?: number }[] = [];
  if (route.mirror?.host) {
    mirrors.push({
      host: route.mirror.host,
      subset: route.mirror.subset,
      port: route.mirror.port?.number,
      pct: route.mirrorPercentage?.value,
    });
  }
  for (const m of route.mirrors ?? []) {
    if (m.destination?.host) {
      mirrors.push({
        host: m.destination.host,
        subset: m.destination.subset,
        port: m.destination.port?.number,
        pct: m.percentage?.value,
      });
    }
  }
  for (const m of mirrors) {
    const fqdn = expandHost(m.host, vs.namespace);
    const { node, found } = ensureServiceDest(model, fqdn, m.port, m.subset, services, drs, rule.loc);
    model.edges.push({
      from: rule.id, to: node.id, kind: "mirrors",
      label: m.pct !== undefined ? `mirror ${m.pct}%` : "mirror",
    });
    lintDestination(
      model, vs, rule, fqdn,
      { host: m.host, subset: m.subset, port: { number: m.port } },
      rule.loc, node, found, services, drs,
    );
  }
}

function ensureServiceDest(
  model: RoutingModel,
  fqdn: string,
  port: number | undefined,
  subset: string | undefined,
  services: ServiceResource[],
  drs: DestinationRuleResource[],
  loc: { file: string; line: number } | undefined,
): { node: DestNode; found: ServiceResource | undefined } {
  const id = `dest:${fqdn}:${port ?? "-"}:${subset ?? "-"}`;
  const found = findService(services, fqdn);
  let node = model.nodes.get(id) as DestNode | undefined;
  if (!node) {
    const local = splitClusterLocal(fqdn);
    const dr = findDR(drs, fqdn);
    const subsetDef = subset ? dr?.subsets.find((s) => s.name === subset) : undefined;
    node = {
      id, kind: "dest",
      type: found ? "service" : "unknown",
      host: fqdn,
      shortHost: shortHost(fqdn),
      namespace: local?.namespace,
      port, subset,
      subsetLabels: subsetDef?.labels,
      serviceFound: Boolean(found),
      loc: found?.loc ?? loc,
    };
    model.nodes.set(id, node);
  }
  return { node, found };
}

function findService(services: ServiceResource[], fqdn: string): ServiceResource | undefined {
  const local = splitClusterLocal(fqdn);
  if (local) return services.find((s) => s.name === local.name && s.namespace === local.namespace);
  return undefined;
}

function findDR(drs: DestinationRuleResource[], fqdn: string): DestinationRuleResource | undefined {
  return drs.find((d) => expandHost(d.host, d.namespace) === fqdn);
}

function lintDestination(
  model: RoutingModel,
  vs: VirtualServiceResource,
  rule: RuleNode,
  fqdn: string,
  d: { host: string; subset?: string; port?: { number?: number } },
  loc: { file: string; line: number } | undefined,
  node: DestNode,
  svc: ServiceResource | undefined,
  services: ServiceResource[],
  drs: DestinationRuleResource[],
): void {
  const where = `${vs.namespace}/${vs.name} rule #${rule.index + 1}`;
  if (!svc) {
    pushUnique(model.findings, {
      id: "E002",
      severity: "error",
      message: `${where}: destination host "${d.host}" (${fqdn}) has no matching Service in the input set`,
      loc: loc ?? rule.loc,
      nodeIds: [node.id, rule.id],
    });
  } else {
    const portNum = d.port?.number;
    if (portNum !== undefined && !svc.ports.some((p) => p.port === portNum)) {
      pushUnique(model.findings, {
        id: "E003",
        severity: "error",
        message: `${where}: destination port ${portNum} is not exposed by Service ${svc.namespace}/${svc.name} (ports: ${svc.ports.map((p) => p.port).join(", ") || "none"})`,
        loc: loc ?? rule.loc,
        nodeIds: [node.id, rule.id],
      });
    } else if (portNum === undefined && svc.ports.length > 1) {
      pushUnique(model.findings, {
        id: "E003",
        severity: "error",
        message: `${where}: destination has no port but Service ${svc.namespace}/${svc.name} exposes ${svc.ports.length} ports — port is required`,
        loc: loc ?? rule.loc,
        nodeIds: [node.id, rule.id],
      });
    }
  }
  if (d.subset) {
    const dr = findDR(drs, fqdn);
    const def = dr?.subsets.find((s) => s.name === d.subset);
    if (!def) {
      pushUnique(model.findings, {
        id: "E004",
        severity: "error",
        message: `${where}: subset "${d.subset}" of host ${fqdn} is not defined in any DestinationRule`,
        loc: loc ?? rule.loc,
        nodeIds: [node.id, rule.id],
      });
    }
  }
}

/** Dedupe by (id, message); merges nodeIds so a deduped finding still marks every affected node. */
function pushUnique(findings: Finding[], f: Finding): void {
  const existing = findings.find((x) => x.id === f.id && x.message === f.message);
  if (existing) {
    for (const id of f.nodeIds) if (!existing.nodeIds.includes(id)) existing.nodeIds.push(id);
  } else {
    findings.push(f);
  }
}

/* ---------------- Match rendering ---------------- */

export function buildMatchBlocks(route: HTTPRoute): MatchBlock[] {
  return (route.match ?? []).map((m) => {
    const exprs: MatchExpr[] = [];
    const sm = (label: string, v: StringMatch | undefined, fmt?: (kind: string, val: string) => string) => {
      if (!v) return;
      const [kind, val] = stringMatchKind(v);
      if (kind === "presence") {
        exprs.push({ text: `${label} present`, regex: false });
      } else {
        const text = fmt ? fmt(kind, val) : `${label} ${kind} ${val}`;
        exprs.push({ text, regex: kind === "regex" });
      }
    };
    sm("URI", m.uri, (k, v) => `URI ${k} ${v}${m.ignoreUriCase ? " (case-insensitive)" : ""}`);
    sm("scheme", m.scheme);
    if (m.method) {
      const [, val] = stringMatchKind(m.method);
      exprs.push({ text: `method ${val}`, regex: false });
    }
    sm("authority", m.authority);
    for (const [h, v] of Object.entries(m.headers ?? {})) sm(`header ${h}`, v);
    for (const [h, v] of Object.entries(m.withoutHeaders ?? {})) {
      const [kind, val] = stringMatchKind(v);
      exprs.push({
        text: kind === "presence" ? `header ${h} absent` : `header ${h} not ${kind} ${val}`,
        regex: kind === "regex",
      });
    }
    for (const [q, v] of Object.entries(m.queryParams ?? {})) {
      const [kind, val] = stringMatchKind(v);
      exprs.push({
        text: kind === "presence" ? `?${q} present` : kind === "exact" ? `?${q}=${val}` : `?${q} ${kind} ${val}`,
        regex: kind === "regex",
      });
    }
    if (m.port !== undefined) exprs.push({ text: `port ${m.port}`, regex: false });
    for (const [k, v] of Object.entries(m.sourceLabels ?? {})) {
      exprs.push({ text: `sourceLabels ${k}=${v}`, regex: false });
    }
    if (m.gateways?.length) exprs.push({ text: `gateway ∈ {${m.gateways.join(", ")}}`, regex: false });
    return { exprs };
  });
}

function stringMatchKind(v: StringMatch): [string, string] {
  if (v.exact !== undefined) return ["exact", v.exact];
  if (v.prefix !== undefined) return ["prefix", v.prefix];
  if (v.regex !== undefined) return ["regex", v.regex];
  return ["presence", ""];
}

function isCatchAll(blocks: MatchBlock[]): boolean {
  if (blocks.length === 0) return true;
  return blocks.some(
    (b) =>
      b.exprs.length === 0 ||
      (b.exprs.length === 1 && (b.exprs[0]!.text === "URI prefix /" || b.exprs[0]!.text === "URI prefix / (case-insensitive)")),
  );
}

/* ---------------- Modifiers ---------------- */

function buildModifiers(route: HTTPRoute): Modifier[] {
  const mods: Modifier[] = [];
  if (route.redirect) {
    const r = route.redirect;
    mods.push({
      kind: "redirect",
      summary: `redirect ${r.redirectCode ?? 301}`,
      detail: `redirect → ${r.scheme ? r.scheme + "://" : ""}${r.authority ?? "(same host)"}${r.uri ?? ""} (HTTP ${r.redirectCode ?? 301})`,
    });
  }
  if (route.directResponse) {
    mods.push({
      kind: "directResponse",
      summary: `direct ${route.directResponse.status ?? "?"}`,
      detail: `direct response with status ${route.directResponse.status ?? "?"}`,
    });
  }
  if (route.rewrite) {
    const w = route.rewrite;
    const parts: string[] = [];
    if (w.uri) parts.push(`uri → ${w.uri}`);
    if (w.authority) parts.push(`authority → ${w.authority}`);
    if (w.uriRegexRewrite) parts.push(`uri regex ${w.uriRegexRewrite.match ?? ""} → ${w.uriRegexRewrite.rewrite ?? ""}`);
    mods.push({ kind: "rewrite", summary: `rewrite ${w.uri ?? w.authority ?? "regex"}`, detail: `rewrite: ${parts.join(", ")}` });
  }
  if (route.timeout) {
    mods.push({ kind: "timeout", summary: `timeout ${route.timeout}`, detail: `request timeout ${route.timeout}` });
  }
  if (route.retries) {
    const r = route.retries;
    const extra = [r.perTryTimeout && `perTryTimeout ${r.perTryTimeout}`, r.retryOn && `on ${r.retryOn}`]
      .filter(Boolean)
      .join(", ");
    mods.push({
      kind: "retries",
      summary: `retry ${r.attempts ?? 0}x`,
      detail: `retries: ${r.attempts ?? 0} attempts${extra ? ` (${extra})` : ""}`,
    });
  }
  if (route.fault) {
    const f = route.fault;
    const parts: string[] = [];
    if (f.delay) parts.push(`delay ${f.delay.fixedDelay ?? "?"} @ ${f.delay.percentage?.value ?? f.delay.percent ?? 100}%`);
    if (f.abort) parts.push(`abort ${f.abort.httpStatus ?? "?"} @ ${f.abort.percentage?.value ?? f.abort.percent ?? 100}%`);
    mods.push({ kind: "fault", summary: "fault", detail: `fault injection: ${parts.join("; ")}` });
  }
  if (route.mirror?.host || route.mirrors?.length) {
    const hosts = [route.mirror?.host, ...(route.mirrors ?? []).map((m) => m.destination?.host)].filter(Boolean);
    mods.push({ kind: "mirror", summary: "mirror", detail: `mirrors traffic to ${hosts.join(", ")}` });
  }
  if (route.headers) mods.push({ kind: "headers", summary: "headers", detail: "request/response header manipulation" });
  if (route.corsPolicy) mods.push({ kind: "cors", summary: "CORS", detail: "CORS policy attached" });
  return mods;
}

/* ---------------- Lints: shadowing & weights ---------------- */

function lintRuleShadowing(model: RoutingModel, vs: VirtualServiceResource, rules: RuleNode[]): void {
  for (let i = 0; i < rules.length; i++) {
    for (let j = 0; j < i; j++) {
      const earlier = rules[j]!;
      const later = rules[i]!;
      if (shadows(earlier, later)) {
        later.unreachable = true;
        model.findings.push({
          id: "W002",
          severity: "warn",
          message:
            `${vs.namespace}/${vs.name}: rule #${later.index + 1} is unreachable — ` +
            `rule #${earlier.index + 1} (${ruleLabel(earlier)}) matches a superset of its traffic first`,
          loc: later.loc,
          nodeIds: [later.id],
        });
        break;
      }
    }
  }
}

function ruleLabel(r: RuleNode): string {
  if (r.matchBlocks.length === 0) return "catch-all";
  return r.matchBlocks.map((b) => b.exprs.map((e) => e.text).join(" AND ") || "any").join(" OR ");
}

/** Conservative: true only when every request matching `later` provably matches `earlier` first. */
function shadows(earlier: RuleNode, later: RuleNode): boolean {
  const eMatches = earlier.raw.match ?? [{}]; // no match = one empty (catch-all) block
  const lMatches = later.raw.match ?? [{}];
  // every later block must be subsumed by some earlier block
  return lMatches.every((lb) => eMatches.some((eb) => blockSubsumes(eb, lb)));
}

type AnyMatch = NonNullable<HTTPRoute["match"]>[number];

function blockSubsumes(e: AnyMatch, l: AnyMatch): boolean {
  if (!smSubsumes(e.uri, l.uri)) return false;
  if (!smSubsumes(e.scheme, l.scheme)) return false;
  if (!smSubsumes(e.method, l.method)) return false;
  if (!smSubsumes(e.authority, l.authority)) return false;
  for (const [k, v] of Object.entries(e.headers ?? {})) {
    if (!smSubsumes(v, (l.headers ?? {})[k])) return false;
  }
  for (const [k, v] of Object.entries(e.queryParams ?? {})) {
    if (!smSubsumes(v, (l.queryParams ?? {})[k])) return false;
  }
  // any of these on the earlier rule makes subsumption unprovable unless identical
  if (Object.keys(e.withoutHeaders ?? {}).length > 0) return false;
  if (e.port !== undefined && e.port !== l.port) return false;
  if (Object.keys(e.sourceLabels ?? {}).length > 0) return false;
  if (e.gateways?.length) return false;
  return true;
}

/** Does earlier StringMatch `e` match everything later `l` matches? */
function smSubsumes(e: StringMatch | undefined, l: StringMatch | undefined): boolean {
  if (e === undefined) return true; // earlier unconstrained
  const [ek, ev] = stringMatchKind(e);
  if (ek === "presence") return l !== undefined; // presence subsumes any concrete match
  if (l === undefined) return false; // earlier constrained, later not
  const [lk, lv] = stringMatchKind(l);
  switch (ek) {
    case "exact":
      return lk === "exact" && lv === ev;
    case "prefix":
      return (lk === "exact" || lk === "prefix") && lv.startsWith(ev);
    case "regex":
      return lk === "regex" && lv === ev;
  }
  return false;
}

function lintWeights(model: RoutingModel, vs: VirtualServiceResource, rules: RuleNode[]): void {
  rules.forEach((rule) => {
    const dests = rule.raw.route ?? [];
    if (dests.length === 0) return;
    const explicit = dests.filter((d) => d.weight !== undefined);
    if (dests.length === 1 && explicit.length === 0) return;
    const sum = dests.reduce((acc, d) => acc + (d.weight ?? 0), 0);
    if (sum !== 100) {
      model.findings.push({
        id: "W003",
        severity: "warn",
        message: `${vs.namespace}/${vs.name} rule #${rule.index + 1}: destination weights sum to ${sum}, not 100`,
        loc: rule.loc,
        nodeIds: [rule.id],
      });
    }
  });
}

const SEV_ORDER: Record<string, number> = { error: 0, warn: 1, info: 2 };
function sortFindings(findings: Finding[]): void {
  findings.sort((a, b) => SEV_ORDER[a.severity]! - SEV_ORDER[b.severity]! || a.id.localeCompare(b.id));
}

/* ---------------- Display filters ---------------- */

export interface FilterOpts {
  gateway?: string;
  host?: string;
  namespace?: string;
  /** only show rules with a URI condition starting with this path prefix */
  uri?: string;
  /** only show rules routing (or mirroring) to a service whose name contains this string */
  service?: string;
}

/** Normalize a user-typed path prefix: "api" → "/api". */
export function normalizeUriPrefix(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return p.startsWith("/") ? p : "/" + p;
}

/** Does the rule declare a URI condition under the given path prefix? */
export function ruleMatchesUriPrefix(rule: RuleNode, prefix: string): boolean {
  for (const m of rule.raw.match ?? []) {
    if (!m.uri) continue;
    if (m.uri.exact?.startsWith(prefix) || m.uri.prefix?.startsWith(prefix)) return true;
    if (m.uri.regex?.includes(prefix)) return true;
  }
  return false;
}

/** Does the rule route or mirror to a service whose display name contains `needle`? */
export function ruleMatchesService(model: RoutingModel, rule: RuleNode, needle: string): boolean {
  const n = needle.toLowerCase();
  for (const e of model.edges) {
    if (e.from !== rule.id || (e.kind !== "routes" && e.kind !== "mirrors")) continue;
    const dest = model.nodes.get(e.to);
    if (dest?.kind !== "dest") continue;
    if ((dest.shortHost ?? dest.host).toLowerCase().includes(n)) return true;
  }
  return false;
}

/** Narrow the model's sections/bindings for --gateway/--host/--namespace/--uri/--service. */
export function filterModel(model: RoutingModel, opts: FilterOpts): RoutingModel {
  const uri = normalizeUriPrefix(opts.uri);
  const service = opts.service?.trim() || undefined;
  if (!opts.gateway && !opts.host && !opts.namespace && !uri && !service) return model;

  const ruleOk = (rid: string): boolean => {
    const rule = model.nodes.get(rid) as RuleNode;
    if (uri && !ruleMatchesUriPrefix(rule, uri)) return false;
    if (service && !ruleMatchesService(model, rule, service)) return false;
    return true;
  };

  const filterBindings = (bindings: HostBinding[]): HostBinding[] => {
    const kept = bindings.filter((b) => bindingMatch(b, opts));
    if (!uri && !service) return kept;
    return kept
      .map((b) => ({ ...b, ruleIds: b.ruleIds.filter(ruleOk) }))
      .filter((b) => b.ruleIds.length > 0);
  };

  const sections = model.sections
    .filter((s) => !opts.gateway || s.listener.gateway === opts.gateway)
    .map((s) => ({ listener: s.listener, bindings: filterBindings(s.bindings) }))
    .filter((s) => s.bindings.length > 0 || (!opts.host && !uri && !service));
  const mesh = {
    bindings: opts.gateway ? [] : filterBindings(model.mesh.bindings),
  };
  return { ...model, sections, mesh };
}

function bindingMatch(b: HostBinding, opts: FilterOpts): boolean {
  if (opts.namespace && b.hostNode.vsNamespace !== opts.namespace) return false;
  if (opts.host && !b.hostNode.hosts.some((h) => hostMatches(opts.host!, h) || hostMatches(h, opts.host!))) return false;
  return true;
}

export { type GraphNode, type GraphEdge };
