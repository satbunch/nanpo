import L from "leaflet";
import "leaflet/dist/leaflet.css";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";
import type { LatLon } from "./geo";
import { AreaLoader, computeSegments, fetchRadius, type Area } from "./area";
import { createIdbStore } from "./idbStore";
import type { Segment } from "./graph";
import { fetchWalkableWays, geocode } from "./overpass";
import { walkingMinutesAt } from "./walkTime";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const minutesInput = $<HTMLInputElement>("minutes");
const minutesOut = $<HTMLOutputElement>("minutes-out");
const mpmInput = $<HTMLInputElement>("mpm");
const statusEl = $("status");
const legendEl = $("legend");
const tipEl = $<HTMLDivElement>("walk-tip");
const tipSwatch = tipEl.querySelector("i") as HTMLElement;
const tipText = tipEl.querySelector("span") as HTMLElement;

// ダブルクリックは起点の変更に使うので、既定のダブルクリックズームは切る
const map = L.map("map", { doubleClickZoom: false }).setView([35.681236, 139.767125], 15); // 東京駅
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

// 結果専用のペイン。読み込み中は薄くして「古い表示」だと分かるようにする
const resultPane = map.createPane("result");
const renderer = L.canvas({ pane: "result" });
const resultLayer = L.layerGroup().addTo(map);
// 既定アイコンは CSS から画像パスを推測するため、バンドル後に壊れる。明示的に渡す
const icon = L.icon({ ...L.Icon.Default.prototype.options, iconUrl, iconRetinaUrl, shadowUrl });
const marker = L.marker([35.681236, 139.767125], { icon }).addTo(map);

/** 近い=緑 → 遠い=赤 */
const colorFor = (minute: number, max: number) =>
  `hsl(${120 - (120 * (minute - 1)) / Math.max(1, max - 1)}, 80%, 45%)`;

/** 描画の太さ。当たり判定はこの半径 + にじみ1px（色のついた画素の上だけ） */
const ROAD_WEIGHT_PX = 4;
const ROAD_HIT_PX = ROAD_WEIGHT_PX / 2 + 1;

let origin: LatLon = [35.681236, 139.767125];
// 最近の起点はメモリに、取得した道路データはブラウザ（IndexedDB）にも保存
const loader = new AreaLoader(fetchWalkableWays, { store: createIdbStore() });
/** 最後に始めた update だけ描画するための通し番号 */
let seq = 0;
/** いま描いている着色区間と、凡例の最大分数 */
let colored: Segment[] = [];
let minuteMax = 1;
/** 地図上の最後のカーソル位置（ビューポート座標） */
let pointer: { x: number; y: number } | undefined;
let tipFrame: number | undefined;
let tipMinute: number | undefined;
let tipMax: number | undefined;

function setLoading(message: string | undefined) {
  document.body.classList.toggle("loading", message !== undefined);
  resultPane.classList.toggle("stale", message !== undefined);
  if (message !== undefined) statusEl.textContent = message;
}

async function update() {
  const id = ++seq;
  const minutes = Number(minutesInput.value);
  const mpm = Number(mpmInput.value) || 80;
  const at = origin;
  marker.setLatLng(at);

  try {
    let area = loader.cached(at, fetchRadius(minutes, mpm));
    if (!area) {
      setLoading("道路データを取得中…");
      area = await loader.load(at, fetchRadius(minutes, mpm));
      if (id !== seq) return;
    }
    render(area, minutes, mpm);
    setLoading(undefined);
    // スライダーを最大まで動かしても再取得しないよう、裏で先読み
    loader.prefetch(at, fetchRadius(Number(minutesInput.max), mpm));
  } catch (e) {
    if (id !== seq || (e as Error).name === "AbortError") return;
    setLoading(undefined);
    statusEl.textContent = `エラー: ${(e as Error).message}`;
  }
}

function render(area: Area, minutes: number, mpm: number) {
  minuteMax = minutes;
  if (area.start === undefined) {
    resultLayer.clearLayers();
    colored = [];
    syncTip();
    statusEl.textContent = "近くに歩ける道が見つからなかったよ";
    return;
  }
  colored = computeSegments(area, minutes, mpm);
  const byMinute = new Map<number, LatLon[][]>();
  for (const s of colored) {
    let lines = byMinute.get(s.minutes);
    if (!lines) byMinute.set(s.minutes, (lines = []));
    lines.push([s.from, s.to]);
  }

  resultLayer.clearLayers();
  for (let m = minutes; m >= 1; m--) {
    const lines = byMinute.get(m);
    if (!lines) continue;
    L.polyline(lines, {
      renderer,
      color: colorFor(m, minutes),
      weight: ROAD_WEIGHT_PX,
      opacity: 0.9,
      // 当たり判定は自分で行う。Leaflet の hover だと分数レイヤ単位にまとまってしまう
      interactive: false,
    }).addTo(resultLayer);
  }
  renderLegend(minutes);
  statusEl.textContent = `徒歩${minutes}分（${mpm}m/分 = ${minutes * mpm}m）／ ${colored.length}区間`;
  syncTip();
}

