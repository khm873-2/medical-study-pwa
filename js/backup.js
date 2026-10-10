// 앱 상태 백업 — iOS에서 홈화면 아이콘을 지우면 저장소가 통째로 날아간다.
//
// 왜 필요한가: 아이콘을 바꾸려면 홈화면에서 지웠다 다시 추가하는 방법밖에 없는데,
// 그때마다 IndexedDB가 비워진다. 토큰은 다시 넣으면 그만이지만
// **플래시카드 일정(srs)·이어풀기·저장 대기 중인 결과는 되찾을 수 없다**(2026-10-09).
//
// 비공개 vault에 `.medstudy/state.json` 한 파일로 백업한다. 점으로 시작하는 폴더라
// 옵시디언 탐색기에 뜨지 않고, 앱만 쓰는 파일이라 덮어써도 충돌 상대가 없다.
//
// ⚠️ **비밀은 백업하지 않는다.** GitHub 토큰은 넣어봐야 의미가 없고(그게 있어야
// 백업을 읽으니까), Gemini 키는 git 히스토리에 영구히 남는 게 이득보다 손해다.
// 복원 화면에서 "이 둘은 다시 넣어야 한다"고 분명히 알린다.

import { putFile, getTextIfExists } from './github.js';
import {
  kvGet, kvSet, allSessions, saveSession, listOutbox, enqueue,
  allAttempts, mergeAttempts,
} from './db.js';

export const BACKUP_PATH = '.medstudy/state.json';

/** 백업에 담는 kv 키. 비밀과 "다시 만들면 되는 캐시"는 뺀다. */
export const BACKUP_KEYS = ['srs', 'theme', 'cached_paths', 'gemini_model', 'side_w', 'ai_h'];

/** 절대 백업하지 않는 키(실수로 추가되는 걸 테스트가 잡게 명시해둔다). */
export const SECRET_KEYS = ['github_pat', 'gemini_key'];

/** 지금 상태를 모은다. */
export async function collectState() {
  const kv = {};
  for (const k of BACKUP_KEYS) {
    const v = await kvGet(k);
    if (v !== undefined) kv[k] = v;
  }
  const outbox = (await listOutbox()).map(({ id, ...rest }) => rest);   // id는 재발급된다
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    kv,
    sessions: await allSessions(),
    outbox,
    // 문항별 풀이 이력 — 2주에 걸쳐 쌓이는 것이라 재설치로 날아가면 가장 아프다
    attempts: await allAttempts(),
  };
}

/** 사람이 읽을 수 있는 한 줄 요약 — 복원 전에 뭘 되살리는지 보여준다. */
export function describe(state) {
  if (!state || typeof state !== 'object') return '';
  const srs = state.kv && state.kv.srs ? Object.keys(state.kv.srs).length : 0;
  const sessions = state.sessions ? Object.keys(state.sessions).length : 0;
  const outbox = Array.isArray(state.outbox) ? state.outbox.length : 0;
  const attempts = Array.isArray(state.attempts) ? state.attempts.length : 0;
  const when = state.savedAt ? new Date(state.savedAt).toLocaleString('ko-KR') : '시각 미상';
  const parts = [];
  if (srs) parts.push(`플래시카드 ${srs}장`);
  if (attempts) parts.push(`푼 문항 ${attempts}개`);
  if (sessions) parts.push(`풀던 시험 ${sessions}개`);
  if (outbox) parts.push(`저장 대기 ${outbox}건`);
  return `${when} · ${parts.length ? parts.join(' · ') : '내용 없음'}`;
}

/** vault에 저장. */
export async function backupNow() {
  const state = await collectState();
  await putFile(BACKUP_PATH, JSON.stringify(state, null, 1), 'iPad: 앱 상태 백업');
  await kvSet('backup_at', state.savedAt);
  return state;
}

/** vault에서 읽는다. 없으면 null. */
export async function fetchBackup() {
  const text = await getTextIfExists(BACKUP_PATH);
  if (!text) return null;
  try {
    const state = JSON.parse(text);
    return state && state.v === 1 ? state : null;
  } catch {
    return null;        // 깨진 백업 때문에 앱이 멈추면 안 된다
  }
}

/**
 * 백업을 현재 기기에 되살린다.
 * srs는 **합친다** — 두 기기에서 따로 외웠을 때 한쪽을 지우면 안 되므로
 * 카드마다 더 많이 진도가 나간(박스가 큰) 쪽을 남긴다.
 */
export async function restore(state) {
  if (!state || state.v !== 1) throw new Error('백업 형식을 알 수 없습니다.');
  const applied = { srs: 0, sessions: 0, outbox: 0, attempts: 0 };

  for (const [k, v] of Object.entries(state.kv || {})) {
    if (!BACKUP_KEYS.includes(k)) continue;        // 모르는 키는 무시(앞으로의 포맷 변화 대비)
    if (k === 'srs') {
      const mine = (await kvGet('srs')) || {};
      const merged = { ...mine };
      for (const [id, s] of Object.entries(v || {})) {
        const cur = merged[id];
        if (!cur || (s.box || 0) > (cur.box || 0)) merged[id] = s;
      }
      await kvSet('srs', merged);
      applied.srs = Object.keys(v || {}).length;
    } else {
      await kvSet(k, v);
    }
  }

  for (const [key, st] of Object.entries(state.sessions || {})) {
    const mine = await (await import('./db.js')).loadSession(key);
    // 더 최근에 저장된 쪽을 남긴다
    if (!mine || (st.savedAt || 0) > (mine.savedAt || 0)) {
      await saveSession(key, st);
      applied.sessions++;
    }
  }

  for (const item of state.outbox || []) {
    await enqueue(item);
    applied.outbox++;
  }
  applied.attempts = await mergeAttempts(state.attempts || []);
  await kvSet('backup_at', state.savedAt);
  return applied;
}

/** 마지막 백업 시각(ISO) 또는 null. */
export async function lastBackupAt() {
  return (await kvGet('backup_at')) || null;
}

// ---- 자동 백업 ----
// 바뀔 때마다 올리면 커밋이 쏟아지므로 한 번 모아서 올린다.
let timer = null;
let pending = false;

/** 상태가 바뀌었음을 알린다. 조용히 모았다가 올린다(실패해도 앱 흐름을 막지 않는다). */
export function scheduleBackup({ delay = 20000, onDone } = {}) {
  pending = true;
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    if (!pending) return;
    pending = false;
    try {
      const s = await backupNow();
      if (onDone) onDone(null, s);
    } catch (e) {
      if (onDone) onDone(e);
    }
  }, delay);
}

/** 테스트·화면 전환용 — 대기 중인 백업을 즉시 올린다. */
export async function flushBackup() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending) return null;
  pending = false;
  return backupNow();
}
