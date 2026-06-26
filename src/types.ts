/** Shared types: parsed resources, routing model graph, findings. */

export interface SourceLoc {
  file: string;
  line: number; // 1-based
}

export type Severity = "error" | "warn" | "info";

export interface Finding {
  id: string; // E001..E004, W001..W004, I001
  severity: Severity;
  message: string;
  loc?: SourceLoc;
  /** Node ids in the graph this finding attaches to. */
  nodeIds: string[];
}

/* ---------------- Parsed resources (schema-tolerant) ---------------- */

export interface StringMatch {
  exact?: string;
  prefix?: string;
  regex?: string;
}

export interface HTTPMatchRequest {
  name?: string;
  uri?: StringMatch;
  scheme?: StringMatch;
  method?: StringMatch;
  authority?: StringMatch;
  headers?: Record<string, StringMatch>;
  withoutHeaders?: Record<string, StringMatch>;
  queryParams?: Record<string, StringMatch>;
  port?: number;
  sourceLabels?: Record<string, string>;
  gateways?: string[];
  ignoreUriCase?: boolean;
}

export interface Destination {
  host: string;
  subset?: string;
  port?: { number?: number };
}

export interface HTTPRouteDestination {
  destination: Destination;
  weight?: number;
  loc?: SourceLoc;
}

export interface HTTPRedirect {
  uri?: string;
  authority?: string;
  redirectCode?: number;
  scheme?: string;
  port?: number;
}

export interface HTTPRewrite {
  uri?: string;
  authority?: string;
  uriRegexRewrite?: { match?: string; rewrite?: string };
}

export interface HTTPRetry {
  attempts?: number;
  perTryTimeout?: string;
  retryOn?: string;
}

export interface HTTPFaultInjection {
  delay?: { fixedDelay?: string; percentage?: { value?: number }; percent?: number };
  abort?: { httpStatus?: number; percentage?: { value?: number }; percent?: number };
}

export interface HTTPDirectResponse {
  status?: number;
  body?: { string?: string };
}

export interface HTTPRoute {
  name?: string;
  match?: HTTPMatchRequest[];
  route?: HTTPRouteDestination[];
  redirect?: HTTPRedirect;
  directResponse?: HTTPDirectResponse;
  rewrite?: HTTPRewrite;
  timeout?: string;
  retries?: HTTPRetry;
  fault?: HTTPFaultInjection;
  mirror?: Destination;
  mirrors?: { destination: Destination; percentage?: { value?: number } }[];
  mirrorPercentage?: { value?: number };
  headers?: unknown;
  corsPolicy?: unknown;
  loc?: SourceLoc;
  /** Raw YAML fragment of this http route entry, for the HTML side panel. */
  yaml?: string;
}

export interface ResourceMeta {
  name: string;
  namespace: string;
  loc: SourceLoc;
  /** Raw YAML of the whole document. */
  yaml: string;
}

export interface GatewayServer {
  port: { number: number; name?: string; protocol: string };
  hosts: string[];
  tls?: { mode?: string };
  loc?: SourceLoc;
}

export interface GatewayResource extends ResourceMeta {
  kind: "Gateway";
  selector?: Record<string, string>;
  servers: GatewayServer[];
}

export interface VirtualServiceResource extends ResourceMeta {
  kind: "VirtualService";
  hosts: string[];
  gateways: string[]; // empty/unset normalized to ["mesh"]
  http: HTTPRoute[];
  hasTcp: boolean;
  hasTls: boolean;
  gatewaysLoc?: SourceLoc;
}

export interface ServicePort {
  name?: string;
  port: number;
  protocol?: string;
  targetPort?: number | string;
}

export interface ServiceResource extends ResourceMeta {
  kind: "Service";
  ports: ServicePort[];
  selector?: Record<string, string>;
}

export interface DRSubset {
  name: string;
  labels?: Record<string, string>;
  loc?: SourceLoc;
}

