/** Terminal-friendly tree renderer (also the CI-friendly format). */
import type {
  DestNode,
  Finding,
  HostBinding,
  RoutingModel,
  RuleNode,
  TraceResult,
} from "../types.js";

const SEV_MARK: Record<string, string> = { error: "✖", warn: "⚠", info: "ℹ" };

export function renderText(model: RoutingModel, opts: { color?: boolean } = {}): string {
  const out: string[] = [];
  const c = colors(opts.color ?? false);

  for (const section of model.sections) {
    const l = section.listener;
    const tls = l.tlsMode ? `, ${l.tlsMode} TLS` : "";
    out.push(c.bold(`gateway ${l.namespace}/${l.gateway} :${l.port} (${l.protocol}${tls})  hosts: ${l.hosts.join(", ")}`));
    if (section.bindings.length === 0) {
      out.push("└─ (no VirtualService binds here)");
    }
    section.bindings.forEach((b, bi) => {
      renderBinding(out, model, b, bi === section.bindings.length - 1, c);
    });
    out.push("");
  }

  if (model.mesh.bindings.length > 0) {
    out.push(c.bold("mesh routing (no gateway)"));
    model.mesh.bindings.forEach((b, bi) => {
      renderBinding(out, model, b, bi === model.mesh.bindings.length - 1, c);
    });
    out.push("");
  }

  if (model.l4Notes.length > 0) {
    out.push("L4 (not diagrammed):");
    for (const n of model.l4Notes) out.push(`  • ${n}`);
    out.push("");
  }

  if (model.findings.length > 0) {
    out.push(c.bold("findings:"));
    for (const f of model.findings) out.push("  " + formatFinding(f, c));
  } else {
    out.push("findings: none");
  }
  return out.join("\n") + "\n";
}

export function formatFinding(f: Finding, c = colors(false)): string {
  const mark = SEV_MARK[f.severity] ?? "•";
  const loc = f.loc ? `  (${f.loc.file}:${f.loc.line})` : "";
  const line = `${mark} ${f.id} ${f.message}${loc}`;
  return f.severity === "error" ? c.red(line) : f.severity === "warn" ? c.yellow(line) : c.dim(line);
}

function renderBinding(
  out: string[],
  model: RoutingModel,
  b: HostBinding,
  last: boolean,
  c: ReturnType<typeof colors>,
): void {
  const branch = last ? "└─" : "├─";
  const cont = last ? "   " : "│  ";
  out.push(`${branch} ${b.hostNode.hosts.join(", ")}  [vs: ${b.hostNode.vsName}, ns: ${b.hostNode.vsNamespace}]`);
  const findingsByNode = indexFindings(model);
  b.ruleIds.forEach((rid, ri) => {
    const rule = model.nodes.get(rid) as RuleNode;
    const rbranch = ri === b.ruleIds.length - 1 ? "└─" : "├─";
    const marks = (findingsByNode.get(rid) ?? [])
      .map((f) => `${SEV_MARK[f.severity]} ${f.id}`)
      .join(" ");
    let line = `${cont}${rbranch} #${rule.index + 1}  ${matchSummary(rule)}  → ${destSummary(model, rule)}`;
    const mods = rule.modifiers.filter((m) => m.kind !== "redirect" && m.kind !== "directResponse");
    if (mods.length > 0) line += `   [${mods.map((m) => m.summary).join(", ")}]`;
    if (marks) line += `   ${marks}`;
    if (rule.unreachable) line = c.dim(line + "   (unreachable)");
    out.push(line);
  });
}

function indexFindings(model: RoutingModel): Map<string, Finding[]> {
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

export function matchSummary(rule: RuleNode): string {
  if (rule.matchBlocks.length === 0) return "(catch-all)";
  return rule.matchBlocks
    .map((b) => (b.exprs.length === 0 ? "any" : b.exprs.map((e) => e.text).join(" AND ")))
    .join("  OR  ");
}

export function destSummary(model: RoutingModel, rule: RuleNode): string {
  const edges = model.edges.filter((e) => e.from === rule.id);
  const parts: string[] = [];
  for (const e of edges) {
    const n = model.nodes.get(e.to) as DestNode | undefined;
    if (!n) continue;
    if (n.type === "redirect" || n.type === "direct") {
      parts.push(n.host);
      continue;
    }
    let p = `${n.shortHost ?? n.host}${n.port ? ":" + n.port : ""}`;
    if (n.subset) p += ` (${n.subset})`;
    if (e.kind === "mirrors") p = `🪞 ${p}`;
    if (e.label && e.kind === "routes") p += ` ${e.label}`;
    parts.push(p);
  }
  return parts.join(" / ") || "(no destination)";
}

/* ---------------- trace text output ---------------- */

export function renderTraceText(model: RoutingModel, result: TraceResult): string {
  const out: string[] = [];
  const req = result.request;
  out.push(`trace: ${req.method} ${req.path}  host=${req.host}${req.port ? ` port=${req.port}` : ""}`);
  for (const [k, v] of Object.entries(req.headers)) out.push(`       header ${k}: ${v}`);
  out.push("");
  if (result.listenerId) {
    const l = model.nodes.get(result.listenerId);
    if (l?.kind === "listener") {
      out.push(`listener: gateway ${l.namespace}/${l.gateway} :${l.port} (${l.protocol})`);
    }
  } else if (result.hostNodeId) {
    out.push("listener: (mesh routing — no gateway)");
  }
  if (result.hostNodeId) {
    const h = model.nodes.get(result.hostNodeId);
    if (h?.kind === "host") {
      out.push(`host:     ${h.hosts.join(", ")}  [vs: ${h.vsName}, ns: ${h.vsNamespace}]`);
    }
    out.push("");
  }
  const multiVs = new Set(result.steps.map((s) => s.vsName)).size > 1;
  const ruleLabel = (s: TraceResult["steps"][number]) =>
    multiVs ? `${s.vsName} rule #${s.index + 1}` : `rule #${s.index + 1}`;
  for (const step of result.steps) {
    if (step.matched) {
      out.push(`✔ ${ruleLabel(step)} MATCHED (${step.reasons[0]})`);
    } else {
      for (const r of step.reasons) {
        out.push(`✘ ${ruleLabel(step)} skipped: ${r}`);
      }
    }
  }
  out.push("");
  out.push(`result: ${result.outcome}`);
  return out.join("\n") + "\n";
}

function colors(enabled: boolean) {
  const wrap = (code: string) => (s: string) => (enabled ? `[${code}m${s}[0m` : s);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    yellow: wrap("33"),
  };
}
