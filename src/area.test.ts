import { describe, expect, it, vi } from "vitest";
import {
  AreaLoader,
  WALK_NETWORK_VERSION,
  computeSegments,
  fetchRadius,
  originKey,
  type FetchWays,
  type StoredWays,
} from "./area";
import { haversine, type LatLon } from "./geo";
import type { OsmWay } from "./graph";

// 東京駅付近に 40m 間隔の格子状の道（約 2km 四方）
const lat0 = 35.681;
const lon0 = 139.767;
const mLat = 1 / 111_200;
const mLon = mLat / Math.cos((lat0 * Math.PI) / 180);
const N = 25;
const B = 40;
const node = (i: number, j: number) => (i + N) * 1000 + (j + N);
const pt = (i: number, j: number) => ({ lat: lat0 + j * B * mLat, lon: lon0 + i * B * mLon });
const city: OsmWay[] = [];
for (let k = -N; k <= N; k++) {
  const idx = Array.from({ length: 2 * N + 1 }, (_, t) => t - N);
  city.push({ nodes: idx.map((i) => node(i, k)), geometry: idx.map((i) => pt(i, k)) });
  city.push({ nodes: idx.map((j) => node(k, j)), geometry: idx.map((j) => pt(k, j)) });
}

/** Overpass の around と同じく、範囲内にノードを1つでも持つ way を丸ごと返す */
const fakeOverpass: FetchWays = async (center, radius) =>
  city.filter((w) => w.geometry.some((g) => haversine(center, [g.lat, g.lon]) <= radius));

const origin: LatLon = [lat0, lon0];
const other: LatLon = [lat0 + 0.001, lon0];

/** 保存先の確認などの非同期処理が済んで、fetch が呼ばれるまで待つ */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 外から resolve できる fetch（取得中の状態を作る） */
function deferredFetch() {
  const calls: { radius: number; signal: AbortSignal; resolve: () => void }[] = [];
  const fetchWays: FetchWays = (center, radius, signal) =>
    new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      calls.push({ radius, signal, resolve: () => void fakeOverpass(center, radius, signal).then(resolve) });
    });
  return { calls, fetchWays };
}

