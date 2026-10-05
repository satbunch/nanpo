import { localOffset, type LatLon } from "./geo";
import type { Segment } from "./graph";

/**
 * 着色された道路のうち、point から toleranceM(m) 以内で最も近い区間の徒歩分数。
 * 返す値は、その区間の色が表している分数（終端までの道のりを切り上げたもの）。
 * 届く範囲の外など、近い着色区間が無ければ undefined。
 * 同じ場所で重なるときは、あとから描かれる小さい分数を優先する。
 */
export function walkingMinutesAt(
  segments: readonly Segment[],
  point: LatLon,
  toleranceM: number,
): number | undefined {
  if (!(toleranceM >= 0) || segments.length === 0) return undefined;

  let bestDist = Infinity;
  let bestMinutes: number | undefined;
  for (const seg of segments) {
    const dist = distanceToSegment(point, seg.from, seg.to);
    if (dist > toleranceM) continue;
    if (
      bestMinutes === undefined ||
      dist < bestDist - 1e-4 ||
      (dist <= bestDist + 1e-4 && seg.minutes < bestMinutes)
    ) {
      bestDist = dist;
      bestMinutes = seg.minutes;
    }
  }
  return bestMinutes;
}

/** 点から線分までの平面距離(m)。線分の外側は端点までの距離 */
function distanceToSegment(point: LatLon, from: LatLon, to: LatLon): number {
  const [ax, ay] = localOffset(point, from);
  const [bx, by] = localOffset(point, to);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(ax, ay);
  const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
