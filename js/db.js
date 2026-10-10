// IndexedDB 래퍼 — 아웃박스 큐 · 이어풀기 상태 · 콘텐츠 캐시 · 설정(KV).
//
// 왜 localStorage가 아니라 IndexedDB인가: iOS Safari는 localStorage를 7일 미사용 시
// 지워버릴 수 있다(ITP). 홈화면 PWA로 설치하면 완화되지만, 풀이기록·토큰처럼
// 날아가면 곤란한 데이터라 IndexedDB를 쓴다.

const DB_NAME = 'medstudy';
const DB_VER = 2;

const STORE_KV = 'kv';            // 설정·토큰
const STORE_OUTBOX = 'outbox';    // vault에 못 보낸 저장분(재시도 큐)
const STORE_SESSION = 'session';  // 모의고사별 이어풀기 상태
const STORE_CACHE = 'cache';      // 시험 HTML/노트 텍스트 캐시
const STORE_CARDS = 'cards';      // 네모로 만든 플래시카드(관리 화면에서 다시 본다)

let _dbp = null;

function open() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        db.createObjectStore(STORE_OUTBOX, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_SESSION)) db.createObjectStore(STORE_SESSION);
      if (!db.objectStoreNames.contains(STORE_CACHE)) db.createObjectStore(STORE_CACHE);
      if (!db.objectStoreNames.contains(STORE_CARDS)) db.createObjectStore(STORE_CARDS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        try {
          out = fn(s);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const req2val = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// ---- KV (설정·토큰) ----
export async function kvGet(key) {
  const db = await open();
  return req2val(db.transaction(STORE_KV, 'readonly').objectStore(STORE_KV).get(key));
}
export async function kvSet(key, val) {
  return tx(STORE_KV, 'readwrite', (s) => s.put(val, key));
}
export async function kvDel(key) {
  return tx(STORE_KV, 'readwrite', (s) => s.delete(key));
}

// ---- 이어풀기 ----
export async function saveSession(examKey, state) {
  return tx(STORE_SESSION, 'readwrite', (s) => s.put({ ...state, savedAt: Date.now() }, examKey));
}
export async function loadSession(examKey) {
  const db = await open();
  return req2val(db.transaction(STORE_SESSION, 'readonly').objectStore(STORE_SESSION).get(examKey));
}
export async function clearSession(examKey) {
  return tx(STORE_SESSION, 'readwrite', (s) => s.delete(examKey));
}
export async function allSessions() {
  const db = await open();
  const t = db.transaction(STORE_SESSION, 'readonly').objectStore(STORE_SESSION);
  const keys = await req2val(t.getAllKeys());
  const vals = await req2val(db.transaction(STORE_SESSION, 'readonly').objectStore(STORE_SESSION).getAll());
  const out = {};
  keys.forEach((k, i) => { out[k] = vals[i]; });
  return out;
}

// ---- 아웃박스(vault 저장 대기열) ----
export async function enqueue(item) {
  return tx(STORE_OUTBOX, 'readwrite', (s) => s.add({ ...item, queuedAt: Date.now(), tries: 0 }));
}
export async function listOutbox() {
  const db = await open();
  return req2val(db.transaction(STORE_OUTBOX, 'readonly').objectStore(STORE_OUTBOX).getAll());
}
export async function dequeue(id) {
  return tx(STORE_OUTBOX, 'readwrite', (s) => s.delete(id));
}
export async function bumpTries(id, errMsg) {
  const db = await open();
  const store = db.transaction(STORE_OUTBOX, 'readwrite').objectStore(STORE_OUTBOX);
  const item = await req2val(store.get(id));
  if (!item) return;
  item.tries = (item.tries || 0) + 1;
  item.lastError = errMsg || '';
  item.lastTriedAt = Date.now();
  return tx(STORE_OUTBOX, 'readwrite', (s) => s.put(item));
}

// ---- 콘텐츠 캐시 ----
export async function cacheGet(path) {
  const db = await open();
  return req2val(db.transaction(STORE_CACHE, 'readonly').objectStore(STORE_CACHE).get(path));
}
export async function cacheSet(path, data) {
  return tx(STORE_CACHE, 'readwrite', (s) => s.put({ data, at: Date.now() }, path));
}
export async function cacheClear() {
  return tx(STORE_CACHE, 'readwrite', (s) => s.clear());
}

// ---- 네모로 만든 카드 ----
// 왜 저장하나: 카드를 그때그때 만들고 버리면 "지난주에 만든 카드"를 다시 볼 수가 없고,
// 관리 화면에서 무엇을 버렸는지도 알 수 없다(2026-10-10).
export async function saveCards(cards) {
  if (!cards || !cards.length) return 0;
  const db = await open();
  await new Promise((res, rej) => {
    const t = db.transaction(STORE_CARDS, 'readwrite');
    const st = t.objectStore(STORE_CARDS);
    cards.forEach((c) => st.put({ ...c, savedAt: c.savedAt || Date.now() }));
    t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
  return cards.length;
}
export async function allCards() {
  const db = await open();
  return req2val(db.transaction(STORE_CARDS, 'readonly').objectStore(STORE_CARDS).getAll());
}
export async function deleteCard(id) {
  return tx(STORE_CARDS, 'readwrite', (s) => s.delete(id));
}
export async function clearCards() {
  return tx(STORE_CARDS, 'readwrite', (s) => s.clear());
}