export interface DestinationRuleResource extends ResourceMeta {
  kind: "DestinationRule";
  host: string;
  subsets: DRSubset[];
}

export type Resource =
  | GatewayResource
  | VirtualServiceResource
  | ServiceResource
  | DestinationRuleResource;

export interface LoadResult {
  resources: Resource[];
  warnings: string[]; // unrecognized kinds, parse issues
}

/* ---------------- Routing model graph ---------------- */

export interface ListenerNode {
  id: string;
  kind: "listener";
  gateway: string; // name
  namespace: string;
  port: number;
  portName?: string;
  protocol: string;
  tlsMode?: string;
  hosts: string[]; // host patterns (ns/ prefix stripped)
  loc?: SourceLoc;
}

export interface HostNode {
  id: string;
  kind: "host";
  /** Effective hosts: intersection of listener hosts and VS hosts. */
  hosts: string[];
  vsName: string;
  vsNamespace: string;
  loc?: SourceLoc;
}

export interface MatchExpr {
  /** Human-readable condition, e.g. "URI prefix /api/v2". */
  text: string;
  regex: boolean;
}

/** One match block (AND of its exprs); blocks are OR'd. */
export interface MatchBlock {
  exprs: MatchExpr[];
}

export interface Modifier {
  kind:
    | "rewrite"
    | "redirect"
    | "timeout"
    | "retries"
    | "fault"
    | "mirror"
    | "headers"
    | "cors"
    | "directResponse";
  summary: string; // e.g. "timeout 5s", "retry 3x"
  detail: string;
}

export interface RuleNode {
  id: string;
  kind: "rule";
  index: number; // evaluation order within its VS, 0-based
  name?: string;
  vsName: string;
  vsNamespace: string;
  matchBlocks: MatchBlock[]; // empty => catch-all
  isCatchAll: boolean;
  modifiers: Modifier[];
  loc?: SourceLoc;
  yaml?: string;
  /** Set by lint W002. */
  unreachable?: boolean;
  raw: HTTPRoute;
}

export interface DestNode {
  id: string;
  kind: "dest";
  /** "service" backed by a K8s Service; "redirect"/"direct" are terminals; "unknown" when unresolved. */
  type: "service" | "redirect" | "direct" | "unknown";
  host: string; // FQDN for services; description for terminals
  shortHost?: string;
  namespace?: string;
  port?: number;
  subset?: string;
  subsetLabels?: Record<string, string>;
  serviceFound: boolean;
  loc?: SourceLoc;
}

export type GraphNode = ListenerNode | HostNode | RuleNode | DestNode;

export interface GraphEdge {
  from: string;
  to: string;
  kind: "accepts" | "evaluates" | "routes" | "mirrors";
  /** Edge label, e.g. "90%" for weighted routes, "order 1" for evaluates. */
  label?: string;
  weight?: number;
}

/** A host binding: one VS attached to a listener (or mesh) for a set of hosts. */
export interface HostBinding {
  hostNode: HostNode;
  ruleIds: string[];
}

export interface ListenerSection {
  listener: ListenerNode;
  bindings: HostBinding[];
}

export interface MeshSection {
  bindings: HostBinding[];
}

export interface RoutingModel {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  sections: ListenerSection[];
  mesh: MeshSection;
  findings: Finding[];
  /** L4 (tcp/tls) blocks present but not diagrammed. */
  l4Notes: string[];
  resources: Resource[];
}

/* ---------------- Trace ---------------- */

export interface TraceRequest {
  host: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  port?: number;
}

export interface TraceStep {
  ruleId: string;
  vsName: string;
  index: number;
  matched: boolean;
  /** Per match-block explanation of why it failed (or "matched"). */
  reasons: string[];
}

export interface TraceResult {
  request: TraceRequest;
  listenerId?: string;
  hostNodeId?: string;
  steps: TraceStep[];
  winner?: TraceStep;
  /** Destination node ids reached by the winning rule. */
  destIds: string[];
  outcome: string; // human summary
}
