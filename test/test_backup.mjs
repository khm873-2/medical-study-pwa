// 백업·복원 테스트.
//
// 왜 있나: iOS는 홈화면 아이콘을 지우면 앱 데이터를 통째로 지운다. 아이콘을 바꾸려면
// 지웠다 다시 추가하는 수밖에 없어서, 그때마다 플래시카드 일정이 날아갔다(2026-10-09).
// 여기서 가장 중요한 검사는 **비밀이 백업에 섞여 들어가지 않는가**다 —
// 토큰이 git 히스토리에 들어가면 되돌릴 수 없다.

import { readFileSync, writeFileSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

// github.js / db.js 를 가짜로 바꿔 끼운 사본을 만든다(네트워크·IndexedDB 없이 돌리려고)
const store = { kv: {}, sessions: {}, outbox: [] };
let putCalls = [];
let remoteFile = null;

const shimSrc = readFileSync(`${PWA}/js/backup.js`, 'utf8')
  .replace("import { putFile, getTextIfExists } from './github.js';", `
const putFile = async (path, content) => { globalThis.__put.push({ path, content }); globalThis.__remote = content; };
const getTextIfExists = async () => globalThis.__remote;`)
  .replace("import { kvGet, kvSet, allSessions, saveSession, listOutbox, enqueue } from './db.js';", `
const S = globalThis.__store;
const kvGet = async (k) => S.kv[k];
const kvSet = async (k, v) => { S.kv[k] = v; };
const allSessions = async () => ({ ...S.sessions });
const saveSession = async (k, v) => { S.sessions[k] = v; };
const listOutbox = async () => S.outbox.map((o, i) => ({ id: i + 1, ...o }));
const enqueue = async (it) => { S.outbox.push(it); };`)
  .replace("const mine = await (await import('./db.js')).loadSession(key);",
           "const mine = S.sessions[key];");

globalThis.__store = store;
globalThis.__put = putCalls;
globalThis.__remote = remoteFile;

const shim = `${PWA}/js/__tb.mjs`;
writeFileSync(shim, shimSrc);
let B;
try { B = await import(pathToFileURL(shim).href); } finally { rmSync(shim, { force: true }); }

// ── 1. 비밀이 절대 안 들어간다 (가장 중요) ──
store.kv = {
  github_pat: 'github_pat_SECRET_DO_NOT_LEAK',
  gemini_key: 'AIzaSECRET_DO_NOT_LEAK',
  srs: { 'card-1': { box: 2, due: 123 }, 'card-2': { box: 0, due: 0 } },
  theme: 'dark',
  gemini_model: 'gemini-2.0-flash',
  cached_paths: ['a/b.md'],
  note_index: [{ huge: 'rebuildable' }],
};
store.sessions = { 'exam-1': { cur: 3, answers: [0, 1], savedAt: 100 } };
store.outbox = [{ path: '00_Raw_Text/x.md', content: '결과' }];

const state = await B.collectState();
const json = JSON.stringify(state);
ok('백업에 GitHub 토큰이 없다', !json.includes('github_pat_SECRET'));
ok('백업에 Gemini 키가 없다', !json.includes('AIzaSECRET'));
ok('SECRET_KEYS가 BACKUP_KEYS와 겹치지 않는다',
  !B.SECRET_KEYS.some((k) => B.BACKUP_KEYS.includes(k)), B.SECRET_KEYS.join(','));
ok('"DO_NOT_LEAK" 문자열이 어디에도 없다', !json.includes('DO_NOT_LEAK'));

// ── 2. 되찾을 수 없는 건 전부 들어간다 ──
ok('플래시카드 일정 포함', Object.keys(state.kv.srs).length === 2);
ok('이어풀기 포함', Object.keys(state.sessions).length === 1);
ok('저장 대기분 포함', state.outbox.length === 1);
ok('아웃박스 id는 빼고 담는다', state.outbox[0].id === undefined);
ok('테마 포함', state.kv.theme === 'dark');
ok('다시 만들면 되는 캐시는 뺀다', state.kv.note_index === undefined);
ok('버전이 찍힌다', state.v === 1);
ok('저장 시각이 찍힌다', !!state.savedAt && !Number.isNaN(Date.parse(state.savedAt)));

// ── 3. 올리고 받아오기 ──
await B.backupNow();
ok('vault에 한 파일로 올린다', putCalls.length === 1 && putCalls[0].path === '.medstudy/state.json',
  putCalls.map((p) => p.path).join());
ok('점으로 시작하는 폴더(옵시디언에 안 보임)', B.BACKUP_PATH.startsWith('.'));
ok('마지막 백업 시각을 기억한다', !!store.kv.backup_at);
const fetched = await B.fetchBackup();
ok('받아온 백업이 같다', JSON.stringify(fetched.kv.srs) === JSON.stringify(state.kv.srs));

// ── 4. 복원 — 새 기기(빈 상태) ──
// 모듈이 캡처한 store 객체를 비워서 "새로 설치한 기기"를 흉내 낸다
store.kv = {}; store.sessions = {}; store.outbox = [];
const n = await B.restore(fetched);
ok('복원: 플래시카드가 돌아온다', Object.keys(store.kv.srs).length === 2, `${n.srs}장`);
ok('복원: 이어풀기가 돌아온다', Object.keys(store.sessions).length === 1);
ok('복원: 저장 대기분이 돌아온다', store.outbox.length === 1);
ok('복원: 테마도 돌아온다', store.kv.theme === 'dark');
ok('복원이 토큰을 만들어내지 않는다', store.kv.github_pat === undefined && store.kv.gemini_key === undefined);

// ── 5. 복원 — 두 기기에서 따로 외운 경우(합치기) ──
store.kv = { srs: { 'card-1': { box: 0, due: 0 }, 'card-9': { box: 4, due: 9 } } };
store.sessions = {}; store.outbox = [];
await B.restore(fetched);
ok('합치기: 더 진도 나간 쪽을 남긴다', store.kv.srs['card-1'].box === 2,
  `box=${store.kv.srs['card-1'].box}`);
ok('합치기: 이 기기에만 있던 카드를 지우지 않는다', store.kv.srs['card-9'].box === 4);

// 세션은 더 최근 것을 남긴다
store.sessions = { 'exam-1': { cur: 7, savedAt: 999 } };
await B.restore(fetched);
ok('합치기: 더 최근 이어풀기를 남긴다', store.sessions['exam-1'].cur === 7, `cur=${store.sessions['exam-1'].cur}`);

// ── 6. 깨진 백업에 앱이 멈추지 않는다 ──
globalThis.__remote = '{이건 JSON이 아님';
ok('깨진 백업은 null로 흘려보낸다', (await B.fetchBackup()) === null);
globalThis.__remote = JSON.stringify({ v: 99, kv: {} });
ok('모르는 버전은 무시한다', (await B.fetchBackup()) === null);
let threw = false;
try { await B.restore({ v: 99 }); } catch { threw = true; }
ok('모르는 버전 복원은 명확히 실패한다', threw);

// ── 7. 사람이 읽는 요약 ──
const d = B.describe(fetched);
ok('요약에 장수가 나온다', /플래시카드 2장/.test(d), d);
ok('요약에 시험 수가 나온다', /시험 1개/.test(d), d);
ok('빈 백업도 문장이 깨지지 않는다',
  typeof B.describe({ v: 1, kv: {}, sessions: {}, outbox: [] }) === 'string');
ok('null에도 안 터진다', B.describe(null) === '');

// ── 8. 자동 백업은 모아서 한 번만 ──
putCalls.length = 0;
B.scheduleBackup({ delay: 5 });
B.scheduleBackup({ delay: 5 });
B.scheduleBackup({ delay: 5 });
await new Promise((r) => setTimeout(r, 60));
ok('여러 번 예약해도 한 번만 올린다', putCalls.length === 1, `${putCalls.length}회`);

putCalls.length = 0;
B.scheduleBackup({ delay: 100000 });
await B.flushBackup();
ok('flush하면 기다리지 않고 올린다', putCalls.length === 1, `${putCalls.length}회`);
ok('올릴 게 없으면 flush는 아무것도 안 한다', (await B.flushBackup()) === null);

// ── 9. 앱이 실제로 이 모듈을 쓰고 있나(배선 확인) ──
const appSrc = readFileSync(`${PWA}/js/app.js`, 'utf8');
const quizSrc = readFileSync(`${PWA}/js/quiz.js`, 'utf8');
const html = readFileSync(`${PWA}/index.html`, 'utf8');
ok('app.js가 backup을 import한다', /import \* as backup from '\.\/backup\.js'/.test(appSrc));
ok('플래시카드 채점 후 백업 예약', /saveSrs\(cardDeck\.srs\);\s*\n\s*backup\.scheduleBackup\(\)/.test(appSrc));
ok('이어풀기 저장 후 백업 예약', /scheduleBackup\(\)/.test(quizSrc));
ok('앱이 가려질 때 flush', /visibilitychange[\s\S]{0,200}flushBackup/.test(appSrc));
ok('새 설치면 복원을 제안한다', /offerRestoreIfFresh/.test(appSrc));
ok('설정에 백업 버튼이 있다', html.includes('id="backupNowBtn"') && html.includes('id="restoreBtn"'));
ok('설정 문구가 토큰·키는 백업 안 한다고 알린다',
  /토큰과 Gemini 키는 백업하지 않습니다/.test(html));

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
