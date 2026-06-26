/**
 * Trace evaluator: simulates Envoy's routing decision for a synthetic
 * request — listener selection by port/host, host binding selection, then
 * first-match-wins rule walk with an explanation for every skipped rule.
 */
import { hostMatches } from "./hosts.js";
import type {
  HTTPMatchRequest,
  HostBinding,
  RoutingModel,
  RuleNode,
  StringMatch,
  TraceRequest,
  TraceResult,
  TraceStep,
} from "./types.js";

export function trace(model: RoutingModel, req: TraceRequest): TraceResult {
  const result: TraceResult = {
    request: req,
    steps: [],
    destIds: [],
    outcome: "",
  };

  // 1. Listener selection: port (if given) + host pattern intersection.
  let candidates = model.sections.filter((s) =>
    s.listener.hosts.some((h) => hostMatches(h, req.host)),
  );
  if (req.port !== undefined) {
    candidates = candidates.filter((s) => s.listener.port === req.port);
  }
  let bindings: HostBinding[];
  if (candidates.length > 0) {
    // prefer a listener that actually has a binding for this host
    const withBinding = candidates.find((s) => s.bindings.some((b) => bindingServes(b, req.host)));
    const section = withBinding ?? candidates[0]!;
    result.listenerId = section.listener.id;
    bindings = section.bindings.filter((b) => bindingServes(b, req.host));
    if (bindings.length === 0) {
      result.outcome = `listener ${section.listener.gateway}:${section.listener.port} accepts host ${req.host}, but no VirtualService binds that host there → 404`;
      return result;
    }
  } else {
    // fall back to mesh routing
    bindings = model.mesh.bindings.filter((b) => bindingServes(b, req.host));
    if (bindings.length === 0) {
      result.outcome =
        req.port !== undefined
          ? `no gateway listener on port ${req.port} accepts host ${req.host}, and no mesh route matches → connection refused / 404`
          : `no gateway listener or mesh route accepts host ${req.host} → 404`;
      return result;
    }
  }

  // 2. Walk the merged rule table in order, first-match-wins.
  //    Istio concatenates the http routes of every VirtualService that binds
  //    the same host on the same gateway (or in the mesh) into one ordered
  //    table; a request that no rule of the first VS matches falls through to
  //    the next VS's rules, not straight to 404. W004 flags that the order
  //    *between* VirtualServices is not deterministic offline.
  result.hostNodeId = bindings[0]!.hostNode.id;
  let winnerBinding: HostBinding | undefined;

  outer: for (const binding of bindings) {
    for (const ruleId of binding.ruleIds) {
      const rule = model.nodes.get(ruleId) as RuleNode;
      const step = evaluateRule(rule, req);
      result.steps.push(step);
      if (step.matched) {
        result.winner = step;
        winnerBinding = binding;
        break outer;
      }
    }
  }
  if (winnerBinding) result.hostNodeId = winnerBinding.hostNode.id;

  if (result.winner) {
    const rule = model.nodes.get(result.winner.ruleId) as RuleNode;
    result.destIds = model.edges
      .filter((e) => e.from === rule.id && e.kind === "routes")
      .map((e) => e.to);
    const destDesc = result.destIds
      .map((id) => {
        const n = model.nodes.get(id);
        if (n?.kind !== "dest") return id;
        const edge = model.edges.find((e) => e.from === rule.id && e.to === id && e.kind === "routes");
        const w = edge?.label ? ` (${edge.label})` : "";
        return `${n.shortHost ?? n.host}${n.port ? ":" + n.port : ""}${n.subset ? " subset " + n.subset : ""}${w}`;
      })
      .join(", ");
    result.outcome = `rule #${rule.index + 1} of ${rule.vsNamespace}/${rule.vsName} matches → ${destDesc || "(no destination)"}`;
  } else {
    const vsList = [...new Set(bindings.map((b) => `${b.hostNode.vsNamespace}/${b.hostNode.vsName}`))];
    const where =
      vsList.length === 1 ? vsList[0] : `any of ${vsList.length} VirtualServices on this host (${vsList.join(", ")})`;
    result.outcome = `no rule matched in ${where} → 404`;
  }
  return result;
}

function bindingServes(b: HostBinding, host: string): boolean {
  return b.hostNode.hosts.some((h) => hostMatches(h, host));
}

