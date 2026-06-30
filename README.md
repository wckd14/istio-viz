# istio-viz

Visualize the **effective Istio L7 routing topology** from a set of Kubernetes/Istio
manifests — offline, read-only, no cluster access. It joins Gateway,
VirtualService, Service, and DestinationRule resources, simulates Envoy's
first-match-wins evaluation, and renders the result as an interactive diagram,
terminal tree, Graphviz source, or static SVG/PNG.

Implements [SPEC.md](./SPEC.md).

## Install / build

```sh
make setup           # one-shot: npm install + build + test + `npm link`
istio-viz --help     # now on your PATH
```

`make help` lists the individual targets (`install`, `build`, `test`, `link`,
`unlink`, `clean`). Without make:

```sh
npm install
npm run build        # compiles to dist/, exposes the `istio-viz` bin
npm test             # type-check + unit/acceptance tests
npm link             # optional: put `istio-viz` on the PATH
```

During development, run directly from source with `npm run dev -- <args>`
(e.g. `npm run dev -- render testdata/bookinfo --format text`).

## Usage

```
istio-viz render [paths...] [-o out.html] [--format html|svg|png|dot|text|paths]
                            [--gateway NAME] [--host PATTERN] [--namespace NS]
                            [--uri PREFIX] [--service NAME] [--strict]
                            [--cluster] [--context CTX] [--kubeconfig PATH]
istio-viz trace  [paths...] --host H --path P [--method M] [--header k=v ...]
                            [--port N] [-o out.html | --format text]
                            [--cluster] [--context CTX] [--kubeconfig PATH]
istio-viz lint   [paths...] [--strict]
                            [--cluster] [--context CTX] [--kubeconfig PATH]
istio-viz watch  [paths...] [--port N] [--gateway NAME] [--host PATTERN] [--namespace NS]
                            [--uri PREFIX] [--service NAME]
                            [--cluster] [--context CTX] [--kubeconfig PATH] [--poll-interval N]
```

`[paths...]` are YAML files or directories (recursed, multi-document files
supported), and are optional when `--cluster` is set. All of `networking.istio.io/v1alpha3`, `v1beta1`, and `v1` are
accepted; unrecognized kinds are ignored with a warning. A top-level
Kubernetes `List` (the shape of a `kubectl get … -o yaml` dump) is unwrapped
transparently — its `items` are classified individually and non-network kinds
are dropped silently. An unreadable subdirectory is skipped with a warning
rather than aborting the whole scan.

**Kustomize overlays:** if a path is a directory containing a
`kustomization.yaml` (or the file itself), the tool runs `kustomize build`
(falling back to `kubectl kustomize`) and ingests the generated output.
Non-network kinds in the build output (Deployment, ConfigMap, PVC, ...) are
filtered out silently. Source locations then refer to the generated stream
(`<dir> (kustomize build):line`).

### Examples

```sh
# interactive HTML diagram (self-contained, opens from the filesystem)
istio-viz render ./manifests/ -o routes.html

# terminal tree, CI-friendly; exit non-zero on errors
istio-viz render ./manifests/ --format text --strict

# where does this request go, and why were earlier rules skipped?
istio-viz trace ./manifests/ --host shop.example.com --path /api/v2/cart \
    --method POST --header x-canary=true

# findings only
istio-viz lint ./manifests/ --strict

# render a kustomize overlay (filters out Deployments, ConfigMaps, ...)
istio-viz render ./overlays/prod -o routes.html

# live mode: serve the report and re-render on every file change
istio-viz watch ./overlays/prod --port 4400

# canonical host → match → service paths, for committing / diffing
istio-viz render ./overlays/prod --format paths -o network-paths.txt
```

### Network paths view & diffable export

The HTML report has a second view ("paths" toggle in the header) that hides
the Istio object structure and shows pure **host → match → service** paths,
consolidated per unique host across all contributing VirtualServices — as a
per-host three-column diagram (default) or a compact table (in-place toggle).
The same data exports as canonical text via `--format paths`:

```
shop.example.com via prod/shop-gateway:443, prod/shop-gateway:80
  /* -> web.prod:80
  /api* -> api.prod:8080(v1) [mirror api-shadow.prod:8080, rewrite /]
  /api/v2* {header x-canary=true} -> api.prod:8080(v2)=90% api.prod:8080(v1)=10% [retry 3x, timeout 5s]
  /old -> redirect:301:/new
```

Lines are sorted, deduplicated, and free of timestamps/padding, so the file
is byte-stable: restructuring VirtualServices without changing effective
routing produces an identical file, and `diff` between two exports shows only
real routing changes.

### Live cluster source

With `--cluster`, the tool fetches Gateway, VirtualService, Service, and
DestinationRule resources from the active Kubernetes cluster via the `kubectl`
binary on your PATH (no k8s client library, no write calls). It issues a single
`kubectl get … --output yaml` per call; if the Istio CRDs aren't installed it
falls back to per-group fetches and warns instead of failing, so the Service
topology still renders.

```sh
istio-viz render --cluster -o routes.html
istio-viz render --cluster --context prod-ctx --namespace istio-system -o routes.html
istio-viz trace  --cluster --host shop.example.com --path /api/v2/cart
istio-viz watch  --cluster --poll-interval 15
```

`--cluster` may be combined with file/directory arguments: files are loaded
first and cluster resources are merged in afterward, with the **file winning**
on a same kind+namespace+name conflict (preview local changes against live
state). Source locations show as `cluster://<context>/<namespace>/<Kind>/<name>`
instead of `file:line`. Flags: `--context CTX` (kubeconfig context),
`--namespace NS` (restrict fetch; otherwise all namespaces), `--kubeconfig PATH`,
and `--poll-interval N` (watch mode re-fetch interval, default 30s, floored at
5s). `--context`/`--kubeconfig` imply `--cluster`.

