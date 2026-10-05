import type { LatLon } from "./geo";
import type { OsmWay } from "./graph";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** 混雑・タイムアウト系で、別サーバーや再試行で解決しうるステータス */
const RETRYABLE = new Set([429, 502, 503, 504]);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * 各エンドポイントを順に試し、混雑系エラーやタイムアウトなら次のサーバーへ。
 * 全部失敗したら少し待って rounds 回まで繰り返す。成功したら本文を返す。
 * timeoutMs は1サーバーあたりの上限（本文のダウンロードまで含む）。
 */
export async function fetchWithFallback(
  endpoints: string[],
  init: RequestInit,
  {
    rounds = 2,
    delayMs = 1500,
    timeoutMs = 15_000,
  }: { rounds?: number; delayMs?: number; timeoutMs?: number } = {},
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const userSignal = init.signal ?? undefined;
  let lastError: Error = new Error("Overpass API error: no endpoint");
  for (let round = 0; round < rounds; round++) {
    if (round > 0) await sleep(delayMs, userSignal);
    for (const url of endpoints) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
      try {
        const res = await fetchFn(url, { ...init, signal });
        if (res.ok) return await res.text();
        lastError = new Error(`Overpass API error: ${res.status}`);
        if (!RETRYABLE.has(res.status)) throw lastError;
      } catch (e) {
        if (userSignal?.aborted || e === lastError) throw e;
        // タイムアウト・ネットワーク断・CORS 失敗なども次のサーバーで再試行
        lastError = timeout.aborted
          ? new Error(`Overpass API timeout (${timeoutMs / 1000}s)`)
          : e instanceof Error
            ? e
            : new Error(String(e));
      }
    }
  }
  throw lastError;
}

/**
 * サーバ側で落とす道路種別。
 * trunk（成田街道のような一般道）は歩けるので、このリストには入れない。
 * motorway / motorway_link は歩道タグが付いていても落とす。立体のランプを歩道としては扱わない。
 */
export const EXCLUDED_HIGHWAYS = [
  "motorway",
  "motorway_link",
  "proposed",
  "construction",
  "raceway",
  "bus_guideway",
  "bridleway",
] as const;

const excludedHighway = new Set<string>(EXCLUDED_HIGHWAYS);
const forbiddenAccess = /^(no|private)$/;
const explicitFoot = new Set(["yes", "designated", "permissive"]);
const explicitSidewalk = new Set(["yes", "both", "left", "right"]);
const sidewalkKeys = ["sidewalk", "sidewalk:left", "sidewalk:right", "sidewalk:both"] as const;

/**
 * trunk_link は既定では入れない。ほとんどがランプ・スリップ路だから。
 * 人が実際に歩けるものだけ残す。
 * - motorroad=yes、または bridge / tunnel / layer≠0 の立体は自動車用ランプとして除外。
 *   sidewalk や foot=yes が付いていても中心線は歩道にしない（歩く面は別の way になる）。
 * - 地平で foot=yes|designated|permissive、または way 上の歩道タグがあるものは入れる。
 * - 地平で一方通行でなく、歩行禁止でもないものは街路の接続として入れる。
 * - 地平の一方通行で歩行タグが無いものは自動車用スリップ路として除外
 *   （勝田台の成田街道×東京環状の連絡路がこの形。成田街道本体は trunk 同士でつながっている）。
 */
function trunkLinkIsWalkable(tags: Record<string, string>): boolean {
  if (tags.motorroad === "yes") return false;
  if (isGradeSeparated(tags)) return false;
  if (hasExplicitPedestrianAccess(tags)) return true;
  return !isOneway(tags);
}

function isGradeSeparated(tags: Record<string, string>): boolean {
  if (tags.bridge !== undefined && tags.bridge !== "no") return true;
  if (tags.tunnel !== undefined && tags.tunnel !== "no") return true;
  return tags.layer !== undefined && tags.layer !== "0";
}

function isOneway(tags: Record<string, string>): boolean {
  const oneway = tags.oneway;
  return oneway === "yes" || oneway === "1" || oneway === "-1" || oneway === "reverse";
}

function hasExplicitPedestrianAccess(tags: Record<string, string>): boolean {
  if (explicitFoot.has(tags.foot ?? "")) return true;
  return sidewalkKeys.some((key) => explicitSidewalk.has(tags[key] ?? ""));
}

/** タグから、徒歩ネットワークに入れる道かどうかを決める */
export function isWalkableRoad(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  const { highway } = tags;
  if (!highway || excludedHighway.has(highway)) return false;
  if (forbiddenAccess.test(tags.foot ?? "") || forbiddenAccess.test(tags.access ?? "")) return false;
  // trunk の自動車専用（motorroad）は成田街道のような一般道ではない
  if (highway === "trunk" && tags.motorroad === "yes") return false;
  if (highway === "trunk_link") return trunkLinkIsWalkable(tags);
  return true;
}

export function buildWalkableWaysQuery(lat: number, lon: number, radius: number): string {
  const excluded = EXCLUDED_HIGHWAYS.join("|");
  return `
    [out:json][timeout:25];
    way["highway"]
      ["highway"!~"^(${excluded})$"]
      ["foot"!~"^(no|private)$"]
      ["access"!~"^(no|private)$"]
      (around:${Math.ceil(radius)},${lat},${lon});
    out geom;`;
}

interface OverpassWay {
  type: string;
  nodes?: number[];
  geometry?: OsmWay["geometry"];
  tags?: Record<string, string>;
}

/** Overpass の要素から、歩ける way だけを取り出す。trunk_link のランプはここで落とす */
export function selectWalkableWays(elements: OverpassWay[]): OsmWay[] {
  return elements.flatMap((e) =>
    e.type === "way" && e.nodes && e.geometry && isWalkableRoad(e.tags)
      ? [{ nodes: e.nodes, geometry: e.geometry }]
      : [],
  );
}

/** 徒歩で通れない道を除いた、center から radius(m) 以内の道路を取得する */
export async function fetchWalkableWays(
  center: LatLon,
  radius: number,
  signal?: AbortSignal,
): Promise<OsmWay[]> {
  const [lat, lon] = center;
  const text = await fetchWithFallback(ENDPOINTS, {
    method: "POST",
    body: new URLSearchParams({ data: buildWalkableWaysQuery(lat, lon, radius) }),
    ...(signal ? { signal } : {}),
  });

  const json = JSON.parse(text) as { elements: OverpassWay[] };
  return selectWalkableWays(json.elements);
}

export async function geocode(q: string): Promise<LatLon | undefined> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "Accept-Language": "ja" } });
  if (!res.ok) throw new Error(`Nominatim error: ${res.status}`);
  const [hit] = (await res.json()) as { lat: string; lon: string }[];
  return hit ? [Number(hit.lat), Number(hit.lon)] : undefined;
}
