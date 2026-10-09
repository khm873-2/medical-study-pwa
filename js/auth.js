// 토큰 보관 — 이 모듈 하나만 교체하면 나중에 Cloudflare Worker 프록시로 옮길 수 있다.
// 지금은 fine-grained PAT를 기기(IndexedDB)에만 저장하고 GitHub API를 직접 호출한다.
//
// 보안 전제(계획서 "토큰 보관" 항목):
//   - PAT 스코프는 medical-vault 레포 하나, Contents: Read and write 만
//   - 90일 만료
//   - 기기 잠금(FaceID/패스코드)이 1차 방어선
//
// Worker 프록시로 전환할 때 바꿀 것: getToken()이 null을 반환하게 두고,
// github.js의 BASE를 Worker URL로 돌리면 된다(나머지 코드는 손대지 않아도 됨).

import { kvGet, kvSet, kvDel } from './db.js';

const TOKEN_KEY = 'github_pat';
const REPO_KEY = 'vault_repo';

const DEFAULT_REPO = 'khm873-2/medical-vault';

let _cached = null;

export async function getToken() {
  if (_cached !== null) return _cached;
  _cached = (await kvGet(TOKEN_KEY)) || null;
  return _cached;
}

export async function setToken(token) {
  const t = (token || '').trim();
  if (!t) throw new Error('토큰이 비어 있습니다.');
  await kvSet(TOKEN_KEY, t);
  _cached = t;
}

export async function clearToken() {
  await kvDel(TOKEN_KEY);
  _cached = null;
}

export async function hasToken() {
  return !!(await getToken());
}

export async function getRepo() {
  return (await kvGet(REPO_KEY)) || DEFAULT_REPO;
}

export async function setRepo(repo) {
  await kvSet(REPO_KEY, (repo || DEFAULT_REPO).trim());
}

/** 토큰이 실제로 레포를 읽을 수 있는지 확인(설정 화면 "연결 테스트"용). */
export async function verifyToken(token, repo) {
  const r = repo || (await getRepo());
  const res = await fetch(`https://api.github.com/repos/${r}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 200) {
    const j = await res.json();
    return { ok: true, name: j.full_name, private: j.private };
  }
  if (res.status === 401) return { ok: false, error: '토큰이 유효하지 않습니다(401). 다시 발급해 주세요.' };
  if (res.status === 404) {
    return {
      ok: false,
      error: `레포를 찾을 수 없습니다(404). "${r}" 이름이 맞는지, 토큰 권한에 이 레포가 포함됐는지 확인해 주세요.`,
    };
  }
  return { ok: false, error: `GitHub 응답 ${res.status}` };
}
