import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXCLUDED_HIGHWAYS,
  buildWalkableWaysQuery,
  fetchWalkableWays,
  fetchWithFallback,
  isWalkableRoad,
  selectWalkableWays,
} from "./overpass";

const res = (status: number, body = `{"status":${status}}`) => new Response(body, { status });
const urls = ["https://a", "https://b"];
const opts = { rounds: 2, delayMs: 0 };

/** signal で中断されるまで応答しない fetch（サーバーが固まった状態） */
const hang = (_url: string, init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });

describe("fetchWithFallback", () => {
  it("504 なら次のサーバーで成功し、本文を返す", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(504)).mockResolvedValueOnce(res(200, "ok"));
    expect(await fetchWithFallback(urls, {}, opts, f)).toBe("ok");
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://a", "https://b"]);
  });

  it("全サーバー失敗なら待って次のラウンドを試す", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(504))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200, "ok"));
    expect(await fetchWithFallback(urls, {}, opts, f)).toBe("ok");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("リトライ対象外(400)は即エラー", async () => {
    const f = vi.fn().mockResolvedValue(res(400));
    await expect(fetchWithFallback(urls, {}, opts, f)).rejects.toThrow("400");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("全ラウンド失敗なら最後のエラーを投げる", async () => {
    const f = vi.fn().mockResolvedValue(res(504));
    await expect(fetchWithFallback(urls, {}, opts, f)).rejects.toThrow("504");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("ネットワークエラーでも次のサーバーを試す", async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(res(200, "ok"));
    expect(await fetchWithFallback(urls, {}, opts, f)).toBe("ok");
  });

  it("中断されたら再試行せず投げる", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(fetchWithFallback(urls, { signal: ac.signal }, opts, f)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });

  describe("タイムアウト", () => {
    it("応答が無いサーバーは打ち切って次へ進む", async () => {
      const f = vi.fn().mockImplementationOnce(hang).mockResolvedValueOnce(res(200, "ok"));
      const started = Date.now();
      expect(await fetchWithFallback(urls, {}, { ...opts, timeoutMs: 30 }, f)).toBe("ok");
      expect(f).toHaveBeenCalledTimes(2);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("全部タイムアウトならタイムアウトのエラーを投げる", async () => {
      const f = vi.fn().mockImplementation(hang);
      await expect(fetchWithFallback(urls, {}, { ...opts, timeoutMs: 20 }, f)).rejects.toThrow(
        "timeout",
      );
      expect(f).toHaveBeenCalledTimes(4);
    });

    it("本文のダウンロードが遅い場合もタイムアウト扱い", async () => {
      // ヘッダーはすぐ返るが、本文が届かないレスポンス
      const slowBody = (_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                init.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
              },
            }),
          ),
        );
      const f = vi.fn().mockImplementationOnce(slowBody).mockResolvedValueOnce(res(200, "ok"));
      expect(await fetchWithFallback(urls, {}, { ...opts, timeoutMs: 30 }, f)).toBe("ok");
    });

    it("利用者の中断はタイムアウトと区別し、再試行しない", async () => {
      const ac = new AbortController();
      const f = vi.fn().mockImplementation(hang);
      const p = fetchWithFallback(urls, { signal: ac.signal }, { ...opts, timeoutMs: 10_000 }, f);
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: "AbortError" });
      expect(f).toHaveBeenCalledTimes(1);
    });
  });
});

const line = [
  { lat: 35.716, lon: 140.126 },
  { lat: 35.717, lon: 140.127 },
];

