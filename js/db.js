// IndexedDB 래퍼 — 아웃박스 큐 · 이어풀기 상태 · 콘텐츠 캐시 · 설정(KV).
//
// 왜 localStorage가 아니라 IndexedDB인가: iOS Safari는 localStorage를 7일 미사용 시
// 지워버릴 수 있다(ITP). 홈화면 PWA로 설치하면 완화되지만, 풀이기록·토큰처럼
// 날아가면 곤란한 데이터라 IndexedDB를 쓴다.

const DB_NAME = 'medstudy';
const DB_VER = 3;

const STORE_KV = 'kv';            // 설정·토큰
const STORE_OUTBOX = 'outbox';    // vault에 못 보낸 저장분(재시도 큐)
const STORE_SESSION = 'session';  // 모의고사별 이어풀기 상태
const STORE_CACHE = 'cache';      // 시험 HTML/노트 텍스트 캐시
const STORE_CARDS = 'cards';      // 네모로 만든 플래시카드(관리 화면에서 다시 본다)
const STORE_ATTEMPTS = 'attempts'; // 문항별 풀이 이력(과목 전체에서 약한 문항을 모으기 위해)

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
      if (!db.objectStoreNames.contains(STORE_ATTEMPTS)) {
        const st = db.createObjectStore(STORE_ATTEMPTS, { keyPath: 'id' });
        st.createIndex('subject', 'subject');   // 과목 전체에서 약한 문항 모으기
      }
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
// ---- 문항별 풀이 이력 ----
// 왜 세션만으로 부족한가: session은 examKey(파일 경로)별 "이어풀기" 상태라, 시험을 끝내고
// 나오면 "어제 ACLS에서 틀린 4문항 + 오늘 Shock에서 틀린 6문항"을 모을 방법이 없었다.
// 문항을 키로 따로 쌓아 과목 전체에서 약한 것만 다시 꺼낸다(2026-10-10).
export const attemptId = (exam, num) => `${exam}#${num}`;

export async function recordAttempt({ exam, num, subject, kind, title, picked, correct, unsure }) {
  const db = await open();
  const id = attemptId(exam, num);
  const store = db.transaction(STORE_ATTEMPTS, 'readwrite').objectStore(STORE_ATTEMPTS);
  const prev = await req2val(store.get(id));
  const rec = prev || { id, exam, num, subject, kind, title, n: 0, wrongN: 0, unsureN: 0 };
  rec.subject = subject; rec.kind = kind; rec.title = title;   // 파일이 옮겨가도 따라오게
  rec.n += 1;
  if (!correct) rec.wrongN += 1;
  if (unsure) rec.unsureN += 1;
  rec.last = { at: Date.now(), picked, correct: !!correct, unsure: !!unsure };
  return tx(STORE_ATTEMPTS, 'readwrite', (s) => s.put(rec));
}

/** 이미 푼 문항에 "확신 없었음"만 뒤늦게 켜고 끈다 — 시도 횟수는 올리지 않는다. */
export async function markUnsure(exam, num, unsure) {
  const db = await open();
  const id = attemptId(exam, num);
  const store = db.transaction(STORE_ATTEMPTS, 'readwrite').objectStore(STORE_ATTEMPTS);
  const rec = await req2val(store.get(id));
  if (!rec || !rec.last) return null;
  if (!!rec.last.unsure === !!unsure) return rec;
  rec.last.unsure = !!unsure;
  rec.unsureN = Math.max(0, (rec.unsureN || 0) + (unsure ? 1 : -1));
  await tx(STORE_ATTEMPTS, 'readwrite', (s) => s.put(rec));
  return rec;
}

/**
 * 이력을 그대로 써넣는다(백업 복원용) — recordAttempt는 횟수를 올리므로 복원에 쓸 수 없다.
 * 같은 문항이 양쪽에 있으면 **마지막으로 푼 쪽**을 남기고 누적 횟수는 큰 값을 취한다.
 */
export async function mergeAttempts(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  const db = await open();
  const cur = new Map(
    (await req2val(db.transaction(STORE_ATTEMPTS, 'readonly').objectStore(STORE_ATTEMPTS).getAll()))
      .map((a) => [a.id, a]));
  let n = 0;
  await new Promise((res, rej) => {
    const t = db.transaction(STORE_ATTEMPTS, 'readwrite');
    const st = t.objectStore(STORE_ATTEMPTS);
    for (const inc of list) {
      if (!inc || !inc.id) continue;
      const mine = cur.get(inc.id);
      const newer = !mine || (inc.last?.at || 0) > (mine.last?.at || 0);
      const merged = newer ? { ...mine, ...inc } : { ...inc, ...mine };
      merged.n = Math.max(inc.n || 0, mine?.n || 0);
      merged.wrongN = Math.max(inc.wrongN || 0, mine?.wrongN || 0);
      merged.unsureN = Math.max(inc.unsureN || 0, mine?.unsureN || 0);
      st.put(merged);
      n++;
    }
    t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
  return n;
}

export async function allAttempts() {
  const db = await open();
  return req2val(db.transaction(STORE_ATTEMPTS, 'readonly').objectStore(STORE_ATTEMPTS).getAll());
}

export async function attemptsForExam(exam) {
  return (await allAttempts()).filter((a) => a.exam === exam);
}

export async function clearAttempts() {
  return tx(STORE_ATTEMPTS, 'readwrite', (s) => s.clear());
}

export async function clearCards() {
  return tx(STORE_CARDS, 'readwrite', (s) => s.clear());
}