function renderLegend(max: number) {
  legendEl.innerHTML = Array.from({ length: max }, (_, i) => i + 1)
    .map(
      (m) =>
        `<span style="display:inline-block;margin:2px 6px 2px 0"><i style="display:inline-block;width:12px;height:12px;background:${colorFor(m, max)};vertical-align:middle"></i> ${m}分</span>`,
    )
    .join("");
}

function hideTip() {
  map.getContainer().classList.remove("walk-hover");
  if (tipEl.hidden) return;
  tipEl.hidden = true;
  tipMinute = undefined;
  tipMax = undefined;
}

/** カーソルの近くに出し、画面端では反対側へずらして切れないようにする */
function showTip(minutes: number, x: number, y: number) {
  if (tipMinute !== minutes || tipMax !== minuteMax) {
    tipMinute = minutes;
    tipMax = minuteMax;
    tipSwatch.style.background = colorFor(minutes, minuteMax);
    tipText.textContent = `徒歩${minutes}分`;
  }
  map.getContainer().classList.add("walk-hover");
  tipEl.hidden = false;
  const pad = 14;
  const margin = 8;
  let left = x + pad;
  let top = y + pad;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
  const box = tipEl.getBoundingClientRect();
  if (left + box.width > window.innerWidth - margin) left = x - pad - box.width;
  if (top + box.height > window.innerHeight - margin) top = y - pad - box.height;
  const maxLeft = Math.max(margin, window.innerWidth - box.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - box.height - margin);
  left = Math.min(Math.max(left, margin), maxLeft);
  top = Math.min(Math.max(top, margin), maxTop);
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

function toleranceMeters(lat: number, lon: number): number {
  const ll = L.latLng(lat, lon);
  const p = map.latLngToContainerPoint(ll);
  const q = map.containerPointToLatLng(L.point(p.x + ROAD_HIT_PX, p.y));
  return map.distance(ll, q);
}

function syncTip() {
  if (!pointer || colored.length === 0) {
    hideTip();
    return;
  }
  const rect = map.getContainer().getBoundingClientRect();
  const x = pointer.x - rect.left;
  const y = pointer.y - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    hideTip();
    return;
  }
  const ll = map.containerPointToLatLng(L.point(x, y));
  const minutes = walkingMinutesAt(colored, [ll.lat, ll.lng], toleranceMeters(ll.lat, ll.lng));
  if (minutes === undefined) hideTip();
  else showTip(minutes, pointer.x, pointer.y);
}

function scheduleTip() {
  if (!pointer || tipFrame !== undefined) return;
  tipFrame = requestAnimationFrame(() => {
    tipFrame = undefined;
    syncTip();
  });
}

function rememberPointer(ev: MouseEvent) {
  const target = ev.target;
  if (target instanceof Element && target.closest(".leaflet-control")) {
    pointer = undefined;
    hideTip();
    return;
  }
  pointer = { x: ev.clientX, y: ev.clientY };
  scheduleTip();
}

// シングルクリックだと地図を触っただけで誤爆しやすいので、ダブルクリックで起点を変える
map.on("dblclick", (e: L.LeafletMouseEvent) => {
  origin = [e.latlng.lat, e.latlng.lng];
  void update();
});

// 結果の canvas は Leaflet の map mousemove を止めるので、DOM のイベントを直接見る。
// オーバーレイは地図の外に出しているので、popup とは重ならない。
map.getContainer().addEventListener("mousemove", (ev) => rememberPointer(ev));
map.on("move zoom", scheduleTip);
map.getContainer().addEventListener("mouseleave", () => {
  pointer = undefined;
  if (tipFrame !== undefined) cancelAnimationFrame(tipFrame);
  tipFrame = undefined;
  hideTip();
});

minutesInput.addEventListener("input", () => {
  minutesOut.textContent = minutesInput.value;
  void update();
});
mpmInput.addEventListener("change", () => void update());

$("search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("q").value.trim();
  if (!q) return;
  setLoading("検索中…");
  try {
    const hit = await geocode(q);
    if (!hit) {
      setLoading(undefined);
      statusEl.textContent = "見つからなかったよ";
      return;
    }
    origin = hit;
    map.setView(hit, 16);
    await update();
  } catch (err) {
    setLoading(undefined);
    statusEl.textContent = `エラー: ${(err as Error).message}`;
  }
});

void update();