describe("AreaLoader のキャッシュ", () => {
  it("取得済みの半径に収まる要求はネットワークに行かない", async () => {
    const f = vi.fn(fakeOverpass);
    const loader = new AreaLoader(f);
    await loader.load(origin, fetchRadius(20, 80));
    for (const m of [1, 5, 10, 19, 20]) await loader.load(origin, fetchRadius(m, 80));
    expect(f).toHaveBeenCalledTimes(1);
    expect(loader.cached(origin, fetchRadius(20, 80))).toBeDefined();
  });

  it("半径が足りなければ取り直す", async () => {
    const f = vi.fn(fakeOverpass);
    const loader = new AreaLoader(f);
    await loader.load(origin, fetchRadius(10, 80));
    expect(loader.cached(origin, fetchRadius(11, 80))).toBeUndefined();
    await loader.load(origin, fetchRadius(11, 80));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("新しい起点は取得し、前の起点もキャッシュに残る", async () => {
    const f = vi.fn(fakeOverpass);
    const loader = new AreaLoader(f);
    await loader.load(origin, 500);
    await loader.load(other, 500);
    expect(f).toHaveBeenCalledTimes(2);
    expect(loader.cached(origin, 500)).toBeDefined();
  });

  it("取得中の要求で足りるなら相乗りする", async () => {
    const { calls, fetchWays } = deferredFetch();
    const loader = new AreaLoader(fetchWays);
    const big = loader.load(origin, 1650);
    const small = loader.load(origin, 500);
    await tick();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve();
    expect(await small).toBe(await big);
  });

  it("起点が変わったら取得中の古い要求を中断する", async () => {
    const { calls, fetchWays } = deferredFetch();
    const loader = new AreaLoader(fetchWays);
    const old = loader.load(origin, 500);
    await tick();
    expect(calls).toHaveLength(1);
    const next = loader.load(other, 500);
    expect(calls[0]!.signal.aborted).toBe(true);
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    calls[1]!.resolve();
    expect((await next).origin).toBe(other);
  });

  it("fetch を始める前に起点が変わったら、古い起点の fetch 自体をしない", async () => {
    const { calls, fetchWays } = deferredFetch();
    const loader = new AreaLoader(fetchWays);
    const old = loader.load(origin, 500);
    const next = loader.load(other, 500);
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve();
    expect((await next).origin).toBe(other);
  });

  it("先読みが後から終わっても、大きいエリアを小さいもので上書きしない", async () => {
    const { calls, fetchWays } = deferredFetch();
    const loader = new AreaLoader(fetchWays);
    const big = loader.load(origin, 1650);
    await tick();
    calls[0]!.resolve();
    await big;
    // 大きいエリアがあるので、小さい要求はキャッシュから返る
    await loader.load(origin, 500);
    expect(calls).toHaveLength(1);
    expect(loader.cached(origin, 1650)).toBeDefined();
  });

  it("prefetch の失敗は握りつぶし、キャッシュも汚さない", async () => {
    const loader = new AreaLoader(() => Promise.reject(new Error("504")));
    loader.prefetch(origin, 1650);
    await new Promise((r) => setTimeout(r, 0));
    expect(loader.cached(origin, 1650)).toBeUndefined();
  });
});

describe("computeSegments", () => {
  // キャッシュの前提: 大きく取ったエリアで計算しても、ちょうどの半径で取った場合と結果が同じ
  it.each([1, 3, 7, 10])("徒歩%i分: 最大範囲のキャッシュと、ちょうどの範囲で同じ結果", async (m) => {
    const exact = await new AreaLoader(fakeOverpass).load(origin, fetchRadius(m, 80));
    const big = await new AreaLoader(fakeOverpass).load(origin, fetchRadius(20, 80));
    const key = (s: { from: LatLon; to: LatLon; minutes: number }) =>
      `${s.from.map((v) => v.toFixed(7))}|${s.to.map((v) => v.toFixed(7))}|${s.minutes}`;
    const a = computeSegments(exact, m, 80).map(key).sort();
    const b = computeSegments(big, m, 80).map(key).sort();
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it("歩ける道が無ければ空", async () => {
    const area = await new AreaLoader(async () => []).load(origin, 500);
    expect(area.start).toBeUndefined();
    expect(computeSegments(area, 10, 80)).toEqual([]);
  });
});

/** テスト用のメモリ上の WayStore */
function memoryStore() {
  const data = new Map<string, StoredWays>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: StoredWays) => void data.set(key, value)),
  };
}

const third: LatLon = [lat0, lon0 + 0.001];

describe("AreaLoader の複数起点キャッシュ", () => {
  it("起点を行き来しても再取得しない", async () => {
    const f = vi.fn(fakeOverpass);
    const loader = new AreaLoader(f);
    await loader.load(origin, 500);
    await loader.load(other, 500);
    await loader.load(origin, 500);
    await loader.load(other, 500);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("上限を超えたら一番長く使っていない起点を捨てる", async () => {
    const f = vi.fn(fakeOverpass);
    const loader = new AreaLoader(f, { maxAreas: 2 });
    await loader.load(origin, 500);
    await loader.load(other, 500);
    loader.cached(origin, 500); // origin を使ったので、other が一番古くなる
    await loader.load(third, 500);
    expect(loader.cached(origin, 500)).toBeDefined();
    expect(loader.cached(third, 500)).toBeDefined();
    expect(loader.cached(other, 500)).toBeUndefined();
  });

  it("ほぼ同じ座標(0.1m未満の差)は同じ起点として扱う", () => {
    expect(originKey([35.6812361, 139.7671251])).toBe(originKey([35.6812364, 139.7671249]));
    expect(originKey([35.681236, 139.767125])).not.toBe(originKey([35.681246, 139.767125]));
  });
});

describe("AreaLoader のブラウザ保存", () => {
  const day = 24 * 60 * 60 * 1000;

  it("取得したデータを保存し、次回(リロード後)はネットワークに行かない", async () => {
    const store = memoryStore();
    const f = vi.fn(fakeOverpass);
    await new AreaLoader(f, { store }).load(origin, 500);
    expect(store.put).toHaveBeenCalledTimes(1);

    // リロード = メモリが空の新しい loader
    const area = await new AreaLoader(f, { store }).load(origin, 500);
    expect(f).toHaveBeenCalledTimes(1);
    expect(area.start).toBeDefined();
  });

  it("保存済みの半径が大きければ、その分もメモリに載る", async () => {
    const store = memoryStore();
    await new AreaLoader(fakeOverpass, { store }).load(origin, 1650);
    const f = vi.fn(fakeOverpass);
    const loader = new AreaLoader(f, { store });
    await loader.load(origin, 500);
    expect(loader.cached(origin, 1650)).toBeDefined();
    expect(f).not.toHaveBeenCalled();
  });

  it("保存済みの半径が足りなければ取り直して上書きする", async () => {
    const store = memoryStore();
    await new AreaLoader(fakeOverpass, { store }).load(origin, 500);
    const f = vi.fn(fakeOverpass);
    await new AreaLoader(f, { store }).load(origin, 1650);
    expect(f).toHaveBeenCalledTimes(1);
    expect(store.data.get(originKey(origin))!.radius).toBe(1650);
  });

  it("期限切れのデータは使わない", async () => {
    const store = memoryStore();
    let now = 0;
    await new AreaLoader(fakeOverpass, { store, now: () => now }).load(origin, 500);

    const f = vi.fn(fakeOverpass);
    now = 7 * day; // ちょうど期限内
    await new AreaLoader(f, { store, now: () => now }).load(origin, 500);
    expect(f).not.toHaveBeenCalled();

    now = 7 * day + 1;
    await new AreaLoader(f, { store, now: () => now }).load(origin, 500);
    expect(f).toHaveBeenCalledTimes(1);
    expect(store.data.get(originKey(origin))!.savedAt).toBe(now);
  });

  it("保存先が壊れていても(読み書き失敗)、ネットワークから取って表示できる", async () => {
    const store = {
      get: vi.fn().mockRejectedValue(new Error("IndexedDB is not available")),
      put: vi.fn().mockRejectedValue(new Error("QuotaExceededError")),
    };
    const f = vi.fn(fakeOverpass);
    const area = await new AreaLoader(f, { store }).load(origin, 500);
    expect(area.start).toBeDefined();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["バージョンが無い", undefined],
    ["定義が古い", 1],
  ])("%s保存データは期限内でも使わず、取り直す", async (_label, networkVersion) => {
    const store = memoryStore();
    const now = 1_000_000;
    const key = originKey(origin);
    // 半径は足りている。バージョンを見ないと、trunk の無い古い道路のままになる
    store.data.set(key, {
      radius: 1650,
      savedAt: now,
      ways: [],
      ...(networkVersion === undefined ? {} : { networkVersion }),
    });
    const first = vi.fn(fakeOverpass);
    const area = await new AreaLoader(first, { store, now: () => now }).load(origin, 500);
    expect(first).toHaveBeenCalledTimes(1);
    expect(area.start).toBeDefined();
    expect(store.data.get(key)).toMatchObject({ networkVersion: WALK_NETWORK_VERSION, radius: 500 });

    const second = vi.fn(fakeOverpass);
    await new AreaLoader(second, { store, now: () => now }).load(origin, 500);
    expect(second).not.toHaveBeenCalled();
  });

  it("保存先の読み込み中に起点が変わったら、古い起点のためにネットワークに行かない", async () => {
    let release!: () => void;
    const store = memoryStore();
    store.get.mockImplementationOnce(
      () => new Promise<undefined>((r) => (release = () => r(undefined))),
    );
    const f = vi.fn(fakeOverpass);
    const loader = new AreaLoader(f, { store });
    const old = loader.load(origin, 500);
    const next = loader.load(other, 500);
    release();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    await next;
    expect(f.mock.calls.map((c) => c[0])).toEqual([other]);
  });
});
