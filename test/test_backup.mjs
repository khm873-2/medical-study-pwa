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
const store = { kv: {}, sessions: {}, outbox: [], attempts: [] };
let putCalls = [];
let remoteFile = null;

// import 줄을 **정규식**으로 집는다 — 전에 문자열을 그대로 맞춰보다가, backup.js에서
// import가 여러 줄로 바뀌자 스텁이 빗나가 진짜 db.js를 불러왔다(2026-10-10).
const raw = readFileSync(`${PWA}/js/backup.js`, 'utf8');
for (const [name, re] of [['github.js', /^import\s*\{[^}]*\}\s*from\s*'\.\/github\.js';$/m],
                          ['db.js', /^import\s*\{[\s\S]*?\}\s*from\s*'\.\/db\.js';$/m]]) {
  ok(`스텁이 ${name} import를 찾는다`, re.test(raw),
    '못 찾으면 실제 모듈이 로드돼 테스트가 무의미해진다');
}

const shimSrc = raw
  .replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/github\.js';$/m, `
const putFile = async (path, content) => { globalThis.__put.push({ path, content }); globalThis.__remote = content; };
const getTextIfExists = async () => globalThis.__remote;`)
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/db\.js';$/m, `
const S = globalThis.__store;
const kvGet = async (k) => S.kv[k];
const kvSet = async (k, v) => { S.kv[k] = v; };
const allSessions = async () => ({ ...S.sessions });
const saveSession = async (k, v) => { S.sessions[k] = v; };
const listOutbox = async () => S.outbox.map((o, i) => ({ id: i + 1, ...o }));
const enqueue = async (it) => { S.outbox.push(it); };
const allAttempts = async () => S.attempts.map((a) => ({ ...a }));
const mergeAttempts = async (list) => {
  for (const inc of list || []) {
    const i = S.attempts.findIndex((a) => a.id === inc.id);
    if (i < 0) S.attempts.push(inc);
    else if ((inc.last?.at || 0) > (S.attempts[i].last?.at || 0)) S.attempts[i] = inc;
  }
  return (list || []).length;
};`)
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

// ── 8.5 문항 풀이 이력이 재설치를 넘어간다 ──
// 2주에 걸쳐 쌓이는 데이터라 날아가면 "다시 볼 문항"이 통째로 빈다.
{
  store.attempts = [
    { id: '06_모의고사/응급_중환자/1015_Shock_모의고사.html#3', exam: '06_모의고사/응급_중환자/1015_Shock_모의고사.html',
      num: 3, subject: '응급_중환자', kind: '모의고사', n: 2, wrongN: 2, unsureN: 0,
      last: { at: 1000, picked: 1, correct: false, unsure: false } },
    { id: 'E#1', exam: 'E', num: 1, subject: '응급_중환자', n: 1, wrongN: 0, unsureN: 1,
      last: { at: 2000, picked: 0, correct: true, unsure: true } },
  ];
  const state = await B.collectState();
  ok('백업에 풀이 이력이 담긴다', Array.isArray(state.attempts) && state.attempts.length === 2,
    JSON.stringify(state.attempts && state.attempts.length));
  ok('찍어서 맞춘 표시도 담긴다', state.attempts.some((a) => a.last.unsure === true));
  ok('요약에 푼 문항 수가 보인다', /푼 문항 2개/.test(B.describe(state)), B.describe(state));

  // 재설치 — 저장소가 비었다고 가정하고 복원
  store.attempts = [];
  const applied = await B.restore(JSON.parse(JSON.stringify(state)));
  ok('복원이 이력 개수를 보고한다', applied.attempts === 2, JSON.stringify(applied));
  ok('이력이 되살아난다', store.attempts.length === 2);
  ok('오답 누적 횟수가 보존된다', store.attempts.find((a) => a.num === 3).wrongN === 2);

  // 두 기기에서 따로 풀었을 때 — 더 최근에 푼 쪽이 남아야 한다
  store.attempts = [{ id: 'E#1', exam: 'E', num: 1, subject: '응급_중환자', n: 5, wrongN: 0, unsureN: 0,
    last: { at: 9000, picked: 2, correct: true, unsure: false } }];
  await B.restore(JSON.parse(JSON.stringify(state)));
  const merged = store.attempts.find((a) => a.id === 'E#1');
  ok('더 최근에 푼 기록이 이긴다', merged.last.at === 9000 && merged.last.unsure === false,
    JSON.stringify(merged.last));
  store.attempts = [];
}

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
