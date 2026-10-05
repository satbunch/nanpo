import { describe, expect, it } from "vitest";
import { buildGraph, nearestNode, reachableSegments, shortestDistances } from "./graph";

// 緯度0°上で東に一直線の道（経度0.001° ≒ 111.2m）
const line = {
  nodes: [1, 2, 3],
  geometry: [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
    { lat: 0, lon: 0.002 },
  ],
};

describe("shortestDistances", () => {
  const graph = buildGraph([line]);

  it("上限内のノードだけ距離を返す", () => {
    const dist = shortestDistances(graph, 1, 150);
    expect(dist.get(2)).toBeCloseTo(111.19, 0);
    expect(dist.has(3)).toBe(false);
  });

  it("最寄りノードを選ぶ", () => {
    expect(nearestNode(graph, [0, 0.0019])).toBe(3);
  });
});

describe("reachableSegments", () => {
  const graph = buildGraph([line]);

  it("徒歩分数は切り上げ、上限で線分が切られる", () => {
    const max = 160; // 80m/分 × 2分
    const segs = reachableSegments(graph, shortestDistances(graph, 1, max), max, 80);
    expect(segs).toHaveLength(2);
    const [first, second] = segs.sort((a, b) => a.minutes - b.minutes);
    expect(first!.minutes).toBe(2); // 111m → 2分
    expect(second!.minutes).toBe(2);
    // 2本目は 160m 地点（経度 ≒ 0.001+0.00044）で止まる
    expect(second!.to[1]).toBeCloseTo(0.001 + (160 - 111.19) / 111.19 * 0.001, 5);
  });
});
