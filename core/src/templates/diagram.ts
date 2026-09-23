/**
 * Node diagrams: Mermaid flowcharts and plain arrow chains ("需求 → 设计 → 开发").
 *
 * Parsing keeps every node label and edge label verbatim; nothing is inferred
 * beyond what the syntax states. Layout is a small layered (Sugiyama-style)
 * layout: ranks by longest path with cycles reversed, dummy points for edges
 * that span ranks, barycenter ordering, parent-aligned coordinates, then
 * orthogonal edge routing with per-edge channels. The result is plain boxes,
 * line segments, arrowheads and text, drawn by compose.ts like any template.
 */
import type { TemplateContent } from "./types.ts";

export const DIAGRAM_DIRECTIONS = ["TD", "LR", "BT", "RL"] as const;
export type DiagramDirection = (typeof DIAGRAM_DIRECTIONS)[number];
export type DiagramShape = "rect" | "round" | "pill" | "diamond";
export interface DiagramNode { readonly id: string; readonly label: string; readonly shape: DiagramShape }
export interface DiagramEdge {
  readonly from: string; readonly to: string; readonly label?: string;
  readonly line: "solid" | "dotted" | "thick"; readonly arrow: boolean;
}
export type DiagramContent = Extract<TemplateContent, { kind: "diagram" }>;

export const DIAGRAM_LIMITS = { nodes: 40, edges: 80, label: 80 } as const;

// ---------------------------------------------------------------- parsing

const ID = String.raw`[\p{L}\p{N}_]+(?:[.\-][\p{L}\p{N}_]+)*`;
const SHAPES: readonly [string, string, DiagramShape][] = [
  ["(((", ")))", "pill"], ["((", "))", "pill"], ["([", "])", "pill"], ["[[", "]]", "rect"], ["[(", ")]", "round"],
  ["{{", "}}", "round"], ["[/", "/]", "rect"], ["[/", "\\]", "rect"], ["[\\", "\\]", "rect"], ["[\\", "/]", "rect"],
  ["[", "]", "rect"], ["(", ")", "round"], ["{", "}", "diamond"], [">", "]", "rect"],
];

