import { describe, expect, it } from "vitest";
import { haversine, lerp, type LatLon } from "./geo";
import { buildGraph, reachableSegments, shortestDistances, type Segment } from "./graph";
import { walkingMinutesAt } from "./walkTime";

const seg = (from: LatLon, to: LatLon, minutes: number): Segment => ({ from, to, minutes });

/** 東へ meters だけ動かした点（localOffset と同じ換算） */
function eastOf(origin: LatLon, meters: number): LatLon {
  const mPerDeg = (Math.PI / 180) * 6_371_000;
  const dLon = meters / (mPerDeg * Math.cos((origin[0] * Math.PI) / 180));
  return [origin[0], origin[1] + dLon];
}

describe("walkingMinutesAt", () => {
  const road = seg([0, 0], [0, 0.001], 4);

  it("線分の上では、その色が表す徒歩分数を返す", () => {
    expect(walkingMinutesAt([road], [0, 0.0005], 1)).toBe(4);
    expect(walkingMinutesAt([road], [0, 0], 1)).toBe(4);
    expect(walkingMinutesAt([road], [0, 0.001], 1)).toBe(4);
  });

  it("許容距離の外や、着色区間が無いときは分数を返さない", () => {
    expect(walkingMinutesAt([], [0, 0], 1_000)).toBeUndefined();
    expect(walkingMinutesAt([road], [0, 0.0005], -1)).toBeUndefined();
    // 線分の延長上（道は続いているが、この区間の外）
    expect(walkingMinutesAt([road], [0, 0.002], 20)).toBeUndefined();
    expect(walkingMinutesAt([road], [0.001, 0.0005], 20)).toBeUndefined();
  });

  it("線のすぐ横は拾い、それより遠い道は拾わない", () => {
    const lat = 35.681236;
    const lon = 139.767;
    // 南北の道。東へのずれは経度の縮尺が合っていないと距離が狂う
    const road = seg([lat, lon], [lat + 0.001, lon], 6);
    const onRoad: LatLon = [lat + 0.0005, lon];
    const beside = eastOf(onRoad, 12);
    expect(haversine(onRoad, beside)).toBeCloseTo(12, 0);
    expect(walkingMinutesAt([road], beside, 11)).toBeUndefined();
    expect(walkingMinutesAt([road], beside, 13)).toBe(6);
  });

  it("近い区間を優先し、重なっているときは小さい分数（上に描かれる色）を返す", () => {
    const high = seg([0, 0], [0, 0.001], 8);
    const lowFar = seg([0.0002, 0], [0.0002, 0.001], 1);
    expect(walkingMinutesAt([lowFar, high], [0, 0.0005], 40)).toBe(8);

    const low = seg([0, 0], [0, 0.001], 3);
    expect(walkingMinutesAt([high, low], [0, 0.0005], 5)).toBe(3);
    expect(walkingMinutesAt([low, high], [0, 0.0005], 5)).toBe(3);
  });

  it("点だけの区間も、その位置に近ければ分数を返す", () => {
    const dot = seg([0, 0], [0, 0], 2);
    expect(walkingMinutesAt([dot], [0, 0], 1)).toBe(2);
    expect(walkingMinutesAt([dot], [0, 0.001], 10)).toBeUndefined();
  });
});

describe("着色データの徒歩分数", () => {
  const way = {
    nodes: [1, 2, 3, 4],
    geometry: [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.001 },
      { lat: 0, lon: 0.002 },
      { lat: 0, lon: 0.003 },
    ],
  };

  it("カーソル位置の分数は、その区間の色と同じ。届かない先の道は出さない", () => {
    const graph = buildGraph([way]);
    const max = 250; // 80m/分なら 3分と少し。最後のノードまでは届かない
    const segs = reachableSegments(graph, shortestDistances(graph, 1, max), max, 80);
    expect(new Set(segs.map((s) => s.minutes)).size).toBeGreaterThan(1);

    for (const s of segs) {
      expect(walkingMinutesAt(segs, lerp(s.from, s.to, 0.5), 15)).toBe(s.minutes);
    }
    // ノード4は道の上だが、上限で切れた先なので色が付かない
    expect(walkingMinutesAt(segs, [0, 0.003], 20)).toBeUndefined();
    expect(walkingMinutesAt(segs, [0.01, 0], 50)).toBeUndefined();
  });
});