### Live mode

`istio-viz watch` serves the HTML report at `http://127.0.0.1:<port>/` and
rebuilds it whenever the inputs change, pushing a reload to open browser tabs
via Server-Sent Events. With `--cluster`, file-watching is supplemented by
periodic `kubectl get` polling every `--poll-interval` seconds; a re-render is
emitted only when the fetched resource set differs from the previous poll.
Filter selections survive reloads. For kustomize
overlays, `kustomize build` is re-run on each change, and directories
referenced by `resources:`/`bases:`/`components:`/`patches:` (e.g. a base
outside the overlay) are watched too. Rebuild failures show an error page
without killing the server; load warnings appear as a banner. This is the only
mode that runs a server — `render` output stays static and offline.

### Text output

```
gateway prod/shop-gateway :443 (HTTPS, SIMPLE TLS)  hosts: shop.example.com
└─ shop.example.com  [vs: shop-routes, ns: prod]
   ├─ #1  URI prefix /api/v2 AND header x-canary exact true  → api.prod:8080 (v2) 90% / api.prod:8080 (v1) 10%   [timeout 5s, retry 3x]
   ├─ #2  URI prefix /api  → api.prod:8080 (v1) / 🪞 api-shadow.prod:8080   [rewrite /, mirror]
   ├─ #3  URI exact /old  → HTTP 301 → /new
   └─ #4  URI prefix /  → web.prod:80
```

### Trace output

```
✘ rule #1 skipped: URI /cart does not match prefix "/api/v2"
✘ rule #2 skipped: URI /cart does not match prefix "/api"
✘ rule #3 skipped: URI /cart does not match exact "/old"
✔ rule #4 MATCHED (matched)

result: rule #4 of prod/shop-routes matches → web.prod:80
```

With `-o trace.html` the same decision log is embedded in the HTML diagram and
the winning path is highlighted; skipped rules are dimmed.

## HTML report

- Layered left-to-right DAG per gateway listener: **Client → listener → host →
  numbered rules (evaluation order top-to-bottom) → destinations**; mesh-internal
  VirtualServices (`gateways: [mesh]` or unset) get their own section.
- Click any node for a side panel with full detail, the originating YAML
  fragment, and its `file:line`.
- Hover highlights the full upstream/downstream path.
- Filters by gateway / namespace / host / URL path prefix (the path box dims
  every rule that doesn't declare a URI condition under the typed prefix) /
  service name (substring match on destination services), plus a "warnings
  only" toggle. The path and service filters are also available on the CLI as
  `--uri PREFIX` and `--service NAME`, which prune the diagram server-side.
- Weighted splits are fan-out edges labeled with percentages; mirrors are dashed;
  redirects/direct-responses are terminal nodes; modifier badges (↻ retry,
  ⏱ timeout, ✂ rewrite, ⤳ redirect, 🪞 mirror, ⚡ fault) appear on rule nodes.
- Fully self-contained: no network access, no external scripts.

## Findings

| ID | Severity | Condition |
|---|---|---|
| E001 | error | VirtualService references a Gateway not in the input set |
| E002 | error | Destination host has no matching Service |
| E003 | error | Destination port not exposed by the Service (or missing on a multi-port Service) |
| E004 | error | Subset referenced but not defined in any DestinationRule |
| W001 | warn | VS hosts have empty intersection with Gateway hosts |
| W002 | warn | Rule unreachable — an earlier rule matches a superset of its traffic |
| W003 | warn | Destination weights don't sum to 100 |
| W004 | warn | Multiple VirtualServices define the same host on the same gateway |
| I001 | info | No catch-all rule — unmatched requests will get 404 |

`--strict` makes `render`/`lint` exit with code 2 when any error-severity
finding is present. `trace` exits 1 when no rule matches.

## Notes / limitations (v1, per spec)

- TCP/TLS route blocks are listed under "L4 (not diagrammed)" but not drawn.
- PeerAuthentication / AuthorizationPolicy, EnvoyFilter, ServiceEntry, Sidecar,
  and multi-cluster / east-west gateway topologies are out of scope.
- `png` export uses the optional `@resvg/resvg-js` dependency; if it isn't
  installed, use `--format svg`.
- `sourceLabels` match conditions can't be evaluated for a synthetic edge
  request; trace treats them as non-matching and says so.

## Architecture

```
src/
  loader.ts        YAML ingestion, kind classification, file:line tracking
  cluster.ts       live cluster backend: kubectl get + merge + poll hashing
  kustomize.ts     overlay detection, `kustomize build` integration, watch-dir discovery
  hosts.ts         Istio host/wildcard semantics (match, intersect, FQDN expansion)
  resolve.ts       Gateway↔VS binding, destination/subset resolution, lints
  trace.ts         Envoy-style first-match-wins request evaluation
  paths.ts         canonical host → match → service paths text export
  types.ts         shared RoutingModel / Resource / TraceRequest types
  watch.ts         live mode: HTTP server + fs.watch + SSE auto-reload + cluster poll
  render/
    text.ts        terminal tree
    dot.ts         Graphviz source
    layout.ts      layered DAG geometry (shared by svg + html)
    svg.ts         SVG emitter (static export + html embed)
    html.ts        self-contained interactive report
  index.ts         CLI (render / trace / lint / watch)
testdata/          Bookinfo + synthetic fixtures used by the tests
```

The loader and resolver are pure and renderer-independent; renderers consume
the same `RoutingModel`.