function evaluateRule(rule: RuleNode, req: TraceRequest): TraceStep {
  const step: TraceStep = {
    ruleId: rule.id,
    vsName: rule.vsName,
    index: rule.index,
    matched: false,
    reasons: [],
  };
  const matches = rule.raw.match ?? [];
  if (matches.length === 0) {
    step.matched = true;
    step.reasons.push("no match conditions (catch-all)");
    return step;
  }
  matches.forEach((m, i) => {
    const fail = evaluateBlock(m, req);
    const blockTag = matches.length > 1 ? `match block ${i + 1}: ` : "";
    if (fail === null) {
      step.matched = true;
      step.reasons.push(`${blockTag}matched`);
    } else {
      step.reasons.push(`${blockTag}${fail}`);
    }
  });
  if (step.matched) {
    // keep only the matching block's reason first for readability
    step.reasons = step.reasons.filter((r) => r.endsWith("matched")).concat(
      step.reasons.filter((r) => !r.endsWith("matched")),
    );
  }
  return step;
}

/** Returns null when the block matches, else a human explanation of the first failing condition. */
function evaluateBlock(m: HTTPMatchRequest, req: TraceRequest): string | null {
  if (m.uri) {
    const fail = matchString(m.uri, req.path, m.ignoreUriCase);
    if (fail) return `URI ${req.path} does not match ${describe(m.uri)}`;
  }
  if (m.method) {
    const fail = matchString(m.method, req.method);
    if (fail) return `method ${req.method} does not match ${describe(m.method)}`;
  }
  if (m.authority) {
    const fail = matchString(m.authority, req.host);
    if (fail) return `authority ${req.host} does not match ${describe(m.authority)}`;
  }
  if (m.scheme) {
    const scheme = req.port === 80 ? "http" : "https";
    const fail = matchString(m.scheme, scheme);
    if (fail) return `scheme ${scheme} does not match ${describe(m.scheme)}`;
  }
  for (const [name, sm] of Object.entries(m.headers ?? {})) {
    const val = headerValue(req.headers, name);
    if (val === undefined) return `header ${name} is not present`;
    const fail = matchString(sm, val);
    if (fail) return `header ${name}="${val}" does not match ${describe(sm)}`;
  }
  for (const [name, sm] of Object.entries(m.withoutHeaders ?? {})) {
    const val = headerValue(req.headers, name);
    if (val !== undefined && matchString(sm, val) === null) {
      return `header ${name}="${val}" matches excluded ${describe(sm)}`;
    }
  }
  if (m.queryParams && Object.keys(m.queryParams).length > 0) {
    const qIdx = req.path.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? req.path.slice(qIdx + 1) : "");
    for (const [name, sm] of Object.entries(m.queryParams)) {
      const val = params.get(name);
      if (val === null) return `query param ${name} is not present`;
      const fail = matchString(sm, val);
      if (fail) return `query param ${name}="${val}" does not match ${describe(sm)}`;
    }
  }
  if (m.port !== undefined && req.port !== undefined && m.port !== req.port) {
    return `port ${req.port} does not match ${m.port}`;
  }
  if (m.sourceLabels && Object.keys(m.sourceLabels).length > 0) {
    return `sourceLabels conditions cannot be evaluated for a synthetic edge request (assumed non-matching)`;
  }
  return null;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Returns null on match, "fail" otherwise. */
function matchString(sm: StringMatch, value: string, ignoreCase?: boolean): "fail" | null {
  const v = ignoreCase ? value.toLowerCase() : value;
  if (sm.exact !== undefined) {
    const e = ignoreCase ? sm.exact.toLowerCase() : sm.exact;
    return v === e ? null : "fail";
  }
  if (sm.prefix !== undefined) {
    const p = ignoreCase ? sm.prefix.toLowerCase() : sm.prefix;
    return v.startsWith(p) ? null : "fail";
  }
  if (sm.regex !== undefined) {
    try {
      // Envoy RE2 path matches are anchored full-string matches.
      return new RegExp(`^(?:${sm.regex})$`).test(value) ? null : "fail";
    } catch {
      return "fail";
    }
  }
  return null; // presence-only match ({}): any value matches
}

function describe(sm: StringMatch): string {
  if (sm.exact !== undefined) return `exact "${sm.exact}"`;
  if (sm.prefix !== undefined) return `prefix "${sm.prefix}"`;
  if (sm.regex !== undefined) return `regex "${sm.regex}"`;
  return "presence";
}
