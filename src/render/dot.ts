/** Graphviz DOT emitter. */
import type { DestNode, RoutingModel, RuleNode } from "../types.js";
import { matchSummary } from "./text.js";

export function renderDot(model: RoutingModel): string {
  const out: string[] = [];
  out.push("digraph istio_routes {");
  out.push("  rankdir=LR;");
  out.push('  node [shape=box, fontname="Helvetica", fontsize=10];');
  out.push('  edge [fontname="Helvetica", fontsize=9];');
  out.push(`  client [label="Client", shape=oval];`);

  const emitted = new Set<string>();
  let clusterIdx = 0;

  const emitDest = (id: string) => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const n = model.nodes.get(id) as DestNode;
    let label: string;
    let attrs = "";
    if (n.type === "redirect" || n.type === "direct") {
      label = n.host;
      attrs = ", shape=note";
    } else {
      label = `${n.shortHost ?? n.host}${n.port ? ":" + n.port : ""}${n.subset ? `\\nsubset ${n.subset}` : ""}`;
      if (!n.serviceFound) attrs = ", color=red, fontcolor=red";
    }
    out.push(`  ${q(id)} [label="${esc(label)}"${attrs}];`);
  };

  for (const section of model.sections) {
    const l = section.listener;
    out.push(`  subgraph cluster_${clusterIdx++} {`);
    out.push(`    label="gateway ${esc(l.namespace + "/" + l.gateway)} :${l.port} ${esc(l.protocol)}";`);
    out.push(`    ${q(l.id)} [label="${esc(`:${l.port} ${l.protocol}${l.tlsMode ? " " + l.tlsMode : ""}\\n${l.hosts.join(", ")}`)}", shape=component];`);
    for (const b of section.bindings) {
      out.push(`    ${q(b.hostNode.id)} [label="${esc(b.hostNode.hosts.join("\\n"))}", shape=cds];`);
      for (const rid of b.ruleIds) emitRule(out, model, rid);
    }
    out.push("  }");
    out.push(`  client -> ${q(l.id)};`);
  }

  if (model.mesh.bindings.length > 0) {
    out.push(`  subgraph cluster_${clusterIdx++} {`);
    out.push('    label="mesh routing";');
    for (const b of model.mesh.bindings) {
      out.push(`    ${q(b.hostNode.id)} [label="${esc(b.hostNode.hosts.join("\\n"))}", shape=cds];`);
      for (const rid of b.ruleIds) emitRule(out, model, rid);
    }
    out.push("  }");
  }

  for (const e of model.edges) {
    if (!model.nodes.has(e.from) || !model.nodes.has(e.to)) continue;
    const to = model.nodes.get(e.to)!;
    if (to.kind === "dest") emitDest(e.to);
    const attrs: string[] = [];
    if (e.label) attrs.push(`label="${esc(e.label)}"`);
    if (e.kind === "mirrors") attrs.push("style=dashed");
    out.push(`  ${q(e.from)} -> ${q(e.to)}${attrs.length ? ` [${attrs.join(", ")}]` : ""};`);
  }

  out.push("}");
  return out.join("\n") + "\n";

  function emitRule(lines: string[], m: RoutingModel, rid: string): void {
    if (emitted.has(rid)) return;
    emitted.add(rid);
    const r = m.nodes.get(rid) as RuleNode;
    const mods = r.modifiers.map((mo) => mo.summary).join(", ");
    const label = `#${r.index + 1} ${matchSummary(r)}${mods ? `\\n[${mods}]` : ""}`;
    const style = r.unreachable ? ", style=dashed, color=orange" : "";
    lines.push(`    ${q(rid)} [label="${esc(label)}"${style}];`);
  }
}

function q(id: string): string {
  return `"${id.replace(/"/g, '\\"')}"`;
}

function esc(s: string): string {
  return s.replace(/"/g, '\\"');
}
