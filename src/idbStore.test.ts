import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { StoredWays } from "./area";
import { createIdbStore } from "./idbStore";

let n = 0;
/** テストごとに別の DB を使う */
const fresh = (maxEntries?: number) => {
  const dbName = `test-${++n}`;
  return { dbName, store: createIdbStore({ dbName, ...(maxEntries ? { maxEntries } : {}) }) };
};

const entry = (savedAt: number, radius = 850): StoredWays => ({
  radius,
  savedAt,
  ways: [{ nodes: [1, 2], geometry: [{ lat: 35.68, lon: 139.76 }, { lat: 35.681, lon: 139.761 }] }],
});

describe("createIdbStore", () => {
  it("保存したものをそのまま読める", async () => {
    const { store } = fresh();
    await store.put("a", entry(1));
    expect(await store.get("a")).toEqual(entry(1));
    expect(await store.get("missing")).toBeUndefined();
  });

  it("別インスタンス(リロード相当)からも読める", async () => {
    const { dbName, store } = fresh();
    await store.put("a", entry(1));
    expect(await createIdbStore({ dbName }).get("a")).toEqual(entry(1));
  });

  it("同じキーは上書きする", async () => {
    const { store } = fresh();
    await store.put("a", entry(1, 850));
    await store.put("a", entry(2, 1650));
    expect((await store.get("a"))!.radius).toBe(1650);
  });

  it("上限を超えたら保存日時が古いものから消す", async () => {
    const { store } = fresh(2);
    await store.put("old", entry(1));
    await store.put("mid", entry(2));
    await store.put("new", entry(3));
    expect(await store.get("old")).toBeUndefined();
    expect(await store.get("mid")).toBeDefined();
    expect(await store.get("new")).toBeDefined();
  });

  it("IndexedDB が使えない環境では reject する", async () => {
    const store = createIdbStore({ factory: undefined });
    await expect(store.get("a")).rejects.toThrow("not available");
    await expect(store.put("a", entry(1))).rejects.toThrow("not available");
  });
});
