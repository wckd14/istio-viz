/**
 * Istio host pattern semantics.
 *
 * A host pattern is either an FQDN-ish exact host ("shop.example.com"),
 * a wildcard-prefix pattern ("*.example.com"), or "*" (all hosts).
 * Gateway server hosts may carry a namespace qualifier ("ns/host",
 * "./host", or a star qualifier) restricting which VirtualService
 * namespaces may bind.
 */

export interface GatewayHost {
  /** undefined = any namespace ("*" or no qualifier), "." resolved by caller. */
  namespace?: string;
  host: string;
}

export function parseGatewayHost(raw: string, gatewayNamespace: string): GatewayHost {
  const idx = raw.indexOf("/");
  if (idx === -1) return { host: raw };
  const ns = raw.slice(0, idx);
  const host = raw.slice(idx + 1);
  if (ns === "*") return { host };
  if (ns === ".") return { namespace: gatewayNamespace, host };
  return { namespace: ns, host };
}

/** Does pattern (possibly wildcard) match the concrete host name? */
export function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    if (host.startsWith("*.")) {
      // wildcard request host: matches if its suffix is within pattern suffix
      return host.slice(1).endsWith(suffix) || host.slice(1) === suffix;
    }
    return host.length > suffix.length && host.toLowerCase().endsWith(suffix.toLowerCase());
  }
  return pattern.toLowerCase() === host.toLowerCase();
}

/**
 * Intersection of two host patterns, or null when empty.
 * Returns the narrower pattern (the set intersection expressed as a pattern).
 */
export function intersectPattern(a: string, b: string): string | null {
  if (a === "*") return b;
  if (b === "*") return a;
  const aw = a.startsWith("*.");
  const bw = b.startsWith("*.");
  if (aw && bw) {
    const as = a.slice(1).toLowerCase(); // ".example.com"
    const bs = b.slice(1).toLowerCase();
    if (as.endsWith(bs)) return a;
    if (bs.endsWith(as)) return b;
    return null;
  }
  if (aw) return hostMatches(a, b) ? b : null;
  if (bw) return hostMatches(b, a) ? a : null;
  return a.toLowerCase() === b.toLowerCase() ? a : null;
}

/** Intersection of two pattern lists (deduped, order preserved by first list). */
export function intersectHosts(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const pa of a) {
    for (const pb of b) {
      const r = intersectPattern(pa, pb);
      if (r !== null && !out.includes(r)) out.push(r);
    }
  }
  return out;
}

/** Expand a short destination host to FQDN using the resource's namespace. */
export function expandHost(host: string, namespace: string): string {
  if (host === "*" || host.startsWith("*.")) return host;
  if (host.includes(".")) return host;
  return `${host}.${namespace}.svc.cluster.local`;
}

/** Shorten an FQDN service host to "name.ns" for display. */
export function shortHost(fqdn: string): string {
  const m = /^([^.]+)\.([^.]+)\.svc\.cluster\.local$/.exec(fqdn);
  return m ? `${m[1]}.${m[2]}` : fqdn;
}

/** Split an FQDN cluster-local host into {name, namespace}, or null. */
export function splitClusterLocal(fqdn: string): { name: string; namespace: string } | null {
  const m = /^([^.]+)\.([^.]+)\.svc\.cluster\.local$/.exec(fqdn);
  return m ? { name: m[1]!, namespace: m[2]! } : null;
}
