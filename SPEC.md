# Spec: Istio L7 Routing Visualizer

## 1. Overview

A command-line tool that ingests Istio and Kubernetes manifests (Gateway, VirtualService, Service, and optionally DestinationRule) and produces a visual representation of the effective Layer 7 routing topology. The primary goal is comprehension: given a set of manifests, a user should be able to see, at a glance, how an incoming request flows from the edge to a backend workload, which match rules apply, in what order they are evaluated, and where traffic is split, redirected, rewritten, or dropped.

The tool is read-only. It can operate either fully offline on manifest files, or against a live Kubernetes cluster via `kubectl` (no direct API server connection; all cluster I/O goes through the user's existing kubeconfig and kubectl binary).

## 2. Problem Statement

Istio routing behavior is distributed across multiple resources that reference each other by name and host:

- A Gateway declares listeners (port, protocol, hosts, TLS mode).
- One or more VirtualServices bind to that Gateway via the `gateways` field and a host intersection.
- Each VirtualService contains an *ordered* list of HTTP routes, each with match conditions (URI, headers, method, query params, port, sourceLabels), and each route forwards to one or more destinations with weights, rewrites, redirects, retries, timeouts, fault injection, and mirroring.
- Destinations reference Kubernetes Services (and optionally DestinationRule subsets).

Reading this as YAML requires mentally joining four resource types and simulating Envoy's first-match-wins evaluation. The visualizer does that join and simulation, and renders the result.

## 3. Goals and Non-Goals

### Goals (v1)

1. Parse a set of YAML manifests and build a routing model.
2. Render the model as a left-to-right flow diagram: **Client → Gateway listener → Host → VirtualService → ordered match rules → Destination (Service / subset, weight)**.
3. Make L7 match semantics explicit and readable: exact vs prefix vs regex URI matches, header/method/query conditions, and rule evaluation order.
4. Surface route *modifiers* on the edge where they apply: weight splits, rewrites, redirects, timeouts, retries, fault injection, mirrors.
5. Detect and visually flag common problems (see §7): unbound VirtualServices, dangling Service references, unreachable rules shadowed by earlier matches, host mismatches between Gateway and VirtualService, port mismatches.
6. Support a "trace" mode: given a synthetic request (host + path + method + headers), highlight the exact path it would take through the graph.

### Non-Goals (v1)

- mTLS / PeerAuthentication / AuthorizationPolicy visualization (security layer, not routing).
- EnvoyFilter, ServiceEntry, Sidecar resources.
- TCP/TLS route blocks in VirtualServices (L4); the tool may list them but does not diagram them.
- Envoy config dumps or actual live traffic data.
- Multi-cluster / east-west gateway topologies.

## 4. Inputs

The tool accepts one or more file paths or directories containing YAML (multi-document files supported):

```
istio-viz render ./manifests/ -o routes.html
istio-viz render gateway.yaml vs.yaml svc.yaml --format svg
istio-viz trace ./manifests/ --host shop.example.com --path /api/v2/cart --method POST
```

Recognized resource kinds:

| Kind | apiVersion | Required | Role in model |
|---|---|---|---|
| Gateway | networking.istio.io/v1* | yes (for ingress view) | Entry points: ports, protocols, hosts, TLS |
| VirtualService | networking.istio.io/v1* | yes | L7 routing rules — the core of the diagram |
| Service | v1 | yes | Route targets; validates host/port references |
| DestinationRule | networking.istio.io/v1* | optional | Subset definitions (labels), LB/TLS policy per subset |

Unrecognized kinds are ignored with a warning. Both `v1alpha3`, `v1beta1`, and `v1` API versions must be accepted.

### 4.1 Kustomize overlays

If an input path is a directory containing a `kustomization.yaml` / `kustomization.yml` / `Kustomization` file (or is such a file itself), the tool does not walk it for raw YAML. Instead it renders the overlay with `kustomize build <dir>` (falling back to `kubectl kustomize <dir>` when the standalone binary is absent) and ingests the generated multi-document output:

```
istio-viz render ./overlays/prod -o routes.html
istio-viz trace  ./overlays/prod --host shop.example.com --path /api/v2/cart
```

The build output typically contains many non-network kinds (Deployment, ConfigMap, PVC, ...); these are filtered out silently — the "unrecognized kind" warning is suppressed for kustomize-generated input, and only the four recognized kinds enter the model. Source locations for findings refer to the generated stream (`<dir> (kustomize build):line`), since kustomize does not preserve origin file positions. A failed kustomize build is a fatal CLI error with kustomize's stderr passed through. Kustomize detection applies to the given path only, not to subdirectories discovered while walking a plain directory.

Namespace handling: short destination hosts (e.g. `reviews`) are expanded to FQDN form (`reviews.<namespace>.svc.cluster.local`) using the resource's own namespace, mirroring Istio's resolution rules. Mesh-internal VirtualServices (`gateways: [mesh]` or unset) are rendered in a separate "mesh routing" section rather than under a Gateway.

### 4.2 Live cluster source

When the `--cluster` flag is present, the tool fetches resources from the active Kubernetes cluster instead of (or in addition to) local files. All cluster I/O is delegated to the `kubectl` binary already expected to be on the PATH.

#### Invocation

```
istio-viz render --cluster [-o routes.html]
istio-viz render --cluster --context prod-ctx --namespace istio-system -o routes.html
istio-viz trace  --cluster --host shop.example.com --path /api/v2/cart
istio-viz watch  --cluster [--poll-interval N]
```

`--cluster` may be combined with file or directory arguments. Files are loaded first; cluster resources are merged in afterward. When the same resource (same kind + namespace + name) appears in both a file and the cluster, the **file wins** — allowing users to preview local changes against live state.

#### Fetch strategy

The tool issues a single `kubectl get` call per resource group to minimise API-server round-trips:

```
kubectl get gateway,virtualservice,service,destinationrule \
  --all-namespaces \          # or -n NAMESPACE if --namespace is set
  --output yaml \
  [--context CONTEXT] \
  [--kubeconfig KUBECONFIG]
```

The resulting YAML `List` is fed into the existing multi-document parser unchanged. No custom k8s client library is required.

#### Flags

| Flag | Default | Description |
|---|---|---|
| `--cluster` | off | Enable live cluster source |
| `--context CTX` | current-context | kubeconfig context to use |
| `--namespace NS` | all namespaces | Restrict fetch to one namespace |
| `--kubeconfig PATH` | `KUBECONFIG` env / `~/.kube/config` | Path to kubeconfig file |
| `--poll-interval N` | 30 | Seconds between re-fetches in `watch` mode |

#### Source locations

Instead of `file:line`, findings and panel detail rows show:

```
cluster://<context>/<namespace>/<Kind>/<name>
```

e.g. `cluster://prod-ctx/istio-system/VirtualService/shop-routes`

#### RBAC requirements

The caller must have `get`/`list` on `gateways`, `virtualservices`, `destinationrules` (networking.istio.io) and `services` (core) in the target namespaces. The tool makes no write calls.

#### Error handling

- `kubectl` not on PATH → fatal error with remediation hint.
- Cluster unreachable / context not found → fatal error, stderr from kubectl passed through.
- Partial fetch failure (e.g. CRD not installed, no VirtualServices exist) → warning; tool continues with whatever was returned. An empty model produces a clear "no resources found" message rather than a blank diagram.

## 5. Routing Model (internal representation)

The parser produces a directed graph with typed nodes and edges:

**Nodes**

- `GatewayListener` — gateway name, port number/name, protocol, TLS mode, host patterns.
- `Host` — the effective host(s) a VirtualService serves on a listener (intersection of Gateway hosts and VS hosts, with wildcard semantics).
- `RouteRule` — one entry in `spec.http[]`, carrying its index (evaluation order), its full match conditions, and its modifiers (rewrite, redirect, timeout, retries, fault, mirror, headers manipulation, CORS).
- `Destination` — resolved Service + port + optional subset.
- `Service` / `Subset` — backing K8s service and DR subset with its labels.

**Edges**

- Listener → Host: "accepts"
- Host → RouteRule: "evaluates (order n)"
- RouteRule → Destination: "routes (weight w%)"
- RouteRule → terminal nodes for `redirect` (HTTP 301/302 with target) and `directResponse`.
- RouteRule ⇢ Destination (dashed): "mirrors to"

A `RouteRule` with multiple `match` blocks is OR semantics; conditions inside one match block are AND. The model preserves this structure so the renderer can show it correctly (e.g. "prefix /api **AND** header x-canary=true, **OR** exact /healthz").

Wildcard host matching (`*.example.com`) must follow Istio semantics when computing Gateway↔VS bindings.

## 6. Output / Visualization

### 6.1 Primary output: self-contained HTML

A single static HTML file (no server) with an embedded interactive diagram. Layout is a layered left-to-right DAG:

```
[Client] → [gateway: ingress :443 HTTPS] → [shop.example.com] → ┌ rule 1: GET /api/v2/* ──→ api-svc:8080 (v2, 90%)
                                                                │                        └→ api-svc:8080 (v1, 10%)
                                                                ├ rule 2: hdr x-debug ───→ debug-svc:8080
                                                                └ rule 3: /* (fallback) ─→ web-svc:80
```

Rendering requirements:

- Rule nodes are numbered and vertically ordered by evaluation precedence; the first-match-wins semantics must be visually obvious (e.g. numbered badges, top-to-bottom order, a "falls through to" visual cue).
- Match conditions rendered as compact, human-readable expressions: `URI prefix /api/v2`, `method ∈ {GET, POST}`, `header end-user exact jason`, `?version=beta`. Regex matches flagged with a distinct style.
- Weighted splits drawn as fan-out edges labeled with percentages; weights that don't sum to 100 flagged.
- Modifiers shown as small badges/icons on the rule node (↻ retry, ⏱ timeout, ✂ rewrite, ⤳ redirect, 🪞 mirror, ⚡ fault), with full detail in a hover/click side panel showing the originating YAML fragment and source file/line.
- Hovering a node highlights its full upstream/downstream path.
- Filters: by gateway, by host, by namespace, by URL path prefix (shows only rules declaring a URI condition under the typed prefix), and by service name (substring match on destination services, also available as `--service` on the CLI); non-matching nodes are dimmed. Toggle to collapse healthy detail and show only warnings.

### 6.2 Secondary outputs

- `--format svg` / `--format png`: static export of the same diagram.
- `--format dot`: Graphviz source, for users who want their own pipeline.
- `--format text`: a terminal-friendly tree (useful in CI), e.g.:

```
gateway ingressgateway :443 (HTTPS, SIMPLE TLS)
└─ shop.example.com  [vs: shop-routes, ns: prod]
   ├─ #1  GET|POST  prefix /api/v2  → api.prod:8080  v2 90% / v1 10%   [retry 3x, timeout 5s]
   ├─ #2  header x-debug: exact "1" → debug.prod:8080                  ⚠ service not found
   └─ #3  prefix /                  → web.prod:80
```

### 6.3 Network paths view

Besides the object diagram, the HTML report offers a second view (header toggle "diagram | paths") that abstracts away the Istio objects entirely and shows pure **host → match → service** paths, grouped per unique host name. All VirtualServices contributing routes to the same host are consolidated into one group; the listeners serving the host are listed once per group ("via ns/gateway:port", or "mesh"). The view renders both as a per-host **diagram** (three columns: host → match → service, default) and as a compact **table**, switchable in place. Both reuse the detail side panel (click a match or service node/row) and honor the gateway/namespace/host/path/service filters. Hovering shows which VirtualService(s) an entry came from.

The same view is available as a plain-text export designed for manual diffing:

```
istio-viz render <paths...> --format paths -o network-paths.txt
```

The output is canonical and implementation-independent: hosts sorted alphabetically, one line per (match → destinations) entry sorted by match string, destinations weight-sorted, modifiers sorted, duplicates merged, no timestamps and no alignment padding. Two manifest sets that express the same effective routing — regardless of how rules are distributed across VirtualServices or Gateways — produce byte-identical files, so `diff old.txt new.txt` shows only real routing changes. Canonical notation: `prefix` matches end in `*` (`/api*`, `/*`), `exact` matches are bare paths, regex matches are prefixed `~`, catch-all is `*`; non-URI conditions appear sorted in `{...}`; weighted destinations carry `=NN%`; unresolvable services carry `!missing`; redirects render as `redirect:<code>:<target>`.

### 6.4 Trace mode

`istio-viz trace` takes a synthetic request and evaluates the model exactly as Envoy would: select listener by port/SNI, select host, walk rules in order, stop at first match. Output highlights the winning path in the diagram (HTML) or prints the decision steps (text), including which rules were considered and *why each non-matching rule failed* ("rule #1 skipped: URI /cart does not match prefix /api"). This is the main debugging feature.

### 6.5 Live mode (watch)

`istio-viz watch` serves the HTML report from a local HTTP server and re-renders on every change to the input files:

```
istio-viz watch <paths...> [--port N] [--gateway NAME] [--host PATTERN] [--namespace NS]
```

- Inputs are the same as `render` (files, directories, kustomize overlays). For kustomize overlays, `kustomize build` is re-run on each change; the watcher also follows relative `resources:`/`bases:`/`components:`/`patches:` references in the kustomization file so edits to bases outside the overlay directory are picked up.
- The served page is the normal self-contained HTML report plus an injected Server-Sent-Events client; on each rebuild the browser reloads automatically. Filter state (gateway/namespace/host selections) is preserved across reloads via `sessionStorage`.
- Rebuild failures (YAML or kustomize errors) do not kill the server: the error is shown in the browser and on stderr, and the next successful rebuild replaces it.
- Watching is recursive with debounce; changes are detected for `*.yaml`/`*.yml` files (and any file inside a kustomize root, since generators may consume non-YAML files).
- When `--cluster` is set, file-watching is replaced (or supplemented) by periodic polling: `kubectl get` is re-run every `--poll-interval` seconds (default 30, floored at 5). A new render is emitted only when the fetched resource set differs from the previous fetch (compared as a canonical JSON hash). The browser page reloads on change in the same way as the file-watch path.
- `--cluster` and file inputs may be combined in watch mode: file changes trigger an immediate re-render; poll ticks trigger a re-render only if the cluster diff is non-empty.

This is the only mode that runs a server; all `render` outputs remain static and offline.

## 7. Validation & Lint Findings

During model construction, the tool emits findings, each with severity, message, and source location:

| ID | Severity | Condition |
|---|---|---|
| E001 | error | VirtualService references a Gateway that isn't in the input set |
| E002 | error | Destination host has no matching Service in input set |
| E003 | error | Destination port not exposed by the Service |
| E004 | error | Subset referenced but not defined in any DestinationRule |
| W001 | warn | VS hosts have empty intersection with Gateway hosts (rule can never receive traffic) |
| W002 | warn | Rule unreachable: an earlier rule's match is a superset (e.g. prefix `/` above it) |
| W003 | warn | Weights don't sum to 100 |
| W004 | warn | Multiple VirtualServices define the same host on the same gateway (merge-order ambiguity) |
| I001 | info | Catch-all rule absent: unmatched requests will get 404 |

Findings appear in the HTML side panel and as colored markers on the affected nodes; `--strict` makes the CLI exit non-zero on errors (CI-friendly).

## 8. CLI Surface

```
istio-viz render [<paths...>] [-o out.html] [--format html|svg|png|dot|text|paths]
                              [--gateway NAME] [--host PATTERN] [--namespace NS]
                              [--uri PREFIX] [--service NAME] [--strict]
                              [--cluster] [--context CTX] [--kubeconfig PATH]
istio-viz trace  [<paths...>] --host H --path P [--method M] [--header k=v ...]
                              [--port N] [-o out.html|--format text]
                              [--cluster] [--context CTX] [--kubeconfig PATH]
istio-viz lint   [<paths...>] [--strict]
                              [--cluster] [--context CTX] [--kubeconfig PATH]
istio-viz watch  [<paths...>] [--port N]      # live HTML server, re-renders on change (§6.5)
                              [--gateway NAME] [--host PATTERN] [--namespace NS] [--uri PREFIX]
                              [--cluster] [--context CTX] [--kubeconfig PATH] [--poll-interval N]
```

`<paths...>` is optional when `--cluster` is set. Providing both fetches files first and merges cluster resources in, with files winning on conflict (same kind + namespace + name).

`--uri PREFIX` keeps only route rules that declare a URI match (exact/prefix/regex) under the given path prefix; bindings and sections left without rules are dropped. A prefix without a leading `/` is normalized to one.

## 9. Architecture Sketch

Three cleanly separated layers, so the renderer can evolve independently:

1. **Loader/Parser** — YAML ingestion, schema-tolerant decoding of the four kinds, source-location tracking (file + line, or cluster/<context>/...) for every field used in the model. Two source backends share a common `LoadedResource[]` interface:
   - *File backend* — walks paths, detects kustomize overlays, runs `kustomize build` as needed.
   - *Cluster backend* — shells out to `kubectl get <kinds> --all-namespaces --output yaml` (see §4.2), parses the returned List, and attaches cluster-style source locations. Both backends return the same type; the resolver is unaware of which was used.
2. **Resolver/Evaluator** — builds the graph: gateway↔VS binding (host intersection, port/protocol), destination resolution, subset join, lint analysis, and the request-trace evaluator. This layer is pure and fully unit-testable with fixture manifests.
3. **Renderers** — HTML (embedded JS layout, e.g. dagre/elk-style layered DAG), SVG/PNG export, DOT emitter, text tree.

Suggested implementation: Go (single static binary, k8s yaml libraries readily available) or TypeScript/Node (easier HTML rendering pipeline). Decision left to implementer; the spec is language-agnostic.

## 10. Acceptance Criteria

1. Given the Istio Bookinfo sample manifests (gateway + virtual services + services + destination rules), `render` produces an HTML diagram showing the ingress gateway, the `bookinfo` VS rules in order, and the reviews v1/v2/v3 subset routing, with no errors.
2. A VS rule placed *after* a `prefix: /` catch-all is flagged W002 and visually dimmed.
3. `trace --host shop.example.com --path /api/v2/items --header x-canary=true` selects the correct rule and prints the skip reason for every earlier rule.
4. Removing a Service manifest from the input set produces E002 attached to the correct destination node with the correct file/line of the referencing VS.
5. A multi-document YAML file with all four kinds parses identically to the same content split across files.
6. The HTML output opens from the filesystem with no network access and renders in current Chrome/Firefox/Safari.

## 11. Future Extensions (explicitly deferred)

- **TCP/TLS route blocks** — VirtualService `spec.tcp[]` and `spec.tls[]` L4 routing; currently listed but not diagrammed.
- **ServiceEntry / egress** — external service discovery and egress gateway routing.
- **AuthorizationPolicy overlay** — annotate the routing diagram with which rules are blocked by policy.
- **Diff mode** — compare two manifest sets (or a file set vs a cluster snapshot) and show what routing changes if the diff is applied.
- **Cluster watch via informers** — replace the poll-interval approach with a true `kubectl watch` stream for sub-second latency on cluster changes.
- **Trace permalink** — export a trace result as a self-contained shareable URL.
