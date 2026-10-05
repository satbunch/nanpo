import type { LatLon } from "./geo";
import {
  buildGraph,
  nearestNode,
  reachableSegments,
  shortestDistances,
  type Graph,
  type OsmWay,
  type Segment,
} from "./graph";

/** 起点の周り radius(m) 以内の道路グラフ。radius 以下の徒歩圏ならこれだけで計算できる */
export interface Area {
  origin: LatLon;
  radius: number;
  graph: Graph;
  /** 起点に最も近いノード。歩ける道が無ければ undefined */
  start: number | undefined;
}

export type FetchWays = (center: LatLon, radius: number, signal: AbortSignal) => Promise<OsmWay[]>;

/** 取得した道路データの永続化先（IndexedDB など）。失敗しても動作は続ける */
export interface WayStore {
  get(key: string): Promise<StoredWays | undefined>;
  put(key: string, value: StoredWays): Promise<void>;
}

/**
 * 徒歩ネットワークの定義。変えたら上げる。
 * 保存データにこの値が無い（trunk を落としていた頃）か、違う場合は使わない。
 * 上げないと、リロードや再訪で IndexedDB の古い道路が trunk を隠し続ける。
 */
export const WALK_NETWORK_VERSION = 2;

export interface StoredWays {
  radius: number;
  ways: OsmWay[];
  savedAt: number;
  /** この道路データを取ったときの徒歩ネットワークの定義。無いものは古い */
  networkVersion?: number;
}

export interface AreaLoaderOptions {
  store?: WayStore;
  /** メモリに保持する起点の数（グラフは大きいので少なめ） */
  maxAreas?: number;
  /** 保存データの有効期限。道路は頻繁には変わらないが、古すぎるのは避ける */
  maxAgeMs?: number;
  now?: () => number;
}

/** 同じ地点を同じキーにする（小数6桁 ≒ 0.1m） */
export const originKey = ([lat, lon]: LatLon) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

/**
 * 道路データの取得とキャッシュ。
 * - 最近の起点を maxAreas 件までメモリに保持（古いものから捨てる）
 * - メモリに無ければ store（ブラウザ保存）を見て、それも無ければネットワークへ
 * - 保存の networkVersion が現行と違うときは、半径が足りていても取り直す
 * - 取得中の要求で足りるなら、それを待つ（重複リクエストしない）
 * - 起点が変わったら、取得中の古い要求は中断する
 */
export class AreaLoader {
  /** 挿入順 = 古い順。参照したら末尾に付け直す（LRU） */
  private readonly areas = new Map<string, Area>();
  private pending:
    | { key: string; radius: number; promise: Promise<Area>; controller: AbortController }
    | undefined;
  private readonly store: WayStore | undefined;
  private readonly maxAreas: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    private readonly fetchWays: FetchWays,
    { store, maxAreas = 5, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now }: AreaLoaderOptions = {},
  ) {
    this.store = store;
    this.maxAreas = maxAreas;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  /** ネットワークにもストレージにも行かずに使えるエリア */
  cached(origin: LatLon, radius: number): Area | undefined {
    const key = originKey(origin);
    const a = this.areas.get(key);
    if (!a || a.radius < radius) return undefined;
    this.areas.delete(key);
    this.areas.set(key, a);
    return a;
  }

  load(origin: LatLon, radius: number): Promise<Area> {
    const hit = this.cached(origin, radius);
    if (hit) return Promise.resolve(hit);

    const key = originKey(origin);
    const p = this.pending;
    if (p && p.key === key && p.radius >= radius) return p.promise;
    // 古い起点の取得は不要。同じ起点でも半径が足りないなら取り直す
    p?.controller.abort();

    const controller = new AbortController();
    const promise = this.loadWays(key, origin, radius, controller.signal).then(
      ({ ways, radius: got }) => {
        const graph = buildGraph(ways);
        const area: Area = { origin, radius: got, graph, start: nearestNode(graph, origin) };
        // 先に大きいエリアが取れていたら、小さいもので上書きしない
        if (!this.cached(origin, got)) this.remember(key, area);
        return area;
      },
    );
    const entry = { key, radius, promise, controller };
    this.pending = entry;
    const clear = () => {
      if (this.pending === entry) this.pending = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  /** 後で使いそうな範囲を裏で取得しておく。失敗しても無視 */
  prefetch(origin: LatLon, radius: number): void {
    this.load(origin, radius).catch(() => {});
  }

  private async loadWays(key: string, origin: LatLon, radius: number, signal: AbortSignal) {
    const stored = await this.store?.get(key).catch(() => undefined);
    signal.throwIfAborted();
    if (
      stored &&
      stored.networkVersion === WALK_NETWORK_VERSION &&
      stored.radius >= radius &&
      this.now() - stored.savedAt <= this.maxAgeMs
    ) {
      // 保存済みの半径のほうが大きければ、その分も使える
      return { ways: stored.ways, radius: stored.radius };
    }
    const ways = await this.fetchWays(origin, radius, signal);
    void this.store
      ?.put(key, { radius, ways, savedAt: this.now(), networkVersion: WALK_NETWORK_VERSION })
      .catch(() => {});
    return { ways, radius };
  }

  private remember(key: string, area: Area) {
    this.areas.delete(key);
    this.areas.set(key, area);
    while (this.areas.size > this.maxAreas) {
      const oldest = this.areas.keys().next().value!;
      this.areas.delete(oldest);
    }
  }
}

/** エリア内で、徒歩 minutes 分以内に行ける線分を求める */
export function computeSegments(area: Area, minutes: number, metersPerMinute: number): Segment[] {
  if (area.start === undefined) return [];
  const maxDist = minutes * metersPerMinute;
  const dist = shortestDistances(area.graph, area.start, maxDist);
  return reachableSegments(area.graph, dist, maxDist, metersPerMinute);
}

/** 直線距離 ≦ 道のり距離なので、徒歩距離 + 余白の半径を取れば取りこぼさない */
export const fetchRadius = (minutes: number, metersPerMinute: number) =>
  minutes * metersPerMinute + 50;
