// GitHub Contents API 래퍼 — 비공개 vault 레포에서 읽고, AI대화로그에 새 파일로 쓴다.
//
// 설계 원칙(계획서 1번): vault에는 **새 파일만 만든다**(append-only).
// 기존 파일을 read-modify-write 하지 않으므로 git 충돌이 구조적으로 생기지 않는다.

import { getToken, getRepo } from './auth.js';
import { cacheGet, cacheSet, kvGet, kvSet } from './db.js';

const API = 'https://api.github.com';

async function headers(extra = {}) {
  const token = await getToken();
  if (!token) throw new Error('NO_TOKEN');
  return {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

/** 경로를 세그먼트별로 인코딩(한글 폴더·파일명이 많아서 필수). */
function encPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** 디렉터리 목록. [{name, path, type:'file'|'dir', size}] */
export async function listDir(path) {
  const repo = await getRepo();
  const res = await fetch(`${API}/repos/${repo}/contents/${encPath(path)}`, {
    headers: await headers({ Accept: 'application/vnd.github+json' }),
  });
  if (!res.ok) throw new Error(`목록 조회 실패 (${res.status}) — ${path}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`디렉터리가 아닙니다 — ${path}`);
  return json.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
}

/**
 * 텍스트 파일 읽기. raw 미디어 타입을 쓰면 base64 디코딩이 필요 없고 1MB 제한도 없다.
 * useCache=true면 IndexedDB 캐시를 먼저 보고, 실패(오프라인) 시에도 캐시로 폴백한다.
 */
export async function getText(path, { useCache = true } = {}) {
  if (useCache) {
    const hit = await cacheGet(path);
    if (hit) {
      // 캐시가 있어도 네트워크가 되면 갱신을 시도하되, 실패하면 캐시를 그대로 쓴다.
      refreshInBackground(path);
      return hit.data;
    }
  }
  const repo = await getRepo();
  let res;
  try {
    res = await fetch(`${API}/repos/${repo}/contents/${encPath(path)}`, {
      headers: await headers({ Accept: 'application/vnd.github.raw' }),
    });
  } catch (e) {
    const hit = await cacheGet(path);
    if (hit) return hit.data;
    throw new Error(`네트워크 오류 — ${path}`);
  }
  if (!res.ok) {
    const hit = await cacheGet(path);
    if (hit) return hit.data;
    throw new Error(`파일 읽기 실패 (${res.status}) — ${path}`);
  }
  const text = await res.text();
  if (useCache) { await cacheSet(path, text); await rememberCached(path); }
  return text;
}

/** 검색 범위를 알기 위해 "캐시에 들어있는 경로"를 따로 모아둔다(search.js가 읽는다). */
async function rememberCached(path) {
  try {
    const list = (await kvGet('cached_paths')) || [];
    if (!list.includes(path)) { list.push(path); await kvSet('cached_paths', list); }
  } catch {}
}

function refreshInBackground(path) {
  // 조용한 갱신 — 실패해도 사용자에게 보이지 않는다.
  (async () => {
    try {
      const repo = await getRepo();
      const res = await fetch(`${API}/repos/${repo}/contents/${encPath(path)}`, {
        headers: await headers({ Accept: 'application/vnd.github.raw' }),
      });
      if (res.ok) await cacheSet(path, await res.text());
    } catch (_) {}
  })();
}

/** 바이너리(이미지) 읽기 → blob URL. 캐시는 하지 않는다(용량 때문). */
/**
 * 그림 주소 — **한 번 받은 것은 다시 쓴다**.
 *
 * 전에는 부를 때마다 새로 받아 `createObjectURL`을 만들고 **아무도 풀어주지 않았다**.
 * 노트를 넘길 때마다 blob이 쌓여서(그림 한 장이 수백 KB) 오래 보고 있으면 앱이
 * 무거워졌다. vault의 attachments만 429MB다(2026-10-14 실측).
 *
 * 이제 경로별로 하나만 들고 돌려 쓴다. 넘치면 **가장 오래 안 쓴 것부터 풀어준다** —
 * 같은 섹션을 오가도 다시 안 받으니 네트워크도 같이 아낀다.
 */
const BLOB_MAX = 60;                 // 그림 60장 ≈ 수십 MB. 한 과목을 넘겨 보기에 충분하다.
const blobUrls = new Map();          // path → objectURL (들어온 순서 = 오래된 순)
const blobWait = new Map();          // 같은 그림을 동시에 두 번 받지 않게

export async function getBlobUrl(path) {
  const hit = blobUrls.get(path);
  if (hit) {                          // 쓴 것은 뒤로 — 가장 오래 안 쓴 것이 앞에 남는다
    blobUrls.delete(path);
    blobUrls.set(path, hit);
    return hit;
  }
  if (blobWait.has(path)) return blobWait.get(path);

  const task = (async () => {
    const repo = await getRepo();
    const res = await fetch(`${API}/repos/${repo}/contents/${encPath(path)}`, {
      headers: await headers({ Accept: 'application/vnd.github.raw' }),
    });
    if (!res.ok) throw new Error(`이미지 읽기 실패 (${res.status}) — ${path}`);
    const url = URL.createObjectURL(await res.blob());
    blobUrls.set(path, url);
    while (blobUrls.size > BLOB_MAX) {
      const oldest = blobUrls.keys().next().value;
      URL.revokeObjectURL(blobUrls.get(oldest));
      blobUrls.delete(oldest);
    }
    return url;
  })().finally(() => blobWait.delete(path));

  blobWait.set(path, task);
  return task;
}

/** 들고 있는 그림을 전부 풀어준다(설정의 "저장 공간 비우기"가 쓴다). */
export function releaseBlobs() {
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls.clear();
  return blobUrls.size;
}

/** 지금 몇 장을 들고 있나 — 설정 화면에 보여준다. */
export function blobCount() { return blobUrls.size; }

/**
 * 새 파일 생성(append-only). 같은 경로가 이미 있으면 파일명에 -2, -3... 을 붙여 피한다
 * — 덮어쓰기를 아예 하지 않는 게 이 설계의 핵심이라 sha를 다루지 않는다.
 * @param {string|{base64:string}} content 글이면 그대로, 이미지는 {base64}로 넘긴다
 *   (스크랩의 붙여넣은 그림 — 바이너리는 UTF-8 인코딩을 거치면 깨진다, 2026-10-12)
 */
export async function createFile(path, content, message) {
  const repo = await getRepo();
  const b64 = (content && typeof content === 'object' && content.base64)
    ? content.base64
    : base64EncodeUtf8(content);
  let target = path;
  // 같은 이름이 있으면 -2, -3… 으로 비켜 간다. 그게 몇 번 더 부딪히면 **무작위 꼬리**를
  // 붙여 끝낸다 — 번호만 올리다 보면 영영 못 넣는 수가 있다(2026-10-15: 이름이 -5까지
  // 차서 "같은 이름의 파일이 너무 많습니다"로 떨어졌다).
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${API}/repos/${repo}/contents/${encPath(target)}`, {
      method: 'PUT',
      headers: await headers({
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ message: message || `iPad: ${target}`, content: b64 }),
    });
    if (res.ok) return { path: target };
    const body = await res.text().catch(() => '');
    // 422는 "이미 있다"만이 아니다 — 내용이 너무 크거나 경로가 잘못돼도 422가 온다.
    // 그걸 싸잡아 이름 탓으로 돌리면 **엉뚱한 메시지**를 띄우게 된다(2026-10-15 지적).
    if (res.status === 422 && /already exists|"sha" wasn't supplied|sha/i.test(body)) {
      target = attempt < 4 ? suffixPath(path, attempt + 2)
        : suffixPath(path, `${Date.now().toString(36).slice(-4)}`);
      continue;
    }
    throw new Error(`저장 실패 (${res.status}) — ${explainGithub(res.status, body)}`);
  }
  throw new Error('저장 실패 — 같은 이름으로 여러 번 부딪혔습니다. 잠시 뒤 다시 보내보세요.');
}

/** GitHub가 돌려준 오류를 **무엇을 하면 되는지**가 보이는 말로 바꾼다. */
function explainGithub(status, body) {
  const msg = (() => {
    try { return JSON.parse(body).message || ''; } catch { return ''; }
  })() || String(body || '').slice(0, 160);
  if (status === 401) return '토큰이 만료됐습니다 — 설정에서 다시 연결하세요.';
  if (status === 403 && /rate limit/i.test(body)) return 'GitHub 요청 한도에 걸렸습니다 — 잠시 뒤 다시.';
  if (status === 403) return `권한이 없습니다 (${msg})`;
  if (status === 404) return '저장소나 폴더를 찾지 못했습니다 — 설정의 저장소 이름을 확인하세요.';
  if (status === 409) return '같은 파일을 동시에 고쳤습니다 — 다시 보내면 됩니다.';
  if (status === 413 || /too large/i.test(body)) return '파일이 너무 큽니다.';
  if (status >= 500) return 'GitHub 쪽 문제입니다 — 잠시 뒤 다시 보내보세요.';
  return msg || '알 수 없는 오류';
}

function suffixPath(path, n) {
  const i = path.lastIndexOf('.');
  if (i < 0) return `${path}-${n}`;
  return `${path.slice(0, i)}-${n}${path.slice(i)}`;
}

/** 한글이 섞인 문자열을 base64로(btoa는 latin1만 받아서 직접 변환해야 한다). */
export function base64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/**
 * 파일 하나를 **덮어쓴다**(없으면 만든다).
 *
 * 이 저장소의 원칙은 append-only다 — 노트를 덮어쓰면 옵시디언·클로드코드 편집과
 * 충돌하기 때문이다. 하지만 앱 상태 백업처럼 **앱만 쓰는 파일**은 충돌 상대가 없고,
 * 매번 새 파일을 만들면 수천 개가 쌓인다. 그래서 이 함수는 백업 전용으로만 쓴다.
 */
export async function putFile(path, content, message) {
  const repo = await getRepo();
  const b64 = base64EncodeUtf8(content);
  for (let attempt = 0; attempt < 3; attempt++) {
    let sha;
    const cur = await fetch(`${API}/repos/${repo}/contents/${encPath(path)}`, {
      headers: await headers({ Accept: 'application/vnd.github+json' }),
    });
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status !== 404) throw new Error(`백업 조회 실패 (${cur.status})`);

    const res = await fetch(`${API}/repos/${repo}/contents/${encPath(path)}`, {
      method: 'PUT',
      headers: await headers({
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ message: message || `iPad: ${path}`, content: b64, ...(sha ? { sha } : {}) }),
    });
    if (res.ok) return { path };
    if (res.status === 409) continue;      // 그사이 바뀜 → sha 다시 읽어 재시도
    const body = await res.text().catch(() => '');
    throw new Error(`백업 저장 실패 (${res.status}) — ${body.slice(0, 160)}`);
  }
  throw new Error('백업 저장 실패 — 다른 기기와 충돌이 계속됩니다.');
}

/** 캐시를 거치지 않고 읽는다. 없으면 null(백업 존재 확인용). */
export async function getTextIfExists(path) {
  const repo = await getRepo();
  const res = await fetch(`${API}/repos/${repo}/contents/${encPath(path)}`, {
    headers: await headers({ Accept: 'application/vnd.github.raw' }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`조회 실패 (${res.status}) — ${path}`);
  return res.text();
}