function cleanLabel(raw: string): string {
  let label = raw.trim();
  if (label.length >= 2 && label.startsWith('"') && label.endsWith('"')) label = label.slice(1, -1);
  return label.replace(/<br\s*\/?>/gi, "\n").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

interface Cursor { s: string; i: number }
const skip = (c: Cursor) => { while (c.i < c.s.length && /[\t ]/.test(c.s[c.i]!)) c.i++; };

function readNode(c: Cursor, nodes: Map<string, DiagramNode>): string | undefined {
  skip(c);
  const id = c.s.slice(c.i).match(new RegExp(`^${ID}`, "u"))?.[0];
  if (!id) return;
  c.i += id.length;
  for (const [open, close, shape] of SHAPES) {
    if (!c.s.startsWith(open, c.i)) continue;
    const start = c.i + open.length;
    let end: number;
    if (c.s[start] === '"') {
      const q = c.s.indexOf('"', start + 1);
      end = q < 0 ? -1 : c.s.indexOf(close, q + 1);
    } else end = c.s.indexOf(close, start);
    if (end < 0) return;
    const label = cleanLabel(c.s.slice(start, end));
    c.i = end + close.length;
    nodes.set(id, { id, label: label || id, shape });
    return id;
  }
  if (!nodes.has(id)) nodes.set(id, { id, label: id, shape: "rect" });
  return id;
}

function readGroup(c: Cursor, nodes: Map<string, DiagramNode>): string[] | undefined {
  const ids: string[] = [];
  for (;;) {
    const id = readNode(c, nodes);
    if (!id) return;
    ids.push(id);
    skip(c);
    if (c.s[c.i] !== "&") return ids;
    c.i++;
  }
}

/** An edge operator, optionally with `|label|` or an inline `-- label -->`. */
function readEdge(c: Cursor): Omit<DiagramEdge, "from" | "to"> | undefined {
  skip(c);
  const rest = c.s.slice(c.i);
  const style = (op: string): DiagramEdge["line"] => op.includes(".") ? "dotted" : op.includes("=") ? "thick" : "solid";
  // `-- label -->` first: otherwise its leading `--` reads as a bare link.
  let m = rest.match(/^(--|==|-\.)[\t ]+(.+?)[\t ]+(-{2,}|={2,}|\.+-)([>xo])?/);
  if (m) {
    c.i += m[0].length;
    const label = cleanLabel(m[2]!);
    return { line: style(m[1]! + m[3]!), arrow: Boolean(m[4]), ...(label ? { label } : {}) };
  }
  m = rest.match(/^<?(-{2,}|={2,}|-?\.+-|~{3})([>xo])?/);
  if (m) {
    c.i += m[0].length;
    skip(c);
    let label: string | undefined;
    const piped = c.s.slice(c.i).match(/^\|([^|]*)\|/);
    if (piped) { label = cleanLabel(piped[1]!); c.i += piped[0].length; }
    return { line: style(m[1]!), arrow: Boolean(m[2]), ...(label ? { label } : {}) };
  }
  return;
}

/** Mermaid `graph`/`flowchart` only. Styling statements are ignored;
 * subgraphs are flattened. Anything else unparseable means "not a diagram". */
export function parseMermaid(source: string): DiagramContent | undefined {
  const lines = source.split("\n").map((line) => line.replace(/%%.*$/, "").trim()).filter(Boolean);
  const header = lines.shift()?.match(/^(?:graph|flowchart)(?:[\t ]+(TD|TB|BT|LR|RL))?[\t ]*;?$/i);
  if (!header) return;
  const dir = (header[1] ?? "TD").toUpperCase();
  const direction: DiagramDirection = dir === "TB" ? "TD" : dir as DiagramDirection;
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  for (const line of lines) {
    if (/^(?:classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/i.test(line) || /^end$/i.test(line)) continue;
    if (/^subgraph\b/i.test(line)) continue;
    for (const statement of line.split(";").map((part) => part.trim()).filter(Boolean)) {
      const c: Cursor = { s: statement, i: 0 };
      let from = readGroup(c, nodes);
      if (!from) return;
      for (;;) {
        skip(c);
        if (c.i >= c.s.length) break;
        const edge = readEdge(c);
        if (!edge) return;
        const to = readGroup(c, nodes);
        if (!to) return;
        for (const a of from) for (const b of to) edges.push({ from: a, to: b, ...edge });
        from = to;
      }
    }
  }
  return finish(direction, [...nodes.values()], edges);
}

const ARROW = /[\t ]*(?:-->|->|=>|→|⟶|⇒|➜|➡|⟹)[\t ]*/u;
/** Plain arrow chains, one or more per line: every non-empty line must be a
 * chain of at least two labels. Labels with the same text are one node. */
export function parseArrowChains(source: string): DiagramContent | undefined {
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return;
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  let longest = 0;
  for (const line of lines) {
    const parts = line.split(ARROW).map((part) => part.trim());
    if (parts.length < 2 || parts.some((part) => !part || [...part].length > 40 || !labelLike(part))) return;
    longest = Math.max(longest, parts.length);
    for (const part of parts) if (!nodes.has(part)) nodes.set(part, { id: part, label: part, shape: "round" });
    for (let i = 1; i < parts.length; i++) edges.push({ from: parts[i - 1]!, to: parts[i]!, line: "solid", arrow: true });
  }
  const short = [...nodes.keys()].every((label) => [...label].length <= 10);
  const direction: DiagramDirection = lines.length === 1 && nodes.size <= 5 && short ? "LR" : "TD";
  return finish(direction, [...nodes.values()], edges);
}

/** A node label, not a sentence or code: no sentence punctuation, no `{};=`,
 * and brackets that balance within the label. */
function labelLike(part: string): boolean {
  if (/[，。；！？、{};=]|[,.;!?]\s/u.test(part)) return false;
  let depth = 0;
  for (const ch of part) {
    if ("([（【《".includes(ch)) depth++;
    else if (")]）】》".includes(ch) && --depth < 0) return false;
  }
  return depth === 0;
}

function finish(direction: DiagramDirection, nodes: DiagramNode[], edges: DiagramEdge[]): DiagramContent | undefined {
  if (nodes.length < 2 || !edges.length || nodes.length > DIAGRAM_LIMITS.nodes || edges.length > DIAGRAM_LIMITS.edges) return;
  if ([...nodes.map((n) => n.label), ...edges.map((e) => e.label ?? "")].some((label) => [...label].length > DIAGRAM_LIMITS.label)) return;
  return { kind: "diagram", direction, nodes, edges };
}

// ---------------------------------------------------------------- layout

export interface DiagramBox { width: number; height: number }
export interface PlacedNode { id: string; x: number; y: number; width: number; height: number; rank: number }
export interface Segment { x1: number; y1: number; x2: number; y2: number }
export interface RoutedEdge {
  edge: DiagramEdge; points: { x: number; y: number }[]; rank: number;
  /** Where to put the label box: its center. */
  label?: { x: number; y: number; beside: boolean };
}
export interface DiagramGeometry { width: number; height: number; nodes: PlacedNode[]; edges: RoutedEdge[]; ranks: number }
export interface DiagramSpacing { rankGap: number; nodeGap: number; labelGap: number; dummyWidth: number }

interface LNode { key: string; real?: DiagramNode; size: DiagramBox; rank: number; order: number; cross: number }

/**
 * Pure layered layout in TD coordinates (ranks go down). `size` gives each
 * node's box; LR/RL are laid out with width and height swapped and then
 * transposed; BT/RL are mirrored.
 */
export function layoutDiagram(content: DiagramContent, size: (node: DiagramNode) => DiagramBox, spacing: DiagramSpacing,
  labelSize: (label: string) => DiagramBox): DiagramGeometry {
  const horizontal = content.direction === "LR" || content.direction === "RL";
  const boxOf = (node: DiagramNode): DiagramBox => { const b = size(node); return horizontal ? { width: b.height, height: b.width } : b; };
  const ids = content.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const edges = content.edges.filter((e) => e.from !== e.to && index.has(e.from) && index.has(e.to));

  // Break cycles: DFS in source order; an edge to a node on the stack is reversed.
  const out = new Map<string, DiagramEdge[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.from)!.push(e);
  const reversed = new Set<DiagramEdge>();
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of out.get(id)!) {
      const s = state.get(e.to);
      if (s === 1) reversed.add(e);
      else if (!s) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  const directed = edges.map((e) => reversed.has(e) ? { e, from: e.to, to: e.from } : { e, from: e.from, to: e.to });

  // Longest-path ranks.
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const d of directed) indeg.set(d.to, indeg.get(d.to)! + 1);
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (let q = 0; q < queue.length; q++) {
    const id = queue[q]!;
    for (const d of directed) if (d.from === id) {
      rank.set(d.to, Math.max(rank.get(d.to)!, rank.get(id)! + 1));
      indeg.set(d.to, indeg.get(d.to)! - 1);
      if (indeg.get(d.to) === 0) queue.push(d.to);
    }
  }
  // A source feeding only lower ranks sits just above its first child.
  for (const id of ids) {
    const ins = directed.filter((d) => d.to === id).length;
    const kids = directed.filter((d) => d.from === id).map((d) => rank.get(d.to)!);
    if (!ins && kids.length) rank.set(id, Math.max(rank.get(id)!, Math.min(...kids) - 1));
  }
  const ranks = Math.max(...rank.values()) + 1;

  // Layers with dummy points for long edges.
  const layers: LNode[][] = Array.from({ length: ranks }, () => []);
  const lnodes = new Map<string, LNode>();
  for (const node of content.nodes) {
    const l: LNode = { key: node.id, real: node, size: boxOf(node), rank: rank.get(node.id)!, order: 0, cross: 0 };
    lnodes.set(node.id, l); layers[l.rank]!.push(l);
  }
  const chains: { d: (typeof directed)[number]; keys: string[] }[] = [];
  for (const [n, d] of directed.entries()) {
    const keys = [d.from];
    for (let r = rank.get(d.from)! + 1; r < rank.get(d.to)!; r++) {
      const key = `\u0000${n}:${r}`;
      const l: LNode = { key, size: { width: spacing.dummyWidth, height: 0 }, rank: r, order: 0, cross: 0 };
      lnodes.set(key, l); layers[r]!.push(l); keys.push(key);
    }
    keys.push(d.to);
    chains.push({ d, keys });
  }
  const up = new Map<string, string[]>(), down = new Map<string, string[]>();
  for (const { keys } of chains) for (let i = 1; i < keys.length; i++) {
    (down.get(keys[i - 1]!) ?? down.set(keys[i - 1]!, []).get(keys[i - 1]!)!).push(keys[i]!);
    (up.get(keys[i]!) ?? up.set(keys[i]!, []).get(keys[i]!)!).push(keys[i - 1]!);
  }

  // Barycenter ordering.
  layers.forEach((layer) => layer.forEach((l, i) => { l.order = i; }));
  const sortBy = (layer: LNode[], neighbours: Map<string, string[]>) => {
    const bary = new Map(layer.map((l) => {
      const ns = neighbours.get(l.key) ?? [];
      return [l.key, ns.length ? ns.reduce((sum, k) => sum + lnodes.get(k)!.order, 0) / ns.length : l.order];
    }));
    layer.sort((a, b) => bary.get(a.key)! - bary.get(b.key)! || a.order - b.order);
    layer.forEach((l, i) => { l.order = i; });
  };
  for (let sweep = 0; sweep < 6; sweep++) {
    for (let r = 1; r < ranks; r++) sortBy(layers[r]!, up);
    for (let r = ranks - 2; r >= 0; r--) sortBy(layers[r]!, down);
  }

  // Cross-axis coordinates: pack, then pull toward neighbours without overlap.
  const gap = (a: LNode, b: LNode) => (a.real && b.real ? spacing.nodeGap : spacing.nodeGap / 2) + (a.size.width + b.size.width) / 2;
  const pack = (layer: LNode[]) => { let x = 0; layer.forEach((l, i) => { l.cross = i ? layer[i - 1]!.cross + gap(layer[i - 1]!, l) : l.size.width / 2; x = l.cross; }); return x; };
  layers.forEach(pack);
  const settle = (layer: LNode[], neighbours: Map<string, string[]>) => {
    const want = layer.map((l) => { const ns = neighbours.get(l.key) ?? []; return ns.length ? ns.reduce((s, k) => s + lnodes.get(k)!.cross, 0) / ns.length : l.cross; });
    // Left to right keeps order and spacing, right to left pulls back; average both.
    const left = want.slice(), right = want.slice();
    for (let i = 1; i < layer.length; i++) left[i] = Math.max(left[i]!, left[i - 1]! + gap(layer[i - 1]!, layer[i]!));
    for (let i = layer.length - 2; i >= 0; i--) right[i] = Math.min(right[i]!, right[i + 1]! - gap(layer[i]!, layer[i + 1]!));
    const mid = layer.map((_, i) => (left[i]! + right[i]!) / 2);
    for (let i = 1; i < layer.length; i++) mid[i] = Math.max(mid[i]!, mid[i - 1]! + gap(layer[i - 1]!, layer[i]!));
    layer.forEach((l, i) => { l.cross = mid[i]!; });
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 1; r < ranks; r++) settle(layers[r]!, up);
    for (let r = ranks - 2; r >= 0; r--) settle(layers[r]!, down);
  }
  let minX = Infinity, maxX = -Infinity;
  for (const l of lnodes.values()) { minX = Math.min(minX, l.cross - l.size.width / 2); maxX = Math.max(maxX, l.cross + l.size.width / 2); }
  for (const l of lnodes.values()) l.cross -= minX;
  const width = maxX - minX;

  // Main axis: rank bands; a band gets extra room when edges leaving it carry labels.
  const bandH = layers.map((layer) => Math.max(0, ...layer.map((l) => l.size.height)));
  const labelled = Array.from({ length: ranks }, () => 0);
  for (const { d, keys } of chains) if (d.e.label) labelled[rank.get(keys[0]!)!]! = Math.max(labelled[rank.get(keys[0]!)!]!, horizontal ? labelSize(d.e.label).width : labelSize(d.e.label).height);
  const top: number[] = [];
  let y = 0;
  for (let r = 0; r < ranks; r++) { top.push(y); y += bandH[r]! + spacing.rankGap + (labelled[r]! ? labelled[r]! + spacing.labelGap : 0); }
  const height = y - spacing.rankGap - (labelled[ranks - 1]! ? labelled[ranks - 1]! + spacing.labelGap : 0);
  const centerY = (l: LNode) => top[l.rank]! + bandH[l.rank]! / 2;

  // Ports: spread along the facing side, ordered by the far end's position.
  const nodeOf = (key: string) => lnodes.get(key)!;
  const portsOut = new Map<string, { key: string; far: number }[]>(), portsIn = new Map<string, { key: string; far: number }[]>();
  chains.forEach(({ keys }, n) => {
    (portsOut.get(keys[0]!) ?? portsOut.set(keys[0]!, []).get(keys[0]!)!).push({ key: String(n), far: nodeOf(keys[1]!).cross });
    const last = keys.length - 1;
    (portsIn.get(keys[last]!) ?? portsIn.set(keys[last]!, []).get(keys[last]!)!).push({ key: String(n), far: nodeOf(keys[last - 1]!).cross });
  });
  const portX = (map: Map<string, { key: string; far: number }[]>, key: string, n: number) => {
    const l = nodeOf(key), list = map.get(key)!.slice().sort((a, b) => a.far - b.far);
    if (list.length === 1 || l.real?.shape === "diamond") return l.cross;
    const span = Math.min(l.size.width * 0.6, (list.length - 1) * 28);
    return l.cross - span / 2 + span * list.findIndex((p) => p.key === String(n)) / (list.length - 1);
  };

  // Channels: each gap between ranks hosts the horizontal runs of the edges crossing it.
  const channelUsers: string[][] = Array.from({ length: ranks }, () => []);
  const routes: { n: number; pts: { x: number; y: number }[] }[] = [];
  chains.forEach(({ keys }, n) => {
    const pts: { x: number; y: number }[] = [];
    const sx = portX(portsOut, keys[0]!, n), tx = portX(portsIn, keys[keys.length - 1]!, n);
    const first = nodeOf(keys[0]!);
    pts.push({ x: sx, y: centerY(first) + first.size.height / 2 });
    for (let i = 1; i < keys.length; i++) {
      const l = nodeOf(keys[i]!);
      const x = i === keys.length - 1 ? tx : l.cross;
      const r = l.rank - 1;
      channelUsers[r]!.push(`${n}:${i}`);
      pts.push({ x: pts[pts.length - 1]!.x, y: NaN, }); // bend at the channel, y filled below
      pts.push({ x, y: NaN });
      pts.push({ x, y: l.real ? centerY(l) - l.size.height / 2 : top[l.rank]! });
      if (!l.real) pts.push({ x, y: top[l.rank]! + bandH[l.rank]! });
    }
    routes.push({ n, pts });
  });
  // Assign channel offsets: sort users of a gap by the x they start from.
  const channelY = new Map<string, number>();
  for (let r = 0; r < ranks - 1; r++) {
    const users = channelUsers[r]!;
    const startOf = (u: string) => { const [n] = u.split(":").map(Number); return routes[n!]!.pts[0]!.x; };
    users.sort((a, b) => startOf(a) - startOf(b));
    const from = top[r]! + bandH[r]! + (labelled[r]! ? labelled[r]! + spacing.labelGap : 0);
    const room = top[r + 1]! - from;
    users.forEach((u, k) => channelY.set(u, from + room * (k + 1) / (users.length + 1)));
  }
  const routed: RoutedEdge[] = [];
  for (const { n, pts } of routes) {
    const { d, keys } = chains[n]!;
    let seg = 1;
    for (let i = 1; i < pts.length; i++) {
      if (Number.isNaN(pts[i]!.y)) {
        const y = channelY.get(`${n}:${seg}`)!;
        pts[i]!.y = y; pts[i + 1]!.y = y; i++; seg++;
      }
    }
    // Drop zero-length runs (straight edges have no horizontal leg).
    const clean = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y)
      .filter((p, i, a) => i === 0 || i === a.length - 1 || !((a[i - 1]!.x === p.x && p.x === a[i + 1]!.x) || (a[i - 1]!.y === p.y && p.y === a[i + 1]!.y)));
    const points = reversed.has(d.e) ? clean.slice().reverse() : clean;
    let label: RoutedEdge["label"];
    if (d.e.label) {
      const box = labelSize(d.e.label);
      const along = horizontal ? box.height : box.width;
      // Prefer the longest horizontal (cross-axis) run; else beside the first vertical run.
      let best: { x: number; y: number; len: number } | undefined;
      for (let i = 1; i < clean.length; i++) {
        const a = clean[i - 1]!, b = clean[i]!;
        if (a.y === b.y && Math.abs(a.x - b.x) >= along + 24 && (!best || Math.abs(a.x - b.x) > best.len)) best = { x: (a.x + b.x) / 2, y: a.y, len: Math.abs(a.x - b.x) };
      }
      // Beside: in the room reserved under the source band, next to the line.
      const r = rank.get(keys[0]!)!;
      label = best ? { x: best.x, y: best.y, beside: false }
        : { x: clean[0]!.x, y: top[r]! + bandH[r]! + (labelled[r]! + spacing.labelGap) / 2, beside: true };
    }
    routed.push({ edge: d.e, points, rank: rank.get(d.to)!, ...(label ? { label } : {}) });
  }

  // Map TD geometry to the requested direction.
  let nodes: PlacedNode[] = content.nodes.map((node) => {
    const l = lnodes.get(node.id)!;
    return { id: node.id, x: l.cross - l.size.width / 2, y: centerY(l) - l.size.height / 2, width: l.size.width, height: l.size.height, rank: l.rank };
  });
  let W = width, H = height;
  const map = (p: { x: number; y: number }) => {
    let { x, y } = p;
    if (content.direction === "BT" || content.direction === "RL") y = height - y;
    return horizontal ? { x: y, y: x } : { x, y };
  };
  nodes = nodes.map((n) => {
    const a = map({ x: n.x, y: n.y }), b = map({ x: n.x + n.width, y: n.y + n.height });
    return { ...n, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  });
  const edgesOut = routed.map((r) => ({ ...r, points: r.points.map(map), ...(r.label ? { label: { ...map(r.label), beside: r.label.beside } } : {}) }));
  if (horizontal) [W, H] = [H, W];
  return { width: W, height: H, nodes, edges: edgesOut, ranks };
}