describe("徒歩に含める道路", () => {
  it("クエリは trunk を落とさず、motorway と motorway_link は落とす", () => {
    const query = buildWalkableWaysQuery(35.716, 140.126, 800);
    expect(query).toContain('way["highway"]');
    expect(query).toContain('["foot"!~"^(no|private)$"]');
    expect(query).toContain('["access"!~"^(no|private)$"]');
    expect(query).not.toContain("trunk");
    for (const highway of EXCLUDED_HIGHWAYS) expect(query).toContain(highway);
    expect(EXCLUDED_HIGHWAYS).not.toContain("trunk");
    expect(EXCLUDED_HIGHWAYS).not.toContain("trunk_link");
  });

  it.each([
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "track",
    "path",
    "footway",
    "pedestrian",
    "steps",
    "cycleway",
  ])("%s は歩ける", (highway) => {
    expect(isWalkableRoad({ highway })).toBe(true);
  });

  it("成田街道のような trunk は歩ける。foot=no や自動車専用は歩かない", () => {
    expect(isWalkableRoad({ highway: "trunk", name: "成田街道", ref: "296" })).toBe(true);
    expect(isWalkableRoad({ highway: "trunk", name: "東京環状", ref: "16", foot: "no" })).toBe(false);
    expect(isWalkableRoad({ highway: "trunk", access: "private" })).toBe(false);
    expect(isWalkableRoad({ highway: "trunk", motorroad: "yes" })).toBe(false);
  });

  it("motorway と motorway_link は歩道タグがあっても歩かない", () => {
    expect(isWalkableRoad({ highway: "motorway", sidewalk: "both", foot: "yes" })).toBe(false);
    expect(
      isWalkableRoad({
        highway: "motorway_link",
        sidewalk: "both",
        foot: "yes",
        bridge: "yes",
        layer: "1",
      }),
    ).toBe(false);
  });

  it("trunk_link は地平で歩けるものだけ入れ、ランプは入れない", () => {
    // 勝田台の連絡路: 一方通行・歩道なし、または立体
    expect(isWalkableRoad({ highway: "trunk_link", lanes: "1", oneway: "yes" })).toBe(false);
    expect(
      isWalkableRoad({ highway: "trunk_link", bridge: "yes", layer: "2", oneway: "yes" }),
    ).toBe(false);
    // 立体に foot=yes や歩道が付いていてもランプの中心線は歩かない
    expect(
      isWalkableRoad({ highway: "trunk_link", bridge: "yes", layer: "1", foot: "yes", sidewalk: "left" }),
    ).toBe(false);
    expect(isWalkableRoad({ highway: "trunk_link", motorroad: "yes" })).toBe(false);
    expect(isWalkableRoad({ highway: "trunk_link", oneway: "yes", foot: "no" })).toBe(false);
    // 歩道が別 way のときは、リンクの中心線を歩道にしない
    expect(isWalkableRoad({ highway: "trunk_link", oneway: "yes", sidewalk: "separate" })).toBe(false);
    // 地平で歩行が明示されている一方通行、または一方通行でない接続路
    expect(isWalkableRoad({ highway: "trunk_link", oneway: "yes", foot: "yes" })).toBe(true);
    expect(isWalkableRoad({ highway: "trunk_link", oneway: "yes", sidewalk: "left" })).toBe(true);
    expect(isWalkableRoad({ highway: "trunk_link", oneway: "yes", "sidewalk:right": "yes" })).toBe(true);
    expect(isWalkableRoad({ highway: "trunk_link" })).toBe(true);
    expect(isWalkableRoad({ highway: "trunk_link", bridge: "no", layer: "0" })).toBe(true);
  });

  it("取得結果では成田街道を残し、ランプと高速の連絡路は落とす", () => {
    const ways = selectWalkableWays([
      {
        type: "way",
        nodes: [1, 2],
        geometry: line,
        tags: { highway: "trunk", name: "成田街道", ref: "296" },
      },
      {
        type: "way",
        nodes: [3, 4],
        geometry: line,
        tags: { highway: "trunk_link", oneway: "yes", lanes: "1" },
      },
      {
        type: "way",
        nodes: [5, 6],
        geometry: line,
        tags: { highway: "trunk_link", bridge: "yes", layer: "2", oneway: "yes" },
      },
      {
        type: "way",
        nodes: [7, 8],
        geometry: line,
        tags: { highway: "motorway_link", sidewalk: "both", foot: "yes", bridge: "yes" },
      },
      {
        type: "way",
        nodes: [9, 10],
        geometry: line,
        tags: { highway: "residential" },
      },
    ]);
    expect(ways.map((w) => w.nodes[0])).toEqual([1, 9]);
  });
});

describe("fetchWalkableWays", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("trunk を含むクエリで取り、歩ける道だけ返す", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const query = (init?.body as URLSearchParams).get("data") ?? "";
      expect(query).toBe(buildWalkableWaysQuery(35.716, 140.126, 800));
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: "way",
              nodes: [443008229, 2],
              geometry: line,
              tags: { highway: "trunk", name: "成田街道", ref: "296" },
            },
            {
              type: "way",
              nodes: [23024181, 4],
              geometry: line,
              tags: { highway: "trunk_link", oneway: "yes", lanes: "1", surface: "paved" },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const ways = await fetchWalkableWays([35.716, 140.126], 800);
    expect(ways).toEqual([{ nodes: [443008229, 2], geometry: line }]);
  });
});
