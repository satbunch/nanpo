import { haversine, lerp, type LatLon } from "./geo";

export interface OsmWay {
  nodes: number[];
  geometry: { lat: number; lon: number }[];
}

export interface Graph {
  coords: Map<number, LatLon>;
  adj: Map<number, { to: number; dist: number }[]>;
}

export function buildGraph(ways: OsmWay[]): Graph {
  const coords = new Map<number, LatLon>();
  const adj = new Map<number, { to: number; dist: number }[]>();
  const link = (a: number, b: number, dist: number) => {
    let edges = adj.get(a);
    if (!edges) adj.set(a, (edges = []));
    edges.push({ to: b, dist });
  };

  for (const way of ways) {
    way.nodes.forEach((id, i) => {
      const g = way.geometry[i];
      if (g) coords.set(id, [g.lat, g.lon]);
    });
    for (let i = 0; i + 1 < way.nodes.length; i++) {
      const a = way.nodes[i]!;
      const b = way.nodes[i + 1]!;
      const pa = coords.get(a);
      const pb = coords.get(b);
      if (!pa || !pb) continue;
      const dist = haversine(pa, pb);
      link(a, b, dist);
      link(b, a, dist);
    }
  }
  return { coords, adj };
}

export function nearestNode(graph: Graph, p: LatLon): number | undefined {
  let best: number | undefined;
  let bestDist = Infinity;
  for (const id of graph.adj.keys()) {
    const d = haversine(p, graph.coords.get(id)!);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

/** 最小ヒープ（ダイクストラ法用） */
class MinHeap {
  private items: [number, number][] = []; // [priority, node]

  get size() {
    return this.items.length;
  }

  push(priority: number, node: number) {
    const a = this.items;
    a.push([priority, node]);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]![0] <= a[i]![0]) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      i = parent;
    }
  }

  pop(): [number, number] | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (top === undefined || last === undefined) return top;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/** start から maxDist(m) 以内の各ノードへの最短道のり距離 */
export function shortestDistances(
  graph: Graph,
  start: number,
  maxDist: number,
): Map<number, number> {
  const dist = new Map<number, number>([[start, 0]]);
  const heap = new MinHeap();
  heap.push(0, start);
  while (heap.size > 0) {
    const [d, u] = heap.pop()!;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const { to, dist: w } of graph.adj.get(u) ?? []) {
      const nd = d + w;
      if (nd > maxDist || nd >= (dist.get(to) ?? Infinity)) continue;
      dist.set(to, nd);
      heap.push(nd, to);
    }
  }
  return dist;
}

export interface Segment {
  from: LatLon;
  to: LatLon;
  /** 区間の終端までに必要な徒歩分数（切り上げ） */
  minutes: number;
}

/**
 * 到達できた道路区間を徒歩分数ごとの線分にする。
 * 上限で途切れる区間は、ちょうど届く地点までで切る。
 */
export function reachableSegments(
  graph: Graph,
  dist: Map<number, number>,
  maxDist: number,
  metersPerMinute: number,
): Segment[] {
  const segments: Segment[] = [];
  for (const [u, du] of dist) {
    const pu = graph.coords.get(u)!;
    for (const { to: v, dist: len } of graph.adj.get(u) ?? []) {
      // 無向辺は両端から見えるので片側だけ処理する
      if (u > v) continue;
      const pv = graph.coords.get(v)!;
      const dv = dist.get(v);
      // 近い端点 → 遠い端点の向きに揃える
      const [near, far, dNear, dFar] =
        dv === undefined || du <= dv ? [pu, pv, du, dv] : [pv, pu, dv, du];
      const reachedFar = dFar !== undefined && dFar - dNear <= len + 1e-6;
      const farDist = dNear + len;
      if (reachedFar && dFar !== undefined) {
        segments.push({
          from: near,
          to: far,
          minutes: Math.max(1, Math.ceil(dFar / metersPerMinute)),
        });
      } else if (dNear < maxDist) {
        const t = (maxDist - dNear) / len;
        if (t > 0 && farDist > maxDist) {
          segments.push({
            from: near,
            to: lerp(near, far, Math.min(t, 1)),
            minutes: Math.max(1, Math.ceil(maxDist / metersPerMinute)),
          });
        }
      }
    }
  }
  return segments;
}
