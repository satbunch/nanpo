import type { StoredWays, WayStore } from "./area";

const STORE = "ways";

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

/**
 * 道路データを IndexedDB に保存する。リロード後や翌日も再取得せずに表示できる。
 * 1件あたり数MBになり得るので、maxEntries を超えたら古いものから消す。
 * プライベートブラウズ等で IndexedDB が使えない場合は reject し、呼び出し側で無視する。
 */
export function createIdbStore(
  opts: { dbName?: string; maxEntries?: number; factory?: IDBFactory | undefined } = {},
): WayStore {
  const { dbName = "station-walk-map", maxEntries = 30 } = opts;
  // factory: undefined を明示されたら「使えない環境」として扱う（分割代入の既定値だと区別できない）
  const factory = "factory" in opts ? opts.factory : (globalThis.indexedDB as IDBFactory | undefined);
  let db: Promise<IDBDatabase> | undefined;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) return reject(new Error("IndexedDB is not available"));
      const req = factory.open(dbName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE).createIndex("savedAt", "savedAt");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => {
      db = undefined; // 次回また開けるか試す
      throw e;
    }));

  return {
    async get(key) {
      const tx = (await open()).transaction(STORE, "readonly");
      return (await request(tx.objectStore(STORE).get(key))) as StoredWays | undefined;
    },

    async put(key, value) {
      const tx = (await open()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put(value, key);
      // 上限を超えた分を古い順に削除（put と同じトランザクション内）
      const count = await request(store.count());
      let excess = count - maxEntries;
      if (excess > 0) {
        const cursorReq = store.index("savedAt").openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || excess <= 0) return;
          cursor.delete();
          excess--;
          cursor.continue();
        };
      }
      await done(tx);
    },
  };
}
