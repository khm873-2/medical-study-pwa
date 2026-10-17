// 메인 — 화면 전환, 모의고사 목록, 결과 저장, 동기화 큐.

import { hasToken, setToken, clearToken, verifyToken, getRepo, setRepo } from './auth.js';
import { listDir, getText, getBlobUrl, createFile, putFile, getTextIfExists } from './github.js';
import { parseExamHtml, prettyExamName, examDate, examSortKey, teacherName } from './parser.js';
import { Quiz, isAns } from './quiz.js';
import { PenLayer, tokenizeTree, wordPick } from './pen.js';
import * as gem from './gemini.js';
import { wikiFor, fitLabel } from './wiki.js';
import * as backup from './backup.js';
import { captureRect, canvasToBlob, copyBlobToClipboard } from './capture.js';
import { renderMarkdown, hydrateEmbeds, setSlideDoc } from './markdown.js';
import { buildPrompt, appList, sendTo, share, buildQaMarkdown } from './ask.js';
import {
  noteList, loadNote, renderSection, extractCards, findNoteInGroups,
  marginNoteDocs, findMnDoc,
  loadSrs, saveSrs, dueCards, gradeCard, srsStats, keepAwake, cardsFromBox,
  studyQueue, groupCards, suspendCard, unsuspendCard, buryCard, toggleStar,
  deckTree, cardsInDeck, liveCards, isArchivedCard, deckOf, subKey, noteKey,
  isStarred, isSuspended, isLeech, LEECH_AT, retrievability, parseExamDates, nextExam,
  parseSchedule, lecturesFor, lectureDays, weekOf, dayKey, qaCards, dueToday,
  splitAnswer,
  splitWord, wordScore, blockContext, blankNode, tidyCardHtml,
} from './reader.js';
import { search, cacheSubject, storageInfo, matcher, findAll, buildIndex, indexInfo } from './search.js';
import { JOKBO_ROOT, parseJokbo, chapterTitle } from './jokbo.js';
import { nameSimilarity } from './wiki.js';
import {
  kvGet, kvSet, kvDel, cacheClear, enqueue, listOutbox, dequeue, bumpTries,
  saveCards, allCards, deleteCard,
  allSessions, clearSession, allAttempts,
} from './db.js';
import { weakQueue, weakBySubject, examProgress } from './attempts.js';

// 모의고사와 퀴즈를 둘 다 읽는다 — vault에서 내가 만든 퀴즈도 앱에서 풀 수 있어야 한다.
// 두 폴더의 HTML이 같은 QUESTIONS 스키마를 쓰므로 파서는 그대로 재사용한다(2026-10-10).
const EXAM_ROOTS = [
  { root: '06_모의고사', kind: '모의고사' },
  { root: '05_퀴즈', kind: '퀴즈' },
  // 족보(학교 기출)는 HTML이 아니라 **가공된 마크다운**이고 과목별 가공 상태가 제각각이다.
  // 지금 가공이 끝난 응급_중환자만 연다(2026-10-12 요청) — `only`를 늘리면 과목이 늘어난다.
  { root: JOKBO_ROOT, kind: '족보', ext: '.md', only: ['응급_중환자'] },
];
const LOG_DIR = '00_Raw_Text/AI대화로그';

/**
 * vault에 남길 파일 이름을 짓는다.
 *
 * 왜 길이를 재는가(2026-10-15): 강의 제목을 그대로 넣었더니
 * `응급_중환자_26-10-14_응급_중환자_—_소아기본소생술(PBLS)_및_이물질_기도폐쇄_(차민수_교_모아두기.md`
 * 같은 이름이 나왔고, **맥의 문서 동기화가 이런 긴 이름을 제멋대로 줄여버렸다** —
 * 끝 네 글자가 ` 2`나 `ᄆ`로 바뀌어 `_모아두기`가 통째로 날아갔다. 내용은 멀쩡한데
 * 이름만 뭉개져서 git이 "지워졌다"고 보고, 같은 날 올린 6개가 서로 이름이 겹칠 뻔했다.
 *
 * 그래서 **글자 수가 아니라 바이트로** 잰다(한글 한 글자가 3바이트다). 여유를 두고
 * 90바이트에서 자른다 — 뒤에 `-2`, `-3`이 붙을 자리도 남겨야 한다.
 *
 * 제목이 과목으로 시작하면 그 부분은 뗀다. 파일 이름이 이미 과목으로 시작하므로
 * 두 번 적을 이유가 없다(위 예에서 "응급_중환자"가 두 번 들어가 있었다).
 */
const NAME_BYTES = 90;
function vaultName(subject, stamp, title, kind) {
  const bytes = (s) => new TextEncoder().encode(s).length;
  let slug = String(title || '메모').replace(/[\/\\:*?"<>|]+/g, '_').trim();
  if (subject) {
    // "응급_중환자 — 소아기본소생술…" / "응급중환자_소아기본소생술…" 둘 다 떼어낸다
    const bare = subject.replace(/_/g, '');
    slug = slug.replace(new RegExp(`^(${subject}|${bare})\\s*[—\\-_·]*\\s*`), '').trim() || slug;
  }
  slug = slug.replace(/\s+/g, '_');
  const head = `${subject ? `${subject}_` : ''}${stamp}_`;
  const tail = `_${kind}.md`;
  let room = NAME_BYTES - bytes(head) - bytes(tail);
  // 한 글자씩 떼어내며 줄인다 — 바이트 중간에서 자르면 글자가 깨진다
  while (slug && bytes(slug) > room) slug = slug.slice(0, -1);
  slug = slug.replace(/[_\-—·\s]+$/, '');   // 자르다 남은 이음표는 떼어낸다
  return `${head}${slug || '메모'}${tail}`;
}
// 여러 시험에서 끌어모아 푸는 "다시 볼 문항"의 이어풀기 키 — 실제 파일 경로와 겹치지 않게 한다
const WEAK_KEY = '__weak__';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const screens = ['setupScreen', 'listScreen', 'quizScreen', 'resultScreen', 'readScreen', 'cardScreen', 'deckScreen'];
let quiz = null;
let lastResult = null;
let currentExam = null; // {subject, file, path, title}

// ---------- 화면 전환 ----------
function show(id) {
  screens.forEach((s) => document.getElementById(s).classList.toggle('hidden', s !== id));
  // CSS가 "지금 어느 화면인가"를 알아야 한다 — 읽기 화면만 페이지 스크롤을 끄고
  // 목차·본문을 각자 스크롤시키기 때문(2026-10-12).
  document.body.dataset.screen = id;
  window.scrollTo(0, 0);
  updateAskDock();                   // AI 답변 단추는 읽기 화면에서만 뜬다
  // 막대는 그 화면일 때만 보이므로, 화면이 바뀐 **뒤에야** 폭을 잴 수 있다.
  // 모듈이 뜰 때 재면 전부 0이라 머리줄이 막대 밑에 깔린다(2026-10-13).
  document.querySelectorAll('.read-tools').forEach(reserveForTools);
  paintFindFab();
}

// 찾을 것이 없는 화면에서는 안 띄운다 — 설정·첫 연결 화면에는 찾을 게 없다
const NO_FIND = new Set(['setupScreen']);

/**
 * 늘 떠 있는 돋보기를 지금 화면에 맞춰 세운다.
 *
 * **막대가 있으면 막대 안으로 들어간다.** 처음에는 화면에 고정해 띄웠는데, 넓은 화면
 * (900px 이상)에서는 읽기·퀴즈의 아래 막대가 화면에 붙어 있지 않고 **글 아래에 놓인다**
 * (position: static). 그래서 고정 단추가 막대의 `‹` 위에 그대로 올라탔다
 * (2026-10-16 다섯 가지 화면폭 점검에서 드러남). 막대의 **자식**으로 넣으면
 * 막대가 어디에 있든 첫 단추 자리에 알아서 선다.
 */
function paintFindFab() {
  const el = document.getElementById('findFab');
  if (!el) return;
  const screen = document.body.dataset.screen || '';
  // "찾는 중" 표시는 **창이 실제로 떠 있는지**를 보고 다시 맞춘다. 어디선가 창만
  // 숨기고 closeSearch를 안 부르면 돋보기가 영영 안 돌아오기 때문이다.
  const sheet = document.getElementById('searchSheet');
  document.body.classList.toggle('finding', !!sheet && !sheet.classList.contains('hidden'));
  el.classList.toggle('hidden', NO_FIND.has(screen));

  const sec = screen ? document.getElementById(screen) : null;
  const bar = sec ? sec.querySelector('.navbar') : null;
  const host = bar || document.body;
  if (el.parentElement !== host) host.insertBefore(el, bar ? host.firstChild : null);
  el.classList.toggle('in-bar', !!bar);
}
// 창 크기가 바뀌면 막대가 떠 있던 것이 글 아래로 내려가거나 그 반대가 된다 — 다시 세운다
window.addEventListener('resize', paintFindFab);
window.__paintFindFab = paintFindFab;     // 화면폭 점검이 이 길로 부른다

// ---------- 테마 · 표시 설정 ----------
async function applyTheme() {
  const t = (await kvGet('theme')) || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// 글자 크기·줄 간격·글줄 너비. CSS 변수 세 개로만 움직이게 해뒀다 —
// 화면마다 따로 손대면 어딘가는 반드시 빠지기 때문(2026-10-12 요청).
const DISPLAY_DEFAULT = { font: 100, line: 1.75, width: 86 };
const LINE_LABEL = { 1.55: '좁게', 1.75: '보통', 2: '넓게' };
const WIDTH_LABEL = { 0: '꽉 채움', 68: '좁게', 86: '보통', 110: '넓게' };
let displayPrefs = { ...DISPLAY_DEFAULT };

function applyDisplay(d = displayPrefs) {
  const root = document.documentElement.style;
  root.setProperty('--ui-scale', String(d.font / 100));
  root.setProperty('--read-line', String(d.line));
  // 0 = 제한 없음. ch는 글자 크기를 따라가므로 글자를 키우면 폭도 같이 늘어난다.
  root.setProperty('--read-measure', d.width ? `${d.width}ch` : 'none');
}

async function loadDisplay() {
  const saved = (await kvGet('display')) || {};
  displayPrefs = { ...DISPLAY_DEFAULT, ...saved };
  applyDisplay();
}

async function setDisplay(patch) {
  displayPrefs = { ...displayPrefs, ...patch };
  applyDisplay();
  await kvSet('display', displayPrefs);
  paintDisplayUI();
  // 읽기 화면이 열려 있으면 펜 레이어 크기가 어긋난다 — 다시 맞춘다
  if (readerPen) requestAnimationFrame(() => readerPen.resize());
  if (pen) requestAnimationFrame(() => pen.resize());
}

/** 설정 화면의 버튼·슬라이더를 지금 값에 맞춘다. */
function paintDisplayUI() {
  const d = displayPrefs;
  const r = document.getElementById('fontRange');
  if (!r) return;
  r.value = String(d.font);
  document.getElementById('fontVal').textContent = `${d.font}%`;
  document.getElementById('lineVal').textContent = LINE_LABEL[d.line] || d.line;
  document.getElementById('widthVal').textContent = WIDTH_LABEL[d.width] ?? `${d.width}자`;
  document.querySelectorAll('#lineSeg .btn').forEach((b) =>
    b.classList.toggle('primary', Number(b.dataset.line) === d.line));
  document.querySelectorAll('#widthSeg .btn').forEach((b) =>
    b.classList.toggle('primary', Number(b.dataset.width) === d.width));
}

function initDisplayUI() {
  const r = document.getElementById('fontRange');
  if (!r) return;
  // input은 끄는 동안 계속 온다 — 미리보기는 바로 바꾸고 저장만 묶는다
  r.oninput = () => {
    displayPrefs.font = Number(r.value);
    applyDisplay();
    document.getElementById('fontVal').textContent = `${r.value}%`;
  };
  r.onchange = () => setDisplay({ font: Number(r.value) });
  document.querySelectorAll('#lineSeg .btn').forEach((b) => {
    b.onclick = () => setDisplay({ line: Number(b.dataset.line) });
  });
  document.querySelectorAll('#widthSeg .btn').forEach((b) => {
    b.onclick = () => setDisplay({ width: Number(b.dataset.width) });
  });
  document.getElementById('resetDisplay').onclick = () => setDisplay({ ...DISPLAY_DEFAULT });
  paintDisplayUI();
}

// ---------- 설정 화면 ----------
async function openSetup() {
  document.getElementById('repoInput').value = await getRepo();
  document.getElementById('repoLabel').textContent = await getRepo();
  document.getElementById('tokenInput').value = '';
  document.getElementById('setupMsg').textContent = '';
  document.getElementById('setupCloseBtn').classList.toggle('hidden', !(await hasToken()));
  updateStorageInfo();
  refreshBackupInfo();
  renderKeyList();
  renderSpeed();
  runningBuild().then(({ version, built }) => {
    const el = document.getElementById('appVersion');
    if (el) el.textContent = `앱 버전 ${version}${built ? ` · ${built} 배포` : ''}`;
  });
  document.getElementById('backupMsg').textContent = '';
  paintIndexInfo();
  if (await hasToken()) renderCacheList();
  show('setupScreen');
}

async function updateStorageInfo() {
  const el = document.getElementById('storageInfo');
  try {
    const info = await storageInfo();
    const outbox = await listOutbox();
    const sessions = Object.keys(await allSessions()).length;
    const mb = info.usageMB != null ? info.usageMB.toFixed(1) : '?';
    el.textContent =
      `사용 중 ${mb}MB · 저장된 파일 ${info.files}개 · 저장 대기 ${outbox.length}건 · 풀던 시험 ${sessions}개`;
  } catch {
    el.textContent = '확인할 수 없음';
  }
}

// ── vault 글 전체 색인 (2026-10-15) ──
// "지금껏 꼭 열어본 페이지만 검색이 되는 이유는 뭐지. 그게 더 좋은가?"
// 더 좋지 않았다 — 자세한 사정은 search.js 머리말에 적었다(글만 보면 20MB다).
let indexing = false;

function sinceLabel(ms) {
  if (!ms) return '아직 안 받음';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

async function paintIndexInfo() {
  const el = document.getElementById('indexInfo');
  const btn = document.getElementById('indexBtn');
  if (!el) return;
  const info = await indexInfo();
  el.textContent = info.built ? `글 ${info.files}개 · ${sinceLabel(info.at)}` : '아직 안 받음';
  if (btn && !indexing) btn.textContent = info.built ? '새로 고침' : '받기';
}

/** 색인을 맞춘다. 처음이면 전부, 그다음부터는 바뀐 것만. */
async function runIndex({ quiet = false } = {}) {
  if (indexing) return null;
  indexing = true;
  const prog = document.getElementById('indexProgress');
  const btn = document.getElementById('indexBtn');
  if (btn) { btn.disabled = true; btn.textContent = '받는 중…'; }
  try {
    const r = await buildIndex((done, total, label) => {
      if (prog && !quiet) prog.textContent = `${done}/${total} — ${label}`;
    });
    if (prog && !quiet) {
      prog.textContent = r.fetched
        ? `${r.fetched}개를 새로 받았습니다 (글 ${r.total}개가 검색 범위에 있습니다).`
        : `이미 최신입니다 — 글 ${r.total}개가 검색 범위에 있습니다.`;
    }
    if (r.truncated && prog) prog.textContent += ' ⚠️ 목록이 너무 길어 일부만 받았습니다.';
    updateStorageInfo();
    return r;
  } catch (e) {
    if (prog && !quiet) prog.textContent = `받지 못했습니다: ${e.message}`;
    return null;
  } finally {
    indexing = false;
    if (btn) btn.disabled = false;
    paintIndexInfo();
  }
}

document.getElementById('indexBtn')?.addEventListener('click', () => runIndex());

/** 설정 화면의 과목별 오프라인 저장 목록 */
async function renderCacheList() {
  const box = document.getElementById('cacheList');
  box.innerHTML = '<p class="muted">과목을 확인하는 중…</p>';
  try {
    const subjects = (await listDir(EXAM_ROOT)).filter((e) => e.type === 'dir');
    box.innerHTML = '';
    for (const s of subjects) {
      const row = document.createElement('div');
      row.className = 'cache-row';
      const name = document.createElement('div');
      name.className = 'cr-name';
      name.textContent = s.name.replace(/_/g, ' ');
      const btn = document.createElement('button');
      btn.textContent = '저장';
      btn.onclick = async () => {
        btn.disabled = true;
        const prog = document.getElementById('cacheProgress');
        try {
          await cacheSubject(s.name, (done, total, label) => {
            prog.textContent = `${s.name}: ${done}/${total} — ${label}`;
          });
          prog.textContent = `${s.name} 저장 완료`;
          btn.textContent = '완료 ✓';
          updateStorageInfo();
        } catch (e) {
          prog.textContent = `실패: ${e.message}`;
          btn.disabled = false;
        }
      };
      row.append(name, btn);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<p class="muted">목록을 불러오지 못했습니다: ${e.message}</p>`;
  }
}

document.getElementById('saveTokenBtn').onclick = async () => {
  const msg = document.getElementById('setupMsg');
  const token = document.getElementById('tokenInput').value.trim();
  const repo = document.getElementById('repoInput').value.trim();
  if (!token) { msg.className = 'err'; msg.textContent = '토큰을 입력해 주세요.'; return; }
  msg.className = ''; msg.textContent = '확인 중…';
  const r = await verifyToken(token, repo);
  if (!r.ok) { msg.className = 'err'; msg.textContent = r.error; return; }
  await setRepo(repo);
  await setToken(token);
  msg.className = 'ok';
  msg.textContent = `연결됨 — ${r.name}${r.private ? ' (비공개)' : ''}`;
  document.getElementById('setupCloseBtn').classList.remove('hidden');
  refreshBackupInfo();
  await offerRestoreIfFresh();        // 새로 설치했으면 백업을 되살릴지 묻는다
  setTimeout(() => loadList(true), 700);
};

// ---------- 백업 · 복원 ----------
// iOS는 홈화면 아이콘을 지우면 앱 데이터를 통째로 지운다. 아이콘을 바꾸려면 지웠다
// 다시 추가하는 수밖에 없어서, 그때마다 플래시카드 일정·이어풀기가 날아갔다(2026-10-09).
async function refreshBackupInfo() {
  const el = document.getElementById('backupInfo');
  if (!el) return;
  if (!(await hasToken())) { el.textContent = '토큰을 연결하면 백업할 수 있습니다.'; return; }
  const at = await backup.lastBackupAt();
  el.textContent = at
    ? `마지막 백업: ${new Date(at).toLocaleString('ko-KR')}`
    : '아직 백업한 적이 없습니다.';
}

/** 이 기기가 "방금 설치한 빈 상태"면 백업 복원을 제안한다. */
async function offerRestoreIfFresh() {
  const mine = await backup.collectState();
  const empty = !Object.keys(mine.kv.srs || {}).length
    && !Object.keys(mine.sessions || {}).length;
  if (!empty) return;
  let remote;
  try { remote = await backup.fetchBackup(); } catch { return; }
  if (!remote) return;
  const msg = document.getElementById('backupMsg');
  msg.className = '';
  msg.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'warn-box';
  box.textContent = `이전 백업이 있습니다 — ${backup.describe(remote)}. 되살릴까요?`;
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.style.marginTop = '10px';
  btn.textContent = '복원하기';
  btn.onclick = () => doRestore(remote);
  msg.append(box, btn);
}

async function doRestore(state) {
  const msg = document.getElementById('backupMsg');
  msg.className = ''; msg.textContent = '복원 중…';
  try {
    const got = state || (await backup.fetchBackup());
    if (!got) { msg.className = 'err'; msg.textContent = '백업을 찾지 못했습니다.'; return; }
    const n = await backup.restore(got);
    msg.className = 'ok';
    msg.textContent =
      `복원 완료 — 플래시카드 ${n.srs}장 · 시험 ${n.sessions}개 · 저장 대기 ${n.outbox}건. ` +
      'GitHub 토큰과 Gemini 키는 보안상 백업하지 않으므로 직접 넣어주세요.';
    await applyTheme();
    refreshBackupInfo();
    updateStorageInfo();
  } catch (e) {
    msg.className = 'err'; msg.textContent = `복원 실패: ${e.message}`;
  }
}

document.getElementById('backupNowBtn').onclick = async () => {
  const msg = document.getElementById('backupMsg');
  msg.className = ''; msg.textContent = '백업 중…';
  try {
    const s = await backup.backupNow();
    msg.className = 'ok'; msg.textContent = `백업했습니다 — ${backup.describe(s)}`;
    refreshBackupInfo();
  } catch (e) {
    msg.className = 'err'; msg.textContent = `백업 실패: ${e.message}`;
  }
};
document.getElementById('restoreBtn').onclick = () => doRestore(null);

document.getElementById('saveGeminiBtn').onclick = async () => {
  const msg = document.getElementById('geminiMsg');
  const input = document.getElementById('geminiKeyInput');
  const key = input.value.trim();
  if (!key) { msg.style.color = 'var(--wrong)'; msg.textContent = '키를 입력해 주세요.'; return; }
  if ((await gem.getKeys()).includes(key)) {
    msg.style.color = 'var(--sub)'; msg.textContent = '이미 넣어둔 키입니다.';
    input.value = ''; return;
  }
  msg.style.color = ''; msg.textContent = '확인 중…';
  const r = await gem.verifyKey(key);
  if (!r.ok) { msg.style.color = 'var(--wrong)'; msg.textContent = r.error; return; }
  const list = await gem.addKey(key);
  input.value = '';
  msg.style.color = 'var(--correct)';
  msg.textContent = list.length > 1
    ? `키 ${list.length}개 — 하나가 한도에 걸리면 자동으로 다음 키를 씁니다.`
    : `연결됐습니다 (모델: ${r.model}). 밑줄을 그으면 옆에 바로 답변이 뜹니다.`;
  renderKeyList();
};

/** 실측 응답 속도 — "느리다"가 한도 문제인지 모델 문제인지 눈으로 가른다. */
function renderSpeed() {
  const box = document.getElementById('speedBox');
  if (!box) return;
  const rows = gem.speedReport();
  box.innerHTML = '';
  if (!rows.length) {
    box.innerHTML = '<p class="muted">아직 측정된 응답 속도가 없습니다 — 몇 번 써보면 여기에 쌓입니다.</p>';
    return;
  }
  const head = document.createElement('p');
  head.className = 'muted';
  head.textContent = '이 기기에서 실제로 걸린 시간(중앙값). 느린 모델은 자동으로 피합니다.';
  box.appendChild(head);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'speed-row';
    const nm = document.createElement('span');
    nm.className = 'speed-name';
    nm.textContent = r.model;
    const ms = document.createElement('span');
    ms.className = `speed-ms${r.slow ? ' slow' : ''}`;
    ms.textContent = `${(r.median / 1000).toFixed(1)}초`;
    const n = document.createElement('span');
    n.className = 'speed-n';
    n.textContent = `${r.n}회`;
    row.append(nm, ms, n);
    box.appendChild(row);
  }
}

/** 넣어둔 키 목록 — 어느 키가 쉬는 중인지까지 보여준다. */
async function renderKeyList() {
  const box = document.getElementById('geminiKeyList');
  if (!box) return;
  const st = await gem.keyStatus();
  box.innerHTML = '';
  if (!st.length) {
    box.innerHTML = '<p class="muted">넣어둔 키가 없습니다 — 질문은 다른 앱으로 넘기는 방식으로 동작합니다.</p>';
    return;
  }
  for (const k of st) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = k.masked;
    const state = document.createElement('span');
    state.className = `key-state${k.ok ? '' : ' cool'}`;
    state.textContent = k.ok
      ? (k.known ? `${k.limit - k.used}회 남음` : '사용 가능')
      : (k.waitSec > 600 ? '오늘 한도 소진' : `${k.waitSec}초 쉬는 중`);
    const del = document.createElement('button');
    del.className = 'key-del';
    del.textContent = '삭제';
    del.onclick = async () => {
      await gem.removeKey(k.key);
      renderKeyList();
      const m = document.getElementById('geminiMsg');
      m.style.color = 'var(--sub)'; m.textContent = '키를 지웠습니다.';
    };
    row.append(name, state, del);
    box.appendChild(row);
  }
}

/** 404가 났을 때 뭐가 쓸 수 있는지 직접 보고 고를 수 있게. */
document.getElementById('listModelsBtn').onclick = async () => {
  const msg = document.getElementById('geminiMsg');
  const box = document.getElementById('modelList');
  const key = document.getElementById('geminiKeyInput').value.trim() || (await gem.getKey());
  if (!key) { msg.style.color = 'var(--wrong)'; msg.textContent = '먼저 키를 입력하세요.'; return; }
  msg.style.color = ''; msg.textContent = '조회 중…';
  box.innerHTML = '';
  try {
    const names = await gem.listModels(key);
    const cur = await gem.getModel();
    msg.textContent = `${names.length}개 사용 가능 (현재: ${cur})`;
    names.forEach((full) => {
      const name = full.replace(/^models\//, '');
      const row = document.createElement('div');
      row.className = 'cache-row';
      const n = document.createElement('div');
      n.className = 'cr-name';
      n.textContent = name + (name === cur ? '  ← 사용 중' : '');
      const b = document.createElement('button');
      b.textContent = '이걸로';
      b.onclick = async () => {
        // 손으로 고른 건 "이걸 써라"는 뜻이다 — 예전에 죽었다고 기억해둔 걸 풀어준다.
        // (안 풀면 modelFor가 조용히 다른 모델로 바꿔버려서 고른 게 무시된다)
        gem.resetModels();
        await gem.setModel(name);
        msg.style.color = 'var(--correct)';
        msg.textContent = `모델을 ${name}(으)로 바꿨습니다.`;
      };
      row.append(n, b);
      box.appendChild(row);
    });
  } catch (e) {
    msg.style.color = 'var(--wrong)';
    msg.textContent = e.message;
  }
};

document.getElementById('clearCacheBtn').onclick = async () => {
  await cacheClear();
  updateStorageInfo();
  const msg = document.getElementById('setupMsg');
  msg.className = 'ok'; msg.textContent = '캐시를 비웠습니다.';
};

document.getElementById('clearTokenBtn').onclick = async () => {
  await clearToken();
  const msg = document.getElementById('setupMsg');
  msg.className = 'ok'; msg.textContent = '토큰을 삭제했습니다.';
  document.getElementById('setupCloseBtn').classList.add('hidden');
};

document.getElementById('setupCloseBtn').onclick = () => loadList(false);
document.getElementById('settingsBtn').onclick = openSetup;
document.querySelectorAll('[data-theme-set]').forEach((b) => {
  b.onclick = async () => { await kvSet('theme', b.dataset.themeSet); applyTheme(); };
});

// ---------- 모의고사 목록 ----------
document.getElementById('refreshBtn').onclick = () => loadList(true);

async function loadList(force) {
  if (!(await hasToken())) return openSetup();
  show('listScreen');
  restoreTab(force);          // force를 넘겨야 ↻ 가 노트·시간표까지 다시 읽는다
  // 로딩·오류 문구는 **지금 보고 있는 탭**에 띄운다
  const active = document.querySelector('.tab.active')?.dataset.tab;
  const body = document.getElementById(TAB_BODY[active] || 'todayBody');
  if (active === 'quizzes' || active === 'exams' || active === 'jokbo') {
    body.innerHTML = '<p class="muted">불러오는 중…</p>';
  }

  try {
    const index = await buildExamIndex(force);
    const sessions = await allSessions();
    renderList(index, sessions, '퀴즈');
    renderList(index, sessions, '모의고사');
    renderList(index, sessions, '족보');
  } catch (e) {
    body.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'warn-box';
    box.textContent =
      e.message === 'NO_TOKEN'
        ? '토큰이 없습니다. 설정에서 먼저 연결해 주세요.'
        : `목록을 불러오지 못했습니다: ${e.message}`;
    body.appendChild(box);
    const btn = document.createElement('button');
    btn.className = 'btn full';
    btn.style.marginTop = '12px';
    btn.textContent = '설정 열기';
    btn.onclick = openSetup;
    body.appendChild(btn);
  }
}

/**
 * 06_모의고사 · 05_퀴즈를 뒤져 "과목 · 종류"별 목록을 만든다.
 *
 * 캐시해두기 때문에 **수업 후에 새 퀴즈가 올라오면 새로고침을 눌러야** 보인다.
 * (05_퀴즈/응급_중환자/ 처럼 폴더가 나중에 생기는 경우도 force로 집어온다.)
 */
let examIndexInFlight = null;

async function buildExamIndex(force) {
  // 같은 새로고침에서 두 곳(목록·오늘 탭)이 동시에 부른다. 합쳐주지 않으면
  // 폴더를 두 번 훑어 GitHub API 호출이 배로 든다(2026-10-10).
  if (examIndexInFlight) return examIndexInFlight;
  examIndexInFlight = _buildExamIndex(force).finally(() => { examIndexInFlight = null; });
  return examIndexInFlight;
}

async function _buildExamIndex(force) {
  // v3: 정렬이 날짜 오름차순으로 바뀌었다. 키를 안 올리면 **이미 저장된 역순 목록**이
  // 그대로 떠서 "안 고쳐졌다"가 된다(캐시가 정렬 결과까지 담고 있다).
  const cacheKey = 'exam_index_v3';
  let index = force ? null : await kvGet(cacheKey);
  if (!index) {
    const byKey = new Map();            // "과목 · 종류" 단위로 묶는다
    for (const { root, kind, ext = '.html', only } of EXAM_ROOTS) {
      let subjects;
      try { subjects = (await listDir(root)).filter((e) => e.type === 'dir'); }
      catch { continue; }               // 폴더가 없는 과목도 있다 — 조용히 넘어간다
      if (only) subjects = subjects.filter((e) => only.includes(e.name));
      for (const sub of subjects) {
        let files;
        try { files = await listDir(sub.path); } catch { continue; }
        const items = files
          .filter((f) => f.type === 'file' && f.name.endsWith(ext) && !f.name.startsWith('_')
            // 족보는 `NN_챕터.md`만 문항이다 — `00_과목소개`는 총평이라 뺀다
            && (kind !== '족보' || /^(?!00_)\d{2}_/.test(f.name)))
          .map((f) => ({ file: f.name, path: f.path, kind }));
        if (!items.length) continue;
        const k = `${sub.name}|${kind}`;
        if (!byKey.has(k)) byKey.set(k, { subject: sub.name, kind, exams: [] });
        byKey.get(k).exams.push(...items);
      }
    }
    index = [...byKey.values()];
    for (const g of index) {
      // 날짜 **오름차순** — 배운 순서대로 읽힌다(2026-10-12 요청: 역순이라 보기 나쁨).
      // 날짜를 못 읽은 파일은 키가 '999999'라 자연히 맨 뒤로 간다.
      g.exams.sort((a, b) => examSortKey(a.file).localeCompare(examSortKey(b.file))
        || a.file.localeCompare(b.file, 'ko'));
    }
    // 모의고사를 먼저, 그 다음 퀴즈. 같은 종류 안에서는 과목 이름순.
    index.sort((a, b) => (a.kind === b.kind ? a.subject.localeCompare(b.subject, 'ko')
      : a.kind === '모의고사' ? -1 : 1));
    await kvSet(cacheKey, index);
  }
  return index;
}

/**
 * 시험 목록을 그린다. 퀴즈와 모의고사는 **탭이 다르므로 따로** 그린다(2026-10-10 요청).
 * @param {string} kind '모의고사' | '퀴즈'
 */
function renderList(index, sessions, kind = '모의고사') {
  const bodyId = kind === '퀴즈' ? 'quizBody' : kind === '족보' ? 'jokboBody' : 'listBody';
  const body = document.getElementById(bodyId);
  body.innerHTML = '';
  index = index.filter((g) => (g.kind || '모의고사') === kind);
  if (!index.length) {
    // 목록은 캐시해두기 때문에, 수업 후 vault에 새 폴더가 생겨도 새로고침 전에는
    // 안 보인다. 빈 화면에서 그걸 알려줘야 한다(2026-10-10).
    body.innerHTML = '';
    // 어디를 보는 중인지 **전부** 알려준다 — 모의고사만 한 줄로 끝나고 있었다(2026-10-14)
    const WHERE = {
      퀴즈: 'vault의 05_퀴즈/{과목}/ 에 파일이 생기면 여기에 나옵니다.',
      족보: `vault의 ${JOKBO_ROOT}/{과목}/NN_챕터.md 를 읽습니다.`,
      모의고사: 'vault의 06_모의고사/{과목}/ 에 파일이 생기면 여기에 나옵니다.',
    };
    body.appendChild(muted(`${kind}를 찾지 못했습니다. ${WHERE[kind] || ''}`.trim()));
    const b = document.createElement('button');
    b.className = 'btn full';
    b.style.marginTop = '10px';
    b.textContent = '↻ vault에서 다시 찾기';
    b.onclick = () => loadList(true);
    body.appendChild(b);
    return;
  }
  // 과목을 접을 수 있게 한다 — 전부 펼쳐져 있으면 찾는 데 오래 걸린다(2026-10-09 피드백).
  // 마지막으로 연 과목만 펼친 채로 기억한다(탭마다 따로).
  const lastOpen = localStorage.getItem(`open_subject_${kind}`);
  index.forEach((group, gi) => {
    const det = document.createElement('details');
    det.className = 'subject-group';
    const gkey = `${group.subject}|${group.kind || ''}`;
    det.open = lastOpen ? gkey === lastOpen : gi === 0;
    det.ontoggle = () => { if (det.open) localStorage.setItem(`open_subject_${kind}`, gkey); };

    const sum = document.createElement('summary');
    sum.className = 'subject-head';
    const inProgress = group.exams.filter((e) => sessions[e.path]).length;
    sum.innerHTML = '<span class="head-row">' +
      `<span>${escapeText(group.subject.replace(/_/g, ' '))}</span>` +
      `<span class="subject-count">${group.exams.length}개` +
      (inProgress ? ` · 풀던 중 ${inProgress}` : '') + '</span></span>';
    det.appendChild(sum);
    body.appendChild(det);

    group.exams.forEach((ex) => {
      const btn = document.createElement('button');
      btn.className = 'exam-item';

      // 족보는 날짜가 아니라 **강의 번호**로 묶인다(NN_챕터.md) — 그 번호를 날짜 자리에 쓴다
      const isJokbo = (ex.kind || group.kind) === '족보';
      const d = document.createElement('span');
      d.className = 'exam-date';
      d.textContent = isJokbo ? (ex.file.match(/^(\d{2})_/) || ['', ''])[1] : examDate(ex.file);

      const nameWrap = document.createElement('span');
      nameWrap.className = 'exam-name';
      nameWrap.textContent = isJokbo ? chapterTitle(ex.file) : prettyExamName(ex.file);
      const who = isJokbo ? '' : teacherName(ex.file);
      if (who) {
        const t = document.createElement('span');
        t.className = 'teacher-tag';
        t.textContent = who;
        nameWrap.appendChild(t);
      }

      const s = sessions[ex.path];
      if (s) {
        const meta = document.createElement('div');
        meta.className = 'exam-meta';
        const done = (s.answers || []).filter((a) => a !== null).length;
        meta.textContent = `풀던 중 — ${done}/${s.total ?? '?'}문항`;
        nameWrap.appendChild(meta);
      }

      const prog = document.createElement('span');
      prog.className = 'exam-progress';
      prog.textContent = s ? '이어풀기 ›' : '›';

      btn.appendChild(d);
      btn.appendChild(nameWrap);
      btn.appendChild(prog);
      btn.onclick = () => openExam(group.subject, ex);
      det.appendChild(btn);
    });
  });
}

/**
 * 노트 읽기 탭 맨 위의 "이번 주 강의" — 시간표를 읽어 바로가기를 깐다.
 *
 * 왜: 노트 목록이 뿌리 3개 × 과목 28개라, 지금 배우는 강의 하나를 열려고
 * 폴더를 두세 겹 더듬어야 한다(2026-10-13 지적). 시간표에 "언제 무슨 강의"가
 * 이미 있으니 그걸로 바로 열어준다.
 */
async function renderNoteWeek(body, groups) {
  let schedule = [];
  let exams = [];
  try { ({ schedule, exams } = await todayData(false)); } catch { return; }
  if (!schedule.length) return;

  // 시험이 임박한 과목을 먼저 — "오늘" 탭과 같은 기준
  const norm = (x) => String(x || '').replace(/[_\s]/g, '');
  const next = nextExam(exams);
  let pool = schedule;
  if (next) {
    const hot = schedule.filter((l) => norm(l.src) === norm(next.src));
    if (hot.length) pool = hot;
  }
  const days = lectureDays(pool);
  if (!days.length) return;
  const week = weekOf(days, noteWeekPick || undefined);
  if (!week.length) return;

  const from = week[0].date;
  const to = week[week.length - 1].date;
  const subject = pool[0] ? pool[0].src : '';

  const box = document.createElement('div');
  box.className = 'note-week';

  const head = document.createElement('div');
  head.className = 'nw-head';
  const t = document.createElement('span');
  t.textContent = subject ? `이번 주 — ${subject}` : '이번 주 강의';
  const range = document.createElement('span');
  range.className = 'muted';
  range.textContent = `${from.slice(5).replace('-', '/')} ~ ${to.slice(5).replace('-', '/')}`;
  head.append(t, range);

  // 주 넘기기
  const nav = (dir, label) => {
    const outside = dir < 0
      ? days.filter((d) => d.date < from).slice(-1)
      : days.filter((d) => d.date > to).slice(0, 1);
    const b = document.createElement('button');
    b.className = 'nw-btn';
    b.textContent = label;
    b.disabled = !outside.length;
    b.onclick = () => { noteWeekPick = outside[0].date; loadNotesTab(false); };
    return b;
  };
  const navWrap = document.createElement('span');
  navWrap.className = 'nw-btns';
  navWrap.style.marginLeft = 'auto';
  navWrap.append(nav(-1, '‹'), nav(1, '›'));
  head.appendChild(navWrap);
  box.appendChild(head);

  const list = document.createElement('div');
  list.className = 'nw-list';
  const today = dayKey();
  let shown = 0;
  for (const d of week) {
    for (const l of pool.filter((x) => x.date === d.date)) {
      if (!l.wiki && !l.note) continue;              // 노트가 없는 줄은 띄울 이유가 없다
      const row = document.createElement('div');
      row.className = `nw-row${d.date === today ? ' is-today' : ''}`;
      const dt = document.createElement('span');
      dt.className = 'nw-date';
      dt.textContent = `${d.date.slice(5).replace('-', '/')}(${d.dow})`;
      const nm = document.createElement('span');
      nm.className = 'nw-name';
      nm.textContent = l.name;
      nm.title = l.name;
      const btns = document.createElement('span');
      btns.className = 'nw-btns';
      const mk = (label, name, cls) => {
        const b = document.createElement('button');
        b.className = `nw-btn${cls ? ' ' + cls : ''}`;
        b.textContent = label;
        b.onclick = () => openNoteByName(name, { groups });
        btns.appendChild(b);
      };
      if (l.wiki) mk('📗 실강', l.wiki, 'primary');
      if (l.note) mk('📖 예습', l.note);
      row.append(dt, nm, btns);
      list.appendChild(row);
      shown++;
    }
  }
  if (!shown) return;                                 // 이번 주 노트가 하나도 없으면 띄우지 않는다
  box.appendChild(list);

  if (noteWeekPick) {
    const back = document.createElement('button');
    back.className = 'nw-btn';
    back.style.marginTop = '8px';
    back.textContent = '↩ 이번 주로';
    back.onclick = () => { noteWeekPick = null; loadNotesTab(false); };
    box.appendChild(back);
  }
  body.appendChild(box);
}

let noteWeekPick = null;

// ---------- "오늘" 탭의 수업 구역 (2026-10-13) ----------
//
// 전에는 하루치만 띄웠다 — 어제 배운 걸 다시 꺼낼 길이 없었고, 그날의 시험은
// 강의와 따로 맨 아래 한 뭉치로 나와서 어느 게 어느 강의 것인지 알 수 없었다.
// ① 그 주의 수업일을 가로로 깔아 넘겨보게 하고
// ② 시험을 **그 강의 줄에 직접** 붙인다.

let dayPick = null;        // 사용자가 고른 날짜(null이면 오늘/가장 가까운 날)

function renderDaySection(body, pool, index, attempts, noteGroups) {
  const days = lectureDays(pool);
  if (!days.length) {
    const sec = section(body, '수업');
    sec.appendChild(muted('시간표에서 강의를 찾지 못했습니다.'));
    return;
  }
  // 고른 날이 지금 주에 없으면(주를 옮겼다) 그 주의 첫날로 맞춘다
  const base = dayPick || (lecturesFor(pool).date);
  const week = weekOf(days, base);
  const cur = week.some((d) => d.date === base) ? base : week[0].date;

  const title = cur === dayKey() ? '오늘 수업'
    : cur < dayKey() ? '지난 수업' : '다음 수업';
  const sec = section(body, `${title} · ${cur.slice(5).replace('-', '/')}`);

  // ── 날짜 띠 ──
  const strip = document.createElement('div');
  strip.className = 'day-strip';
  const weekNav = (dir) => {
    // 이 주 밖에서 가장 가까운 수업일로 — 주 단위로 건너뛴다
    const outside = dir < 0
      ? days.filter((d) => d.date < week[0].date).slice(-1)
      : days.filter((d) => d.date > week[week.length - 1].date).slice(0, 1);
    if (!outside.length) return null;
    return outside[0].date;
  };
  const arrow = (dir, label) => {
    const b = document.createElement('button');
    b.className = 'day-nav';
    b.textContent = label;
    const to = weekNav(dir);
    b.disabled = !to;
    b.title = dir < 0 ? '지난 주' : '다음 주';
    b.onclick = () => { dayPick = to; loadTodayTab(false); };
    return b;
  };
  strip.appendChild(arrow(-1, '‹'));
  week.forEach((d) => {
    const b = document.createElement('button');
    b.className = `day-chip${d.date === cur ? ' active' : ''}${d.isToday ? ' today' : ''}`;
    b.innerHTML = `<span class="dc-d">${d.date.slice(8)}</span>`
      + `<span class="dc-w">${d.dow}</span>`
      + `<span class="dc-n">${d.n}</span>`;
    b.title = `${d.date} (강의 ${d.n}개)`;
    b.onclick = () => { dayPick = d.date; loadTodayTab(false); };
    strip.appendChild(b);
  });
  strip.appendChild(arrow(1, '›'));
  sec.appendChild(strip);

  // 오늘이 아닌 날을 보고 있으면 돌아올 길을 준다
  if (cur !== dayKey() && days.some((d) => d.isToday)) {
    const back = document.createElement('button');
    back.className = 'chip day-back';
    back.textContent = '↩ 오늘로';
    back.onclick = () => { dayPick = null; loadTodayTab(false); };
    sec.appendChild(back);
  }

  // ── 그 날의 강의 ──
  const lectures = pool.filter((l) => l.date === cur);
  const want = `26${cur.slice(5, 7)}${cur.slice(8, 10)}`;      // YYMMDD
  const usedExams = new Set();
  const byLecture = assignExams(index, lectures, want);

  lectures.forEach((l, li) => {
    const row = document.createElement('div');
    row.className = 'today-lec';
    const head = document.createElement('div');
    head.className = 'today-lec-head';
    head.innerHTML = `<span class="today-period">${escapeHtml(l.period || '')}</span>`
      + `<b>${escapeHtml(l.name)}</b>`
      + (l.teacher ? `<span class="muted"> ${escapeHtml(l.teacher)}</span>` : '');
    row.appendChild(head);

    const chips = document.createElement('div');
    chips.className = 'today-chips';
    const chip = (label, fn, cls = '') => {
      const b = document.createElement('button');
      b.className = `chip${cls ? ' ' + cls : ''}`;
      b.textContent = label;
      b.onclick = fn;
      chips.appendChild(b);
    };

    // 노트 — 실강(수업 후 정리)이 먼저, 그 다음 예습
    if (l.wiki) chip('📗 실강노트', () => openNoteByName(l.wiki, { groups: noteGroups }));
    if (l.note) chip('📖 예습노트', () => openNoteByName(l.note, { groups: noteGroups }));

    // 이 강의의 모의고사·퀴즈 — 전에는 맨 아래 한 뭉치라 어느 강의 것인지 몰랐다
    const mine = byLecture.get(li) || [];
    // 같은 종류가 두 개면 칩에 주제까지 적는다 — "퀴즈" 두 개로는 뭐가 뭔지 모른다
    const twice = new Set(mine.map(({ g }) => g.kind)
      .filter((k, i, a) => a.indexOf(k) !== i));
    for (const { g, ex } of mine) {
      usedExams.add(ex.path);
      const p = examProgress(attempts, ex.path);
      chip(`${g.kind === '퀴즈' ? '📝' : '🧪'} ${g.kind}`
        + (twice.has(g.kind) ? ` · ${prettyExamName(ex.file)}` : '')
        + (p.seen ? ` ${p.solid}/${p.seen}${p.weak ? ` · 약함 ${p.weak}` : ''}` : ''),
      () => openExam(g.subject, ex), 'exam');
    }

    if (l.jokbo) {
      const subject = subjectOfLecture(index, l) || '';
      const hit = findJokboChapter(index, subject, l.jokbo);
      if (hit) chip('📜 족보', () => openExam(hit.g.subject, hit.ex));
    }
    if (chips.children.length) row.appendChild(chips);
    else row.appendChild(muted('아직 만들어진 자료가 없습니다.'));
    sec.appendChild(row);
  });

  // 강의에 못 붙은 그날 시험(이름이 안 맞거나 강의가 시간표에 없는 경우)은 따로 모은다
  const leftover = [];
  for (const g of index) {
    if (g.kind === '족보') continue;
    for (const ex of g.exams) {
      if (examSortKey(ex.file) === want && !usedExams.has(ex.path)) leftover.push({ g, ex });
    }
  }
  if (leftover.length) {
    const wrap = document.createElement('div');
    wrap.className = 'today-chips';
    const lab = document.createElement('span');
    lab.className = 'muted';
    lab.style.cssText = 'font-size:12px;align-self:center;margin-right:4px';
    lab.textContent = '이 날짜의 다른 자료';
    wrap.appendChild(lab);
    leftover.forEach(({ g, ex }) => {
      const b = document.createElement('button');
      b.className = 'chip';
      const p = examProgress(attempts, ex.path);
      b.textContent = `${g.kind === '퀴즈' ? '📝' : '🧪'} ${prettyExamName(ex.file)}`
        + (p.seen ? ` (${p.solid}/${p.seen})` : '');
      b.onclick = () => openExam(g.subject, ex);
      wrap.appendChild(b);
    });
    sec.appendChild(wrap);
  }
}

/** 이 강의가 어느 과목 폴더에 속하나 — 시간표의 과목명(응급중환자)과 폴더명(응급_중환자)이 다르다. */
function subjectOfLecture(index, lecture) {
  const norm = (x) => String(x || '').replace(/[_\s]/g, '');
  const want = norm(lecture.src);
  const g = index.find((x) => norm(x.subject) === want);
  return g ? g.subject : '';
}

/**
 * 그날의 모의고사·퀴즈를 강의마다 나눠 붙인다.
 *
 * 전에는 **그날의 시험 전부를 맨 아래 한 뭉치로** 보여줬다 — 강의가 하루 3개면
 * 어느 게 어느 강의 것인지 알 수가 없어서 사실상 바로가기가 아니었다(2026-10-13 지적).
 * 강의명과 시험 주제를 견줘 **그 강의 줄에 직접** 붙인다.
 *
 *   "기본소생술(BLS)"        ↔ 1012_기본소생술BLS_모의고사.html
 *   "응급의료체계 및 재난의학"  ↔ 261012_김종선_응급의료체계및재난의학_퀴즈.html
 *
 * 그런데 강의마다 "닮은 시험"을 긁어모으게 했더니 **한 시험이 여러 강의에 겹쳐 붙었다**.
 * "임상독성학총론"과 "임상독성학각론"은 서로 0.67만큼 닮아서(문턱 0.5) 두 줄이 서로의
 * 퀴즈까지 집어갔고, 총론 줄의 퀴즈 칩 두 개 중 하나를 누르면 각론 문제가 나왔다
 * (2026-10-15 지적). 그래서 방향을 뒤집는다 — **시험 쪽에서 가장 닮은 강의를 고른다**.
 * 총론 퀴즈는 총론과 1, 각론과 0.67이라 총론 줄에만 붙는다.
 *
 * 다만 **제일 닮은 강의가 둘이면 둘 다에 붙인다**. 두 시간을 한 파일로 묶은 시험이
 * 있어서다 — `1013_임상독성학_모의고사.html`은 총론·각론 어느 쪽과도 똑같이 1이고,
 * 실제로 두 시간 내용을 같이 담고 있다. 여기서 한 줄만 고르면 나머지 줄의 모의고사가
 * 사라진다. 어느 강의에도 0.5를 못 넘긴 시험은 아래 "이 날짜의 다른 자료"로 간다.
 *
 * @returns {Map<number, Array<{g, ex, sim}>>} lectures의 인덱스 → 그 줄에 붙을 시험들
 */
const SAME_SIM = 1e-9;      // Dice 값이 사실상 같은가 — 부동소수 오차만 흡수한다
function assignExams(index, lectures, dayKeyYYMMDD) {
  const out = new Map();
  for (const g of index) {
    if (g.kind === '족보') continue;                  // 족보는 날짜가 아니라 챕터로 붙는다
    for (const ex of g.exams) {
      if (examSortKey(ex.file) !== dayKeyYYMMDD) continue;
      const topic = prettyExamName(ex.file);
      const sims = lectures.map((l) => nameSimilarity(l.name, topic));
      const bestSim = Math.max(0, ...sims);
      if (bestSim < 0.5) continue;
      sims.forEach((sim, i) => {
        if (sim < bestSim - SAME_SIM) return;
        if (!out.has(i)) out.set(i, []);
        out.get(i).push({ g, ex, sim });
      });
    }
  }
  // 한 강의 안에서는 모의고사가 먼저, 그 다음 더 닮은 것부터
  for (const list of out.values()) {
    list.sort((a, b) => (a.g.kind === b.g.kind ? b.sim - a.sim
      : a.g.kind === '모의고사' ? -1 : 1));
  }
  return out;
}

/** 시간표의 `가공족보` 칸(파일명)으로 족보 챕터를 찾는다. */
function findJokboChapter(index, subject, file) {
  for (const g of index) {
    if (g.kind !== '족보') continue;
    if (subject && g.subject !== subject) continue;
    const ex = g.exams.find((e) => e.file === file);
    if (ex) return { g, ex };
  }
  return null;
}

/**
 * 족보 챕터 머리말 — "이 챕터는 매년 무엇이 나오는가".
 *
 * vault 가공본은 문항마다 해설을 달기 전에 챕터 전체 출제 경향을 먼저 적어둔다.
 * 그 2만 자가 앱에는 한 줄도 안 나오고 있었다(2026-10-13 전수 대조에서 드러남).
 */
function showJokboIntro(intro, subject) {
  const box = document.getElementById('jokboIntro');
  if (!box) return;
  box.classList.toggle('hidden', !intro);
  box.open = false;
  if (!intro) return;
  document.getElementById('jokboIntroBody').innerHTML = renderMarkdown(intro);
  const btn = document.getElementById('jokboOverview');
  btn.onclick = (e) => {
    e.preventDefault();
    openNote(`${JOKBO_ROOT}/${subject}/00_과목소개.md`);
  };
}

// ---------- 시험 열기 ----------
/**
 * 머리줄에 적을 제목 — 파일 안의 제목이 **딴 강의를 가리키면 안 쓴다**.
 *
 * 임상독성학각론 퀴즈를 열었는데 머리줄에 "소아기본소생술 PBLS 및 이물질 기도폐쇄 (차민수)"가
 * 떴다(2026-10-15 지적). 문항은 아세트아미노펜인데 머리줄만 딴소리라 **지금 뭘 풀고 있는지**를
 * 알 수 없었다. 파일을 열어보니 `<h1>`만 앞 강의에서 베껴온 채였다 — vault의 퀴즈 128개 중
 * **8개가 같은 PBLS 머리말을 달고 있었다**. 같은 파일의 `<title>`("임상독성학 각론 퀴즈 —
 * 윤성현 교수")과 `LECTURE_NAME`은 멀쩡했다. 손으로 베끼는 건 머리말이고, 나머지 둘은
 * 만드는 쪽에서 박아 넣는 값이라 그렇다.
 *
 * 그래서 **파일이 스스로 적어둔 강의명**(LECTURE_NAME 따위)과 **파일 이름**, 둘을
 * 기준으로 두고 후보를 h1 → title → 강의명 순으로 훑어 **어느 한쪽과 말이 되는 첫 번째**를
 * 쓴다. 둘 다 봐야 하는 건 서로 다른 걸 흘리기 때문이다 — 강의명은 "근골격계 골관절염"처럼
 * 과목이 앞에 붙어 제목과의 점수가 깎이고, 파일 이름은 "두경부피부_사시"처럼 눌려 있다.
 * 반대로 베껴온 머리말은 **양쪽 모두와** 0.00~0.19다. 128개를 다 재보고 0.3에서 끊었다.
 */
const TITLE_FIT = 0.3;
function examTitle(parsed, fromFile) {
  const cands = (parsed.titles || [parsed.title])
    .map((t) => String(t || '').trim()).filter(Boolean);
  const anchors = [String(parsed.lectureName || '').trim(), fromFile].filter(Boolean);
  if (!anchors.length) return cands[0] || '';
  const fits = (t) => anchors.some((a) => nameSimilarity(t, a) >= TITLE_FIT);
  return cands.find(fits) || fromFile || anchors[0];
}

async function openExam(subject, ex) {
  const body = document.getElementById('listBody');
  const prev = body.innerHTML;
  body.innerHTML = '<p class="muted">시험을 불러오는 중…</p>';
  try {
    const raw = await getText(ex.path);
    // 족보는 HTML이 아니라 가공된 마크다운이다 — 파서만 갈아끼우면 나머지(펜·뜯어보기·
    // 사이드 노트·이어풀기)는 그대로 돈다.
    const isJokbo = (ex.kind || '') === '족보';
    const parsed = isJokbo ? parseJokbo(raw, ex.path) : parseExamHtml(raw);
    const { questions } = parsed;
    showJokboIntro(isJokbo ? parsed.intro : '', subject);
    if (!questions.length) throw new Error('이 파일에서 문항을 찾지 못했습니다.');
    const fallbackTitle = isJokbo ? chapterTitle(ex.file) : prettyExamName(ex.file);
    currentExam = { subject, file: ex.file, path: ex.path, title: examTitle(parsed, fallbackTitle),
      kind: ex.kind || '' };

    if (quiz) quiz.destroy();
    destroyPen();
    closeOverview();   // 전체보기는 지금 연 시험 것이어야 한다 — 이전 시험 내용이 남으면 안 된다
    quiz = new Quiz({
      examKey: ex.path,
      questions,
      title: currentExam.title,
      onFinish: showResult,
      onExit: () => { quiz.destroy(); destroyPen(); closeOverview(); stopTimer(); loadList(false); },
      onRender: onQuestionRender,
      meta: { subject, kind: ex.kind || '' },
    });
    const had = await quiz.restore();
    show('quizScreen');
    quiz.start();
    ensurePen();
    // 넓은 화면이면 오른쪽 공간이 어차피 비므로 관련 노트를 바로 띄운다
    if (wideScreen()) {
      document.getElementById('wikiPanel').classList.remove('hidden');
      document.getElementById('toolWiki').classList.add('active');
      syncSideCol();
      loadWiki(quiz.q, quiz.answers[quiz.qIndex] !== null);
    }
    if (had) toast('이어서 풉니다.');
  } catch (e) {
    body.innerHTML = prev;
    alertBox(`시험을 열지 못했습니다: ${e.message}`);
  }
}

// ═══════════ Phase 3 — 펜 · 위키 패널 · AI 질문 ═══════════

let pen = null;
let penStrokes = {};      // {문항index: serialize()}  문항별 필기 보관
let wikiState = null;     // {refs, secIdx, unlocked}
let askItems = [];        // 이번 시험에서 물어본 것들(저장용)
let askCtx = null;        // 현재 질문 시트의 맥락

function ensurePen() {
  if (pen) return;
  // 문제 카드 + 사이드(노트·AI)를 한꺼번에 덮는다 — 위키/해설에서도 밑줄을 그을 수 있게.
  const host = document.querySelector('#quizScreen .split') || document.getElementById('qcard');
  pen = new PenLayer(host, {
    onSelect: handleSelect,
    onCapture: handleCapture,
    onTap: handlePenTap,
    onChange: () => { if (quiz) penStrokes[quiz.qIndex] = pen.serialize(); },
  });
}
function destroyPen() {
  if (pen) { pen.destroy(); pen = null; }
  penStrokes = {};
  closeWiki();
  closeAi();
}

/** 펜으로 탭 — 선지 번호를 누르면 답 선택(모드 전환 없이). */
function handlePenTap(el) {
  if (!el || !quiz) return false;
  const row = el.closest && el.closest('.opt-row');
  if (row && !row.classList.contains('locked')) {
    const rows = [...document.getElementById('optsContainer').children];
    const i = rows.indexOf(row);
    if (i >= 0) { quiz.select(i); return true; }
  }
  const ox = el.closest && el.closest('.ox-btn');
  if (ox && !ox.disabled) { quiz.select(Number(ox.dataset.ox)); return true; }
  // 접힌 콜아웃 등은 그대로 열리게
  const sum = el.closest && el.closest('summary');
  if (sum) { sum.click(); return true; }
  return false;
}

document.getElementById('toolUndo').onclick = () => pen && pen.undo();
document.getElementById('toolClear').onclick = () => pen && pen.clear();
document.getElementById('toolErase').onclick = () => setTool(penTool === 'erase' ? 'off' : 'erase');
document.getElementById('toolWiki').onclick = () => { closeOverview(); toggleWiki(); };
// AI 해설도 위키처럼 탭으로 — 질문할 때마다 자동으로 열리기만 하던 걸 직접 열고 닫게 한다
document.getElementById('toolAi').onclick = () => {
  const p = document.getElementById('aiPanel');
  if (p.classList.contains('hidden')) {
    closeOverview();
    p.classList.remove('hidden');
    syncSideCol();
    if (!askCtx || !askCtx.answer) {
      document.getElementById('aiTerm').textContent = 'AI 해설';
      document.getElementById('aiBody').innerHTML =
        '<p class="muted">문제나 해설에서 궁금한 부분을 펜으로 긋고 <b>🤖 여기서 질문</b>을 누르세요.</p>';
      document.getElementById('aiStatus').textContent = '';
    }
  } else {
    closeAi();
  }
};

/** 문항이 바뀔 때마다 — 필기 복원 + 위키 갱신 + 전체보기가 열려 있으면 같이 갱신 */
function onQuestionRender(q, idx, { answered }) {
  if (pen) {
    pen.load(penStrokes[idx] || null);
    requestAnimationFrame(() => pen && pen.resize());
  }
  if (!document.getElementById('wikiPanel').classList.contains('hidden')) {
    loadWiki(q, answered);
  }
  if (!document.getElementById('overviewPanel').classList.contains('hidden')) {
    highlightOverviewCurrent();
  }
  resetTimerForQuestion();      // "문항마다 다시 시작"이 켜져 있을 때만 움직인다
}

// ---------- 위키 패널 ----------
function toggleWiki() {
  const panel = document.getElementById('wikiPanel');
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    document.getElementById('toolWiki').classList.add('active');
    syncSideCol();
    loadWiki(quiz.q, quiz.answers[quiz.qIndex] !== null);
  } else {
    closeWiki();
  }
}
function closeWiki() {
  document.getElementById('wikiPanel').classList.add('hidden');
  document.getElementById('toolWiki').classList.remove('active');
  syncSideCol();
}
document.getElementById('wikiClose').onclick = closeWiki;

// ---------- 문항 전체보기 (2026-10-12) ----------
//
// 문제를 한 장씩 넘기지 않고 **쭉 스크롤하며 훑어보는** 화면 — 위키/AI와 같은
// 사이드 칸을 쓰므로(서로 배타적) 넓은 화면에서는 폭 조절(col-resizer)이 그대로 된다.
//
// 색상 표시는 북마크(★, "다시 볼 것" 하나뿐)와 달리 **뜻을 사용자가 정해 쓰라고**
// 6갈래를 열어둔다. Obsidian이 플러그인 없이도 그리는 색 원(🔴🟠🟡🟢🔵🟣)을 그대로
// 써서, "vault에 저장"을 누르면 Obsidian 쪽 노트에서도 같은 기호로 보인다(아래 참고).
// `name`은 **Obsidian 쪽 이름**이다 — vault에 저장할 때 `달모/빨강` 같은 태그와
// 🔴 이모지로 같이 적어서, 앱에서 칠한 색을 Obsidian에서 검색·필터할 수 있게 한다
// (2026-10-12 요청: "옵시디언에서도 관리가 같이 되면서"). 뜻은 사용자가 정해 쓴다.
const OV_TAGS = [
  { emoji: '🔴', hex: '#ef4444', name: '빨강' },
  { emoji: '🟠', hex: '#f97316', name: '주황' },
  { emoji: '🟡', hex: '#eab308', name: '노랑' },
  { emoji: '🟢', hex: '#22c55e', name: '초록' },
  { emoji: '🔵', hex: '#3b82f6', name: '파랑' },
  { emoji: '🟣', hex: '#a855f7', name: '보라' },
];

let ovFilterColor = 0;      // 0 = 필터 없음
let ovStarOnly = false;

function closeOverview() {
  document.getElementById('overviewPanel').classList.add('hidden');
  document.getElementById('toolOverview').classList.remove('active');
  syncSideCol();
}

document.getElementById('toolOverview').onclick = () => {
  const p = document.getElementById('overviewPanel');
  if (p.classList.contains('hidden')) {
    closeWiki();
    closeAi();
    ovFilterColor = 0;
    ovStarOnly = false;
    p.classList.remove('hidden');
    document.getElementById('toolOverview').classList.add('active');
    syncSideCol();
    renderOverview();
  } else {
    closeOverview();
  }
};
document.getElementById('ovClose').onclick = closeOverview;

/** 문항 하나의 채점 상태 — 없는 함수(_renderOpen류)와 중복 없이 한 곳에서만 판단한다. */
function ovStatus(i) {
  const q = quiz.all[i];
  const answered = quiz.answers[i] !== null;
  if (q.type === 'open') return answered ? { label: '읽음', cls: 'read' } : { label: '안읽음', cls: 'new' };
  if (!answered) return { label: '안 풂', cls: 'new' };
  return quiz.isCorrect(i) ? { label: '정답', cls: 'ok' } : { label: '오답', cls: 'bad' };
}

function renderOverview() {
  if (!quiz) return;
  const body = document.getElementById('ovBody');
  const filters = document.getElementById('ovFilters');
  const stats = document.getElementById('ovStats');

  const rows = quiz.order.map((i) => ({ i, status: ovStatus(i) }));
  const counts = { ok: 0, bad: 0, new: 0, read: 0, star: 0 };
  const colorCounts = [0, 0, 0, 0, 0, 0, 0];
  rows.forEach(({ i, status }) => {
    counts[status.cls]++;
    if (quiz.bookmarks[i]) counts.star++;
    colorCounts[quiz.colors[i]]++;
  });
  stats.textContent = `전체 ${rows.length} · 정답 ${counts.ok} · 오답 ${counts.bad}`
    + (counts.read ? ` · 읽음 ${counts.read}` : '') + ` · 안 풂 ${counts.new}`;

  // ── 필터 줄 ──
  filters.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = `ov-chip${!ovFilterColor && !ovStarOnly ? ' active' : ''}`;
  allBtn.textContent = '전체';
  allBtn.onclick = () => { ovFilterColor = 0; ovStarOnly = false; renderOverview(); };
  filters.appendChild(allBtn);

  const starBtn = document.createElement('button');
  starBtn.className = `ov-chip${ovStarOnly ? ' active' : ''}`;
  starBtn.textContent = `★ ${counts.star}`;
  starBtn.onclick = () => { ovStarOnly = !ovStarOnly; renderOverview(); };
  filters.appendChild(starBtn);

  OV_TAGS.forEach((tag, ci) => {
    const n = colorCounts[ci + 1];
    const b = document.createElement('button');
    b.className = `ov-chip${ovFilterColor === ci + 1 ? ' active' : ''}`;
    b.textContent = `${tag.emoji} ${n}`;
    b.onclick = () => { ovFilterColor = ovFilterColor === ci + 1 ? 0 : ci + 1; renderOverview(); };
    filters.appendChild(b);
  });

  // ── 목록 ──
  const show = rows.filter(({ i }) =>
    (!ovFilterColor || quiz.colors[i] === ovFilterColor) && (!ovStarOnly || quiz.bookmarks[i]));
  body.innerHTML = '';
  if (!show.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.padding = '14px';
    p.textContent = '조건에 맞는 문항이 없습니다.';
    body.appendChild(p);
    return;
  }
  show.forEach(({ i, status }) => body.appendChild(ovRow(i, status)));
  highlightOverviewCurrent();
}

function ovRow(i, status) {
  const q = quiz.all[i];
  const row = document.createElement('div');
  row.className = `ov-row ov-${status.cls}`;
  row.dataset.i = String(i);
  if (quiz.colors[i]) row.style.borderLeftColor = OV_TAGS[quiz.colors[i] - 1].hex;

  const main = document.createElement('div');
  main.className = 'ov-main';
  main.innerHTML = `<span class="ov-num">${q.num}</span>`
    + `<span class="ov-pill ov-pill-${status.cls}">${status.label}</span>`
    + `<span class="ov-stem">${escapeHtml(String(q.q || '').slice(0, 90))}</span>`;
  main.onclick = () => {
    quiz.goTo(i);
    if (!wideScreen()) closeOverview();
  };
  row.appendChild(main);

  const acts = document.createElement('div');
  acts.className = 'ov-acts';
  const star = document.createElement('button');
  star.className = `ov-star${quiz.bookmarks[i] ? ' on' : ''}`;
  star.textContent = quiz.bookmarks[i] ? '★' : '☆';
  star.title = '다시 볼 문항으로 표시';
  star.onclick = (e) => {
    e.stopPropagation();
    quiz.bookmarks[i] = !quiz.bookmarks[i];
    quiz.persist();
    if (quiz.qIndex === i) {
      quiz.el.bookmark.classList.toggle('active', quiz.bookmarks[i]);
      quiz.el.bookmark.textContent = quiz.bookmarks[i] ? '★' : '☆';
    }
    renderOverview();
  };
  acts.appendChild(star);
  OV_TAGS.forEach((tag, ci) => {
    const b = document.createElement('button');
    b.className = `ov-dot${quiz.colors[i] === ci + 1 ? ' on' : ''}`;
    b.textContent = tag.emoji;
    b.onclick = (e) => { e.stopPropagation(); quiz.setColor(i, ci + 1); renderOverview(); };
    acts.appendChild(b);
  });
  row.appendChild(acts);
  return row;
}

/** 전체 다시 그리지 않고 "지금 보고 있는 문항" 줄만 강조 — 문제를 넘길 때마다 부른다. */
function highlightOverviewCurrent() {
  const body = document.getElementById('ovBody');
  const cur = String(quiz.qIndex);
  body.querySelectorAll('.ov-row').forEach((el) => {
    el.classList.toggle('current', el.dataset.i === cur);
  });
}



/** 섹션 드롭다운에 상태 한 줄만 띄운다(불러오는 중·오류 등). */
function wikiStatus(text) {
  const pick = document.getElementById('wikiSecPick');
  pick.innerHTML = '';
  const o = document.createElement('option');
  o.textContent = text;
  pick.appendChild(o);
}

async function loadWiki(q, answered) {
  const body = document.getElementById('wikiBody');
  const lock = document.getElementById('wikiLock');
  wikiStatus('불러오는 중…');
  document.getElementById('wikiNote').textContent = '';
  body.innerHTML = '';
  lock.classList.add('hidden');

  let refs;
  try {
    refs = await wikiFor(q, currentExam.path);
  } catch (e) {
    wikiStatus('노트를 불러오지 못했습니다');
    body.innerHTML = `<p class="muted">${escapeText(e.message)}</p>`;
    return;
  }
  if (!refs || !refs.sections.length) {
    wikiStatus('연결된 노트 없음');
    body.innerHTML = '<p class="muted">이 모의고사에 연계노트가 지정돼 있지 않습니다.</p>';
    return;
  }
  wikiState = { refs, secIdx: 0, unlocked: !!answered };
  renderWikiSection();
}

/**
 * 풀다가 다른 노트를 옆에 띄운다 (2026-10-14 요청).
 *
 * 문제를 풀 때 보고 싶은 건 연계노트 하나가 아니다 — 암기법·Q&A·다른 강의를 오간다.
 * 읽기 화면의 서랍을 **그대로** 쓴다. 두 군데에 비슷한 목록을 두면 한쪽만 고쳐진다.
 */
let wikiHome = null;        // 원래 걸려 있던 연계노트 — ↩로 돌아간다

async function openNoteInWikiPanel(note) {
  if (!wikiHome && wikiState) wikiHome = wikiState;
  wikiState = {
    refs: {
      noteName: note.title,
      notePath: note.path,
      sections: note.sections,
      auto: false,
      manual: true,
    },
    secIdx: 0,
    unlocked: true,         // 내가 직접 고른 노트다 — 가릴 이유가 없다
  };
  document.getElementById('wikiPanel').classList.remove('hidden');
  document.getElementById('toolWiki').classList.add('active');
  syncSideCol();
  renderWikiSection();
}

function restoreWikiHome() {
  if (!wikiHome) return;
  wikiState = wikiHome;
  wikiHome = null;
  renderWikiSection();
}

function renderWikiSection() {
  if (!wikiState) return;
  const { refs, secIdx, unlocked } = wikiState;
  const sec = refs.sections[secIdx];
  document.getElementById('wikiBack').classList.toggle('hidden', !wikiHome);

  // 섹션 목록을 드롭다운으로 — 자동 매칭이 빗나가도 한 번에 찾아간다.
  // (자동 매칭은 추정이라 100%가 될 수 없다. 틀렸을 때 바로잡는 비용을 0에 가깝게 만든다.)
  const pick = document.getElementById('wikiSecPick');
  pick.innerHTML = '';
  refs.sections.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    const tag = s.extra ? ' · 참고' : (refs.auto && i === 0 ? ` · ${fitLabel(s.fit || 0)}` : '');
    o.textContent = `${s.heading}${tag}`;
    pick.appendChild(o);
  });
  pick.value = String(secIdx);

  const quality = refs.auto && !sec.extra ? `  ·  ${fitLabel(sec.fit || 0)}` : '';
  document.getElementById('wikiNote').textContent =
    `${refs.noteName}  ·  ${secIdx + 1}/${refs.sections.length}${refs.auto ? '  · 자동 매칭' : ''}${quality}`;

  const body = document.getElementById('wikiBody');
  const lock = document.getElementById('wikiLock');
  if (!unlocked) {
    // 정답을 고르기 전에는 내용을 가린다 — 노트에 같은 문항이 정답과 함께 실려 있을 수 있다.
    lock.classList.remove('hidden');
    body.innerHTML = '';
    return;
  }
  lock.classList.add('hidden');
  body.innerHTML = renderMarkdown(sec.text);
  // 노트 본문도 밑줄로 긁어서 질문할 수 있게 토큰화한다
  tokenizeTree(body);
  hydrateEmbeds(body, (name) => getBlobUrl(`attachments/${name}`)).catch(() => {});
}

document.getElementById('wikiSecPick').onchange = (e) => {
  if (!wikiState) return;
  wikiState.secIdx = Number(e.target.value) || 0;
  renderWikiSection();
};
document.getElementById('wikiUnlock').onclick = () => {
  if (wikiState) { wikiState.unlocked = true; renderWikiSection(); }
};
document.getElementById('wikiPrevSec').onclick = () => {
  if (!wikiState) return;
  wikiState.secIdx = (wikiState.secIdx - 1 + wikiState.refs.sections.length) % wikiState.refs.sections.length;
  renderWikiSection();
};
document.getElementById('wikiNextSec').onclick = () => {
  if (!wikiState) return;
  wikiState.secIdx = (wikiState.secIdx + 1) % wikiState.refs.sections.length;
  renderWikiSection();
};

// ---------- 긁기 → 무엇을 할지 고르기 ----------
//
// 예전엔 긁자마자 Gemini로 질문이 나갔다. 실수로 그어도 호출이 낭비되고, "복사만 하고
// 다른 앱에 던지고 싶다"는 길이 막혀 있었다. 이제 작은 팝업으로 한 번 고르게 한다.

function handleSelect(text, info) {
  if (!text) { toast('글자 위에 선을 그어보세요.'); return; }
  const q = quiz ? quiz.q : null;
  askCtx = {
    term: text,
    qnum: q ? q.num : '—',
    qtext: q ? q.q : '',
    question: q,
  };
  askCtx.prompt = buildPrompt({
    term: text,
    question: q,
    subject: currentExam ? currentExam.subject : '',
    lecture: currentExam ? prettyExamName(currentExam.file) : '',
  });
  showSelPop(text, info && info.box);
}

/**
 * 긴 글을 앞머리 … 꼬리로 줄인다.
 *
 * 앞만 보여주면 "어디까지 골랐는지"를 알 수 없다 — 긁은 범위의 **끝**을 확인하려고
 * 보는 팝업인데 정작 그게 안 보였다(2026-10-13 지적).
 */
function selPreview(text, head = 70, tail = 45) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= head + tail + 10) return t;
  return tail > 0 ? `${t.slice(0, head)} … ${t.slice(-tail)}` : `${t.slice(0, head)}…`;
}

/**
 * 긁은 글을 클립보드에 담는다. 되면 true.
 *
 * 사파리는 "사용자가 방금 손을 뗀 그 언저리"에만 클립보드 쓰기를 허용한다. 긁기는 손을
 * 뗀 뒤 0.4초쯤 지나 확정되므로 보통은 아직 창이 열려 있지만, 닫혀 있을 때를 대비해
 * **옛 방식(execCommand)도 한 번 더** 시도한다 — 그쪽은 활성화 조건이 느슨하다.
 * 실패해도 조용히 넘어간다. 팝업의 "복사" 단추로 다시 하면 된다.
 */
async function autoCopy(text) {
  const t = String(text || '');
  if (!t) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch { /* 아래 옛 방식으로 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, t.length);
    const done = document.execCommand && document.execCommand('copy');
    ta.remove();
    return !!done;
  } catch { return false; }
}

/** 선택한 자리 근처에 팝업을 띄운다. */
function showSelPop(text, box) {
  const pop = document.getElementById('selPop');
  const full = String(text).replace(/\s+/g, ' ').trim();
  const body = document.getElementById('selPopText');
  body.textContent = selPreview(full);
  body.title = full;                       // 길게 누르면 전문
  const count = document.getElementById('selPopCount');
  count.textContent = `${full.length}자`;
  pop.classList.remove('hidden');
  // 긁자마자 **클립보드에 담는다** (2026-10-16 요청: "긁기를 하면 그냥 복사가 자동으로
  // 되는걸로 바꾸자. 복사 엄청많이 쓰네. 클립보드야 그냥 버리면 되는거니까").
  // 담겼는지는 글자 수 옆에 조용히 적는다 — 토스트까지 띄우면 긁을 때마다 시끄럽다.
  autoCopy(full).then((done) => {
    if (done && count.textContent === `${full.length}자`) {
      count.textContent = `${full.length}자 · 복사됨`;
    }
  });

  // 선택 영역 바로 아래에 두되 화면 밖으로 나가지 않게
  pop.style.visibility = 'hidden';
  pop.style.left = '0px';
  pop.style.top = '0px';
  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    let x = 16, y = 16;
    if (box && pen) {
      const cr = pen.canvas.getBoundingClientRect();
      x = cr.left + (box.l + box.r) / 2 - pr.width / 2;
      y = cr.top + box.b + 10;
      // 아래로 넘치면 위쪽에
      if (y + pr.height > window.innerHeight - 8) y = cr.top + box.t - pr.height - 10;
    } else {
      x = (window.innerWidth - pr.width) / 2;
      y = window.innerHeight - pr.height - 90;
    }
    pop.style.left = `${Math.max(8, Math.min(x, window.innerWidth - pr.width - 8))}px`;
    pop.style.top = `${Math.max(8, Math.min(y, window.innerHeight - pr.height - 8))}px`;
    pop.style.visibility = 'visible';
  });
}

function hideSelPop() { document.getElementById('selPop').classList.add('hidden'); }

// 들러보기를 테스트가 직접 열어볼 수 있게 — "이 문서" 검색은 열린 문서가 있어야 하는데
// 검사 하네스에서는 진짜 노트를 받을 수 없다
window.__showPeek = (note, secIdx, needle, title) => showPeek(note, secIdx, needle, title);

document.getElementById('selCancel').onclick = hideSelPop;
// 팝업 버튼들은 askCtx(긁은 내용)가 있어야 의미가 있다 — 없으면 조용히 닫는다.
const selTerm = () => (askCtx && askCtx.term) || '';
document.getElementById('selAsk').onclick = () => {
  hideSelPop();
  const term = selTerm();
  if (!term) return;
  // 읽기 모드엔 사이드 패널이 없으므로 시트 쪽에 답변을 띄운다
  if (!document.getElementById('readScreen').classList.contains('hidden')) askInReader(term);
  else askNow(term);
};
document.getElementById('selSend').onclick = () => { hideSelPop(); if (selTerm()) fillAskSheet(selTerm()); };
document.getElementById('selCopy').onclick = async () => {
  const t = selTerm();
  hideSelPop();
  if (!t) return;
  // 긁을 때 이미 담았지만, 그때 막혔을 수도 있으니 다시 한 번 — 여기서는 눌러서
  // 하는 일이라 결과를 말해준다
  toast(await autoCopy(t) ? '📋 복사했습니다.' : '복사에 실패했습니다.');
};
// 긁은 글을 **모아두기**로 — 어느 화면에서든 같은 곳으로 간다(2026-10-14).
// 전에는 퀴즈에서만 되는 "메모"였고 아이콘도 필기와 같은 ✎라 뭘 하는 건지 알 수 없었다.
document.getElementById('selCloze').onclick = () => {
  const t = selTerm();
  // 블록을 **지금** 잡아둔다 — 팝업을 닫으면 선택이 풀려 못 찾는다
  const root = document.getElementById('readBody') || document.getElementById('wikiBody');
  let ctxBlock = null;
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && root) {
      ctxBlock = blockContext(sel.getRangeAt(0).commonAncestorContainer, root);
    }
  } catch {}
  if (!ctxBlock && root) {
    // 펜으로 긁은 경우엔 브라우저 선택이 없다 — 그 글이 든 블록을 글자로 찾는다
    const key = t.replace(/\s+/g, ' ').trim().slice(0, 24);
    const hit = [...root.querySelectorAll('p,li,tr,blockquote')]
      .find((b) => b.textContent.replace(/\s+/g, ' ').includes(key));
    if (hit) ctxBlock = blockContext(hit, root);
  }
  hideSelPop();
  if (!t) return;
  const doc = currentDoc();
  const sec = doc && doc.sections ? doc.sections[currentSecIdx()] : null;
  openClozeMaker(t, {
    notePath: (doc && doc.path) || '',
    noteTitle: (doc && doc.title) || '',
    heading: sec ? sec.heading : '',
    block: ctxBlock ? ctxBlock.block : null,
    trail: ctxBlock ? ctxBlock.trail : [],
  });
};
document.getElementById('selNote').onclick = () => {
  const t = selTerm();
  hideSelPop();
  if (!t) return;
  openScrap();
  const ta = document.getElementById('scText');
  ta.value = ta.value ? `${ta.value}\n\n${t}` : t;
  document.getElementById('scStatus').textContent = `${t.length}자를 담았습니다`;
};
// 팝업 밖을 건드리면 닫는다
document.addEventListener('pointerdown', (e) => {
  const pop = document.getElementById('selPop');
  if (pop.classList.contains('hidden')) return;
  if (!pop.contains(e.target)) hideSelPop();
}, true);

/**
 * 질문한다 — Gemini 키가 있으면 사이드 패널에 바로 답을, 없으면 기존 앱 전달 시트를 연다.
 */
/** Gemini 키가 없을 때 — 조용히 다른 앱으로 넘기지 않고 이유를 보여준다.
 *  "여기서 질문"을 눌렀는데 설명 없이 앱 선택 시트가 뜨면 고장으로 보인다(2026-10-09). */
function askNoKey(term) {
  openAi(term);
  const body = document.getElementById('aiBody');
  document.getElementById('aiStatus').textContent = '';
  body.innerHTML = '';

  const box = document.createElement('div');
  box.className = 'warn-box';
  box.textContent = '여기서 바로 답하려면 Gemini API 키가 필요합니다. 무료이고 1분이면 됩니다.';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
  const set = document.createElement('button');
  set.className = 'btn primary';
  set.textContent = '설정에서 키 넣기';
  set.onclick = () => openSetup();
  const app = document.createElement('button');
  app.className = 'btn';
  app.textContent = '다른 앱에서 묻기';
  app.onclick = () => fillAskSheet(term);
  row.append(set, app);
  body.append(box, row);
}

async function askNow(term) {
  if (!(await gem.hasKey())) { askNoKey(term); return; }
  openAi(term);
  const body = document.getElementById('aiBody');
  const status = document.getElementById('aiStatus');
  body.innerHTML = '<div class="ai-loading">묻는 중…</div>';
  status.textContent = '';
  try {
    const body2 = document.getElementById('aiBody');
    const answer = await gem.ask({
      term,
      onProgress: (full) => { body2.innerHTML = renderMarkdown(full); },
      question: askCtx.question,
      noteText: wikiState ? wikiState.refs.sections[wikiState.secIdx].text : '',
      subject: currentExam ? currentExam.subject : '',
      lecture: currentExam ? prettyExamName(currentExam.file) : '',
    });
    askCtx.answer = answer;
    body.innerHTML = renderMarkdown(answer);
    tokenizeTree(body);        // AI 답변에서도 긁어서 다시 물어볼 수 있게
    status.textContent = '저장하지 않으면 사라집니다';
  } catch (e) {
    if (e.message === 'NO_KEY') { askNoKey(term); return; }
    const wait = /^RATE_WAIT:(\d+)$/.exec(e.message);
    if (wait) { showRateWait(Number(wait[1]), term); return; }
    body.innerHTML = `<div class="warn-box">${escapeText(e.message)}</div>`;
    status.textContent = '앱에서 이어보기를 눌러 직접 물어볼 수 있습니다';
  }
}

/** 한도에 걸렸을 때 — 남은 시간을 세어주고 끝나면 알아서 다시 묻는다. */
function showRateWait(sec, term) {
  const body = document.getElementById('aiBody');
  const status = document.getElementById('aiStatus');
  let left = sec;

  // 기다리라고만 하면 할 수 있는 게 없다 — 그 자리에서 빠져나갈 길을 준다(2026-10-10)
  const paint = async () => {
    const keys = await gem.getKeys();
    body.innerHTML = '';

    const box = document.createElement('div');
    box.className = 'warn-box';
    box.innerHTML = keys.length <= 1
      ? `키가 <b>1개</b>뿐이라 한도에 걸리면 기다릴 수밖에 없습니다. ` +
        `<b>다른 구글 계정</b>으로 키를 하나만 더 넣으면 한도가 따로라 거의 안 걸립니다.`
      : `넣어둔 키 <b>${keys.length}개</b>가 모두 한도에 걸렸습니다. 키를 더 넣으면 줄어듭니다.`;
    body.appendChild(box);

    const count = document.createElement('p');
    count.className = 'muted';
    count.style.margin = '10px 0 12px';
    count.innerHTML = `<b>${left}초</b> 뒤 자동으로 다시 묻습니다.`;
    body.appendChild(count);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const add = document.createElement('button');
    add.className = 'btn primary';
    add.textContent = '키 추가하기';
    add.onclick = () => { clearInterval(rateTimer); openSetup(); };
    const other = document.createElement('button');
    other.className = 'btn';
    other.textContent = '다른 앱에서 묻기';
    other.onclick = () => { clearInterval(rateTimer); fillAskSheet(term); };
    const now = document.createElement('button');
    now.className = 'btn';
    now.textContent = '지금 다시 시도';
    now.onclick = () => { clearInterval(rateTimer); askNow(term); };
    row.append(add, other, now);
    body.appendChild(row);

    status.textContent = `대기 중 · 남은 호출 ${await gem.callsLeft()}회`;
  };

  paint();
  clearInterval(rateTimer);
  rateTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(rateTimer); askNow(term); return; }
    paint();
  }, 1000);
}
let rateTimer = null;

function openAi(term) {
  document.getElementById('aiTerm').textContent = term;
  document.getElementById('aiPanel').classList.remove('hidden');
  document.getElementById('quizScreen').classList.add('with-side');
  requestAnimationFrame(() => pen && pen.resize());
}
function closeAi() {
  clearInterval(rateTimer);
  document.getElementById('aiPanel').classList.add('hidden');
  syncSideCol();
}
document.getElementById('aiClose').onclick = closeAi;
document.getElementById('aiRetry').onclick = () => { if (askCtx && askCtx.term) askNow(askCtx.term); };
document.getElementById('aiSave').onclick = () => {
  if (!askCtx || !askCtx.answer) { toast('저장할 답변이 없습니다.'); return; }
  askItems.push({ ...askCtx });
  toast(`기록했습니다 (${askItems.length}건) — 결과 화면에서 vault에 저장됩니다.`);
};
document.getElementById('aiOpenApp').onclick = () => { if (askCtx && askCtx.term) fillAskSheet(askCtx.term); };

/**
 * 사이드 칼럼 상태 동기화.
 * 넓은 화면에선 사이드가 **항상** 있다(네비가 거기 들어가므로) — 패널 유무와 무관.
 * 좁은 화면에선 패널이 열릴 때만 공간을 차지한다.
 */
function syncSideCol() {
  const anyOpen =
    !document.getElementById('aiPanel').classList.contains('hidden') ||
    !document.getElementById('wikiPanel').classList.contains('hidden') ||
    !document.getElementById('overviewPanel').classList.contains('hidden');
  document.getElementById('quizScreen').classList.toggle('with-side', anyOpen);
  updatePaneLayout();
  requestAnimationFrame(() => pen && pen.resize());
}

/** 넓은 화면인가? (사이드바를 상시 쓰는 기준) */
const wideScreen = () => window.matchMedia('(min-width: 900px)').matches;

/** 두 패널이 동시에 열렸는지에 따라 높이 분할 여부가 달라진다. */
function updatePaneLayout() {
  const aiOpen = !document.getElementById('aiPanel').classList.contains('hidden');
  const wikiOpen = !document.getElementById('wikiPanel').classList.contains('hidden');
  const col = document.querySelector('#quizScreen .side-col');
  if (col) col.classList.toggle('both', aiOpen && wikiOpen);
  document.getElementById('paneResizer').classList.toggle('hidden', !(aiOpen && wikiOpen));
  document.getElementById('toolAi').classList.toggle('active', aiOpen);
  document.getElementById('toolWiki').classList.toggle('active', wikiOpen);
}

// ---------- 영역 캡처 ----------
// 글자 긁기로는 표·그림·수식이 깨진다 → 보이는 그대로 이미지로 떠서 클립보드에 넣는다.
//
// ⚠️ 새 창(window.open)을 띄우면 아이패드 PWA에서 **돌아올 길이 없어 앱을 껐다 켜야 한다**
//    (2026-10-10 실제로 겪음). 실패해도 창을 띄우지 않고 문구만 보여준다.

/** 살짝 떴다 사라지는 반투명 배지. */
function capToast(msg, ms = 1400) {
  let el = document.getElementById('capToast');
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'capToast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(capToast._t);
  capToast._t = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 340);
  }, ms);
  return el;
}

async function handleCapture(box) { return captureFromPen(pen, box); }

/** 펜으로 친 네모를 이미지로 떠서 클립보드에. 문제 화면·읽기 화면이 함께 쓴다. */
async function captureFromPen(penLayer, box) {
  const r = penLayer.canvas.getBoundingClientRect();
  const rect = {
    left: r.left + box.l, top: r.top + box.t,
    width: box.r - box.l, height: box.b - box.t,
  };
  const busy = capToast('캡처하는 중…', 20000);

  // ⚠️ 사파리는 **손을 뗀 그 순간**에만 클립보드 쓰기를 허용한다. 그림을 다 만든 뒤에
  //    쓰면 이미 늦어서 거절당한다("캡처했지만 복사 권한이 없습니다" — 2026-10-14).
  //    그래서 **아직 안 끝난 Promise를 먼저 건네고** 그림은 그 뒤에 완성시킨다.
  let settle;
  const pending = new Promise((res, rej) => { settle = { res, rej }; });
  const writing = copyBlobToClipboard(pending).then(() => true, () => false);

  try {
    const cv = await captureRect(rect);
    const blob = await canvasToBlob(cv);
    if (!blob) throw new Error('이미지를 만들지 못했습니다.');
    lastCapture = blob;                       // 복사에 실패해도 손에 남겨둔다
    settle.res(blob);
    const copied = await writing;
    busy.remove();
    if (copied) { capToast('📋 복사했습니다'); return; }
    // 클립보드가 막혔으면 **그림을 띄워준다** — 길게 눌러 복사하거나 다른 앱으로 보낸다.
    showCapturePreview(blob);
  } catch (e) {
    settle.rej(e);
    writing.catch(() => {});
    busy.remove();
    capToast(`캡처 실패 — ${e.message}`, 2400);
  }
}

/**
 * 클립보드가 막혔을 때 뜨는 작은 창.
 *
 * "복사 권한이 없습니다"라고만 하면 **캡처한 그림이 어디에도 없다**. 띄워두면
 * 길게 눌러 복사하거나, 공유 시트로 다른 앱에 보내거나, 모아두기에 넣을 수 있다.
 */
function showCapturePreview(blob) {
  document.getElementById('capPrev')?.remove();
  const url = URL.createObjectURL(blob);
  const box = document.createElement('div');
  box.id = 'capPrev';
  box.className = 'cap-prev';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '캡처한 그림';
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = '그림을 길게 눌러 복사하거나, 아래에서 고르세요.';
  const acts = document.createElement('div');
  acts.className = 'cap-acts';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = label;
    b.onclick = fn;
    return b;
  };
  const close = () => { box.remove(); URL.revokeObjectURL(url); };
  acts.append(
    mk('📋 다시 복사', async () => {
      // 이번엔 **누른 그 순간**이라 사파리가 받아준다
      try { await copyBlobToClipboard(Promise.resolve(blob)); capToast('📋 복사했습니다'); close(); }
      catch { capToast('그래도 막혔습니다 — 그림을 길게 눌러 복사하세요', 2600); }
    }),
    mk('＋ 모아두기', async () => {
      close();
      openScrap();
      await addShot(blob);
      document.getElementById('scStatus').textContent = '캡처한 그림을 담았습니다';
    }),
    mk('↗ 다른 앱으로', async () => {
      const file = new File([blob], '캡처.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); close(); return; } catch { /* 취소 */ }
      }
      const a = document.createElement('a');
      a.href = url; a.download = '캡처.png'; a.click();
    }),
    mk('닫기', close),
  );
  box.append(img, hint, acts);
  document.body.appendChild(box);
}
let lastCapture = null;

document.getElementById('toolCapture').onclick = () => setTool(penTool === 'shot' ? 'off' : 'shot');

// ---------- 문제 뜯어보기 ----------
// 지문을 단서별로 끊어 "시험에서 이게 뭘 뜻하는지"를 붙인다.
// 답을 알려주는 게 아니라 읽는 법을 훈련하는 용도(2026-10-10 요청).
let breakdownBusy = false;
let breakdownAbort = null;     // 뜯어보는 중에 그만두면 요청까지 끊는다(2026-10-13)

async function runBreakdown() {
  if (!quiz) return;
  // 뜯어보는 중에 또 누르면 **그만둔다**. 전에는 아무 반응이 없어서, 안 보고 싶어도
  // 다 뜰 때까지 기다려야 했다(2026-10-13 지적). 요청도 실제로 끊어 할당량을 아낀다.
  if (breakdownBusy) { cancelBreakdown(); return; }
  const q = quiz.all[quiz.order[quiz.cur]];
  const el = document.getElementById('breakdown');
  // 뜯어보기는 "선지를 어떤 기준으로 쳐내는가"를 보여주는 기능이다 —
  // 족보의 서술형 복원 문항처럼 선지가 없으면 보여줄 게 없다(2026-10-12).
  if (!(q.opts && q.opts.length)) {
    toast('선지가 없는 문항이라 뜯어볼 수 없습니다 — 해설을 보세요.');
    return;
  }

  // 이미 떠 있으면 토글로 닫는다
  if (!el.classList.contains('hidden') && el.dataset.forNum === String(q.num)) {
    el.classList.add('hidden');
    document.getElementById('toolBreak').classList.remove('active');
    return;
  }
  breakdownBusy = true;
  breakdownAbort = typeof AbortController === 'function' ? new AbortController() : null;
  el.dataset.forNum = String(q.num);
  el.classList.remove('hidden');
  document.getElementById('toolBreak').classList.add('active');

  // ① 미리 만들어둔 게 있으면 그걸 쓴다 — 0초, 할당량 0, 오프라인에서도 된다.
  //    모의고사 문제는 **고정된 콘텐츠**다. 매번 AI를 부를 이유가 없다(2026-10-10).
  try {
    const pre = await prebuiltBreakdown(q);
    if (pre) {
      renderBreakdown(el, pre, q);
      breakdownBusy = false;
      if (pen) requestAnimationFrame(() => pen.resize());
      return;
    }
  } catch { /* 없으면 아래에서 AI로 */ }

  // 기다리는 동안에도 그만둘 수 있다는 걸 보여준다
  el.innerHTML = '';
  {
    const load = document.createElement('div');
    load.className = 'bd-loading';
    load.textContent = '지문을 뜯어보는 중…';
    const stop = document.createElement('button');
    stop.className = 'bd-stop';
    stop.textContent = '그만';
    stop.onclick = cancelBreakdown;
    load.appendChild(stop);
    el.appendChild(load);
  }
  if (!(await gem.hasKey())) { askNoKey(q.q); breakdownBusy = false; return; }
  try {
    // 스트리밍 — 줄이 오는 대로 다시 그린다. 다 기다리면 40초가 걸렸다(2026-10-10).
    let painted = false;
    const data = await gem.breakdown(q, false, (partial) => {
      if (breakdownAbort && breakdownAbort.signal.aborted) return;
      if (!partial.clues.length && !partial.impression && !partial.options.length) return;
      renderBreakdown(el, partial, q);
      painted = true;
    }, breakdownAbort ? breakdownAbort.signal : null);
    if (breakdownAbort && breakdownAbort.signal.aborted) return;
    if (!painted || data.clues.length || data.options.length) renderBreakdown(el, data, q);
  } catch (e) {
    if (e.name === 'AbortError' || (breakdownAbort && breakdownAbort.signal.aborted)) return;
    const wait = /^RATE_WAIT:(\d+)$/.exec(e.message);
    el.innerHTML = '';
    const w = document.createElement('div');
    w.className = 'warn-box';
    w.textContent = wait ? `요청이 많습니다 — ${wait[1]}초 뒤에 다시 눌러주세요.` : e.message;
    el.appendChild(w);
  } finally {
    breakdownBusy = false;
    breakdownAbort = null;
    if (pen) requestAnimationFrame(() => pen.resize());
  }
}

/** 뜯어보기 그만두기 — 화면은 **즉시** 닫고, 네트워크 요청도 끊는다. */
function cancelBreakdown() {
  if (breakdownAbort) { try { breakdownAbort.abort(); } catch {} }
  breakdownBusy = false;
  breakdownAbort = null;
  const el = document.getElementById('breakdown');
  el.classList.add('hidden');
  el.innerHTML = '';
  el.dataset.forNum = '';
  document.getElementById('toolBreak').classList.remove('active');
  if (pen) requestAnimationFrame(() => pen.resize());
}

/**
 * 미리 만들어둔 뜯어보기를 vault에서 찾는다.
 *
 * `06_모의고사/{과목}/{시험}_뜯어보기.json` — 문항 번호를 키로 한 객체.
 * 모의고사는 내용이 바뀌지 않으므로 한 번 만들어두면 그만이다.
 * 파일이 없으면 null을 돌려주고, 그때만 AI를 부른다.
 */
const preCache = new Map();
async function prebuiltBreakdown(q) {
  if (!currentExam) return null;
  // 족보는 `.md`라 `.html` 치환이 안 먹는다 — 확장자를 통째로 바꾼다
  const path = currentExam.path.replace(/\.(html|md)$/, '_뜯어보기.json');
  if (!preCache.has(path)) {
    try {
      preCache.set(path, JSON.parse(await getText(path)));
    } catch {
      preCache.set(path, null);          // 없는 파일을 매번 다시 찾지 않는다
    }
  }
  const all = preCache.get(path);
  const hit = all && all[String(q.num)];
  if (!hit) return null;
  return {
    clues: Array.isArray(hit.clues) ? hit.clues.filter((c) => c && c.frag && c.note) : [],
    impression: hit.impression || '',
    options: Array.isArray(hit.options) ? hit.options : [],
    truncated: false,
    prebuilt: true,
  };
}

function renderBreakdown(el, data, q) {
  el.innerHTML = '';
  const { clues, impression, options, truncated } = data;
  if (!clues.length && !impression && !options.length) {
    el.innerHTML = '<p class="muted">뜯어볼 단서를 찾지 못했습니다.</p>';
    return;
  }

  const head = document.createElement('div');
  head.className = 'bd-head';
  head.innerHTML = `<span>🔍 지문 뜯어보기${data.prebuilt ? ' · 미리 준비됨' : ''}</span>`;
  const close = document.createElement('button');
  close.className = 'bd-close';
  close.textContent = '✕';
  close.onclick = () => {
    el.classList.add('hidden');
    document.getElementById('toolBreak').classList.remove('active');
    document.querySelectorAll('#qtext .tok.bd-mark').forEach((m) => m.classList.remove('bd-mark'));
    document.querySelectorAll('#qtext .bd-badge').forEach((b) => b.remove());
  };
  head.appendChild(close);
  el.appendChild(head);

  // ① 단서 — 지문의 어느 말이 무엇을 가리키는가.
  //    **읽는 순서대로 번호를 매겨** 지문 쪽 밑줄과 1:1로 잇는다(2026-10-10 요청).
  const numbered = numberClues(clues);
  for (const c of numbered) {
    const row = document.createElement('div');
    row.className = 'bd-row';
    const idx = document.createElement('span');
    idx.className = 'bd-idx';
    idx.textContent = c.n;
    const f = document.createElement('span');
    f.className = 'bd-frag';
    f.textContent = c.frag;
    const ar = document.createElement('span');
    ar.className = 'bd-arrow';
    ar.textContent = '→';
    const n = document.createElement('span');
    n.className = 'bd-note';
    n.textContent = c.note;
    row.append(idx, f, ar, n);
    row.onclick = () => scrollToClue(c.n);
    el.appendChild(row);
  }

  // ② 인상 — 다 읽은 순간의 판단
  if (impression) {
    const imp = document.createElement('div');
    imp.className = 'bd-impression';
    const tag = document.createElement('span');
    tag.className = 'bd-tag';
    tag.textContent = '읽고 나면';
    const t = document.createElement('span');
    t.textContent = impression;
    imp.append(tag, t);
    el.appendChild(imp);
  }

  // ③ 선지 — 무엇을 보고 쳐냈는가 (이게 핵심 훈련)
  if (options.length) {
    const sub = document.createElement('div');
    sub.className = 'bd-sub';
    sub.textContent = '선지 쳐내기';
    el.appendChild(sub);
    const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];
    for (const o of options) {
      const row = document.createElement('div');
      row.className = `bd-opt${o.keep ? ' keep' : ''}`;
      const num = document.createElement('span');
      num.className = 'bd-opt-num';
      num.textContent = CIRCLED[o.idx] || o.idx + 1;
      const mark = document.createElement('span');
      mark.className = 'bd-opt-mark';
      mark.textContent = o.keep ? 'O' : '✕';
      const why = document.createElement('span');
      why.className = 'bd-opt-why';
      why.textContent = o.why;
      row.append(num, mark, why);
      el.appendChild(row);
    }
  }

  if (truncated) {
    const w = document.createElement('div');
    w.className = 'bd-trunc';
    w.textContent = '답변이 중간에 끊겼습니다 — 다시 누르면 재시도합니다.';
    el.appendChild(w);
  }

  highlightFragments(numbered);
  tokenizeTree(el);     // 분석 결과도 펜으로 긁어서 다시 물어볼 수 있게
}

/** 지문에서의 위치를 찾아 **읽는 순서대로** 1,2,3… 번호를 매긴다. */
function numberClues(clues) {
  const host = document.getElementById('qtext');
  const toks = host ? [...host.querySelectorAll('.tok')] : [];
  let acc = '';
  toks.forEach((t) => { acc += t.textContent; });
  return clues
    .map((c) => ({ ...c, pos: acc.indexOf(c.frag.replace(/\s+/g, '')) }))
    .sort((a, b) => (a.pos < 0 ? 1e9 : a.pos) - (b.pos < 0 ? 1e9 : b.pos))
    .map((c, i) => ({ ...c, n: i + 1 }));
}

/**
 * 지문 안의 해당 조각에 밑줄 + 번호 배지를 단다.
 * 토큰 구조를 깨지 않게 클래스만 붙이고, 배지는 마지막 토큰 뒤에 끼워 넣는다.
 */
function highlightFragments(numbered) {
  const host = document.getElementById('qtext');
  if (!host) return;
  host.querySelectorAll('.bd-mark').forEach((m) => m.classList.remove('bd-mark'));
  host.querySelectorAll('.bd-badge').forEach((b) => b.remove());
  const toks = [...host.querySelectorAll('.tok')];
  if (!toks.length) return;
  let acc = '';
  const starts = [];
  toks.forEach((t) => { starts.push(acc.length); acc += t.textContent; });

  for (const c of numbered) {
    const needle = c.frag.replace(/\s+/g, '');
    const at = acc.indexOf(needle);
    if (at < 0) continue;
    const end = at + needle.length;
    let last = null;
    toks.forEach((t, i) => {
      const a = starts[i], b = a + t.textContent.length;
      if (b > at && a < end) { t.classList.add('bd-mark'); last = t; }
    });
    if (!last) continue;
    const badge = document.createElement('sup');
    badge.className = 'bd-badge';
    badge.textContent = c.n;
    badge.dataset.n = String(c.n);
    badge.title = c.note;
    badge.onclick = () => scrollToClue(c.n);
    last.after(badge);
  }
}

/** 번호를 누르면 반대쪽(지문 ↔ 뜯어보기)을 잠깐 깜빡여 짝을 알려준다. */
function scrollToClue(n) {
  const row = [...document.querySelectorAll('#breakdown .bd-row')]
    .find((r) => r.querySelector('.bd-idx') && r.querySelector('.bd-idx').textContent === String(n));
  const badge = document.querySelector(`#qtext .bd-badge[data-n="${n}"]`);
  [row, badge].forEach((el) => {
    if (!el) return;
    el.classList.remove('bd-flash');
    void el.offsetWidth;            // 애니메이션 재시작
    el.classList.add('bd-flash');
    setTimeout(() => el.classList.remove('bd-flash'), 900);
  });
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.getElementById('toolBreak').onclick = runBreakdown;


// ═══════════ 손잡이가 가까이 오면 깨어난다 ═══════════
//
// 2px 선 하나를 10px 칸에 그려두니 아이패드에서 **잡기가 너무 어려웠다**
// (2026-10-13: "퀴즈 및 문제 풀 때 사이즈 조절이 원활하지 않음").
//
// 요청대로 "펜으로 가까이 가면 그쪽이 딱 활성화되는" 방식으로 바꾼다. 셋이 함께 움직인다:
//   ① 눌리는 범위를 양옆 ±11px로 넓힌다(CSS ::after) — 보이는 선은 그대로 가늘다.
//   ② 손·펜이 GRIP_NEAR 안으로 들어오면 굵어지고 색이 들어온다.
//   ③ 끄는 동안에는 끝에서 끝까지 선이 선다.
// ①만으로도 잡히긴 하지만, 어디를 잡아야 하는지가 안 보이면 **시도 자체를 안 하게 된다**.

const GRIP_NEAR = 44;      // 이 거리 안에 들어오면 깨운다(px)

/** 점과 사각형 사이 거리. 안에 있으면 0. */
function distToRect(x, y, r) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

let gripRaf = 0;
function wakeGrips(x, y) {
  // 네모를 치는 중에는 깨우지 않는다 — 손잡이가 굵어지며 그리던 네모를 먹었다
  // (2026-10-15: "영역 복사로 네모 칠 때 split 조절 탭이 활성화된다").
  if (document.body.classList.contains('boxing')) return;
  if (gripRaf) return;
  gripRaf = requestAnimationFrame(() => {
    gripRaf = 0;
    for (const g of document.querySelectorAll('.resize-grip')) {
      if (g.classList.contains('dragging')) continue;
      const r = g.getBoundingClientRect();
      if (!r.width && !r.height) { g.classList.remove('near'); continue; }
      g.classList.toggle('near', distToRect(x, y, r) <= GRIP_NEAR);
    }
  });
}
// 펜은 닿기 전(hover)에도 좌표가 온다 — 그래서 "가까이 가면 켜진다"가 성립한다.
// 손가락은 닿아야 오므로, 넓힌 눌림 범위(①)가 그때를 받쳐준다.
document.addEventListener('pointermove', (e) => wakeGrips(e.clientX, e.clientY), { passive: true });
document.addEventListener('pointerleave', () => {
  document.querySelectorAll('.near').forEach((g) => g.classList.remove('near'));
});

/** 끄는 동안 티가 나게 — 어디를 밀고 있는지 보인다. */
function markGripDragging(el, on) {
  if (!el) return;
  el.classList.toggle('dragging', on);
  document.body.classList.toggle('resizing', on);
  if (!on) el.classList.remove('near');
}

// ---------- 패널 크기 조절 ----------
// 사용자가 "창이 2~3개 생기는데 크기 조절이 됐으면" 요청. 끌어서 조절하고 기억한다.
function initResizers() {
  const colR = document.getElementById('colResizer');
  const paneR = document.getElementById('paneResizer');
  const root = document.documentElement;

  // 저장된 값 복원
  const savedW = localStorage.getItem('side_w');
  if (savedW) root.style.setProperty('--side-w', savedW);
  const savedH = localStorage.getItem('ai_h');
  if (savedH) root.style.setProperty('--ai-h', savedH);

  let drag = null;
  const onMove = (e) => {
    if (!drag) return;
    e.preventDefault();
    if (drag.kind === 'col') {
      const w = Math.max(260, Math.min(drag.startW + (drag.x - e.clientX), window.innerWidth * 0.62));
      root.style.setProperty('--side-w', `${Math.round(w)}px`);
    } else {
      // px로 준다 — %는 사이드 칼럼 높이가 불확정이라 브라우저가 무시한다(2026-10-09 버그)
      const col = document.querySelector('#quizScreen .side-col');
      const total = col ? col.getBoundingClientRect().height : window.innerHeight;
      const h = Math.max(110, Math.min(drag.startH + (e.clientY - drag.y), Math.max(140, total - 110)));
      root.style.setProperty('--ai-h', `${Math.round(h)}px`);
    }
    if (pen) pen.resize();
  };
  const onUp = () => {
    if (!drag) return;
    markGripDragging(drag.el, false);
    drag = null;
    localStorage.setItem('side_w', root.style.getPropertyValue('--side-w') || '');
    localStorage.setItem('ai_h', root.style.getPropertyValue('--ai-h') || '');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (pen) pen.resize();
  };
  const start = (kind) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const side = document.querySelector('#quizScreen .side-col');
    const ai = document.getElementById('aiPanel');
    markGripDragging(e.currentTarget, true);
    drag = {
      kind, el: e.currentTarget, x: e.clientX, y: e.clientY,
      startW: side ? side.getBoundingClientRect().width : 360,
      startH: ai ? ai.getBoundingClientRect().height : 200,
    };
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
  };
  colR.addEventListener('pointerdown', start('col'));
  paneR.addEventListener('pointerdown', start('pane'));

  // 더블탭하면 기본값으로
  colR.ondblclick = () => { root.style.removeProperty('--side-w'); localStorage.removeItem('side_w'); if (pen) pen.resize(); };
  paneR.ondblclick = () => { root.style.removeProperty('--ai-h'); localStorage.removeItem('ai_h'); };
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** 질문 시트 채우기 — 모의고사(올가미)와 읽기 모드(텍스트 선택) 둘 다 여기로 온다. */
function fillAskSheet(label) {
  const prompt = askCtx.prompt;
  document.getElementById('askTerm').textContent = label || '(선택 없음)';
  document.getElementById('askAnswer').value = '';
  document.getElementById('askMsg').textContent = '';

  const apps = document.getElementById('askApps');
  apps.innerHTML = '';
  appList().forEach((a) => {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.onclick = async () => {
      const ok = await sendTo(a.id, prompt);
      document.getElementById('askMsg').textContent = ok
        ? '질문을 복사했습니다. 앱에서 붙여넣고, 답변을 복사해 돌아오세요.'
        : '앱을 여는 데 실패했습니다. 아래 "질문 복사"를 쓰세요.';
    };
    apps.appendChild(b);
  });
  const sh = document.createElement('button');
  sh.textContent = '공유…';
  sh.onclick = async () => {
    const ok = await share(prompt);
    document.getElementById('askMsg').textContent = ok ? '전달했습니다.' : '공유를 취소했습니다.';
  };
  apps.appendChild(sh);

  const cp = document.createElement('button');
  cp.textContent = '질문 복사';
  cp.onclick = async () => {
    try { await navigator.clipboard.writeText(prompt); document.getElementById('askMsg').textContent = '📋 복사했습니다.'; }
    catch { document.getElementById('askMsg').textContent = '복사에 실패했습니다.'; }
  };
  apps.appendChild(cp);

  document.getElementById('askSheet').classList.remove('hidden');
}

document.getElementById('askClose').onclick = () => document.getElementById('askSheet').classList.add('hidden');
document.getElementById('askSheet').onclick = (e) => {
  if (e.target.id === 'askSheet') document.getElementById('askSheet').classList.add('hidden');
};
document.getElementById('askSave').onclick = () => {
  const a = document.getElementById('askAnswer').value.trim();
  if (!a) { document.getElementById('askMsg').textContent = '답변을 붙여넣어 주세요.'; return; }
  askItems.push({ ...askCtx, answer: a });
  document.getElementById('askSheet').classList.add('hidden');
  toast(`기록했습니다 (${askItems.length}건) — 결과 화면에서 vault에 저장됩니다.`);
};
document.getElementById('askSaveLater').onclick = () => {
  askItems.push({ ...askCtx, answer: '' });
  document.getElementById('askSheet').classList.add('hidden');
  toast('질문만 기록했습니다.');
};

// ═══════════ Phase 4 — 읽기 모드 · 플래시카드 ═══════════

// ───────────── 읽기 창(pane) 모델 (2026-10-13) ─────────────
//
// 노트를 **둘로 갈라서** 본다 — 같은 문서의 다른 대목을 견주거나, 다른 문서를 나란히.
// 창마다 탭이 여럿이고, 가운데를 끌어 비율을 바꾼다.
//
// ★ 호환성이 이 설계의 핵심이다. 펜·카드 만들기·질문·모아두기 등 25곳이 이미
//   `reader.note` / `reader.secIdx`를 읽고 쓴다. 그래서 `reader`를 없애지 않고
//   **활성 탭 객체 자체를 가리키게** 둔다 — 탭이 `{note, secIdx}`이므로 기존 코드가
//   `reader.secIdx = 3`을 해도 그 탭이 그대로 바뀐다. 한 줄도 안 고쳐도 된다.
//
// ★ 같은 이유로 DOM도 **활성 창의 요소가 `#readCard`/`#readHeading`/`#readBody`
//   id를 가져간다**. 그 id를 찾는 기존 코드가 늘 "지금 보고 있는 창"을 가리키게 된다.
//   창을 바꿀 때 id를 옮긴다(moveReaderIds).

let panes = [];         // [{tabs:[{note,secIdx}], active:0}] — 1개 또는 2개
let activePane = 0;
let paneSeq = 0;        // 창 DOM을 구분하는 번호
let reader = null;      // = panes[activePane].tabs[active] — 기존 코드가 쓰는 그 객체
let readerPen = null;
let cardDeck = null;    // {cards, idx, srs, title}

/** 활성 창·탭이 바뀌었을 때 `reader`와 DOM id를 거기에 맞춘다. */
function syncReader() {
  const p = panes[activePane];
  reader = (p && p.tabs[p.active]) || null;
  moveReaderIds();
  // 회독 단추는 **지금 보는 노트**를 따라간다 — 창·탭을 옮기면 같이 바뀌어야 한다.
  // 여기 한 곳에 두는 이유: 노트를 여는 길이 여럿이라(열기·탭 이동·창 나누기·떨구기)
  // 그 길마다 따로 부르면 반드시 하나를 빠뜨린다 — 실제로 처음엔 안 보였다(2026-10-17).
  paintPassBtn();
}

/** `#readCard`·`#readHeading`·`#readBody`를 활성 창의 요소로 옮긴다. */
function moveReaderIds() {
  document.querySelectorAll('#readPanes .read-pane').forEach((el, i) => {
    const on = i === activePane;
    el.classList.toggle('active', on);
    const card = el.querySelector('.read-card');
    const head = el.querySelector('.read-heading');
    const body = el.querySelector('.read-body');
    if (!card) return;
    if (on) { card.id = 'readCard'; head.id = 'readHeading'; body.id = 'readBody'; }
    else { card.removeAttribute('id'); head.removeAttribute('id'); body.removeAttribute('id'); }
  });
}

const paneCount = () => panes.length;
function curPane() { return panes[activePane] || null; }

// ---- 탭 ----
const TAB_BODY = {
  today: 'todayBody', quizzes: 'quizBody', exams: 'listBody', jokbo: 'jokboBody',
  notes: 'notesBody', cards: 'cardsBody',
};

/**
 * @param {object} [opts]
 * @param {boolean} [opts.force] 캐시를 무시하고 vault에서 다시 읽는다(↻ 버튼).
 *   ⚠️ 이걸 안 넘기면 ↻ 를 눌러도 **노트 목록이 갱신되지 않는다** —
 *   예습노트는 매일 새로 생기는데 note_index가 kv에 캐시돼 있다(2026-10-10 발견).
 */
function showTab(which, { remember = true, force = false } = {}) {
  if (!TAB_BODY[which]) which = 'today';
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === which));
  for (const [k, id] of Object.entries(TAB_BODY)) {
    document.getElementById(id).classList.toggle('hidden', k !== which);
  }
  if (remember) localStorage.setItem('last_tab', which);
  if (which === 'notes') loadNotesTab(force);
  if (which === 'cards') loadCardsTab();
  if (which === 'today') loadTodayTab(force);
  // 퀴즈·모의고사·족보는 **숨겼다 보여주기만** 하고 있었다. 그래서 시험을 열다 만 뒤
  // 돌아오면 "시험을 불러오는 중…"이 그대로 남아 있었다(2026-10-14 점검).
  // 캐시해둔 목록으로 다시 그린다 — 네트워크를 타지 않으니 공짜다.
  if (['quizzes', 'exams', 'jokbo'].includes(which)) redrawList(which).catch(() => {});
}

const KIND_OF = { quizzes: '퀴즈', exams: '모의고사', jokbo: '족보' };

/** 캐시된 목록으로 그 탭을 다시 그린다. 캐시가 없으면 vault에서 한 번 읽는다. */
async function redrawList(which) {
  if (!(await hasToken())) return;
  const body = document.getElementById(TAB_BODY[which]);
  const stale = !body.children.length || /중…/.test(body.textContent);
  const index = await buildExamIndex(false);
  if (!index.length && !stale) return;
  renderList(index, await allSessions(), KIND_OF[which]);
}

/** 마지막으로 보던 탭으로 돌아간다 — 매번 퀴즈 탭부터 찾아 들어가지 않게. */
function restoreTab(force) {
  showTab(localStorage.getItem('last_tab') || 'today', { remember: false, force });
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => showTab(t.dataset.tab);
});

// ---- 오늘 할 것 ----
//
// 왜 필요한가: 강의가 10/12~10/21에 매일 2~3개씩 몰려 있다. 앱을 열 때마다 과목 →
// 날짜를 더듬어 찾아 들어가는 건 그 자체로 마찰이다. 시간표를 읽어 "오늘 배운 것"과
// "다시 볼 문항"을 첫 화면에 올린다(2026-10-10).

let todayCache = null;   // {schedule, exams}

async function todayData(force) {
  if (todayCache && !force) return todayCache;
  let schedule = [];
  let exams = [];
  try {
    // ⚠️ 받아온 것을 **따로** 모았다가 다 성공했을 때만 넘긴다. 전에는 바로
    // 쌓다가 중간에 한 파일이 실패하면, catch에서 캐시를 덧붙여 강의가 두 번
    // 들어갔다(2026-10-10).
    const gotS = [];
    const gotE = [];
    for (const f of (await listDir('00_Raw_Text/시간표')).filter((x) => x.type === 'file' && x.name.endsWith('.md'))) {
      const md = await getText(f.path);
      const subject = f.name.replace(/_?시간표\.md$/, '');
      gotS.push(...parseSchedule(md).map((l) => ({ ...l, src: subject })));
      gotE.push(...parseExamDates(md).map((e) => ({ ...e, src: subject })));
    }
    schedule = gotS;
    exams = gotE;
    await kvSet('schedule_cache', { schedule, exams });
  } catch {
    const c = await kvGet('schedule_cache');
    if (c) { schedule = c.schedule || []; exams = c.exams || []; }
  }
  todayCache = { schedule, exams };
  return todayCache;
}

async function loadTodayTab(force) {
  const body = document.getElementById('todayBody');
  body.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    // ⚠️ 노트 목록(noteList)도 같이 force해야 한다 — 전에는 ↻ 가 시험 인덱스만 다시 읽고
    // 노트 캐시(note_index_v2)는 그대로 둬서, "오늘" 탭에서 ↻ 를 눌러도 **그날 새로
    // 생긴 노트는 "노트를 찾지 못했습니다"로 떴다**(2026-10-12 사용자 지적 — 종료 후
    // 재실행은 되는데 ↻ 로는 안 됨. 원인: 재실행 뒤 첫 조회에서야 비로소 캐시가 채워졌고,
    // 그 뒤로는 ↻ 를 눌러도 이 탭이 캐시를 갱신한 적이 없었다).
    const [{ schedule, exams }, index, attempts, srs, cards, noteGroups] = await Promise.all([
      todayData(force), buildExamIndex(force), allAttempts(), loadSrs(), allCards(), noteList(force),
    ]);
    body.innerHTML = '';

    // ── 다음 시험 D-day ──
    const next = nextExam(exams);
    if (next) {
      const days = Math.ceil((next.at - Date.now()) / 86400000);
      const bar = document.createElement('div');
      bar.className = 'today-exam';
      bar.innerHTML = `<span class="today-d">D-${days}</span>`
        + `<span>${escapeHtml(next.name)} · ${next.date}</span>`;
      body.appendChild(bar);
    }

    // ── 다시 볼 문항 ──
    // 시험이 임박한 과목을 먼저 보여준다 — 시간표 이름(응급중환자)과 폴더 이름(응급_중환자)이
    // 다르므로 '_' 를 떼고 견준다.
    const norm = (s) => String(s || '').replace(/[_\s]/g, '');
    const hotSubject = next ? norm(next.src) : '';
    const groups = weakBySubject(attempts);
    groups.sort((a, b) => (norm(b.subject) === hotSubject) - (norm(a.subject) === hotSubject));

    const weakSec = section(body, '다시 볼 문항');
    if (!groups.length) {
      weakSec.appendChild(muted('아직 푼 문항이 없습니다. 모의고사를 하나 풀면 여기에 쌓입니다.'));
    } else {
      groups.forEach((g) => {
        const row = document.createElement('button');
        row.className = 'exam-item';
        const name = document.createElement('span');
        name.className = 'exam-name';
        const bits = [];
        if (g.wrong) bits.push(`틀림 ${g.wrong}`);
        if (g.unsure) bits.push(`찍음 ${g.unsure}`);
        name.innerHTML = `<b>${escapeHtml(g.subject)}</b>`
          + `<span class="exam-meta">${bits.join(' · ') || '없음'} · 푼 문항 ${g.total}개</span>`;
        const tail = document.createElement('span');
        tail.className = 'exam-progress';
        tail.textContent = g.weak ? `${g.weak}개 ›` : '✓';
        row.append(name, tail);
        row.disabled = !g.weak;
        row.onclick = () => openWeakQueue(g.subject);
        weakSec.appendChild(row);
      });
    }

    // ── 수업 (날짜를 넘겨볼 수 있다) ──
    // 하루치만 보여주면 **어제 배운 걸 다시 꺼낼 길이 없다**(2026-10-13 지적).
    // 그 주의 수업일을 가로로 깔고, 누르면 그 날짜로 간다.
    let pool = schedule;
    if (hotSubject) {
      const hot = schedule.filter((l) => norm(l.src) === hotSubject);
      if (hot.length) pool = hot;
    }
    renderDaySection(body, pool, index, attempts, noteGroups);

    // ── 카드 ──
    // 보관한 과목(= 시험이 끝난 과목)은 빼고 센다 — 안 그러면 "오늘 4,716장"이 뜬다.
    const archived = new Set((await kvGet(ARCHIVE_KEY)) || []);
    const live = liveCards(cards, archived);
    const hidden = cards.length - live.length;
    const due = dueToday(live, srs);
    const cardSec = section(body, '카드');
    const cb = document.createElement('button');
    cb.className = 'exam-item';
    const cn = document.createElement('span');
    cn.className = 'exam-name';
    cn.innerHTML = `<b>복습할 카드</b><span class="exam-meta">전체 ${live.length}장`
      + (hidden ? ` · 보관 ${hidden}장은 빼고` : '') + '</span>';
    const ct = document.createElement('span');
    ct.className = 'exam-progress';
    ct.textContent = due.length ? `${due.length}장 ›` : '✓';
    cb.append(cn, ct);
    cb.onclick = () => showTab('cards');
    cardSec.appendChild(cb);
  } catch (e) {
    body.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'warn-box';
    box.textContent = e.message === 'NO_TOKEN'
      ? '토큰이 없습니다. 설정에서 먼저 연결해 주세요.'
      : `오늘 할 것을 불러오지 못했습니다: ${e.message}`;
    body.appendChild(box);
  }
}

function section(parent, label) {
  const h = document.createElement('div');
  h.className = 'today-h';
  h.textContent = label;
  const box = document.createElement('div');
  box.className = 'today-sec';
  parent.append(h, box);
  return box;
}
function muted(text) {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = text;
  return p;
}

/**
 * 위키링크 이름(1013_응급중환자_임상독성학)으로 노트를 찾아 연다.
 *
 * `groups`를 넘기면(이미 force로 읽어온 최신 목록) 그걸 그대로 쓴다. 안 넘기면
 * 캐시부터 보되, **못 찾으면 한 번 더 실제로 vault를 본다** — 방금 생긴 노트는
 * 캐시에 없는 게 당연하고, 그때마다 사용자가 다른 탭에 가서 ↻ 를 따로 누를 이유가
 * 없다(2026-10-12: "노트를 찾지 못했습니다"가 뜬 원인).
 */
/**
 * 이름으로 노트를 연다.
 *
 * ⚠️ 못 찾으면 **반드시 목록을 새로 받아 한 번 더** 본다. 전에는 부르는 쪽이 목록을
 *    쥐여주면(`groups`) 그 길을 건너뛰었다. 그런데 오늘 탭이 바로 그렇게 부른다 —
 *    화면을 그릴 때 받아둔 목록을 칩마다 물려준다. 그래서 **오늘 수업이 끝나고 맥에서
 *    막 올린 실강노트**는, 목록이 그보다 먼저 캐시됐으면 영영 안 열렸다
 *    (2026-10-15 신고: "오늘치 실강노트 안들어가지는데"). 새로 만든 노트를 여는 건
 *    드문 일이 아니라 **매일 있는 일**이므로, 한 번의 재시도를 아끼면 안 된다.
 */
async function openNoteByName(name, { groups: given, force = false } = {}) {
  try {
    let groups = given || (await noteList(force));
    let hit = findNoteInGroups(groups, name);
    if (!hit && !force) {
      groups = await noteList(true);          // 목록을 새로 받아 한 번 더
      hit = findNoteInGroups(groups, name);
      // 받아온 목록을 오늘 탭이 쥐고 있던 것과 바꿔둔다 — 다음 칩도 바로 열리게
      if (given && Array.isArray(given)) { given.length = 0; given.push(...groups); }
    }
    if (hit) return openNote(hit.path);
    toast(`노트를 찾지 못했습니다: ${name} — 아직 vault에 없는 것 같습니다.`);
  } catch (e) {
    toast(`노트를 열지 못했습니다: ${e.message}`);
  }
}

/**
 * 과목 전체에서 약한 문항만 모아 푼다.
 *
 * 여러 시험에서 문항을 끌어오므로 문항마다 원래 시험을 `__exam`에 달아둔다 —
 * 풀이 이력이 원본 시험에 쌓여야 다음에도 같은 판단이 선다.
 */
async function openWeakQueue(subject) {
  const body = document.getElementById('todayBody');
  const keep = body.innerHTML;
  body.innerHTML = '<p class="muted">약한 문항을 모으는 중…</p>';
  try {
    const attempts = await allAttempts();
    const want = weakQueue(attempts, { subject, limit: 40 });
    if (!want.length) { body.innerHTML = keep; toast('다시 볼 문항이 없습니다.'); return; }

    const byExam = new Map();
    want.forEach((a) => {
      if (!byExam.has(a.exam)) byExam.set(a.exam, []);
      byExam.get(a.exam).push(a);
    });

    const picked = [];
    for (const [path, list] of byExam) {
      let parsed;
      try { parsed = parseExamHtml(await getText(path)); }
      catch { continue; }                 // 파일이 사라졌거나 못 읽으면 건너뛴다
      const meta = list[0];
      for (const a of list) {
        const q = parsed.questions.find((x) => String(x.num) === String(a.num));
        if (!q) continue;
        picked.push({ ...q, __exam: path, __subject: meta.subject, __kind: meta.kind,
          __title: meta.title || prettyExamName(path.split('/').pop()) });
      }
    }
    if (!picked.length) { body.innerHTML = keep; toast('문항을 불러오지 못했습니다.'); return; }

    // 모아 풀기는 순서 자체가 섞여 있어야 "무슨 유형인지 고르는" 연습이 된다
    shuffle(picked);

    // file이 비면 vault에 저장할 때 파일명이 "과목_날짜__모의고사풀이.md"로 빈다
    currentExam = { subject, file: '다시볼문항.html', path: WEAK_KEY, title: `다시 볼 문항 — ${subject}` };
    if (quiz) quiz.destroy();
    destroyPen();
    closeOverview();
    await clearSession(WEAK_KEY);         // 이전 모아풀기 상태가 남아 섞이지 않게
    quiz = new Quiz({
      examKey: WEAK_KEY,
      questions: picked,
      title: `다시 볼 문항 — ${subject} (${picked.length})`,
      onFinish: showResult,
      onExit: () => { quiz.destroy(); destroyPen(); closeOverview(); loadList(false); },
      onRender: onQuestionRender,
      meta: { subject, kind: '모아풀기' },
    });
    show('quizScreen');
    quiz.start();
    ensurePen();
  } catch (e) {
    body.innerHTML = keep;
    toast(`모아 풀기에 실패했습니다: ${e.message}`);
  }
}

// ---- 노트 목록 ----
async function loadNotesTab(force) {
  const body = document.getElementById('notesBody');
  body.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const groups = await noteList(force);
    body.innerHTML = '';
    if (!groups.length) {
      // 빈 화면은 **어디를 보는 중이고 무엇을 하면 되는지**를 말해야 한다.
      // 다른 탭(퀴즈·족보)은 이미 그렇게 하는데 노트만 한 줄로 끝났다(2026-10-14 점검).
      body.innerHTML = '';
      body.append(muted('노트를 찾지 못했습니다. vault의 02_Wiki/{과목}/ · 98_예습노트_보관/{과목}/ 를 읽습니다.'));
      const again = document.createElement('button');
      again.className = 'btn';
      again.textContent = '↻ vault에서 다시 찾기';
      again.onclick = () => loadNotesTab(true);
      body.appendChild(again);
      return;
    }

    // 이번 주 강의를 맨 위에 — 폴더를 더듬어 들어가지 않고 바로 열게(2026-10-13 요청).
    // 노트 목록은 뿌리 3개 × 과목 28개라 "지금 배우는 것"을 찾는 데 손이 많이 간다.
    await renderNoteWeek(body, groups);

    // 뿌리(예습노트/Wiki/임종평)로 한 겹 묶는다. 임종평만 20개 과목이라
    // 그냥 늘어놓으면 28개 그룹이 깔려서 내 과목을 못 찾는다(2026-10-09).
    const ROOT_META = {
      '98_예습노트_보관': { label: '예습노트', order: 0, open: true },
      '02_Wiki': { label: '위키', order: 1, open: true },
      '01_임종평_전범위': { label: '임종평 전범위', order: 2, open: false },
    };
    const byRoot = new Map();
    for (const g of groups) {
      if (!byRoot.has(g.root)) byRoot.set(g.root, []);
      byRoot.get(g.root).push(g);
    }
    const roots = [...byRoot.entries()].sort(
      (a, b) => (ROOT_META[a[0]]?.order ?? 9) - (ROOT_META[b[0]]?.order ?? 9));

    const noteBtn = (n) => {
      const b = document.createElement('button');
      b.className = 'exam-item';
      const name = document.createElement('span');
      name.className = 'exam-name';
      name.textContent = n.name.replace(/^\d{4}_/, '');
      const arrow = document.createElement('span');
      arrow.className = 'exam-progress';
      arrow.textContent = '›';
      b.append(name, arrow);
      b.onclick = () => openNote(n.path);
      return b;
    };

    for (const [root, gs] of roots) {
      const meta = ROOT_META[root] || { label: root.replace(/^\d+_/, ''), open: false };
      const total = gs.reduce((a, g) => a + g.notes.length, 0);

      const outer = document.createElement('details');
      outer.className = 'root-group';
      outer.open = !!meta.open;
      const osum = document.createElement('summary');
      osum.className = 'root-head';
      osum.innerHTML =
        '<span class="head-row">' +
        `<span>${escapeText(meta.label)}</span>` +
        `<span class="subject-count">${gs.length}과목 · ${total}개</span>` + '</span>';
      outer.appendChild(osum);
      body.appendChild(outer);

      for (const g of gs) {
        const det = document.createElement('details');
        det.className = 'subject-group';
        const sum = document.createElement('summary');
        sum.className = 'subject-head';
        sum.innerHTML =
          '<span class="head-row">' +
        `<span>${escapeText(g.subject.replace(/^\d+_/, '').replace(/_/g, ' '))}</span>` +
          `<span class="subject-count">${g.notes.length}개</span>` + '</span>';
        det.appendChild(sum);
        outer.appendChild(det);
        g.notes.forEach((n) => det.appendChild(noteBtn(n)));
      }
    }
  } catch (e) {
    body.innerHTML = `<div class="warn-box">노트 목록을 불러오지 못했습니다: ${e.message}</div>`;
  }
}

async function openNote(path) {
  const body = document.getElementById('notesBody');
  const prev = body.innerHTML;
  body.innerHTML = '<p class="muted">노트를 여는 중…</p>';
  try {
    const note = await loadNote(path);
    // 이 노트의 슬라이드 PDF가 MarginNote에 있으면 `[슬라이드 p.N]`이 그 문서로 바로 간다.
    // 못 찾으면 "현재 열린 문서"로 떨어진다 — 어느 쪽이든 안 깨진다(2026-10-12).
    try { setSlideDoc(findMnDoc(await marginNoteDocs(), note.pdf)); } catch { setSlideDoc(null); }
    // 읽기 화면이 아직 안 열렸으면 창 하나로 시작한다
    if (!panes.length) panes = [{ tabs: [], active: 0 }];
    // 전에 읽던 자리가 있으면 거기서 이어 읽는다 — 매번 1장부터 보지 않게
    const back = Number(readPos[note.path] || 0);
    const at = back > 0 && back < note.sections.length ? back : 0;
    openInPane(note, { pane: activePane, secIdx: at });
    if (at) toast(`읽던 자리(${at + 1}/${note.sections.length})에서 이어 봅니다`);
    show('readScreen');
    // 넓은 화면은 목차를 펴놓고, 좁은 화면은 본문을 가리지 않게 접어둔다(기억값 우선)
    const saved = localStorage.getItem('toc_open');
    tocOpen(saved === null ? window.innerWidth >= 900 : saved === '1');
    renderPanes();
    ensureReaderPen();
  } catch (e) {
    body.innerHTML = prev;
    toast(`노트를 열지 못했습니다: ${e.message}`);
  }
}

// ---------- 읽기모드 목차 ----------
// 섹션이 7~10개라 하나씩 넘기면 느리다 → 목차에서 바로 건너뛴다(2026-10-09 요청).
// 좁은 화면에서는 서랍이라 고르면 닫고, 넓은 화면에서는 칼럼이라 열어둔다.
function tocOpen(on) {
  document.getElementById('readScreen').classList.toggle('toc-off', !on);
  document.getElementById('readTocScrim').classList.toggle('hidden', !(on && window.innerWidth < 900));
  document.getElementById('readTocBtn').classList.toggle('active', on);
  localStorage.setItem('toc_open', on ? '1' : '0');
  if (readerPen) requestAnimationFrame(() => readerPen.resize());
}
function tocIsOpen() { return !document.getElementById('readScreen').classList.contains('toc-off'); }

function renderToc() {
  const list = document.getElementById('readTocList');
  list.innerHTML = '';
  if (!reader) return;
  reader.note.sections.forEach((sec, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `toc-link${i === reader.secIdx ? ' current' : ''}`;
    const n = document.createElement('span');
    n.className = 'toc-i';
    n.textContent = String(i + 1);
    const t = document.createElement('span');
    t.textContent = sec.heading;
    b.append(n, t);
    b.onclick = () => {
      reader.secIdx = i;
      renderReader();
      if (window.innerWidth < 900) tocOpen(false);   // 서랍은 고르면 닫는다
    };
    li.appendChild(b);
    list.appendChild(li);
  });
  scrollTocToCurrent(list);
}

/** 넓은 화면에선 본문이 제 상자 안에서 스크롤된다 — 페이지가 아니라 그 상자를 올린다. */
/**
 * 지금 보는 창을 맨 위로.
 *
 * ⚠️ `querySelector('.read-main')`은 **항상 첫 창**(왼쪽)을 집는다. 그래서 오른쪽에
 *    암기법을 띄워두고 목차를 누르면 **왼쪽 위키가 맨 위로 튀었다**(2026-10-14 지적).
 *    활성 창만 올린다 — 다른 창은 보던 자리를 지킨다.
 */
function scrollReadTop() {
  const pane = document.querySelector(`#readPanes .read-pane[data-pane="${activePane}"]`)
    || document.querySelector('#readScreen .read-pane');
  const main = pane ? pane.querySelector('.read-main') : null;
  if (main) main.scrollTop = 0;
  // 페이지 자체는 읽기 화면에서 스크롤되지 않는다 — 다른 화면에서만 올린다
  if (document.body.dataset.screen !== 'readScreen') window.scrollTo(0, 0);
}

/**
 * 긴 목차에서 현재 항목을 보이게 한다.
 * scrollIntoView를 쓰면 목차뿐 아니라 **페이지까지 같이 스크롤돼** 본문이 튄다.
 * 그래서 목차 상자의 scrollTop만 직접 건드린다.
 */
function scrollTocToCurrent(list) {
  const cur = list.querySelector('.toc-link.current');
  const box = document.getElementById('readToc');
  if (!cur || !box) return;
  // offsetTop은 position에 따라 기준이 바뀐다(넓은 화면 static ↔ 좁은 화면 fixed).
  // 화면 좌표 차이로 계산하면 둘 다에서 맞는다.
  const r = cur.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  if (r.top < br.top) box.scrollTop += r.top - br.top - 8;
  else if (r.bottom > br.bottom) box.scrollTop += r.bottom - br.bottom + 8;
}

document.getElementById('readTocBtn').onclick = () => tocOpen(!tocIsOpen());
document.getElementById('readTocHide').onclick = () => tocOpen(false);
document.getElementById('readTocScrim').onclick = () => tocOpen(false);

// ───────────── 문서 목록 서랍 (2026-10-13) ─────────────
//
// 읽는 중에 다른 노트로 건너뛰려면 목록 화면까지 나갔다 와야 했다.
// 서랍에서 바로 열고, **끌어서 오른쪽에 놓으면 화면이 갈라진다.**

let docDragNote = null;      // 지금 끌고 있는 노트
// 끌어다 놓기는 사람이 손으로 하는 일이라 검사가 흉내 내기 어렵다 — 들어오는 길만 열어둔다
window.__setDocDrag = (n) => { docDragNote = n; };

async function openDocDrawer() {
  const dd = document.getElementById('docDrawer');
  dd.classList.remove('hidden');
  document.getElementById('docScrim').classList.remove('hidden');
  // 안내는 **지금 상태에 맞게** — 이미 갈라져 있으면 "오른쪽에 놓으면 갈라진다"는
  // 틀린 말이다(갈라질 게 없다). 그때는 어느 창에나 놓을 수 있다고 알려준다.
  const hint = dd.querySelector('.dd-hint');
  if (hint) {
    hint.textContent = paneCount() >= 2
      ? '끌어서 왼쪽·오른쪽 어느 창에나 놓을 수 있습니다 — 끄는 동안 이 목록은 비켜납니다'
      : '끌어서 오른쪽에 놓으면 화면이 갈라집니다';
  }
  const list = document.getElementById('docList');
  // 목록은 한 번만 받아오지만 **그릴 때마다 다시 그린다** — 맨 위의 "지금 문서의 짝"과
  // 과목 순서가 지금 열어둔 노트에 달려 있어서, 한 번 그려두면 옛 노트 기준으로 굳는다.
  if (!list.__groups) {
    list.innerHTML = '<p class="muted" style="padding:12px">불러오는 중…</p>';
    try {
      list.__groups = await noteList(false);
    } catch (e) {
      list.innerHTML = `<p class="muted" style="padding:12px">${escapeText(e.message)}</p>`;
      return;
    }
  }
  document.getElementById('docSearch').value = '';
  renderDocList(list.__groups, '');
  setTimeout(() => document.getElementById('docSearch').focus(), 80);
}
function closeDocDrawer() {
  document.getElementById('docDrawer').classList.add('hidden');
  document.getElementById('docScrim').classList.add('hidden');
}

let docOpenGroups = null;      // 펼쳐둔 과목(없으면 지금 보는 과목만)

/**
 * 노트 이름에서 "같은 강의인가"를 가르는 열쇠를 뽑는다.
 *
 *   02_Wiki/응급_중환자/응급중환자_기본소생술BLS.md
 *   02_Wiki/응급_중환자/암기법/응급중환자_기본소생술BLS_암기법.md
 *   98_예습노트_보관/응급_중환자/1012_응급중환자_기본소생술BLS.md
 * 셋은 같은 강의의 세 얼굴이다 — 날짜 머리와 종류 꼬리를 떼면 같은 말이 된다.
 */
function lectureKey(name) {
  return String(name).normalize('NFC')
    .replace(/^\d{3,4}_/, '')
    .replace(/_(암기법|QA|Q&A|퀴즈|요약|정리)$/i, '')
    .replace(/[^0-9A-Za-z가-힣]/g, '')
    .toLowerCase();
}
/** 이름 앞의 날짜 머리(1012_) → "10/12". 없으면 ''. */
function noteDate(name) {
  const m = String(name).match(/^(\d{2})(\d{2})_/);
  return m ? `${Number(m[1])}/${Number(m[2])}` : '';
}
/** 노트가 어떤 갈래인가 — 서랍에서 한눈에 가르려고 쓴다. */
function noteKind(path, name) {
  if (/\/암기법\//.test(path) || /_암기법$/.test(name)) return { ic: '🧠', t: '암기법' };
  if (/\/QA\//.test(path) || /_QA$/i.test(name)) return { ic: '❓', t: 'Q&A' };
  if (path.startsWith('98_예습노트_보관')) return { ic: '📝', t: '예습' };
  if (/\/국시종합\//.test(path)) return { ic: '🎓', t: '국시' };
  return { ic: '📘', t: '위키' };
}

/**
 * 지금 보는 노트의 **짝** — 같은 강의의 다른 얼굴들.
 *
 * 위키가 쌓이면 "이 강의의 암기법"을 이름으로 찾는 데 시간이 걸린다(2026-10-13 지적).
 * 이름 규칙이 이미 일정하니 계산으로 짝을 지어 맨 위에 올려 둔다.
 */
function pairedNotes(groups) {
  const doc = currentDoc();
  if (!doc) return [];
  const mine = doc.path || '';
  const key = lectureKey(doc.title || mine.split('/').pop().replace(/\.md$/, ''));
  if (key.length < 6) return [];
  const out = [];
  for (const g of groups || []) {
    for (const n of g.notes || []) {
      if (n.path === mine) continue;
      const k = lectureKey(n.name);
      // 똑같거나, 한쪽이 다른 쪽을 품으면 짝으로 본다(예습노트는 제목이 짧게 줄기도 한다)
      const hit = k === key || (k.length >= 8 && key.includes(k)) || (key.length >= 8 && k.includes(key));
      if (hit) out.push({ ...n, ...noteKind(n.path, n.name), exact: k === key });
    }
  }
  const rank = { 암기법: 0, 'Q&A': 1, 위키: 2, 국시: 3, 예습: 4 };
  return out.sort((a, b) => (b.exact - a.exact) || (rank[a.t] - rank[b.t])).slice(0, 8);
}

function renderDocList(groups, q) {
  const list = document.getElementById('docList');
  const needle = String(q || '').trim().toLowerCase();
  list.innerHTML = '';

  // 지금 보고 있는 노트와 **같은 과목**을 맨 위로 — 응급을 보는 중이면 응급이 먼저다.
  // 암기법·QA는 `응급_중환자 · 암기법`이라는 **별도 묶음**이라 과목 이름만 보면 안 걸렸다 —
  // 그래서 "노트를 눌러도 암기법이 바로 안 나온다"가 됐다(2026-10-13). 밑동만 보고 가른다.
  // 퀴즈를 푸는 중이면 **그 시험의 과목**이 기준이다 — 읽던 노트가 아니라(2026-10-14).
  const doc = currentDoc();
  const herePath = (doc && doc.path) || (reader && reader.note ? reader.note.path : '');
  const here = herePath ? herePath.split('/') : [];
  const hereSubject = here[1]
    || (document.body.dataset.screen === 'quizScreen' && currentExam ? currentExam.subject : '');
  const hereRoot = here[0] || '02_Wiki';
  const base = (x) => String(x).split(' · ')[0];
  const sorted = [...groups].sort((a, b) => {
    const sa = base(a.subject) === hereSubject, sb = base(b.subject) === hereSubject;
    if (sa !== sb) return sa ? -1 : 1;
    // 같은 과목 안에서는 암기법 → Q&A → 본문 순 — 자주 여는 것이 위로
    if (sa && sb) {
      const r = (x) => (/암기법$/.test(x.subject) ? 0 : /QA$/.test(x.subject) ? 1 : 2);
      if (r(a) !== r(b)) return r(a) - r(b);
    }
    const ra = a.root === hereRoot, rb = b.root === hereRoot;
    if (ra !== rb) return ra ? -1 : 1;
    return 0;
  });

  // ── 지금 문서의 짝 ──
  if (!needle) {
    const pairs = pairedNotes(groups);
    if (pairs.length) {
      const head = document.createElement('div');
      head.className = 'dd-pair-head';
      head.textContent = '지금 문서의 짝';
      list.appendChild(head);
      for (const n of pairs) list.appendChild(docItem(n, true));
    }
  }

  if (docOpenGroups === null) docOpenGroups = new Set();

  let shown = 0;
  for (const g of sorted) {
    const hits = g.notes.filter((n) => !needle || n.name.toLowerCase().includes(needle));
    if (!hits.length) continue;
    const key = `${g.root}|${g.subject}`;
    const isHere = base(g.subject) === hereSubject && g.root === hereRoot;
    // 지금 보는 과목만 펼쳐둔다. 검색 중에는 걸린 것을 다 펼친다 — 접힌 채로는
    // 찾았는지 알 수가 없다(2026-10-13 요청).
    const open = !!needle || isHere || docOpenGroups.has(key);

    const head = document.createElement('button');
    head.className = `dd-group${isHere ? ' here' : ''}${open ? ' open' : ''}`;
    head.innerHTML = `<span class="dd-caret">${open ? '▾' : '▸'}</span>`
      + `<span class="dd-gname"></span><span class="dd-gn">${hits.length}</span>`;
    head.querySelector('.dd-gname').textContent =
      // 지금 과목의 묶음들은 이름을 짧게 — `위키 · 응급 중환자 · 암기법 — 지금 보는 과목`이
      // 네 줄 연달아 나오면 정작 무엇이 다른지가 안 보인다. 테두리 색이 이미 "여기"를 말한다.
      (isHere
        ? (g.subject.includes(' · ') ? g.subject.split(' · ').slice(1).join(' · ') : '지금 보는 과목')
        : `${ROOT_LABEL[g.root] || g.root} · ${g.subject.replace(/_/g, ' ')}`);
    head.onclick = () => {
      if (docOpenGroups.has(key)) docOpenGroups.delete(key); else docOpenGroups.add(key);
      renderDocList(groups, document.getElementById('docSearch').value);
    };
    list.appendChild(head);
    if (!open) continue;

    hits.slice(0, needle ? 40 : 200).forEach((n) => {
      list.appendChild(docItem(n, false));
      shown++;
    });
  }
  if (!shown && !list.children.length) {
    list.innerHTML = '<p class="muted" style="padding:12px">찾는 노트가 없습니다.</p>';
  }
}

/** 서랍의 노트 한 줄. 짝 목록과 과목 목록이 **같은 것**을 쓴다(동작이 갈라지지 않게). */
function docItem(n, asPair) {
  const b = document.createElement('button');
  b.className = `dd-item${asPair ? ' pair' : ''}`;
  if (asPair) {
    const ic = document.createElement('span');
    ic.className = 'dd-kind';
    const kind = noteKind(n.path, n.name);
    ic.textContent = `${kind.ic} ${kind.t}`;
    b.appendChild(ic);
  }
  const t = document.createElement('span');
  t.className = 'dd-name';
  t.textContent = n.name;
  b.appendChild(t);
  const d = noteDate(n.name);
  if (d) {
    const dd = document.createElement('span');
    dd.className = 'dd-date';
    dd.textContent = d;
    b.appendChild(dd);
  }
  b.title = n.name;
  b.draggable = true;
  b.onclick = async () => {
    closeDocDrawer();
    try {
      const note = await loadNote(n.path);
      // 어디서 열었느냐에 따라 **들어갈 자리**가 다르다 — 문제를 풀던 중이면 옆칸으로,
      // 노트를 읽던 중이면 그 창으로(2026-10-14).
      if (document.body.dataset.screen === 'quizScreen') { await openNoteInWikiPanel(note); return; }
      openInPane(note, { pane: activePane });
      renderPanes();
    } catch (e) { toast(`노트를 열지 못했습니다: ${e.message}`); }
  };
  b.addEventListener('dragstart', (e) => {
    docDragNote = n;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', n.path);
    document.getElementById('readPanes').classList.add('drop-ready');
    document.body.classList.add('dragging-doc');
  });
  b.addEventListener('dragend', () => {
    docDragNote = null;
    document.body.classList.remove('dragging-doc');
    clearDropHint();
  });
  return b;
}

/**
 * 떨구기 — 어느 창에 넣을지는 **떨군 자리**가 정한다.
 *
 *   창이 하나: 왼쪽 절반 → 그 창에 탭 추가 / 오른쪽 절반 → 갈라서 새 창
 *   창이 둘  : 떨군 그 창에 탭 추가 (탭 줄에 놓아도 된다)
 *
 * ⚠️ 서랍의 가림막(.dd-scrim)이 화면을 통째로 덮고 있어서 `#readPanes`가 dragover를
 *    아예 못 받고 있었다 — 드래그로 떨구기가 **한 번도 동작한 적이 없다**(2026-10-13
 *    발견). 끄는 동안 가림막을 통과시키고 서랍은 흐리게 비켜준다.
 */
function paneAtPoint(x, y) {
  const els = document.querySelectorAll('#readPanes .read-pane');
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(el.dataset.pane);
  }
  return null;
}

/** 떨구면 어떻게 될지 — {pane, split} */
function dropPlan(x, y) {
  const host = document.getElementById('readPanes');
  const r = host.getBoundingClientRect();
  if (panes.length >= 2) {
    const pi = paneAtPoint(x, y);
    return { pane: pi == null ? activePane : pi, split: false };
  }
  const right = (x - r.left) / r.width > 0.5;
  return right ? { pane: 1, split: true } : { pane: 0, split: false };
}

function paintDropHint(plan) {
  const host = document.getElementById('readPanes');
  host.classList.toggle('drop-split', !!(plan && plan.split));
  document.querySelectorAll('#readPanes .read-pane').forEach((el) => {
    el.classList.toggle('drop-into', !!plan && !plan.split && Number(el.dataset.pane) === plan.pane);
  });
}
function clearDropHint() {
  const host = document.getElementById('readPanes');
  host.classList.remove('drop-ready', 'drop-split');
  document.querySelectorAll('#readPanes .read-pane').forEach((el) => el.classList.remove('drop-into'));
}

function initDocDrop() {
  const host = document.getElementById('readPanes');
  host.addEventListener('dragover', (e) => {
    if (!docDragNote) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    paintDropHint(dropPlan(e.clientX, e.clientY));
  });
  host.addEventListener('dragleave', (e) => { if (e.target === host) clearDropHint(); });
  host.addEventListener('drop', async (e) => {
    if (!docDragNote) return;
    e.preventDefault();
    const n = docDragNote;
    const plan = dropPlan(e.clientX, e.clientY);
    docDragNote = null;
    clearDropHint();
    closeDocDrawer();
    try {
      // 위키링크에서 끌었으면 이름만 있다 — 그때 경로를 찾는다
      let path = n.path;
      if (!path) {
        const hit = findNoteInGroups(await noteList(false), n.name);
        if (!hit) { toast(`노트를 찾지 못했습니다: ${n.name}`); return; }
        path = hit.path;
      }
      const note = await loadNote(path);
      if (plan.split && panes.length < 2) splitPane(note);
      else { openInPane(note, { pane: Math.min(plan.pane, panes.length - 1) }); renderPanes(); }
    } catch (err) { toast(`노트를 열지 못했습니다: ${err.message}`); }
  });
}

document.getElementById('readDocs').onclick = openDocDrawer;
document.getElementById('wikiDocs').onclick = openDocDrawer;
document.getElementById('wikiBack').onclick = restoreWikiHome;

// ---------- 더보기 메뉴 (2026-10-13) ----------
// 머리줄 아이콘이 9개까지 늘었는데 정작 늘 쓰는 건 서넛뿐이다. 자주 쓰는 것만 밖에 두고
// 나머지는 접는다 — 접힌 메뉴는 글씨로 설명까지 붙일 수 있어 오히려 찾기 쉽다.
function closeMore() {
  document.getElementById('readMoreMenu').classList.add('hidden');
  document.getElementById('readMore').setAttribute('aria-expanded', 'false');
}
function toggleMore() {
  const m = document.getElementById('readMoreMenu');
  const on = m.classList.contains('hidden');
  m.classList.toggle('hidden', !on);
  document.getElementById('readMore').setAttribute('aria-expanded', String(on));
  if (on) { paintMoreStates(); placeMoreMenu(); }
}
/** 도구막대가 어디로 가 있든 ⋯ 버튼 옆에 붙인다. 화면 밖으로는 안 나간다. */
function placeMoreMenu() {
  const m = document.getElementById('readMoreMenu');
  const b = document.getElementById('readMore').getBoundingClientRect();
  m.style.setProperty('--mm-x', '0px');
  m.style.setProperty('--mm-y', '0px');
  requestAnimationFrame(() => {
    const r = m.getBoundingClientRect();
    const x = Math.max(8, Math.min(b.right - r.width, innerWidth - r.width - 8));
    const below = b.bottom + 6;
    const y = below + r.height < innerHeight - 8 ? below : Math.max(8, b.top - r.height - 6);
    m.style.setProperty('--mm-x', `${x}px`);
    m.style.setProperty('--mm-y', `${y}px`);
  });
}

/** 켜고 끄는 항목은 지금 상태를 보여준다 — 눌러봐야 아는 메뉴는 쓸모가 없다. */
function paintMoreStates() {
  const awake = document.getElementById('readAwake').classList.contains('active');
  document.getElementById('mmAwake').classList.toggle('on', awake);
  document.getElementById('mmTts').classList.toggle('on', ttsOn);
}

document.getElementById('readMore').onclick = (e) => { e.stopPropagation(); toggleMore(); };
document.addEventListener('pointerdown', (e) => {
  const m = document.getElementById('readMoreMenu');
  if (m.classList.contains('hidden')) return;
  if (!m.contains(e.target) && e.target.id !== 'readMore') closeMore();
});

const mm = (id, fn) => { document.getElementById(id).onclick = () => { closeMore(); fn(); }; };
mm('mmCards', openCardManager);
mm('mmAwake', () => document.getElementById('readAwake').click());
mm('mmTts', () => toggleTts());
mm('mmClear', () => document.getElementById('toolClear').click());
mm('mmTop', () => scrollReadTop());
mm('mmKeys', () => showKeyHelp());

document.getElementById('readFind').onclick = () => openSearch('doc');

// ── 키보드 · 마우스 ────────────────────────────────────────
// 아이패드에 키보드를 붙여 쓸 때가 있고(2026-10-13 요청), 마우스 보조 버튼도
// 쓴다. 손이 어디 있든 같은 일을 할 수 있게 한자리에 모아 둔다.
// 단축키는 Obsidian 습관을 그대로 따른다 — 머리로 외울 게 하나라도 적게.
const KEYS = [
  ['⌘F', '이 문서에서 찾기'],
  ['⌘⇧F', '열어본 모든 자료에서 찾기'],
  ['⌘O', '다른 노트 열기'],
  ['⌘\\', '화면 나누기 / 합치기'],
  ['⌘[ ⌘]', '이전 / 다음 섹션'],
  ['⌘⇧A', '긁은 곳에 AI 질문'],
  ['Enter ⇧Enter', '찾은 다음 / 이전 자리로'],
  ['Esc', '찾기·팝업 닫기'],
  ['/', '찾기 (글자 칸 밖에서)'],
  ['?', '이 목록'],
];
const MOUSE = [
  ['오른쪽 버튼', '찾기 열기'],
  ['가운데(휠) 버튼', '뒤로'],
  ['4·5번 버튼', '이전 / 다음 섹션'],
  ['엄지 휠(좌우)', '이전 / 다음 섹션'],
  ['끌기', '글 선택 → 질문·복사·카드'],
];
function showKeyHelp() {
  const rows = (list) => list
    .map(([k, d]) => `<div class="kh-row"><kbd>${escapeText(k)}</kbd><span>${escapeText(d)}</span></div>`)
    .join('');
  document.getElementById('keyHelpBody').innerHTML = `
    <div class="kh-sec">키보드</div>${rows(KEYS)}
    <div class="kh-sec">마우스 (MX Master 등 버튼 많은 마우스)</div>${rows(MOUSE)}
    <p class="muted kh-note">아이패드는 마우스 보조 버튼을 시스템이 먼저 가져갑니다.
    설정 › 손쉬운 사용 › 터치 › AssistiveTouch › 기기 에서 버튼마다 할 일을 정해 두면
    위 동작이 앱까지 전달됩니다.</p>`;
  document.getElementById('keySheet').classList.remove('hidden');
}
// 마우스 버튼 시험 — "되나?"를 말로 따지지 말고 눌러서 확인한다.
// 아이패드는 버튼마다 시스템이 먼저 가져갈 수도 있어서, 기기에서 직접 봐야 안다.
{
  const pad = document.getElementById('mpPad');
  const log = document.getElementById('mpLog');
  const seen = new Set();
  const NAME = { 0: '왼쪽', 1: '가운데(휠)', 2: '오른쪽', 3: '4번(뒤로)', 4: '5번(앞으로)' };
  const note = (what) => {
    if (seen.has(what)) return;
    seen.add(what);
    const d = document.createElement('div');
    d.className = 'mp-hit';
    d.textContent = `✓ ${what}`;
    log.appendChild(d);
  };
  const onBtn = (e) => { e.preventDefault(); note(NAME[e.button] || `${e.button}번`); };
  pad.addEventListener('pointerdown', onBtn);
  pad.addEventListener('auxclick', onBtn);
  pad.addEventListener('contextmenu', (e) => { e.preventDefault(); note('오른쪽 (보조 클릭)'); });
  pad.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) note('엄지 휠(좌우)');
  }, { passive: true });
  pad.addEventListener('keydown', (e) => note(`키보드: ${e.key}`));
}

document.getElementById('keyClose').onclick = () =>
  document.getElementById('keySheet').classList.add('hidden');
document.getElementById('keySheet').onclick = (e) => {
  if (e.target.id === 'keySheet') e.target.classList.add('hidden');
};

// ---- 읽어주기 ----
// 머리줄에서는 뺐지만(거의 안 쓴다) 누워서 들을 때가 있어 메뉴에 남긴다.
let ttsOn = false;
function stopTts() {
  try { window.speechSynthesis.cancel(); } catch {}
  ttsOn = false;
}
function toggleTts() {
  if (!('speechSynthesis' in window)) { toast('이 기기는 읽어주기를 지원하지 않습니다.'); return; }
  if (ttsOn) { stopTts(); toast('읽어주기 끔'); return; }
  const text = (document.getElementById('readBody').textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
  u.lang = 'ko-KR';
  u.rate = 1.05;
  u.onend = () => stopTts();
  window.speechSynthesis.speak(u);
  ttsOn = true;
  toast('읽어주기 시작');
}
document.getElementById('docClose').onclick = closeDocDrawer;
document.getElementById('docScrim').onclick = closeDocDrawer;
document.getElementById('docSearch').oninput = (e) => {
  const list = document.getElementById('docList');
  if (list.__groups) renderDocList(list.__groups, e.target.value);
};
document.getElementById('readSplitBtn').onclick = () => {
  if (panes.length > 1) closePane(1);
  else splitPane(null);                                       // 같은 문서를 복제해 비교
};

// ───────────── 창 그리기 · 탭 · 나누기 (2026-10-13) ─────────────

/** 이 창에 노트를 연다. 이미 열려 있으면 그 탭으로 간다(같은 문서를 두 번 안 띄운다). */
// 노트별 "마지막으로 보던 섹션". 같은 문서를 다시 열면 거기서 이어 읽는다(2026-10-13).
// ⚠️ **분할로 연 쪽은 기억하지 않는다** — 비교하려고 잠깐 띄운 자리가 "읽던 자리"로
//    덮어써지면, 다음에 그 노트를 열었을 때 엉뚱한 데서 시작한다.
// ───────────── 회독수 — 처음 배우는 중인가, 아는 줄 알았는데 안 나온 건가 ─────────────
//
// 왜 세는가(2026-10-17 요청): 모아두기로 담는 것의 **성격이 회독에 따라 다르다**.
//   · 1회독 중에는 "기전이 궁금해서 찾아본 것" — 처음 배우는 내용이다.
//   · 한 번 다 읽은 뒤에 담는 것은 "알았어야 하는데 안 떠오른 것" — 인출 실패다.
// 지금까지는 둘을 구별하지 않아서, **거의 모르는 내용을 정리한 것까지 인출 실패로**
// 기록되고 있었다(사용자 지적, 특히 응급). 가중치를 주는 쪽이 둘을 다르게 봐야 한다.
const READ_PASS_KEY = 'read_pass';
let readPass = {};           // {노트경로: 다 읽은 횟수}

async function loadReadPass() { readPass = (await kvGet(READ_PASS_KEY)) || {}; }
function passOf(path) { return Number((readPass || {})[path] || 0); }
async function setPass(path, n) {
  if (!path) return;
  const v = Math.max(0, Math.round(n));
  if (v) readPass[path] = v; else delete readPass[path];
  await kvSet(READ_PASS_KEY, readPass);
  backup.scheduleBackup();
  paintPassBtn();
}

/** 지금 읽는 노트의 회독 단추를 상태에 맞게 그린다. */
function paintPassBtn() {
  const b = document.getElementById('readPass');
  if (!b) return;
  const path = reader && reader.note ? reader.note.path : '';
  const n = passOf(path);
  b.classList.toggle('hidden', !path);
  b.classList.toggle('done', n > 0);
  b.textContent = n ? `${n}회독` : '1회독 중';
  b.title = n
    ? `${n}회독 마침 — 지금 담는 건 "인출 실패"로 갑니다. 길게 누르면 되돌립니다.`
    : '아직 1회독 중 — 지금 담는 건 "처음 배우는 것"으로 갑니다. 누르면 1회독 완료.';
}

const READ_POS_KEY = 'read_pos';
let readPos = {};

async function loadReadPos() { readPos = (await kvGet(READ_POS_KEY)) || {}; }

// 읽던 자리는 **섹션을 넘길 때마다** 바뀐다. 그때마다 통째로 저장하면 한 학기 뒤에는
// 48KB짜리 덩어리를 한 번 넘길 때마다 다시 쓰게 된다(2026-10-14 실측). 둘로 줄인다:
//   ① 모아서 쓴다(1.2초 안에 또 넘기면 한 번만)
//   ② 오래된 것은 버린다 — 300개면 "요즘 보던 것"으로 충분하다
const READ_POS_MAX = 300;
let readPosTimer = 0;
function rememberReadPos() {
  // 나뉘어 있을 때는 **옆칸 기억**에 자리를 적어둔다(2026-10-14) — 닫고 다시 열면
  // 그 장부터 이어 본다.
  if (panes.length === 2) { rememberSplit(); return; }
  // 창이 하나일 때만 "읽던 자리"로 기억한다(분할 중에는 어느 쪽인지 정할 수 없다)
  if (panes.length !== 1 || !reader) return;
  readPos[reader.note.path] = reader.secIdx;
  readPos.__t = readPos.__t || {};
  readPos.__t[reader.note.path] = Date.now();
  clearTimeout(readPosTimer);
  readPosTimer = setTimeout(flushReadPos, 1200);
}
function flushReadPos() {
  clearTimeout(readPosTimer);
  readPosTimer = 0;
  const t = readPos.__t || {};
  const paths = Object.keys(readPos).filter((k) => k !== '__t');
  if (paths.length > READ_POS_MAX) {
    // 최근에 본 것부터 남긴다. 시각을 모르는 옛 항목은 뒤로 민다.
    const keep = paths.sort((a, b) => (t[b] || 0) - (t[a] || 0)).slice(0, READ_POS_MAX);
    const next = { __t: {} };
    for (const k of keep) { next[k] = readPos[k]; if (t[k]) next.__t[k] = t[k]; }
    readPos = next;
  }
  kvSet(READ_POS_KEY, readPos).catch(() => {});
}
// 앱을 떠날 때는 미뤄둔 것을 바로 쓴다 — 아이패드는 백그라운드 타이머를 멈춘다
document.addEventListener('visibilitychange', () => { if (document.hidden && readPosTimer) flushReadPos(); });

function openInPane(note, { pane = activePane, secIdx = 0, force = false } = {}) {
  setTimeout(rememberSplit, 0);        // 옆칸 구성이 바뀌면 그때그때 적어둔다
  while (panes.length <= pane) panes.push({ tabs: [], active: 0 });
  const p = panes[pane];
  const i = force ? -1 : p.tabs.findIndex((t) => t.note.path === note.path);
  if (i >= 0) { p.active = i; if (secIdx) p.tabs[i].secIdx = secIdx; }
  else { p.tabs.push({ note, secIdx }); p.active = p.tabs.length - 1; }
  activePane = pane;
  syncReader();
}

/** 창을 둘로 가른다. 넘긴 노트가 없으면 지금 보던 것을 복제한다(같은 문서 비교). */
// ───────────── 옆에 뭘 뒀었는지 기억한다 (2026-10-14 요청) ─────────────
//
// "스플릿 닫았다가 다시 열면 매번 문서에서 끌어다 넣는 건 문제가 있음." 맞다.
// BLS를 보면서 BLS 암기법을 옆에 두는 식으로 **짝이 거의 정해져 있는데**, 닫을 때마다
// 그 사실을 버리고 있었다. 노트별로 "그때 옆에 뒀던 것"을 적어두고 다음에 되살린다.
const SPLIT_MEM_KEY = 'split_mem';     // { 왼쪽노트경로: [오른쪽 노트 경로…] }
let splitMem = {};
async function loadSplitMem() { splitMem = (await kvGet(SPLIT_MEM_KEY)) || {}; }

/**
 * 지금 두 창에 뭐가 떠 있는지 적어둔다 — **보던 자리까지**.
 *
 * 경로만 적어뒀더니 되살릴 때 늘 1장부터 열렸다(2026-10-14 지적). 암기법을 8장까지
 * 보다가 닫았으면 다시 열 때도 8장이어야 한다. 숫자 하나만 더 적으면 되는 일이다.
 */
function rememberSplit() {
  if (panes.length !== 2) return;
  const left = panes[0].tabs[panes[0].active] || panes[0].tabs[0];
  if (!left) return;
  // 왼쪽에 이미 있는 것은 빼둔다 — 되살릴 때 같은 문서가 두 번 뜨면 쓸모가 없다
  const here = new Set(panes[0].tabs.map((t) => t.note.path));
  const right = panes[1].tabs
    .filter((t) => !here.has(t.note.path))
    .map((t) => ({ p: t.note.path, s: t.secIdx || 0 }));
  if (!right.length) return;
  // 비율도 문서별로 기억한다(2026-10-14 요청). 표가 넓은 노트는 왼쪽을 넓게 쓰고
  // 암기법은 오른쪽을 넓게 쓰는 식으로 **문서마다 맞는 비율이 다르다**.
  const ratio = (document.documentElement.style.getPropertyValue('--pane-split')
    || localStorage.getItem('pane_split') || '').trim();
  splitMem[left.note.path] = { tabs: right.slice(0, 4), ratio };
  // 너무 쌓이지 않게 — 최근 60개 노트만
  const keys = Object.keys(splitMem);
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete splitMem[k];
  kvSet(SPLIT_MEM_KEY, splitMem).catch(() => {});
}

async function splitPane(note) {
  if (panes.length >= 2) return;
  const cur = reader;
  if (!cur && !note) return;

  // 끌어다 놓은 게 아니라 **나누기 버튼**을 누른 경우라면, 지난번에 옆에 뒀던 걸 되살린다.
  if (!note && cur) {
    // 옛 기록은 배열이거나 경로 문자열이다 — 둘 다 받아준다(쓰다 보면 저절로 새 꼴이 된다)
    const mem = splitMem[cur.note.path];
    const list = Array.isArray(mem) ? mem : (mem && mem.tabs) || [];
    const want = list.map((x) => (typeof x === 'string' ? { p: x, s: 0 } : x));
    const ratio = (mem && !Array.isArray(mem) && mem.ratio) || '';
    const tabs = [];
    for (const { p: path, s: at } of want) {
      if (path === cur.note.path) continue;
      try {
        const n2 = await loadNote(path);
        // 그사이 노트가 짧아졌을 수 있다 — 없는 장을 가리키면 처음으로
        const sec = at > 0 && at < n2.sections.length ? at : 0;
        tabs.push({ note: n2, secIdx: sec });
      } catch { /* 지워졌으면 건너뛴다 */ }
    }
    if (tabs.length) {
      // 비율을 **창을 만들기 전에** 돌려놓는다 — 반반으로 폈다가 줄어들면 한 번 더 출렁인다
      if (ratio) document.documentElement.style.setProperty('--pane-split', ratio);
      panes.push({ tabs, active: 0 });
      activePane = 1;
      syncReader();
      // ⚠️ **움직이지 않는다.** 되살리는 것은 이미 아는 모양으로 돌아가는 일이다.
      //    0.28초 동안 폭이 변하는데 그 사이 글이 다시 배치되고 그림까지 뜨면서
      //    "몇 초간 못 읽는" 상태가 됐다(2026-10-14 지적). 그냥 그 자리에 둔다.
      renderPanes();
      toast(`지난번에 옆에 뒀던 ${tabs.length}개를 띄웠습니다`);
      return;
    }
  }

  const n = note || cur.note;
  panes.push({ tabs: [{ note: n, secIdx: note ? 0 : cur.secIdx }], active: 0 });
  activePane = 1;
  syncReader();
  renderPanes({ animate: true });
  rememberSplit();
}

/** 창 하나를 닫는다(합치기). */
function closePane(idx) {
  if (panes.length < 2) return;
  rememberSplit();              // 닫기 **전에** 적어둔다 — 다음에 그대로 되살리려고
  panes.splice(idx, 1);
  activePane = 0;
  document.documentElement.style.removeProperty('--pane-split');
  syncReader();
  renderPanes();
}

/** 탭 하나를 닫는다. 창의 마지막 탭이면 창을 닫거나(둘일 때) 목록으로 나간다. */
function closeTab(paneIdx, tabIdx) {
  const p = panes[paneIdx];
  if (!p) return;
  p.tabs.splice(tabIdx, 1);
  if (!p.tabs.length) {
    if (panes.length > 1) { closePane(paneIdx); return; }
    document.getElementById('readBack').onclick();
    return;
  }
  p.active = Math.min(p.active, p.tabs.length - 1);
  if (paneIdx === activePane) syncReader();
  renderPanes();
}

/** 창 DOM을 만든다. 내용은 renderPaneBody가 채운다. */
/** 창을 누르면 그 창이 활성이 된다 — 펜·질문이 그 창을 향하게. 요소당 한 번만 붙인다. */
function bindPaneFocus(pane) {
  if (pane.__focusBound) return;
  pane.__focusBound = true;
  pane.addEventListener('pointerdown', () => {
    const pi = Number(pane.dataset.pane);
    if (activePane === pi || !panes[pi]) return;
    activePane = pi;
    syncReader();
    renderToc();
    renderPaneTabs();
    updateNavForPane();
    // 펜은 활성 창의 카드에 붙어야 한다
    if (readerPen) { readerPen.destroy(); readerPen = null; }
    ensureReaderPen();
  }, true);
}

function renderPanes({ animate = false } = {}) {
  const host = document.getElementById('readPanes');
  host.classList.toggle('two', panes.length === 2);

  // 첫 창은 HTML에 있는 것을 **재사용**한다 — 지웠다 만들면 #readBody 같은 id가
  // 잠깐 사라져서, 그걸 찾는 코드(펜·카드·질문 25곳)가 그 틈에 터진다.
  const keep = host.querySelector('.read-pane[data-pane="0"]');
  [...host.children].forEach((el) => { if (el !== keep) el.remove(); });

  panes.forEach((p, pi) => {
    const reuse = pi === 0 ? keep : null;
    const pane = reuse || document.createElement('div');
    pane.className = `read-pane${pi === activePane ? ' active' : ''}`;
    pane.dataset.pane = String(pi);
    bindPaneFocus(pane);                   // 한 번만 붙는다(재사용 창 포함)

    // 탭 줄은 창이 둘일 때만 — 하나뿐이면 보여줄 이유가 없다
    const oldTabs = pane.querySelector('.pane-tabs');
    if (oldTabs) oldTabs.remove();
    if (panes.length > 1) pane.insertBefore(buildPaneTabs(pi, p), pane.firstChild);

    if (reuse) return;                     // 본문 요소는 그대로 둔다

    const main = document.createElement('div');
    main.className = 'read-main';
    const card = document.createElement('div');
    card.className = 'card read-card';
    const head = document.createElement('div');
    head.className = 'read-heading';
    const body = document.createElement('div');
    body.className = 'wiki-body read-body';
    card.append(head, body);
    main.appendChild(card);
    pane.appendChild(main);
    // 탭 줄은 위에서 이미 넣었다 — 여기서 또 넣으면 두 줄이 된다
    // 손잡이는 두 창 **사이**에 넣는다. CSS order로 옮기면 `:last-child` 같은
    // 선택자가 손잡이를 가리키게 돼서 창 폭 규칙이 빗나간다(2026-10-13에 겪음 —
    // 손잡이가 맨 오른쪽에 붙어 끌 때 비율이 반대로 움직였다).
    if (pi === 1) host.appendChild(buildPaneResizer());
    host.appendChild(pane);
  });

  moveReaderIds();
  panes.forEach((_, pi) => renderPaneBody(pi));
  renderToc();
  updateNavForPane();
  if (animate) {
    host.classList.add('splitting');
    setTimeout(() => host.classList.remove('splitting'), 320);
  }
  // 펜은 활성 창에 다시 붙인다(카드 요소가 새로 만들어졌다)
  if (readerPen) { readerPen.destroy(); readerPen = null; }
  ensureReaderPen();
}

function buildPaneTabs(pi, p) {
  const bar = document.createElement('div');
  bar.className = 'pane-tabs pen-passthrough';
  p.tabs.forEach((t, ti) => {
    const b = document.createElement('button');
    b.className = `pane-tab${ti === p.active ? ' active' : ''}`;
    const label = document.createElement('span');
    label.className = 'pt-name';
    label.textContent = t.note.title;
    label.title = t.note.title;
    b.appendChild(label);
    const x = document.createElement('span');
    x.className = 'pt-x';
    x.textContent = '✕';
    x.title = '탭 닫기';
    x.onclick = (e) => { e.stopPropagation(); closeTab(pi, ti); };
    b.appendChild(x);
    b.onclick = () => {
      activePane = pi; p.active = ti;
      syncReader(); renderPanes();
    };
    bar.appendChild(b);
  });
  const close = document.createElement('button');
  close.className = 'pane-close';
  close.textContent = '⟷';
  close.title = '이 창 닫기(합치기)';
  close.onclick = () => closePane(pi);
  bar.appendChild(close);
  return bar;
}

/** 가운데 손잡이 — 끌어서 비율을 바꾼다. 더블탭하면 50:50. */
function buildPaneResizer() {
  const r = document.createElement('div');
  r.className = 'pane-split-resizer resize-grip';
  r.dataset.axis = window.innerWidth <= 760 ? 'y' : 'x';   // CSS의 위아래 분할 기준과 같게
  r.title = '끌어서 비율 조절 (두 번 누르면 반반)';
  r.appendChild(Object.assign(document.createElement('span'), { className: 'rg-dots' }));
  const host = document.getElementById('readPanes');
  r.addEventListener('pointerdown', (e) => {
    const box = host.getBoundingClientRect();
    // 포인터를 묶어둬야 손이 손잡이 밖으로 나가도 move가 온다. 묶을 포인터가 없으면
    // 던지는데, 거기서 멈추면 **끌기가 아예 안 된다** — 받아 넘긴다.
    try { r.setPointerCapture(e.pointerId); } catch {}
    markGripDragging(r, true);
    // 좁은 화면에서는 창이 위아래로 선다 — 그때는 세로로 민다
    const vertical = r.dataset.axis === 'y';
    const move = (ev) => {
      const ratio = vertical
        ? (ev.clientY - box.top) / box.height
        : (ev.clientX - box.left) / box.width;
      document.documentElement.style.setProperty('--pane-split',
        `${(Math.max(0.2, Math.min(0.8, ratio)) * 100).toFixed(1)}%`);
    };
    const up = () => {
      r.removeEventListener('pointermove', move);
      r.removeEventListener('pointerup', up);
      markGripDragging(r, false);
      localStorage.setItem('pane_split',
        getComputedStyle(document.documentElement).getPropertyValue('--pane-split').trim());
      if (readerPen) readerPen.resize();
    };
    r.addEventListener('pointermove', move);
    r.addEventListener('pointerup', up);
    e.preventDefault();
  });
  r.ondblclick = () => {
    document.documentElement.style.removeProperty('--pane-split');
    localStorage.removeItem('pane_split');
    // 이 문서에 기억해둔 비율도 같이 지운다 — 안 그러면 다시 열 때 되살아나서
    // "반반으로 돌려놨는데 왜 또 그 비율이지"가 된다(2026-10-14)
    const left = panes[0] && (panes[0].tabs[panes[0].active] || panes[0].tabs[0]);
    const mem = left && splitMem[left.note.path];
    if (mem && !Array.isArray(mem)) { mem.ratio = ''; kvSet(SPLIT_MEM_KEY, splitMem).catch(() => {}); }
    if (readerPen) readerPen.resize();
  };
  return r;
}

function renderPaneTabs() {
  if (panes.length < 2) return;
  document.querySelectorAll('#readPanes .read-pane').forEach((el, pi) => {
    const old = el.querySelector('.pane-tabs');
    if (old) el.replaceChild(buildPaneTabs(pi, panes[pi]), old);
  });
}

/**
 * 본문의 위키링크를 **끌 수 있게** 만든다 (2026-10-13).
 *
 * "관련 노트: [[심폐소생술]] · [[…_QA]]" 같은 줄이 노트마다 있다. 누르면 그 자리에서
 * 열리고, **끌어다 오른쪽에 놓으면 화면이 갈라진다** — 서랍에서 끄는 것과 같은 길을 탄다.
 * (Obsidian auto-split이 하는 일과 같은 발상이다.)
 */
function makeWikiLinksDraggable(root) {
  root.querySelectorAll('.wikilink').forEach((el) => {
    if (el.__dragBound) return;
    el.__dragBound = true;
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      const name = el.dataset.note;
      docDragNote = { name, path: null };            // 경로는 떨굴 때 찾는다
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', name);
      document.getElementById('readPanes').classList.add('drop-ready');
      document.body.classList.add('dragging-doc');
    });
    el.addEventListener('dragend', () => {
      docDragNote = null;
      document.body.classList.remove('dragging-doc');
      clearDropHint();
    });
    // 누르면 그 자리에서 연다 — 전에는 링크처럼 보이기만 하고 아무 일도 안 했다
    el.addEventListener('click', async () => {
      const name = el.dataset.note;
      try {
        const hit = findNoteInGroups(await noteList(false), name);
        if (!hit) { toast(`노트를 찾지 못했습니다: ${name}`); return; }
        const note = await loadNote(hit.path);
        openInPane(note, { pane: activePane });
        renderPanes();
      } catch (e) { toast(`노트를 열지 못했습니다: ${e.message}`); }
    });
  });
}

/** 한 창의 본문을 그린다. 활성 창이 아니어도 내용은 보여야 한다. */
function renderPaneBody(pi) {
  const p = panes[pi];
  const el = document.querySelector(`#readPanes .read-pane[data-pane="${pi}"]`);
  if (!p || !el) return;
  const t = p.tabs[p.active];
  const head = el.querySelector('.read-heading');
  const body = el.querySelector('.read-body');
  if (!t) { head.textContent = ''; body.innerHTML = ''; return; }
  const sec = t.note.sections[t.secIdx];
  head.textContent = sec ? sec.heading : '';
  renderSection(body, sec || { text: '' });
  tokenizeTree(body);
  makeWikiLinksDraggable(body);        // 관련 노트 링크를 끌어 나눌 수 있게
}

/** 하단 네비(이전/다음/위치)를 활성 창 기준으로 맞춘다. */
function updateNavForPane() {
  if (!reader) return;
  const { note, secIdx } = reader;
  document.getElementById('readTitle').textContent =
    panes.length > 1 ? `${note.title}  ·  ${activePane === 0 ? '왼쪽' : '오른쪽'}` : note.title;
  document.getElementById('readPos').textContent = `${secIdx + 1}/${note.sections.length}`;
  document.getElementById('readPrev').disabled = secIdx === 0;
  document.getElementById('readNext').disabled = secIdx === note.sections.length - 1;
}

/** 활성 창의 본문만 다시 그린다(섹션을 넘겼을 때). 창 구조는 renderPanes가 만든다. */
function renderReader() {
  if (!reader) return;
  rememberReadPos();
  renderToc();
  renderPaneBody(activePane);
  updateNavForPane();
  scrollReadTop();
  if (readerPen) requestAnimationFrame(() => readerPen.resize());
}

function ensureReaderPen() {
  if (readerPen) return;
  readerPen = new PenLayer(document.getElementById('readCard'), {
    onSelect: (text, info) => { if (text) openAskFromReader(text, info); },
    onCard: (box) => makeCardsFromBox(box),
    onCapture: (box) => captureFromPen(readerPen, box),
  });
  window.__penForTest = readerPen;     // 미리보기 동작을 테스트가 들여다본다
  // 카드 창도 같은 방식으로 열어볼 수 있게 둔다 — 펜 없이 화면을 세우려면 이 길이 필요하다
  window.__openCardFloat = openCardFloat;
  readerPen.setTool(penTool);   // 창을 바꿔 펜을 새로 만들어도 하던 모드가 이어진다
}

// ---------- 읽다가 바로 카드 만들기 ----------
// "이 부분 외웠나?" 싶을 때 펜으로 네모 → 그 안의 **굵게·기울임·하이라이트**가
// 빈칸이 되고 나머지 문장이 문제가 된다. 되새김질용(2026-10-10 요청).
function readerCardMode(on) { setTool(on ? 'card' : 'off'); }

// 카드 버튼 = **네모 치기 모드만** 켠다(2026-10-13). 팝업은 네모를 쳐서 후보가
// 생겼을 때만 뜬다 — 누르자마자 창이 뜨면 화면만 가린다.
// 카드를 보고 지우는 건 "카드" 메뉴(readCards)가 따로 맡는다.
document.getElementById('readMakeCard').onclick = () => setTool(penTool === 'card' ? 'off' : 'card');
document.getElementById('readCapture').onclick = () => setTool(penTool === 'shot' ? 'off' : 'shot');
document.getElementById('readShot').onclick = () => setTool(penTool === 'shot' ? 'off' : 'shot');

function makeCardsFromBox(box) {
  if (!reader) return;
  const r = readerPen.canvas.getBoundingClientRect();
  // 펜 좌표(캔버스 기준) → 뷰포트 좌표
  const vp = { l: r.left + box.l, t: r.top + box.t, r: r.left + box.r, b: r.top + box.b };
  const sec = reader.note.sections[reader.secIdx];
  const cards = cardsFromBox(document.getElementById('readBody'), vp, {
    notePath: reader.note.path,
    noteTitle: reader.note.title,
    heading: sec ? sec.heading : '',
  });
  if (!cards.length) {
    capToast('그 범위에 강조된 말이 없습니다 — **굵게**·==하이라이트== 를 덮어 보세요', 2600);
    return;
  }
  readerCardMode(false);
  // ⚠️ 여기서 저장하지 않는다 — 네모를 치는 족족 카드가 쌓이면 쓸 만한 것만 고를
  //    길이 없다(2026-10-13 요청). 창에 **후보**로 띄우고 "＋ 추가"를 눌러야 들어간다.
  openCardFloat(cards);
}

// ---- 모아두기: 공부하다 알게 된 것 (2026-10-12) ----
//
// 왜 필요한가: 문제를 풀거나 노트를 읽다 보면 "따로 찾아본 AI 답변", "어디서 본 그림"처럼
// **노트에 아직 없는 것**이 생긴다. 지금은 그걸 담아둘 자리가 없어서 흘려보내거나
// 다른 앱에 적어두고 잊는다.
//
// vault 파이프라인에 그대로 얹는다 — `00_Raw_Text/AI대화로그`는 CLAUDE.md상
// "읽기 전용 원본 소스이며 다음 /lecture-integrate 때 자동 반영 후보"다. 여기에 넣으면
// 맥에서 git pull만 해도 기존 흐름이 위키·최종정리에 알아서 흡수한다.
// 그림은 `attachments/`에 올리고 `![[파일명]]`으로 임베드한다(Obsidian 문법 그대로).

let scrapFloat = null;
let scrapShots = [];        // 붙여넣은 그림들 {name, mime, base64, url}

/** 지금 뭘 보고 있나 — 나중에 정리할 때 맥락이 있어야 쓸모가 있다. */
function scrapContext() {
  if (reader && reader.note) {
    const sec = reader.note.sections[reader.secIdx];
    return { kind: '노트', subject: reader.note.path.split('/')[1] || '',
      title: reader.note.title, where: sec ? sec.heading : '', path: reader.note.path };
  }
  if (quiz && currentExam) {
    const q = quiz.all[quiz.qIndex];
    return { kind: currentExam.kind || '모의고사', subject: currentExam.subject,
      title: currentExam.title, where: q ? `${q.num}번` : '', path: currentExam.path };
  }
  return { kind: '메모', subject: '', title: '', where: '', path: '' };
}

// 회독 단추 — 누르면 한 회독 마침, 길게 누르면 되돌린다
{
  const b = document.getElementById('readPass');
  if (b) {
    b.onclick = async () => {
      if (!(reader && reader.note)) return;
      const path = reader.note.path;
      const n = passOf(path) + 1;
      await setPass(path, n);
      toast(n === 1
        ? '1회독 마침 — 이제 담는 것은 "인출 실패"로 들어갑니다.'
        : `${n}회독 마침.`);
    };
    longPress(b, async () => {
      if (!(reader && reader.note)) return;
      const path = reader.note.path;
      const n = passOf(path);
      if (!n) { toast('아직 1회독 중입니다.'); return; }
      await setPass(path, n - 1);
      toast(n - 1 ? `${n - 1}회독으로 되돌렸습니다.` : '1회독 중으로 되돌렸습니다.');
    });
  }
}

/**
 * 담은 것을 어느 갈래로 보낼까 — 회독수가 정한다(2026-10-17 요청).
 *
 * 1회독 중이면 **처음 배우는 것**이다. 기전이 궁금해 찾아본 것을 "인출 실패"로 적으면
 * 가중치를 주는 쪽이 "이건 알았어야 하는데 못 떠올린 것"으로 읽는다 — 사실과 다르다.
 * 한 회독을 마친 뒤에 담는 것이라야 인출 실패다.
 */
function scrapBucket() {
  const ctx = scrapContext();
  // 시험을 풀다 담은 건 회독과 무관하게 인출 실패다 — 물어본 시점이 이미 인출 시도다
  if (ctx.kind && ctx.kind !== '노트' && ctx.kind !== '메모') return 'recall';
  return passOf(ctx.path) > 0 ? 'recall' : 'learn';
}
let scrapKind = null;        // 사용자가 손으로 바꾼 갈래(null이면 회독수대로)

function paintScrapKind() {
  const auto = scrapBucket();
  const pick = scrapKind || auto;
  document.querySelectorAll('#scKind .sc-k').forEach((b) => {
    b.classList.toggle('on', b.dataset.bucket === pick);
    b.onclick = () => { scrapKind = b.dataset.bucket; paintScrapKind(); };
  });
  const ctx = scrapContext();
  const n = passOf(ctx.path);
  const why = document.getElementById('scKindWhy');
  if (!why) return;
  if (scrapKind && scrapKind !== auto) why.textContent = '손으로 바꿈';
  else if (ctx.kind && ctx.kind !== '노트' && ctx.kind !== '메모') why.textContent = '문제를 풀다 담음';
  else why.textContent = n ? `${n}회독 뒤` : '1회독 중';
}

function openScrap() {
  const ctx = scrapContext();
  const w = document.getElementById('scWhere');
  w.textContent = [ctx.title, ctx.where].filter(Boolean).join('  ›  ') || '어디에도 묶이지 않은 메모';
  document.getElementById('scStatus').textContent = '';
  scrapKind = null;                     // 열 때마다 회독수대로 다시 정한다
  paintScrapKind();
  document.getElementById('scrapFloat').classList.remove('hidden');
  if (scrapFloat) scrapFloat.place();
  setTimeout(() => document.getElementById('scText').focus(), 60);
}
function closeScrap() { document.getElementById('scrapFloat').classList.add('hidden'); }

function renderShots() {
  const box = document.getElementById('scShots');
  box.innerHTML = '';
  scrapShots.forEach((sh, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'sc-shot';
    const im = document.createElement('img');
    im.src = sh.url;
    const del = document.createElement('button');
    del.className = 'sc-shot-del';
    del.textContent = '✕';
    del.title = '빼기';
    del.onclick = () => {
      URL.revokeObjectURL(scrapShots[i].url);
      scrapShots.splice(i, 1);
      renderShots();
    };
    wrap.append(im, del);
    box.appendChild(wrap);
  });
}

/** 클립보드 항목에서 그림을 꺼낸다. 붙여넣기·버튼 둘 다 여기로 온다. */
async function addShot(blob) {
  if (!blob || !/^image\//.test(blob.type)) return false;
  const buf = await blob.arrayBuffer();
  // 큰 파일은 한 번에 base64로 바꾸면 스택이 터진다 — 쪼개서 넣는다
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  scrapShots.push({
    mime: blob.type,
    ext: (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg'),
    base64: btoa(bin),
    url: URL.createObjectURL(blob),
  });
  renderShots();
  return true;
}

function initScrap() {
  scrapFloat = makeFloat({
    panel: 'scrapFloat', head: 'scHead', grip: 'scResize', key: 'scrap_float_box',
    def: { w: Math.min(560, innerWidth * 0.92), h: Math.min(520, innerHeight * 0.66) },
  });
  document.getElementById('scClose').onclick = closeScrap;

  // 붙여넣기 — 글은 그대로 들어가고, 그림은 따로 모은다.
  // **창 전체**가 받는다. 글 상자에만 걸어두면 버튼을 한 번 누른 뒤 붙여넣을 때
  // 초점이 글 상자 밖에 있어 아무 일도 안 일어난다(2026-10-13).
  document.getElementById('scrapFloat').addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgs = items.filter((it) => it.kind === 'file' && /^image\//.test(it.type));
    const ta = document.getElementById('scText');
    if (!imgs.length) {
      // 글 — 상자 안이면 브라우저 기본 동작에 맡기고, 밖이면 우리가 넣는다
      if (document.activeElement === ta) return;
      const t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!t) return;
      e.preventDefault();
      ta.value = ta.value ? `${ta.value}\n\n${t}` : t;
      document.getElementById('scStatus').textContent = `${t.length}자 붙여넣었습니다`;
      return;
    }
    e.preventDefault();
    for (const it of imgs) await addShot(it.getAsFile());
    document.getElementById('scStatus').textContent = `그림 ${scrapShots.length}장`;
  });

  // 클립보드 읽기 — 아이패드에서는 **사파리가 "붙여넣기?"를 한 번 더 묻는다**.
  // 우리가 띄우는 팝업이 아니라 OS 권한 창이라 없앨 수가 없다(2026-10-13 지적).
  // 그래서 ① 창을 열면 글 상자에 바로 초점을 둬서 **길게 눌러 붙여넣는 길**이 먼저 보이게 하고,
  //        ② 이 버튼에는 "한 번 물어봅니다"를 적어 뒀다.
  // 한 번 허용하면 잠시 동안은 안 묻는다.
  document.getElementById('scPaste').onclick = async () => {
    const st = document.getElementById('scStatus');
    try {
      const items = await navigator.clipboard.read();
      let n = 0;
      for (const it of items) {
        const type = it.types.find((t) => /^image\//.test(t));
        if (type) { await addShot(await it.getType(type)); n++; continue; }
        if (it.types.includes('text/plain')) {
          const t = await (await it.getType('text/plain')).text();
          const ta = document.getElementById('scText');
          ta.value = ta.value ? `${ta.value}\n\n${t}` : t;
          n++;
        }
      }
      st.textContent = n ? `${n}건 붙여넣었습니다` : '클립보드가 비어 있습니다';
      document.getElementById('scText').focus();
    } catch {
      st.textContent = '클립보드를 못 읽었습니다 — 글 상자를 길게 눌러 붙여넣으세요.';
      document.getElementById('scText').focus();
    }
  };

  document.getElementById('scSave').onclick = saveScrap;
}

async function saveScrap() {
  const ta = document.getElementById('scText');
  const st = document.getElementById('scStatus');
  const text = ta.value.trim();
  if (!text && !scrapShots.length) { st.textContent = '아직 아무것도 없습니다.'; return; }

  st.textContent = '저장 중…';
  const ctx = scrapContext();
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(2);
  const stamp = `${yy}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const uniq = `${stamp.replace(/-/g, '')}_${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;

  // ① 그림부터 — attachments/에 올리고 임베드 이름을 받는다
  const payloads = [];
  const embeds = [];
  scrapShots.forEach((sh, i) => {
    const name = `모아두기_${uniq}_${i + 1}.${sh.ext}`;
    payloads.push({ path: `attachments/${name}`, content: { base64: sh.base64 },
      message: `iPad 모아두기 그림: ${name}` });
    embeds.push(name);
  });

  // ② 본문 — /lecture-integrate가 읽을 수 있게 출처·맥락을 머리에 박아둔다
  const lines = ['---'];
  lines.push('출처: 아이패드 "모아두기"(공부 중 직접 수집)');
  if (ctx.subject) lines.push(`과목: ${ctx.subject}`);
  if (ctx.title) lines.push(`관련: ${ctx.title}${ctx.where ? ` · ${ctx.where}` : ''}`);
  if (ctx.path) lines.push(`원본: ${ctx.path}`);
  lines.push(`수집일시: 20${stamp} ${p2(now.getHours())}:${p2(now.getMinutes())}`);
  // 담은 것의 **성격**을 적는다 — 처음 배우는 것과 인출 실패는 가중치가 달라야 한다
  // (2026-10-17 요청: "거의 모르는 내용을 정리한건데 인출실패로 기록되는 측면이 있었음").
  const bucket = scrapKind || scrapBucket();
  const passN = passOf(ctx.path);
  if (bucket === 'recall') {
    lines.push('tags: [달모/모아두기, 달모/인출실패]');
    lines.push(`회독: ${passN || '—'}회독 뒤`);
    lines.push('처리:');
    lines.push('  위키: 대기        # 알았어야 하는데 안 떠오른 것 — 노트에서 찾기 쉽게');
  } else {
    lines.push('tags: [달모/모아두기, 달모/첫회독]');
    lines.push('회독: 1회독 중');
    lines.push('처리:');
    lines.push('  위키: 대기        # 처음 배우는 내용 — 노트에 없으면 채운다');
  }
  lines.push('---', '');
  lines.push(`# ${ctx.title || '모아둔 메모'}${ctx.where ? ` — ${ctx.where}` : ''}`, '');
  if (bucket === 'recall') {
    lines.push('> [!warning] 인출 실패 — 아는 줄 알았는데 안 나온 것');
    lines.push(`> ${passN ? `${passN}회독을 마친 뒤` : '문제를 풀다'} 막혀서 담았다.`);
    lines.push('> **이미 노트에 있는데 못 찾은 것**이면 그 자리를 찾기 쉽게 고치는 게 먼저다');
    lines.push('> (소제목·강조). 없는 내용이면 본문에 넣는다.', '');
  } else {
    lines.push('> [!note] 처음 배우는 것 — 아직 정리 안 된 수집물');
    lines.push('> **1회독 중**에 기전이 궁금해 찾아본 것이다. 몰라서 담은 게 아니라');
    lines.push('> 아직 안 배운 것이니, "인출 실패"로 세지 말 것 — 노트에 빠져 있으면 채운다.', '');
  }
  if (text) lines.push(text, '');
  embeds.forEach((n) => lines.push(`![[${n}]]`, ''));

  payloads.push({
    // 이름에 **시각까지** 넣는다 — 날짜만 쓰니 같은 날 같은 대목에서 모은 것들이
    // 서로 이름이 겹쳐 -2…-5 까지 차고 결국 "같은 이름의 파일이 너무 많습니다"로
    // 떨어졌다(2026-10-15 지적).
    path: `${LOG_DIR}/${vaultName(ctx.subject, `${stamp}_${p2(now.getHours())}${p2(now.getMinutes())}`, ctx.title, '모아두기')}`,
    content: lines.join('\n'),
    message: `iPad 모아두기: ${ctx.title || '메모'}`,
  });

  // ★ **기다리지 않는다**(2026-10-14 요청: "계속 기다려야 하는 게 에너지 쓰인다").
  //   모아두기는 거의 항상 잘 올라간다. 그런데 올라갈 때까지 창을 붙들고 서 있으니
  //   쓸 때마다 몇 초씩 멈추는 꼴이었다.
  //
  //   그래서 **바로 닫고** 보내기는 뒤에서 한다. 잘 되면 짧게 한 줄, 안 되면 그때 띄운다.
  //   실패해도 내용은 대기열에 남으므로 잃는 것이 없다 — 그래서 이렇게 할 수 있다.
  ta.value = '';
  scrapShots.forEach((sh) => URL.revokeObjectURL(sh.url));
  scrapShots = [];
  renderShots();
  closeScrap();
  toast('모아두는 중…');

  const r = await pushToVault(payloads);
  const m = vaultSaveMessage(r);
  if (r.queued.length) {
    // 안 됐을 때만 붙잡는다 — 뭘 해야 하는지 알려줘야 하니까
    alertSheet('모아두지 못했습니다', m.text, m.needSetup ? openSetup : null);
  } else {
    toast(`✓ 모아뒀습니다 (${r.saved.length}건)`);
  }
}

/**
 * 붙잡아야 할 때만 쓰는 알림창.
 *
 * 잘 되는 일은 조용히 지나가고, **안 될 때만** 멈춰 세운다(2026-10-14).
 * 토스트는 놓치기 쉬워서, 손을 써야 하는 일에는 모자란다.
 */
function alertSheet(title, body, onFix) {
  document.getElementById('alertSheet')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'alertSheet';
  wrap.className = 'sheet';
  const card = document.createElement('div');
  card.className = 'sheet-card';
  const h = document.createElement('div');
  h.className = 'sheet-head';
  const b = document.createElement('b');
  b.textContent = title;
  const x = document.createElement('button');
  x.className = 'icon-btn';
  x.textContent = '✕';
  x.onclick = () => wrap.remove();
  h.append(b, x);
  const p = document.createElement('p');
  p.className = 'muted';
  p.style.margin = '6px 0 0';
  p.textContent = body;
  card.append(h, p);
  if (onFix) {
    const foot = document.createElement('div');
    foot.className = 'sheet-foot';
    const go = document.createElement('button');
    go.className = 'btn primary';
    go.textContent = '설정 열기';
    go.onclick = () => { wrap.remove(); onFix(); };
    foot.appendChild(go);
    card.appendChild(foot);
  }
  wrap.appendChild(card);
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
}

/**
 * 노트의 체크 상자를 눌러 고른다 — 그리고 **vault 원본까지 바꾼다**(2026-10-14 요청).
 *
 * 암기법 후보가 셋 떠 있고 그중 하나를 고르는 일이 실제로 있다. 전에는 맥에서 열어
 * 손으로 고쳐야 했다. 이제 아이패드에서 눌러 정하면 그대로 올라간다.
 *
 * ⚠️ 이 저장소는 append-only가 원칙이다(노트를 덮어쓰면 옵시디언·클로드코드 편집과
 *    충돌한다). 여기서는 **그 한 줄의 `[ ]` 한 글자만** 바꾼다 — 사람이 같은 파일의
 *    다른 데를 고치고 있어도 부딪히지 않는다. 그래도 혹시 모르니 바꾸기 직전에
 *    원본을 다시 읽어 그 줄이 그대로인지 확인한다.
 */
async function toggleTask(btn) {
  const doc = currentDoc();
  if (!(doc && doc.path)) { toast('어느 노트인지 알 수 없습니다.'); return; }
  const want = btn.getAttribute('aria-checked') !== 'true';
  const label = btn.dataset.text || '';
  const nth = Number(btn.dataset.idx);        // 이 섹션에서 몇 번째 상자인가
  btn.disabled = true;
  try {
    const raw = await getTextIfExists(doc.path);
    if (raw == null) throw new Error('원본을 찾지 못했습니다.');
    const lines = raw.split('\n');

    // 원본에서 그 줄 번호를 구한다.
    //
    // ⚠️ 전에는 "소제목을 찾아 거기서부터 센다"였는데, 소제목 글자가 조금만 달라도
    //    어긋나서 "그 줄을 못 찾았습니다"가 났다(2026-10-14에 계속 실패).
    //    이제 **앞 섹션들의 상자 수를 더해** 전체에서 몇 번째인지로 바로 간다 —
    //    섹션 본문은 앱이 이미 들고 있으니 셈이 어긋날 데가 없다.
    const BOX = /^\s*[-*+]\s*\[([ xX])\]\s*(.*)$/;
    const secIdx = currentSecIdx();
    let before = 0;
    for (let k = 0; k < secIdx; k++) {
      before += (doc.sections[k].text.split('\n').filter((l) => BOX.test(l))).length;
    }
    const boxes = [];
    lines.forEach((l, k) => { if (BOX.test(l)) boxes.push(k); });

    const norm = (t) => String(t).replace(/\s+/g, ' ').trim().normalize('NFC');
    const labelOf = (k) => norm((lines[k].match(BOX) || [])[2] || '');
    const stateOf = (k) => ((lines[k].match(BOX) || [])[1] || ' ') === ' ';   // true = 비어 있음

    let at = boxes[before + nth];
    // 셈이 어긋났으면(섹션 나누기가 원본과 다를 수 있다) **글자로** 찾아본다.
    // 지금 상태가 맞는 것이 딱 하나면 그것이 분명하다.
    if (at === undefined || labelOf(at) !== norm(label) || stateOf(at) !== want) {
      const cands = boxes.filter((k) => labelOf(k) === norm(label) && stateOf(k) === want);
      if (cands.length === 1) at = cands[0];
      else if (cands.length > 1) {
        // 여러 개면 **섹션 안에서의 순서**로 고른다 — 그 섹션 몫만큼 잘라 nth 번째
        const inSec = doc.sections[secIdx].text.split('\n').filter((l) => BOX.test(l)).length;
        const slice = boxes.slice(before, before + inSec)
          .filter((k) => labelOf(k) === norm(label) && stateOf(k) === want);
        at = slice.length ? slice[Math.min(nth, slice.length - 1)] : cands[0];
      } else at = undefined;
    }
    if (at === undefined) {
      throw new Error(`"${label.slice(0, 20)}" 줄을 원본에서 못 찾았습니다 — ↻ 로 새로고침해 보세요.`);
    }

    lines[at] = lines[at].replace(/\[([ xX])\]/, want ? '[x]' : '[ ]');
    await putFile(doc.path, lines.join('\n'),
      `iPad: ${want ? '채택' : '취소'} — ${label.slice(0, 40)}`);

    btn.setAttribute('aria-checked', String(want));
    btn.textContent = want ? '☑' : '☐';
    btn.closest('.task')?.classList.toggle('done', want);
    // 앱이 들고 있는 섹션 본문도 같이 고친다 — 안 그러면 섹션을 넘겼다 오면 되돌아간다
    const sec = doc.sections[secIdx];
    if (sec) {
      let seen = -1;
      sec.text = sec.text.split('\n').map((l) => {
        if (!BOX.test(l)) return l;
        seen++;
        return seen === nth ? l.replace(/\[([ xX])\]/, want ? '[x]' : '[ ]') : l;
      }).join('\n');
    }

    if (want) await recordPick(doc, at, lines, label);
    toast(want ? '✅ 채택했습니다 — 고른 내용까지 vault로' : '선택을 풀었습니다');
  } catch (e) {
    toast(`바꾸지 못했습니다: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** 지금 보고 있는 섹션 번호 — 읽기 화면이면 그 창, 퀴즈면 옆 패널. */
function currentSecIdx() {
  if (document.body.dataset.screen === 'readScreen' && reader) return reader.secIdx;
  return (wikiState && wikiState.secIdx) || 0;
}

/**
 * 고른 것을 **통째로** 적어 둔다.
 *
 * 체크 한 글자만 바뀌면 vault 쪽이 "무엇을 왜 골랐는지"를 노트 전체를 읽어 되짚어야 한다.
 * 고른 덩어리(앞의 소제목부터 그 체크 줄까지)를 그대로 떠서 AI대화로그에 남기면,
 * /lecture-integrate가 바로 집어 위키 본문에 녹일 수 있다.
 */
async function recordPick(doc, lineIdx, lines, label) {
  // 이 선택이 속한 덩어리 — 바로 위의 소제목·번호 항목부터 체크 줄까지
  let top = lineIdx;
  while (top > 0 && !/^(#{1,6}\s|\s*\d+[.)]\s|\s*[-*+]\s*\*\*|\s*\*\*\[)/.test(lines[top - 1])
         && lines[top - 1].trim() !== '') top--;
  while (top > 0 && lines[top - 1].trim() !== '' && !/^#{1,6}\s/.test(lines[top - 1])) top--;
  const chunk = lines.slice(top, lineIdx + 1).join('\n').trim();

  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${String(now.getFullYear()).slice(2)}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const subject = (doc.path.split('/')[1] || '').replace(/_/g, '_');

  const L = [];
  L.push('---');
  L.push(`출처: 아이패드에서 고름 (${doc.path})`);
  if (subject) L.push(`과목: ${subject}`);
  L.push(`원본노트: "[[${(doc.title || '').replace(/\.md$/, '')}]]"`);
  L.push(`고른항목: ${JSON.stringify(label)}`);
  L.push(`고른줄: ${lineIdx + 1}`);
  L.push(`시각: 20${stamp} ${p2(now.getHours())}:${p2(now.getMinutes())}`);
  L.push('tags: [달모/채택]');
  L.push('처리:');
  L.push('  위키: 대기        # 고른 안을 본문에 녹일 것');
  L.push('---', '');
  L.push(`# ${doc.title} — 채택한 안`, '');
  L.push('> [!check] 아이패드에서 이것을 골랐다');
  L.push('> 아래가 고른 덩어리 전문이다. 원본 노트의 해당 줄도 `[x]`로 바뀌어 있다.');
  L.push('> `/lecture-integrate`가 이 내용을 위키 본문에 녹인 뒤 `위키:` 줄을 닫는다.', '');
  L.push(chunk || `(덩어리를 못 떴다 — 원본 ${doc.path} 의 ${lineIdx + 1}번째 줄)`);
  L.push('');

  await saveToVault([{
    path: `${LOG_DIR}/${vaultName(subject, `${stamp}_${p2(now.getHours())}${p2(now.getMinutes())}`, doc.title, '채택')}`,
    content: L.join('\n'),
    message: `iPad 채택: ${doc.title || '노트'} — ${label.slice(0, 30)}`,
  }]);
}

// 본문·옆 패널 어디서 눌러도 같은 길로
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.task-box');
  if (b) { e.preventDefault(); toggleTask(b); }
});

document.getElementById('readScrap').onclick = openScrap;
// 모아두기는 어느 화면에서든 핵심이다 — 메뉴 안에 두지 않는다(2026-10-14 요청)
document.getElementById('readScrapBtn').onclick = openScrap;
document.getElementById('toolScrap').onclick = openScrap;

// ---- 만든 카드 미리보기 창 (2026-10-12) ----
// 네모 한 번에 보통 1~4장이 나온다. 뭐가 만들어졌는지 눈으로 보고 넘어가야
// "이게 외울 만한 카드인가"를 바로 판단할 수 있다.
let cardFloat = null;
let cfDeck = null;          // {cards, idx, shown} — 아직 저장 안 된 후보
let cfTab = 'new';          // 'new' | 'all'
let cfSaved = [];           // 이 노트에 이미 저장된 카드
// 오래 눌러 고른 카드들 — 한 번에 지우려고 (2026-10-15 요청)
let cfSel = new Set();

function openCardFloat(cards) {
  cfDeck = { cards: cards || [], idx: 0, shown: false };
  cfTab = cfDeck.cards.length ? 'new' : 'all';
  document.getElementById('cardFloat').classList.remove('hidden');
  if (cardFloat) cardFloat.place();
  refreshCardFloat();
}
function closeCardFloat() {
  document.getElementById('cardFloat').classList.add('hidden');
  cfDeck = null;
}

/** 이 노트에 저장된 카드를 다시 읽고 전체를 그린다. */
async function refreshCardFloat() {
  try {
    const all = await allCards();
    const path = reader && reader.note ? reader.note.path : '';
    cfSaved = all.filter((c) => c.notePath === path);
  } catch { cfSaved = []; }
  renderCardFloat();
}

function renderCardFloat() {
  const nNew = cfDeck ? cfDeck.cards.length : 0;
  document.getElementById('cfNewN').textContent = String(nNew);
  document.getElementById('cfAllN').textContent = String(cfSaved.length);
  document.getElementById('cfTabNew').classList.toggle('active', cfTab === 'new');
  document.getElementById('cfTabAll').classList.toggle('active', cfTab === 'all');
  document.getElementById('cfBody').classList.toggle('hidden', cfTab !== 'new');
  document.getElementById('cfList').classList.toggle('hidden', cfTab !== 'all');
  // 고르는 중에는 "외우기" 대신 고르기 단추가 선다
  const picking = cfTab === 'all' && cfSel.size > 0;
  document.getElementById('cfFootNew').classList.toggle('hidden', cfTab !== 'new');
  document.getElementById('cfFootAll').classList.toggle('hidden', cfTab !== 'all' || picking);
  document.getElementById('cfFootSel').classList.toggle('hidden', !picking);
  if (picking) document.getElementById('cfSelDel').textContent = `지우기 ${cfSel.size}장`;
  if (cfTab === 'new') renderCfNew(); else renderCfList();
}

/**
 * 카드 본문의 낱말을 **눌러서** 빈칸으로 만들거나 되돌린다 (2026-10-14 요청).
 *
 * "추천 빈칸 및 카드 좋은데 … 내가 빈칸을 선택하고 싶다니까? 표나 문장 같은 게 나왔을 때
 *  글자를 쭉 띄워놓고 내가 툭툭 누르는 식으로"
 *
 * 추천은 그대로 두고 **고칠 길만** 연다. 표도 문장과 똑같이 칸마다 낱말이 되므로
 * 표 카드에서도 그대로 쓸 수 있다.
 */
/**
 * 편집용 껍데기를 벗긴 본문 HTML.
 *
 * 낱말을 누를 수 있게 하려고 글자마다 `<span class="cf-w">`를 씌우는데, 이걸 **그대로
 * 저장하면** 다음에 그릴 때 그 위에 또 씌워진다. `.cf-w`에는 좌우 2px 여백이 있어서
 * 누를 때마다 낱말 사이가 4px씩 벌어졌다(2026-10-16 신고: "같은 단어를 계속 누르면
 * 점점 글자 간격이 벌어지는데?"). 글자로 지우려 했던 정규식은 껍데기가 겹치면 못 벗긴다.
 * 사본을 떠서 **요소째로** 벗긴다 — 몇 겹이 쌓여 있어도 확실하다.
 */
function cleanPickHtml(root) {
  const c = root.cloneNode(true);
  c.querySelectorAll('span.cf-w').forEach((el) => el.replaceWith(...el.childNodes));
  // 편집 중에만 쓰는 표시는 **전부** 턴다. 하나라도 남으면 다음에 그릴 때 "이미 손잡이를
  // 걸어뒀다"고 잘못 읽어 네모를 못 지우게 된다(2026-10-16에 실제로 그랬다).
  c.querySelectorAll('.pickable, .drawing').forEach((el) => {
    el.classList.remove('pickable', 'drawing');
  });
  c.querySelectorAll('[data-io-ready]').forEach((el) => el.removeAttribute('data-io-ready'));
  c.querySelectorAll('.io-word').forEach((el) => el.remove());   // 글자 추천 칸은 편집 중에만
  c.normalize();
  return c.innerHTML;
}

/**
 * 카드 본문을 그린다 — 정돈하고 **그림까지 불러온다**.
 *
 * 카드 HTML에는 `<img class="embed" data-embed="파일명">`이 src 없이 들어 있다
 * (markdown.js가 그렇게 찍고, 나중에 채우는 구조다). 그런데 카드를 그리는 네 군데가
 * 전부 innerHTML만 꽂고 끝냈다 — 그래서 **카드에 그림이 영영 안 떴다**
 * (2026-10-16 신고: "카드만들기도 그림이 안들어감"). 한 곳으로 모아 같이 처리한다.
 */
function setCardBody(el, html) {
  el.innerHTML = tidyCardHtml(html || '');
  hydrateEmbeds(el, (name) => getBlobUrl(`attachments/${name}`)).catch(() => {});
  return el;
}

/**
 * 고친 화면을 카드에 반영한다 — **답은 본문에서 읽어온다**.
 *
 * 전에는 답 목록을 따로 더하고 뺐는데, 빼는 쪽이 `filter(x => x !== ans)` 였다.
 * 같은 말이 두 군데 빈칸이면(`아트로핀 … 아트로핀`) 하나만 풀어도 **답이 둘 다** 날아가,
 * 본문에는 빈칸이 하나 남았는데 답은 0개가 됐다(2026-10-16 점검). 본문이 곧 답이므로
 * 매번 본문에서 다시 읽는다 — 어긋날 길이 없다.
 */
function syncCardFromDom(root, card) {
  card.contextHtml = cleanPickHtml(root);
  card.answers = [...root.querySelectorAll('.cloze')]
    .map((el) => el.dataset.answer || '')
    .filter(Boolean);
  // 그림을 가린 네모는 **글 답이 아니다** — 답 목록에 넣으면 "(그림)"만 늘어선다.
  // 대신 개수를 들고 있어 "물어볼 게 있는 카드인가"를 판단할 때 센다.
  card.masks = root.querySelectorAll('.io-mask').length;
}

/**
 * 그림 위에 네모를 쳐서 가린다 — 이른바 image occlusion (2026-10-16 요청).
 *
 * 왜 글자 인식(OCR)보다 이게 먼저인가: vault 그림을 24장 표본으로 재어 보니 **17장이
 * 글자가 아예 없었다**(사진·x-ray·해부 그림). 그런 그림에서 OCR은 할 일이 없지만
 * 네모는 전부 통한다. 해부·영상 카드가 원래 이 꼴이다.
 *
 * 자리는 **비율**로 적는다(0~100%). 화면 폭이 바뀌거나 그림이 줄어도 그대로 따라간다.
 * 가린 자리는 글 빈칸과 **같은 상태**를 쓴다(.filled) — "답 보기"가 둘을 같이 벗긴다.
 */
// ── 그림 속 글자 (애플 Vision 곁다리 · 2026-10-16) ──
//
// 맥에서 `tools/ocr/run.sh`가 미리 읽어 `attachments/.ocr/<이름>.json`에 적어둔 것을
// 그대로 쓴다. **앱은 글자 인식을 하지 않는다** — 그래서 앱이 하나도 안 무거워진다.
// (Tesseract.js는 한글 학습데이터만 15MB라 뺐고, 애플 Live Text는 웹에서 부를 길이 없다.)
//
// vault 1,307장을 돌려보니 79%에서 믿을 만한 글자가 나왔다(14,585줄). 다만 빽빽한
// 도표는 엉뚱하게 읽으므로 **conf 0.9 미만은 숨긴다**.
const OCR_MIN = 0.9;
const ocrCache = new Map();
function loadOcr(name) {
  if (ocrCache.has(name)) return ocrCache.get(name);
  const task = getText(`attachments/.ocr/${name}.json`)
    .then((t) => {
      const d = JSON.parse(t);
      return (d.lines || []).filter((l) => l.conf >= OCR_MIN && String(l.t).trim());
    })
    .catch(() => []);            // 곁다리가 없으면 조용히 넘어간다(손으로 네모 치면 된다)
  ocrCache.set(name, task);
  return task;
}

/** 그림 위에 **눌러서 가릴 수 있는 글자 칸**을 얹는다. 곁다리가 있을 때만. */
async function addOcrWords(wrap, im, root, card) {
  const name = im.dataset.embed;
  if (!name) return;
  const lines = await loadOcr(name);
  if (!lines.length || !wrap.isConnected) return;
  for (const l of lines) {
    const w = document.createElement('span');
    w.className = 'io-word';
    w.style.left = `${(l.x * 100).toFixed(2)}%`;
    w.style.top = `${(l.y * 100).toFixed(2)}%`;
    w.style.width = `${(l.w * 100).toFixed(2)}%`;
    w.style.height = `${(l.h * 100).toFixed(2)}%`;
    w.title = l.t;
    w.onclick = (e) => {
      e.stopPropagation();
      const m = document.createElement('span');
      m.className = 'io-mask';
      m.dataset.answer = l.t;          // 읽어낸 글이 곧 답이다
      for (const k of ['left', 'top', 'width', 'height']) m.style[k] = w.style[k];
      w.replaceWith(m);
      bindMask(m, wrap, card);
      syncCardFromDom(root, card);
      renderCfNew();
    };
    wrap.appendChild(w);
  }
}

const ioBound = new WeakSet();     // 손잡이를 건 상자 — HTML에 적지 않는다
function makeImagesOccludable(root, card) {
  for (const im of root.querySelectorAll('img')) {
    const wrap = ensureOcclusionWrap(im);
    if (!wrap || ioBound.has(wrap)) continue;
    ioBound.add(wrap);

    // 이미 쳐둔 네모 — 누르면 지운다
    wrap.querySelectorAll('.io-mask').forEach((m) => bindMask(m, wrap, card));
    // 맥에서 읽어둔 글자가 있으면 **눌러서 가릴 수 있게** 얹는다(없으면 조용히 넘어간다)
    addOcrWords(wrap, im, root, card).catch(() => {});

    let box = null;
    let from = null;
    const pos = (e) => {
      const r = im.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
    };
    const clamp = (v) => Math.max(0, Math.min(100, v));

    wrap.addEventListener('pointerdown', (e) => {
      if (e.target.classList && e.target.classList.contains('io-mask')) return;  // 지우려는 것
      if (e.button > 0) return;
      from = pos(e);
      box = document.createElement('span');
      box.className = 'io-mask drawing';
      wrap.appendChild(box);
      try { wrap.setPointerCapture(e.pointerId); } catch { /* 안 되는 기기도 있다 */ }
      e.preventDefault();
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!box || !from) return;
      const p = pos(e);
      box.style.left = `${clamp(Math.min(from.x, p.x))}%`;
      box.style.top = `${clamp(Math.min(from.y, p.y))}%`;
      box.style.width = `${Math.abs(clamp(p.x) - clamp(from.x))}%`;
      box.style.height = `${Math.abs(clamp(p.y) - clamp(from.y))}%`;
      e.preventDefault();
    });
    const done = () => {
      if (!box) return;
      const w = parseFloat(box.style.width) || 0;
      const h = parseFloat(box.style.height) || 0;
      box.classList.remove('drawing');
      // 손가락이 미끄러진 정도는 네모가 아니다
      if (w < 2 || h < 2) box.remove();
      else { bindMask(box, wrap, card); syncCardFromDom(root, card); renderCfNew(); }
      box = null;
      from = null;
    };
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) wrap.addEventListener(t, done);
  }
}

/** 그림을 네모 담는 상자로 감싼다(이미 감싸져 있으면 그대로). */
function ensureOcclusionWrap(im) {
  const had = im.parentElement;
  if (had && had.classList && had.classList.contains('io-wrap')) return had;
  if (!im.parentElement) return null;
  const wrap = document.createElement('span');
  wrap.className = 'io-wrap';
  im.replaceWith(wrap);
  wrap.appendChild(im);
  return wrap;
}

/** 네모 하나 — 누르면 지운다. */
function bindMask(m, wrap, card) {
  m.classList.add('pickable');
  m.onclick = (e) => {
    e.stopPropagation();
    const root = wrap.closest('.cf-q') || wrap.parentElement;
    m.remove();
    syncCardFromDom(root, card);
    renderCfNew();
  };
}

function makeWordsTappable(root, card) {
  makeImagesOccludable(root, card);
  // ① 이미 빈칸인 것 — 누르면 되돌린다
  root.querySelectorAll('.cloze').forEach((el) => {
    el.classList.add('pickable');
    el.onclick = (e) => {
      e.stopPropagation();
      el.replaceWith(document.createTextNode(el.dataset.answer || ''));
      syncCardFromDom(root, card);
      renderCfNew();
    };
  });

  // ② 아직 글자인 것 — 낱말마다 눌릴 수 있게 감싼다
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (n.parentElement && n.parentElement.closest('.cloze')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const texts = [];
  let n;
  while ((n = walk.nextNode())) texts.push(n);
  for (const node of texts) {
    const frag = document.createDocumentFragment();
    for (const piece of node.nodeValue.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) { frag.appendChild(document.createTextNode(piece)); continue; }
      const w = document.createElement('span');
      w.className = 'cf-w';
      w.textContent = piece;
      w.onclick = (e) => {
        e.stopPropagation();
        w.replaceWith(blankSpan(piece));
        syncCardFromDom(root, card);
        renderCfNew();
      };
      frag.appendChild(w);
    }
    node.replaceWith(frag);
  }
}

/**
 * 빈칸을 가리거나 드러낸다.
 *
 * **글자를 갈아끼우지 않는다** — 답은 처음부터 `<i>` 안에 들어 있고 숨겨져만 있다
 * (reader.js blankNode). class 하나만 뒤집으니 폭이 안 변하고, 그래서 답을 볼 때
 * 뒷글이 밀리지 않는다(2026-10-15 지적). 옛 카드처럼 `<i>`가 없으면 그때만 넣어준다.
 */
function paintCloze(root, shown) {
  root.querySelectorAll('.cloze').forEach((el) => {
    fixOldBlank(el);
    el.classList.toggle('filled', !!shown);
  });
  // 그림을 가린 네모도 같이 벗긴다 — 글 빈칸과 한 손짓으로 열려야 한다
  root.querySelectorAll('.io-mask').forEach((el) => el.classList.toggle('filled', !!shown));
}

/** 옛 카드의 빈칸(공백만 든 것)을 지금 모양으로 바꾼다 — 폭이 안 변하게. */
function fixOldBlank(el) {
  if (el.querySelector('i')) return;
  const t = document.createElement('i');
  t.textContent = el.dataset.answer || '';
  el.textContent = '';
  el.appendChild(t);
}

function renderCfNew() {
  const body = document.getElementById('cfBody');
  body.innerHTML = '';
  if (!cfDeck || !cfDeck.cards.length) {
    document.getElementById('cfStatus').textContent = '';
    body.appendChild(muted('펜으로 네모를 치면 그 범위로 카드 후보가 만들어집니다.'));
    ['cfPrev', 'cfNext', 'cfReveal', 'cfAdd', 'cfDrop'].forEach((id) => {
      document.getElementById(id).disabled = true;
    });
    return;
  }
  const { cards, idx, shown } = cfDeck;
  const c = cards[idx];
  document.getElementById('cfStatus').textContent = `${idx + 1}/${cards.length} · 아직 저장 안 됨`;

  if (c.topic) {
    const t = document.createElement('div');
    t.className = 'cf-topic';
    t.textContent = c.topic;
    body.appendChild(t);
  }
  const q = document.createElement('div');
  q.className = 'cf-q cf-pick';
  setCardBody(q, c.contextHtml);
  // 옛 카드에 껍데기가 묻어 있을 수 있다 — 씌우기 전에 한 번 벗긴다
  q.querySelectorAll('span.cf-w').forEach((el) => el.replaceWith(...el.childNodes));
  q.normalize();
  makeWordsTappable(q, c);        // 낱말을 눌러 빈칸을 더하고 뺀다(2026-10-14 요청)
  paintCloze(q, shown);
  body.appendChild(q);
  const hint = document.createElement('div');
  hint.className = 'cf-hint muted';
  hint.textContent = q.querySelector('img')
    ? '낱말을 눌러 가립니다 · 그림은 끌어서 네모로 가립니다 — 누르면 다시 보입니다.'
    : '낱말을 눌러 직접 가릴 수 있습니다 — 빈칸을 누르면 다시 보입니다.';
  body.appendChild(hint);
  if (shown && (c.answers || []).length) {
    const a = document.createElement('div');
    a.className = 'cf-a';
    a.textContent = (c.answers || []).join('  /  ');
    body.appendChild(a);
  }
  const one = cards.length <= 1;
  document.getElementById('cfPrev').disabled = one || idx === 0;
  document.getElementById('cfNext').disabled = one || idx === cards.length - 1;
  ['cfReveal', 'cfAdd', 'cfDrop'].forEach((id) => { document.getElementById(id).disabled = false; });
  document.getElementById('cfReveal').textContent = shown ? '답 가리기' : '답 보기';
}

/** 이 노트에 저장된 카드 — 여기서 지운다. 카드 관리 화면까지 안 가도 되게(2026-10-13). */
function renderCfList() {
  const list = document.getElementById('cfList');
  list.innerHTML = '';
  document.getElementById('cfStatus').textContent =
    reader && reader.note ? reader.note.title : '';
  if (!cfSaved.length) {
    list.appendChild(muted('이 노트에서 만든 카드가 아직 없습니다.'));
    document.getElementById('cfStudy').disabled = true;
    return;
  }
  document.getElementById('cfStudy').disabled = false;
  // 지워진 카드가 고른 목록에 남아 있지 않게
  const live = new Set(cfSaved.map((c) => c.id));
  [...cfSel].forEach((id) => { if (!live.has(id)) cfSel.delete(id); });
  const picking = cfSel.size > 0;
  list.classList.toggle('picking', picking);

  cfSaved.forEach((c) => {
    const row = document.createElement('div');
    row.className = `cf-row${cfSel.has(c.id) ? ' picked' : ''}`;
    const main = document.createElement('div');
    main.className = 'cf-row-main';
    const top = document.createElement('div');
    top.className = 'cf-row-topic';
    top.textContent = c.topic || c.heading || '';
    const q = document.createElement('div');
    q.className = 'cf-row-q';
    setCardBody(q, c.contextHtml);
    paintCloze(q, false);
    main.append(top, q);
    // 고르는 중이면 누르는 건 **고르기**, 아니면 답 들추기
    main.onclick = () => {
      if (cfSel.size) { toggleCfPick(c.id); return; }
      const on = q.classList.toggle('shown');
      paintCloze(q, on);
    };
    longPress(main, () => toggleCfPick(c.id));
    const del = document.createElement('button');
    del.className = 'cf-del';
    del.textContent = '✕';
    del.title = '이 카드 지우기';
    del.onclick = async (e) => {
      e.stopPropagation();
      await deleteCardsUndoable(c, refreshCardFloat);
    };
    row.append(main, del);
    list.appendChild(row);
  });
}

function toggleCfPick(id) {
  if (cfSel.has(id)) cfSel.delete(id); else cfSel.add(id);
  renderCardFloat();
}

/**
 * 오래 누르면 고르기 (2026-10-15 요청: "오래 누르기 하면 선택되면서 한번에 지우고").
 *
 * 손가락·펜은 꾹 눌러야 시작한다 — 바로 켜면 목록을 넘길 수가 없다. 그래서 움직이면
 * (스크롤하려는 것이므로) 포기한다. 마우스는 오른쪽 단추로도 켤 수 있게 둔다.
 * 켜진 뒤에는 그냥 눌러도 골라진다(위 main.onclick) — 여러 장을 집을 때 편하다.
 */
const LONG_MS = 420;
const LONG_SLOP = 10;
const LONG_EAT = 700;      // 길게 누른 직후 **이 안에** 오는 click만 삼킨다
function longPress(el, fn) {
  let timer = null;
  let at = null;
  let firedAt = 0;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    firedAt = 0;              // 새로 누르는 순간 지난 자국은 지운다
    at = { x: e.clientX, y: e.clientY };
    stop();
    timer = setTimeout(() => {
      timer = null;
      firedAt = Date.now();
      fn();
    }, LONG_MS);
  });
  el.addEventListener('pointermove', (e) => {
    if (at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > LONG_SLOP) stop();
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, stop);
  // ⚠️ 깃발을 세워두고 **다음 click에서 내리는** 방식이면 안 된다. 손가락으로 길게 누르면
  //    뒤따르는 click이 **아예 안 온다** — 깃발이 그대로 남아 그다음 진짜 탭을 삼킨다
  //    (2026-10-16 점검에서 재현: 길게 누른 뒤 보통 탭이 안 먹혔다). 시각으로 재서
  //    바로 뒤에 온 click만 삼키고, 늦게 온 것은 그냥 보낸다.
  el.addEventListener('click', (e) => {
    if (firedAt && Date.now() - firedAt < LONG_EAT) {
      firedAt = 0;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(); });
}

function initCardFloat() {
  cardFloat = makeFloat({
    panel: 'cardFloat', head: 'cfHead', grip: 'cfResize', key: 'card_float_box',
    def: { w: Math.min(560, innerWidth * 0.92), h: Math.min(470, innerHeight * 0.6) },
  });
  document.getElementById('cfClose').onclick = closeCardFloat;
  // 읽기 화면을 거치지 않고도 검사가 카드 창을 열 수 있게 — 펜이 설 때(ensureReaderPen)만
  // 걸어두면 "노트를 먼저 열어야만" 검사가 된다
  window.__openCardFloat = openCardFloat;
  document.getElementById('cfTabNew').onclick = () => { cfTab = 'new'; cfSel.clear(); renderCardFloat(); };
  document.getElementById('cfTabAll').onclick = () => { cfTab = 'all'; refreshCardFloat(); };

  // 오래 눌러 고른 카드들 — 한 번에 지운다(되돌리기도 한 번에)
  document.getElementById('cfSelAll').onclick = () => {
    if (cfSel.size === cfSaved.length) cfSel.clear();
    else cfSaved.forEach((c) => cfSel.add(c.id));
    renderCardFloat();
  };
  document.getElementById('cfSelNone').onclick = () => { cfSel.clear(); renderCardFloat(); };
  document.getElementById('cfSelDel').onclick = async () => {
    const gone = cfSaved.filter((c) => cfSel.has(c.id));
    if (!gone.length) return;
    cfSel.clear();
    await deleteCardsUndoable(gone, refreshCardFloat);
  };

  document.getElementById('cfPrev').onclick = () => {
    if (cfDeck && cfDeck.idx > 0) { cfDeck.idx--; cfDeck.shown = false; renderCfNew(); }
  };
  document.getElementById('cfNext').onclick = () => {
    if (cfDeck && cfDeck.idx < cfDeck.cards.length - 1) { cfDeck.idx++; cfDeck.shown = false; renderCfNew(); }
  };
  document.getElementById('cfReveal').onclick = () => {
    if (cfDeck) { cfDeck.shown = !cfDeck.shown; renderCfNew(); }
  };

  // 후보 중 지금 것만 버린다 — 네모 한 번에 여러 장이 나오는데 쓸 만한 건 보통 한둘이다
  document.getElementById('cfDrop').onclick = () => {
    if (!cfDeck || !cfDeck.cards.length) return;
    cfDeck.cards.splice(cfDeck.idx, 1);
    cfDeck.idx = Math.min(cfDeck.idx, Math.max(0, cfDeck.cards.length - 1));
    cfDeck.shown = false;
    if (!cfDeck.cards.length) { cfTab = 'all'; refreshCardFloat(); return; }
    renderCardFloat();
  };

  // ＋ 추가 — 여기서 비로소 저장된다
  document.getElementById('cfAdd').onclick = async () => {
    if (!cfDeck || !cfDeck.cards.length) return;
    const c = cfDeck.cards[cfDeck.idx];
    try {
      await saveCards([c]);
      backup.scheduleBackup();
      toast('카드를 추가했습니다.');
    } catch (e) { toast(`저장하지 못했습니다: ${e.message}`); return; }
    cfDeck.cards.splice(cfDeck.idx, 1);
    cfDeck.idx = Math.min(cfDeck.idx, Math.max(0, cfDeck.cards.length - 1));
    cfDeck.shown = false;
    if (!cfDeck.cards.length) cfTab = 'all';
    refreshCardFloat();
  };

  document.getElementById('cfStudy').onclick = () => {
    if (!cfSaved.length) return;
    const cards = cfSaved.slice();
    closeCardFloat();
    startDeck(cards, reader ? reader.note.title : '카드', { backTo: 'reader' });
  };
}

/** "카드" 메뉴 — 이 노트의 카드를 보고 지운다(만들기는 연필 네모 버튼이 따로 맡는다). */
function openCardManager() {
  if (!cfDeck) cfDeck = { cards: [], idx: 0, shown: false };
  cfTab = cfDeck.cards.length ? 'new' : 'all';
  document.getElementById('cardFloat').classList.remove('hidden');
  if (cardFloat) cardFloat.place();
  refreshCardFloat();
}

/** 카드 묶음을 띄운다. 돌아갈 곳을 기억해 읽던 자리로 복귀한다. */
async function startDeck(cards, title, { backTo = 'list' } = {}) {
  const srsNow = await loadSrs();
  if (!deckView.exam) deckView.exam = (await kvGet('next_exam')) || null;
  // 중요 → 자주 틀림 → 복습 기한 → 새 카드 순으로. 버린 것·오늘 미룬 것은 빠진다.
  const queue = studyQueue(cards, srsNow);
  if (!queue.length) {
    toast('풀 카드가 없습니다 — 전부 버렸거나 오늘은 미뤘습니다.');
    return;
  }
  cardDeck = { cards: queue, idx: 0, srs: srsNow, title, all: cards, backTo,
    noteTitle: cards[0] ? cards[0].noteTitle : '' };
  show('cardScreen');
  renderCard();
}

document.getElementById('readBack').onclick = () => {
  if (readerPen) { readerPen.destroy(); readerPen = null; }
  keepAwake(false);
  panes = [];
  activePane = 0;
  reader = null;
  show('listScreen');
};
document.getElementById('readPrev').onclick = () => {
  if (reader && reader.secIdx > 0) { reader.secIdx--; renderReader(); }
};
document.getElementById('readNext').onclick = () => {
  if (reader && reader.secIdx < reader.note.sections.length - 1) { reader.secIdx++; renderReader(); }
};
// 펜 버튼 — 누를 때마다 **펜 → 지우개 → 끔**으로 돈다(2026-10-13).
//
// 전에는 "펜은 항상 켜져 있고 이 버튼은 지우개 토글"이었다. 버튼 모양이 늘 펜이라
// 지금 뭐가 켜져 있는지 알 수 없었고, 펜을 아예 끄는 길도 없었다.
// 이제 **아이콘이 지금 모드를 보여준다** — 지우개면 지우개 모양으로 바뀐다.
// ⚠️ "끔" 상태를 뒀더니 두 번 눌러 꺼진 줄 모르고 **선택이 안 되는 것처럼** 보였다
//    (2026-10-13 — "펜으로 범위 지정이 갑자기 안 된다"). 읽기 모드에서 펜의 주 기능은
//    긁어서 고르는 것이라, 끄면 화면이 죽은 것처럼 느껴진다. 펜 ↔ 지우개 둘만 돈다.

/**
 * 펜이 지금 할 일을 정한다 — **앱 전체가 한 군데서** 정한다(2026-10-14 재설계).
 *
 * 전에는 깃발이 셋(erasing·capturing·carding)이고 켜는 함수가 제각각이라,
 * 한쪽을 끄면 다른 쪽이 조용히 꺼졌다. 그래서 "카드 만들기를 켜고 네모를 쳤는데
 * 선택 팝업이 뜨는" 일이 생겼다. 이제 상태는 `penTool` 하나다.
 *
 *   select  긁으면 글이 잡힌다(기본)   write  그리면 손글씨
 *   erase   지나가면 지워진다          card   네모 → 카드
 *   shot    네모 → 그림으로 복사
 *
 * 읽기 화면과 퀴즈 화면이 같은 상태를 쓴다 — 화면을 옮겨도 하던 모드가 유지된다.
 */
let penTool = 'select';

/** 버튼 짝: [도구, 읽기화면 버튼, 퀴즈화면 버튼] */
const TOOL_BTNS = [
  ['off', 'readOff', 'toolOff'],
  ['select', 'readSelect', 'toolSelect'],
  ['write', 'readPen', 'toolWrite'],
  ['erase', 'readPen', 'toolErase'],
  ['card', 'readMakeCard', null],
  ['shot', 'readShot', 'toolCapture'],
];

const TOOL_SAY = {
  off: '일반 — 펜이 아무것도 안 합니다',
  select: '고르기 — 긁으면 글이 잡힙니다',
  write: '필기 — 그리면 손글씨로 남습니다',
  erase: '지우개 — 손글씨 위를 지나가면 지워집니다',
  card: '카드 만들기 — 네모를 치면 그 범위로 카드를 만듭니다',
  shot: '영역 복사 — 네모를 치면 그림으로 복사됩니다',
};

function setTool(tool, { quiet = false } = {}) {
  penTool = TOOL_SAY[tool] ? tool : 'select';
  for (const p of [readerPen, pen]) if (p) p.setTool(penTool);

  // 버튼 표시 — 켜진 것 하나만 밝다
  const on = (id, yes) => { const el = document.getElementById(id); if (el) el.classList.toggle('active', yes); };
  on('readOff', penTool === 'off');
  on('toolOff', penTool === 'off');
  on('readSelect', penTool === 'select');
  on('toolSelect', penTool === 'select');
  on('readPen', penTool === 'write' || penTool === 'erase');
  on('toolWrite', penTool === 'write');
  on('toolErase', penTool === 'erase');
  on('readMakeCard', penTool === 'card');
  on('readShot', penTool === 'shot');
  on('readCapture', penTool === 'shot');
  on('toolCapture', penTool === 'shot');
  // 네모를 치는 도구(영역 복사·카드)에서는 **칸 크기 손잡이를 재운다**.
  // 네모를 그리다 패널 경계를 지나면 손잡이가 깨어나 굵어지고, 거기서 손을 대면
  // 네모 대신 칸 폭이 끌렸다(2026-10-15 지적). 영역 복사는 보이는 그대로를 뜨는
  // 일이므로 **그동안은 아무것도 끼어들지 않아야** 한다 — 손잡이는 그려진 모습
  // 그대로 그림에 들어가면 된다. (pointer-events는 아래 CSS가 끈다.)
  const boxing = penTool === 'shot' || penTool === 'card';
  document.body.classList.toggle('boxing', boxing);
  if (boxing) document.querySelectorAll('.resize-grip.near').forEach((g) => g.classList.remove('near'));

  // 펜 버튼은 지금 지우개인지 아이콘으로 보여준다
  document.getElementById('readPen')?.classList.toggle('erasing', penTool === 'erase');
  const rp = document.getElementById('readPen');
  if (rp) rp.title = penTool === 'erase' ? '지우개 — 다시 누르면 필기' : '필기 — 다시 누르면 지우개';
  if (!quiet) capToast(TOOL_SAY[penTool], 1500);
}

/** 옛 이름 — 아직 부르는 데가 있어서 남긴다. */
function setPenMode(m) { setTool(m === 'erase' ? 'erase' : 'select', { quiet: true }); }

// 같은 버튼을 다시 누르면 **일반으로 돌아간다** — 모드를 빠져나갈 길이 없었다(2026-10-14)
document.getElementById('readOff').onclick = () => setTool('off');
document.getElementById('toolOff').onclick = () => setTool('off');
document.getElementById('readSelect').onclick = () =>
  setTool(penTool === 'select' ? 'off' : 'select');
// 필기 → 지우개 → 일반 → 필기. 끄는 길이 있어야 펜을 손가락처럼 쓸 수 있다.
document.getElementById('readPen').onclick = () =>
  setTool(penTool === 'write' ? 'erase' : (penTool === 'erase' ? 'off' : 'write'));
document.getElementById('toolSelect').onclick = () =>
  setTool(penTool === 'select' ? 'off' : 'select');
document.getElementById('toolWrite').onclick = () =>
  setTool(penTool === 'write' ? 'off' : 'write');

document.getElementById('readAwake').onclick = async () => {
  const btn = document.getElementById('readAwake');
  const on = !btn.classList.contains('active');
  const ok = await keepAwake(on);
  btn.classList.toggle('active', ok && on);
  toast(ok && on ? '화면이 꺼지지 않습니다.' : on ? '이 기기에서는 지원되지 않습니다.' : '해제했습니다.');
};

// 선택한 텍스트로 질문 — 올가미보다 정확해서 읽기 모드에선 이쪽을 쓴다
/**
 * 아래 바의 AI 단추 — **언제 눌러도 뭔가 된다**(2026-10-14 요청).
 *   · 글을 긁어뒀으면 그 부분을 묻는다
 *   · 지난 답이 있으면 그걸 도로 띄운다(이어서 물으면 된다)
 *   · 둘 다 없으면 빈 질문 칸을 열어준다 — 전에는 "먼저 드래그하세요"로 막았다
 */
const askAnywhere = () => {
  const sel = String(window.getSelection() || '').trim();
  if (sel) {
    // 읽기 화면이면 그 노트를, 퀴즈면 옆에 띄운 노트를 같이 읽고 답한다
    if (document.body.dataset.screen === 'readScreen' && reader) openAskFromReader(sel, null);
    else handleSelect(sel, null);      // 퀴즈 화면의 선택 처리와 같은 길
    return;
  }
  if (askThreads.length) { openThread(askThreads[0].id); return; }
  openBlankAsk();
};
document.getElementById('readAsk').onclick = askAnywhere;
document.getElementById('quizAsk').onclick = askAnywhere;

/** 묻을 거리 없이 창만 연다 — 질문 칸에 바로 커서를 둔다. */
function openBlankAsk() {
  const doc = currentDoc();
  const sec = doc && doc.sections ? doc.sections[currentSecIdx()] : null;
  askCtx = {
    term: '', qnum: '—', question: null,
    qtext: doc ? `${doc.title}${sec ? ` · ${sec.heading}` : ''}` : '',
    noteText: sec ? sec.text : '',
  };
  newThread('새 질문', doc ? doc.title : '');
  askThread.turns = [];
  afEl('afQ').textContent = '새 질문';
  afEl('afQFull').textContent = '';
  afEl('afQWrap').open = false;
  paintThread();
  afEl('afPickBar').classList.add('hidden');
  afEl('afStatus').textContent = '';
  afEl('askFloat').classList.remove('hidden');
  updateAskDock();
  restoreFloatBox();
  setTimeout(() => afEl('afInput').focus(), 80);
}

/** 읽기 모드에서 긁었을 때 — 여기서도 바로 묻지 않고 팝업으로 고르게 한다. */
function openAskFromReader(term, info) {
  const { note, secIdx } = reader;
  const sec = note.sections[secIdx];
  askCtx = { term, qnum: '—', qtext: `${note.title} · ${sec.heading}`, question: null, noteText: sec.text };
  askCtx.prompt = buildPrompt({ term, question: null, subject: note.title, lecture: sec.heading });
  showSelPop(term, info && info.box);
}

// ---- 노트 읽기: 움직이는 AI 답변 창 (2026-10-12) ----
//
// 바닥 시트를 쓰던 때의 문제 셋을 한 번에 고친다:
//   ① 문단을 통째로 긁으면 **질문이 화면을 다 먹고 답이 안 보였다** → 질문은 접고 답에 공간을 준다.
//   ② 답이 textarea 안의 날 텍스트라 읽기 힘들었다 → 마크다운으로 렌더한다.
//   ③ 창이 화면 아래에 고정돼 노트를 가렸다 → 끌어 옮기고 크기도 바꾼다.
// 위치·크기는 기억해둔다 — 매번 같은 자리에 두고 쓰는 물건이다.

function afEl(id) { return document.getElementById(id); }

/**
 * 떠 있는 창을 "끌어 옮기고 크기 조절되는" 물건으로 만든다.
 *
 * 질문 답변 창과 카드 만들기 창이 같은 동작을 쓴다 — 한 군데서만 고치게 묶어둔다.
 * @param {object} p
 * @param {string} p.panel  창 요소 id
 * @param {string} p.head   끌어서 옮기는 손잡이 id
 * @param {string} p.grip   끌어서 크기 바꾸는 모서리 id
 * @param {string} p.key    위치·크기를 기억할 localStorage 키
 * @param {object} [p.def]  기본 크기 {w, h}
 */
function makeFloat({ panel, head, grip, key, def = {} }) {
  const f = document.getElementById(panel);

  const place = () => {
    let box = null;
    try { box = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    const w = Math.min(box?.w || def.w || Math.min(560, innerWidth * 0.92), innerWidth - 16);
    const h = Math.min(box?.h || def.h || Math.min(innerHeight * 0.62, 560), innerHeight - 16);
    const x = Math.max(8, Math.min(box?.x ?? (innerWidth - w) / 2, innerWidth - w - 8));
    const y = Math.max(8, Math.min(box?.y ?? innerHeight * 0.12, innerHeight - h - 8));
    f.style.setProperty('--af-w', `${w}px`);
    f.style.setProperty('--af-h', `${h}px`);
    f.style.setProperty('--af-x', `${x}px`);
    f.style.setProperty('--af-y', `${y}px`);
  };
  const save = () => {
    const r = f.getBoundingClientRect();
    localStorage.setItem(key, JSON.stringify({
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    }));
  };

  const drag = (handle, onMove) => {
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;      // 닫기·다시묻기는 버튼이다
      const r = f.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy, r);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        save();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  };
  drag(document.getElementById(head), (dx, dy, r) => {
    // 화면 밖으로 완전히 나가면 되찾을 수가 없다 — 머리 부분은 항상 남겨둔다
    const x = Math.max(8 - r.width + 60, Math.min(r.left + dx, innerWidth - 60));
    const y = Math.max(8, Math.min(r.top + dy, innerHeight - 44));
    f.style.setProperty('--af-x', `${x}px`);
    f.style.setProperty('--af-y', `${y}px`);
  });
  drag(document.getElementById(grip), (dx, dy, r) => {
    f.style.setProperty('--af-w', `${Math.max(280, Math.min(r.width + dx, innerWidth - r.left - 8))}px`);
    f.style.setProperty('--af-h', `${Math.max(200, Math.min(r.height + dy, innerHeight - r.top - 8))}px`);
  });

  return { place, save };
}

function openAskFloat(term, { followUp = false } = {}) {
  const f = afEl('askFloat');
  const title = askThread ? askThread.title : term;
  afEl('afQ').textContent = title;
  afEl('afQFull').textContent = title;
  afEl('afQWrap').open = false;
  // 꼬리질문이면 **앞 내용을 그대로 두고** 아래에 이번 턴만 덧댄다
  afEl('afQWrap').classList.add('hidden');
  if (followUp) paintThread(); else afEl('afBody').innerHTML = '';
  const live = document.createElement('div');
  live.className = 'af-turn af-live';
  const q = document.createElement('div');
  q.className = 'af-tq';
  q.textContent = term;
  const a = document.createElement('div');
  a.className = 'af-ta';
  a.id = 'afLive';
  a.innerHTML = '<p class="muted">묻는 중…</p>';
  live.append(q, a);
  afEl('afBody').appendChild(live);
  afEl('afBody').scrollTop = afEl('afBody').scrollHeight;
  afEl('afStatus').textContent = '';
  afEl('afLogList').classList.add('hidden');
  afEl('afPickBar').classList.add('hidden');
  f.classList.remove('hidden');
  updateAskDock();
  restoreFloatBox();
}

/**
 * 닫기가 아니라 **접기**다.
 *
 * 답이 그냥 사라지면 그걸 보면서 하던 일을 이어갈 수가 없다(2026-10-13 지적:
 * "바로 없어져버리면 작업을 할 수 없음"). 접으면 화면 귀퉁이에 단추로 남고,
 * 내용은 기기에 저장돼 앱을 껐다 켜도 돌아온다.
 */
function closeAskFloat() {
  afEl('askFloat').classList.add('hidden');
  afEl('afLogList').classList.add('hidden');
  updateAskDock();
}

// ── 지난 질문: 한 주제 = 한 "실" ────────────────────────────
//
// 전에는 질문 하나하나가 평평한 목록이었다. 그래서 꼬리질문("그럼 반대는?")을 하면
// 앞뒤가 끊긴 별개 항목이 하나 더 생겼고, 목록은 금세 비슷한 토막으로 가득 찼다
// (2026-10-15 지적: "이전 질문이 관리가 안 되는 게 나쁘네… 꼬리질문이 계속 나올 수도
// 있잖아"). 채팅 앱들이 하는 대로 **주제 하나를 실 하나로 묶는다** — 첫 질문이 제목이고,
// 이어 물은 것은 그 실 안에 턴으로 쌓인다.
//
// 무거워지지 않게 **목록과 본문을 갈라 둔다**:
//   · `ask_threads` — 제목·시각·턴 수만. 목록을 열 때 이것만 읽는다(실 40개에 수 KB).
//   · `ask_t_{id}`  — 그 실의 주고받은 내용. **그 실을 열 때만** 읽고, 쓸 때도 그 실만 쓴다.
// 전에는 답변 HTML까지 한 덩어리라 **물어볼 때마다 128KB를 통째로 다시 썼다**.
//
// 안 쓰는 실은 알아서 사라진다 — 꽂아둔(📌) 것만 남는다.
let askThreads = [];          // [{id, ts, title, n, note, pin}]  최신이 앞
let askThread = null;         // 지금 열려 있는 실 {id, title, note, turns:[{q, html, ts}]}
const ASK_THREAD_MAX = 40;    // 실 개수 상한
const ASK_TURN_MAX = 12;      // 한 실에 담는 턴 수 — 더 길어지면 앞부분을 접는다
const ASK_KEEP_DAYS = 30;     // 꽂아두지 않은 실이 남아 있는 기간
const ASK_HTML_MAX = 12000;   // 답변 하나당 — 이보다 길면 뒤를 접는다

const threadKey = (id) => `ask_t_${id}`;

async function loadAskLog() {
  askThreads = (await kvGet('ask_threads')) || [];
  if (!askThreads.length) await migrateAskLog();
  await pruneThreads();
  updateAskDock();
}

/** 옛 평평한 목록을 실 하나짜리로 옮긴다(한 번만 돈다). */
async function migrateAskLog() {
  const old = (await kvGet('ask_log')) || [];
  if (!old.length) return;
  for (const x of old) {
    await kvSet(threadKey(x.id), { turns: [{ q: x.term, html: x.html, ts: x.ts }] });
    askThreads.push({ id: x.id, ts: x.ts, title: x.term, n: 1, note: x.note || '', pin: false });
  }
  await kvSet('ask_threads', askThreads);
  await kvSet('ask_log', []);     // 같은 걸 두 벌 들고 있지 않는다
}

/** 오래됐거나 넘치는 실을 치운다 — 꽂아둔 것은 건드리지 않는다. */
async function pruneThreads() {
  const cut = Date.now() - ASK_KEEP_DAYS * 864e5;
  const keep = [];
  const drop = [];
  for (const x of askThreads) {
    const old = !x.pin && x.ts < cut;
    const over = !x.pin && keep.filter((k) => !k.pin).length >= ASK_THREAD_MAX;
    (old || over ? drop : keep).push(x);
  }
  if (!drop.length) return;
  for (const x of drop) await kvDel(threadKey(x.id));
  askThreads = keep;
  await kvSet('ask_threads', askThreads);
}

async function readThread(id) {
  return (await kvGet(threadKey(id))) || { turns: [] };
}

/** 지금 실에 턴 하나를 더 쌓는다. 실이 없으면 새로 판다. */
async function rememberTurn(q, html, note) {
  let keep = String(html || '');
  if (keep.length > ASK_HTML_MAX) {
    keep = keep.slice(0, ASK_HTML_MAX)
      + '<p class="muted">… (너무 길어 뒤는 접었습니다 — ↻ 로 다시 물으면 전문이 나옵니다)</p>';
  }
  if (!askThread) askThread = { id: `${Date.now()}`, title: q, note: note || '', turns: [] };
  // 빈 창에서 시작한 실은 제목이 "새 질문"이다 — 첫 물음이 들어오면 그걸 제목으로 쓴다
  if (!askThread.turns.length) askThread.title = q;
  askThread.turns.push({ q, html: keep, ts: Date.now() });
  if (askThread.turns.length > ASK_TURN_MAX) askThread.turns = askThread.turns.slice(-ASK_TURN_MAX);
  if (note) askThread.note = note;
  await kvSet(threadKey(askThread.id), { turns: askThread.turns });
  const meta = { id: askThread.id, ts: Date.now(), title: askThread.title,
    n: askThread.turns.length, note: askThread.note || '',
    pin: (askThreads.find((x) => x.id === askThread.id) || {}).pin || false };
  askThreads = [meta, ...askThreads.filter((x) => x.id !== meta.id)];
  await kvSet('ask_threads', askThreads);
  updateAskDock();
  return askThread.id;
}

/** 새 주제를 시작한다 — 꼬리질문이 아니라 완전히 다른 것을 물을 때. */
function newThread(title, note) {
  askThread = { id: `${Date.now()}`, title: title || '새 질문', note: note || '', turns: [] };
}

/** 접혀 있을 때 귀퉁이에 뜨는 단추. 읽기 화면에서만 보인다. */
function updateAskDock() {
  // 떠다니는 단추를 없앴다(2026-10-14 지적: "오른쪽 아래에 접을 수도 없이 떠 있어서
  // 화면을 가림"). 대신 **아래 바의 AI 단추**에 작은 점을 찍는다 — 거기 자리가 있고,
  // 페이지를 넘기는 손이 이미 가 있는 자리다.
  const open = !afEl('askFloat').classList.contains('hidden');
  const say = askThreads.length
    ? `AI에게 묻기 — 지난 답: ${selPreview(askThreads[0].title, 20, 0).replace(/ … $/, '…')}`
    : 'AI에게 묻기 — 긁어뒀으면 그 부분을, 아니면 새로 묻습니다';
  // 읽기 화면과 퀴즈 화면 **둘 다**에 둔다 — 문제를 풀다 물어본 걸 다시 볼 데가 없었다
  // (2026-10-14 지적). 두 화면이 같은 질문기록을 쓴다.
  // 점만 찍으니 "뭘 물었더라"를 알 수 없었다 — **방금 물어본 말**을 짧게 붙인다
  // (2026-10-14: "예전 버전 나쁘지 않았음. 좀 예쁘게 넣어봐").
  const last = askThreads.length ? selPreview(askThreads[0].title, 12, 0).replace(/ … $/, '…') : '';
  for (const [tagId, btnId] of [['readAskLast', 'readAsk'], ['quizAskLast', 'quizAsk']]) {
    const tag = afEl(tagId);
    if (tag) {
      tag.textContent = last;
      tag.classList.toggle('hidden', open || !last);
    }
    const btn = afEl(btnId);
    if (btn) btn.title = say;
  }
}

/**
 * 실 하나를 통째로 그린다 — 주고받은 순서대로, 마지막 답이 아래에 오게.
 *
 * 전에는 **마지막 답 하나만** 띄웠다. 그래서 꼬리질문을 하면 앞에 뭘 물었는지가
 * 화면에서 사라져, 이어 묻는다는 느낌 자체가 없었다(2026-10-15).
 */
function paintThread() {
  const body = afEl('afBody');
  body.innerHTML = '';
  if (!askThread || !askThread.turns.length) {
    afEl('afQWrap').classList.remove('hidden');
    body.innerHTML = '<p class="muted">아래 칸에 궁금한 것을 적어 물어보세요. '
      + '지금 보고 있는 노트를 같이 읽고 답합니다.</p>';
    return;
  }
  // 주고받은 것이 본문에 다 보이므로 머리글의 "질문" 접기는 숨긴다 — 첫 질문이 두 번 나왔다
  afEl('afQWrap').classList.toggle('hidden', askThread.turns.length > 0);
  askThread.turns.forEach((tn, i) => {
    const w = document.createElement('div');
    w.className = 'af-turn';
    const q = document.createElement('div');
    q.className = 'af-tq';
    q.textContent = tn.q;
    // 첫 질문은 긁어온 대목이라 길다 — 접어두고 누르면 펴지게 한다
    if (i === 0 && tn.q.length > 120) { q.classList.add('clip'); q.onclick = () => q.classList.toggle('clip'); }
    const a = document.createElement('div');
    a.className = 'af-ta';
    a.innerHTML = tn.html;
    w.append(q, a);
    body.appendChild(w);
  });
  tokenizeTree(body);
  if (afPick) afPick.reset();
  // 글이 자리를 잡기 전에 내리면 안 내려간다 — 다음 프레임에 한 번 더 민다
  body.scrollTop = body.scrollHeight;
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

/** 지난 실을 그대로 되살린다(다시 묻지 않는다 — 한도도 아끼고 빠르다). */
async function openThread(id) {
  const meta = askThreads.find((x) => x.id === id);
  if (!meta) return;
  const { turns } = await readThread(id);
  askThread = { id, title: meta.title, note: meta.note, turns };
  const last = turns[turns.length - 1] || {};
  askCtx = { ...(askCtx || {}), term: meta.title, answer: null, qtext: meta.note || '' };
  afEl('afQ').textContent = meta.title;
  afEl('afQFull').textContent = meta.title;
  afEl('afQWrap').open = false;
  paintThread();
  askCtx.answer = stripHtml(last.html || '');
  afEl('afStatus').textContent = `${meta.note ? `${meta.note} · ` : ''}${turns.length}번 주고받음 · `
    + new Date(meta.ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  afEl('afLogList').classList.add('hidden');
  afEl('askFloat').classList.remove('hidden');
  updateAskDock();
  restoreFloatBox();
  updateAfSaveLabel();
}

/** HTML에서 글자만. 저장할 때 태그가 섞여 들어가지 않게. */
function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html || '');
  return d.textContent.trim();
}

/** 같은 날이면 시:분만, 아니면 날짜만 — 목록 한 줄에 들어가야 한다. */
function shortWhen(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString('ko-KR', today ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric' });
}

function renderAskLog(filter = '') {
  const box = afEl('afLogList');
  box.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'al-bar';
  const q = document.createElement('input');
  q.type = 'search';
  q.placeholder = '지난 질문 찾기';
  q.value = filter;
  q.oninput = () => renderAskLog(q.value);
  const nw = document.createElement('button');
  nw.className = 'btn';
  nw.textContent = '＋ 새 주제';
  nw.onclick = () => { afEl('afLogList').classList.add('hidden'); openBlankAsk(); };
  bar.append(q, nw);
  box.appendChild(bar);

  const key = filter.trim().toLowerCase();
  const list = askThreads.filter((x) => !key || x.title.toLowerCase().includes(key)
    || (x.note || '').toLowerCase().includes(key));
  if (!list.length) {
    const m = document.createElement('p');
    m.className = 'muted';
    m.style.padding = '10px 12px';
    m.textContent = askThreads.length ? '찾는 질문이 없습니다.' : '아직 물어본 게 없습니다.';
    box.appendChild(m);
  }
  // 꽂아둔 것이 위로
  for (const item of [...list].sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0))) {
    const row = document.createElement('div');
    row.className = 'af-log-item' + (item.pin ? ' pinned' : '');
    const b = document.createElement('button');
    b.className = 'al-main';
    const tt = document.createElement('span');
    tt.className = 'al-t';
    tt.textContent = selPreview(item.title, 40, 0).replace(/ … $/, '…');
    const meta = document.createElement('span');
    meta.className = 'al-d';
    // 꼬리질문이 몇 번 오갔는지 — 한 줄짜리 실과 길게 이어간 실을 눈으로 가른다
    meta.textContent = `${item.n > 1 ? `꼬리 ${item.n - 1} · ` : ''}${shortWhen(item.ts)}`;
    b.append(tt, meta);
    b.onclick = () => openThread(item.id);

    const pin = document.createElement('button');
    pin.className = 'icon-btn al-pin';
    pin.textContent = '📌';
    pin.title = item.pin ? '꽂아둔 것 풀기' : '꽂아두기 — 오래돼도 안 지워집니다';
    pin.setAttribute('aria-pressed', String(!!item.pin));
    pin.onclick = async (e) => {
      e.stopPropagation();
      item.pin = !item.pin;
      await kvSet('ask_threads', askThreads);
      renderAskLog(filter);
    };

    const del = document.createElement('button');
    del.className = 'icon-btn al-del';
    del.textContent = '✕';
    del.title = '지우기';
    del.onclick = async (e) => {
      e.stopPropagation();
      const gone = item;
      askThreads = askThreads.filter((x) => x.id !== item.id);
      await kvSet('ask_threads', askThreads);
      renderAskLog(filter);
      updateAskDock();
      // 되돌릴 틈을 준다 — 본문은 되돌리기가 끝난 뒤에 지운다
      toastUndo(`"${selPreview(gone.title, 16, 0).replace(/ … $/, '…')}" 지웠습니다`, async () => {
        askThreads = [gone, ...askThreads].sort((a, b) => b.ts - a.ts);
        await kvSet('ask_threads', askThreads);
        renderAskLog(filter);
        updateAskDock();
      }, { onExpire: () => kvDel(threadKey(gone.id)) });
    };

    row.append(b, pin, del);
    box.appendChild(row);
  }
  box.classList.remove('hidden');
}

function toggleAskLog() {
  const box = afEl('afLogList');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  renderAskLog('');
}

/**
 * AI 설명에서 긁은 글.
 *
 * 브라우저 기본 선택을 쓰다가 **어디까지 잡혔는지 안 보인다**는 신고를 받고
 * 낱말 단위 직접 칠하기로 바꿨다(2026-10-15). 그래도 마우스로 기본 선택을 한
 * 경우를 아예 버리지는 않는다 — 둘 중 잡힌 쪽을 쓴다.
 */
let afPick = null;
function selectedInside(root) {
  if (afPick) {
    const picked = afPick.text();
    if (picked) return picked;
  }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const r = sel.getRangeAt(0);
  if (!root.contains(r.commonAncestorContainer)) return '';
  return String(sel).trim();
}

/** "답변 저장" 버튼이 지금 뭘 저장할지 보여준다. */
function updateAfSaveLabel() {
  const btn = afEl('afSave');
  if (!btn) return;
  const n = selectedInside(afEl('afBody')).length;
  btn.textContent = n ? `고른 부분 저장 (${n}자)` : '답변 저장';
  btn.classList.toggle('partial', !!n);
}

/**
 * 고르면 그 자리에 뜨는 작은 막대 — 복사 · 이어 묻기 · 저장.
 *
 * 왜(2026-10-15 요청: "선택하면 복사하기나 뭐 추가질문 이런 식으로"): 고르고 나서
 * 할 수 있는 일이 저 아래 "답변 저장" 하나뿐이었다. 고른 자리 바로 옆에 두면
 * 손이 움직일 거리가 없다.
 */
function placePickBar(sel) {
  const bar = afEl('afPickBar');
  if (!bar) return;
  if (!sel) { bar.classList.add('hidden'); return; }
  const marks = afEl('afBody').querySelectorAll('.tok-pick');
  if (!marks.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const host = afEl('askFloat').getBoundingClientRect();
  const first = marks[0].getBoundingClientRect();
  const last = marks[marks.length - 1].getBoundingClientRect();
  const bw = bar.offsetWidth || 240;
  const bh = bar.offsetHeight || 40;
  // 고른 데 **위**에 붙인다. 위가 좁으면 아래로 넘긴다 — 손가락이 가린 자리를 피한다.
  // ⚠️ 높이를 짐작하면 막대가 고른 글을 덮는다(실측으로 확인) — 잰 값에 틈 8px을 더한다.
  const above = first.top - host.top - bh - 8;
  const y = above > 6 ? above : (last.bottom - host.top + 8);
  const x = Math.max(8, Math.min((first.left + last.right) / 2 - host.left - bw / 2,
    host.width - bw - 8));
  bar.style.left = `${x}px`;
  bar.style.top = `${Math.max(6, Math.min(y, host.height - 50))}px`;
}

function initAfPick() {
  const body = afEl('afBody');
  if (!body || afPick) return;
  afPick = wordPick(body, (txt) => { updateAfSaveLabel(); placePickBar(txt); });
  afEl('afPickCopy').onclick = async () => {
    const s = afPick.text();
    if (!s) return;
    try { await navigator.clipboard.writeText(s); toast('복사했습니다.'); }
    catch { toast('복사하지 못했습니다 — 길게 눌러 복사해 주세요.'); }
  };
  // 고른 대목을 그대로 꼬리질문으로 — 가장 자주 하는 "이게 무슨 말이야?"
  //
  // ★ **바로 보낸다**(2026-10-15 요청). 질문 칸을 채워만 두면 "물어보기"를 또 눌러야 해서
  //   두 번 손이 간다. 손볼 데가 있으면 어차피 복사해서 새로 쓰게 된다.
  afEl('afPickAsk').onclick = () => {
    const s = afPick.text();
    if (!s) return;
    afPick.clear();
    afEl('afInput').value = s.length > 90
      ? `"${s.slice(0, 90)}…" 이 부분을 더 풀어서 설명해줘`
      : `"${s}" 이게 무슨 말이야?`;
    afEl('afSend').click();
  };
  afEl('afPickSave').onclick = () => afEl('afSave').click();
  afEl('afPickClear').onclick = () => afPick.clear();
}

let askFloat = null;
function restoreFloatBox() { if (askFloat) askFloat.place(); }

function initAskFloat() {
  askFloat = makeFloat({
    panel: 'askFloat', head: 'afHead', grip: 'afResize', key: 'ask_float_box',
  });

  afEl('afClose').onclick = closeAskFloat;
  afEl('afLog').onclick = toggleAskLog;
  // 이어 묻기 — **같은 실의 다음 턴**으로 쌓인다(2026-10-15). 전에는 매번 새 항목이
  // 생겨서 앞뒤가 끊겼고, 목록이 비슷한 토막으로 금세 찼다.
  const send = () => {
    const q = afEl('afInput').value.trim();
    if (!q) { afEl('afInput').focus(); return; }
    afEl('afInput').value = '';
    const doc = currentDoc();
    const sec = doc && doc.sections ? doc.sections[currentSecIdx()] : null;
    askCtx = {
      term: q, qnum: '—', question: null,
      qtext: doc ? `${doc.title}${sec ? ` · ${sec.heading}` : ''}` : '',
      noteText: sec ? sec.text : '',
    };
    askInReader(q, { followUp: true });
  };
  afEl('afSend').onclick = send;
  afEl('afInput').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); afEl('afInput').blur(); }
  };

  loadAskLog();
  initAfPick();
  // 실을 펜 없이 열어볼 수 있게 — 테스트가 화면을 세우는 통로(카드 창과 같은 방식).
  // 기기에 심어둔 것을 다시 읽는 길도 같이 연다 — 안 그러면 메모리에 있는 옛 목록을 본다.
  window.__askForTest = { open: openThread, reload: loadAskLog };

  // 긁는 동안 버튼 글씨를 바꿔 "지금 누르면 뭐가 저장되는지" 알려준다
  document.addEventListener('selectionchange', () => {
    if (!afEl('askFloat').classList.contains('hidden')) updateAfSaveLabel();
  });
  afEl('afRetry').onclick = () => { if (askCtx && askCtx.term) askInReader(askCtx.term); };
  afEl('afApp').onclick = () => { if (askCtx && askCtx.term) fillAskSheet(askCtx.term); };
  // 답변 저장 — **긁어둔 부분이 있으면 그것만** 저장한다(2026-10-13 요청).
  // 설명이 길면 쓸모 있는 건 보통 한두 문단이다. 통째로 넣으면 vault가 지저분해진다.
  afEl('afSave').onclick = () => {
    if (!askCtx || !askCtx.answer) { toast('저장할 답변이 없습니다.'); return; }
    const picked = selectedInside(afEl('afBody'));
    askItems.push({ ...askCtx, answer: picked || askCtx.answer, partial: !!picked });
    toast(picked
      ? `고른 부분만 기록했습니다 (${askItems.length}건)`
      : `전체를 기록했습니다 (${askItems.length}건) — 일부만 저장하려면 긁은 뒤 누르세요.`);
    window.getSelection().removeAllRanges();
    if (afPick) afPick.clear();
    updateAfSaveLabel();
  };
}

/** 읽기 모드에서 "여기서 질문"을 고른 경우 — 움직이는 창에 답을 흘려 보여준다. */
async function askInReader(term, { followUp = false } = {}) {
  if (!(await gem.hasKey())) { fillAskSheet(term); return; }
  if (!followUp || !askThread) newThread(term, reader ? reader.note.title : '');
  openAskFloat(term, { followUp });
  const body = afEl('afBody');
  const status = afEl('afStatus');
  status.textContent = '묻는 중…';
  // 꼬리질문이면 앞서 주고받은 것을 같이 넘긴다 — 없으면 "그럼 반대는?"이 말이 안 된다
  const prior = followUp
    ? askThread.turns.map((x) => ({ q: x.q, a: stripHtml(x.html) }))
    : [];
  try {
    const answer = await gem.ask({
      term, question: null, noteText: askCtx.noteText || '', prior,
      subject: reader ? reader.note.title : '', lecture: askCtx.qtext || '',
      // 노트를 읽다 묻는 것이라 "핵심/감별/시험 포인트" 틀을 강요하지 않는다 —
      // 문단을 통째로 긁으면 개념이 여럿이라 그 틀에 안 맞는다(2026-10-12 지적).
      mode: 'read',
      onProgress: (full) => {
        afEl('afLive').innerHTML = renderMarkdown(full);
        body.scrollTop = body.scrollHeight;
      },
    });
    askCtx.answer = answer;
    await rememberTurn(term, renderMarkdown(answer), reader ? reader.note.title : '');
    afEl('afQ').textContent = askThread.title;
    afEl('afQFull').textContent = askThread.title;
    paintThread();                      // 답변에서도 긁어서 다시 물을 수 있게
    status.textContent = askThread.turns.length > 1
      ? `${askThread.turns.length}번 주고받음 — 꾹 눌러 긁으면 그 부분만 다룹니다`
      : '쓸 만한 부분만 꾹 눌러 긁어서 저장할 수 있습니다';
    updateAfSaveLabel();
  } catch (e) {
    const w = /^RATE_WAIT:(\d+)$/.exec(e.message);
    body.innerHTML = `<div class="warn-box">${escapeText(
      w ? `무료 한도에 걸렸습니다 — ${w[1]}초 뒤 다시 누르거나 "다른 앱에서"를 쓰세요.` : e.message)}</div>`;
    status.textContent = '';
  }
}

// ---- 플래시카드 ----
async function loadCardsTab() {
  // 노트 전체 하이라이트로 만든 카드는 거의 안 쓴다 — 네모로 만든 카드만 다룬다(2026-10-10).
  // 탭을 누르면 바로 관리 화면으로 보낸다.
  openDeck();
}

async function startCards(path, srs) {
  const body = document.getElementById('cardsBody');
  const prev = body.innerHTML;
  body.innerHTML = '<p class="muted">카드를 만드는 중…</p>';
  try {
    const note = await loadNote(path);
    const all = extractCards(note);
    if (!all.length) {
      body.innerHTML = prev;
      toast('이 노트에는 ==하이라이트== 가 없습니다.');
      return;
    }
    const srsNow = srs || (await loadSrs());
    const due = dueCards(all, srsNow);
    const deck = due.length ? due : all;   // 복습할 게 없으면 전체를 한 번 더
    shuffle(deck);
    cardDeck = { cards: deck, idx: 0, srs: srsNow, title: note.title, all };
    show('cardScreen');
    renderCard();
    if (!due.length) toast('오늘 복습할 카드가 없어 전체를 보여줍니다.');
  } catch (e) {
    body.innerHTML = prev;
    toast(`카드를 만들지 못했습니다: ${e.message}`);
  }
}

function renderCard() {
  if (!cardDeck) return;
  const c = cardDeck.cards[cardDeck.idx];
  document.getElementById('cardTitle').textContent = cardDeck.title;
  document.getElementById('cardProgress').textContent = `${cardDeck.idx + 1}/${cardDeck.cards.length}`;
  // 어느 대목인지 보여야 "무엇에 대한 질문인지" 생각할 수 있다(2026-10-10 요청)
  // 무엇에 대한 질문인지 — 노트 › 섹션 › 소제목까지 보여야 맞힐 수 있다(2026-10-10)
  document.getElementById('cardSource').textContent =
    [cardDeck.noteTitle || cardDeck.title, c.topic || c.heading].filter(Boolean).join('  ·  ');

  const ctx = document.getElementById('cardContext');
  // 그려줄 때마다 정돈한다 — **이미 만들어둔 카드의 틀어진 띄어쓰기도 여기서 낫는다**
  if (c.contextHtml) setCardBody(ctx, c.contextHtml);               // 표·서식·그림을 그대로 살린다
  else ctx.textContent = c.context || '';
  // 노트에서 가져온 Q&A는 빈칸이 아니라 문장형 질문이라 왼쪽 정렬이 읽기 쉽다
  ctx.classList.toggle('qa-q', c.kind === 'qa');

  const ans = document.getElementById('cardAnswer');
  const list = c.answers && c.answers.length ? c.answers : [c.answer].filter(Boolean);
  ans.innerHTML = '';
  list.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'ans-row';
    if (list.length > 1) {
      const num = document.createElement('span');
      num.className = 'ans-num';
      num.textContent = i + 1;
      row.appendChild(num);
    }
    const t = document.createElement('span');
    t.textContent = a;
    row.appendChild(t);
    ans.appendChild(row);
  });
  // 그림만 가린 카드는 적을 답이 없다 — 답 칸이 비면 "답 보기"가 허탕으로 보인다
  if (!list.length) {
    const row = document.createElement('div');
    row.className = 'ans-row muted';
    row.textContent = '그림에서 가린 곳을 벗겼습니다.';
    ans.appendChild(row);
  }
  ans.classList.add('hidden');
  document.getElementById('cardPre').classList.remove('hidden');
  document.getElementById('cardGrade').classList.add('hidden');
  paintStar();
  document.getElementById('cardShow').classList.remove('hidden');
  document.getElementById('cardGrade').classList.add('hidden');
  window.scrollTo(0, 0);
}

document.getElementById('cardShow').onclick = () => {
  document.getElementById('cardAnswer').classList.remove('hidden');
  // 빈칸 자리에 답을 드러낸다 — 목록만 따로 보면 어느 칸인지 헷갈린다.
  // 글자를 넣는 게 아니라 숨겨둔 걸 보이게만 한다 — 그래야 글이 안 밀린다.
  paintCloze(document.getElementById('cardContext'), true);
  document.getElementById('cardPre').classList.add('hidden');
  document.getElementById('cardGrade').classList.remove('hidden');
};
document.getElementById('cardAgain').onclick = () => advanceCard(false);
document.getElementById('cardGot').onclick = () => advanceCard(true);

// ── 카드 골라내기 (2026-10-10) ──
// 네모로 만들면 카드가 쏟아진다. 다 외울 수 없으니 **그 자리에서 골라낸다.**
document.getElementById('cardSkip').onclick = async () => {
  if (!cardDeck) return;
  buryCard(cardDeck.srs, cardDeck.cards[cardDeck.idx].id);   // 답을 안 봤으니 점수는 안 매긴다
  await saveSrs(cardDeck.srs);
  backup.scheduleBackup();
  nextCard('나중에 — 내일 다시 나옵니다');
};
document.getElementById('cardDrop').onclick = async () => {
  if (!cardDeck) return;
  suspendCard(cardDeck.srs, cardDeck.cards[cardDeck.idx].id);
  await saveSrs(cardDeck.srs);
  backup.scheduleBackup();
  nextCard('버렸습니다 — 카드 관리에서 되살릴 수 있습니다');
};
document.getElementById('cardStar').onclick = async () => {
  if (!cardDeck) return;
  const id = cardDeck.cards[cardDeck.idx].id;
  toggleStar(cardDeck.srs, id);
  await saveSrs(cardDeck.srs);
  backup.scheduleBackup();
  paintStar();
  capToast(isStarred(cardDeck.srs, id) ? '★ 중요 — 다음에 먼저 나옵니다' : '중요 표시를 뗐습니다');
};

function paintStar() {
  if (!cardDeck) return;
  const on = isStarred(cardDeck.srs, cardDeck.cards[cardDeck.idx].id);
  const b = document.getElementById('cardStar');
  b.textContent = on ? '★' : '☆';
  b.classList.toggle('active', on);
}

/** 점수를 매기지 않고 다음 장으로(나중에·버리기). */
function nextCard(msg) {
  if (msg) capToast(msg);
  if (cardDeck.idx + 1 >= cardDeck.cards.length) { finishDeck(); return; }
  cardDeck.idx++;
  renderCard();
}
document.getElementById('cardBack').onclick = () => {
  const back = cardDeck && cardDeck.backTo;
  cardDeck = null;
  // 읽다가 만든 카드면 읽던 자리로 돌아간다
  if (back === 'reader' && reader) { show('readScreen'); if (readerPen) requestAnimationFrame(() => readerPen.resize()); }
  else if (back === 'deck') openDeck();
  else show('listScreen');
};

async function advanceCard(remembered) {
  if (!cardDeck) return;
  const c = cardDeck.cards[cardDeck.idx];
  // 시험이 코앞이면 복습을 그 전으로 당긴다(FSRS 간격이 시험을 넘기지 않게)
  gradeCard(cardDeck.srs, c.id, remembered, { examAt: deckView.exam ? deckView.exam.at : null });
  await saveSrs(cardDeck.srs);
  backup.scheduleBackup();       // 외운 기록은 되찾을 수 없다 — 모아서 vault에 올린다
  if (!remembered && isLeech(cardDeck.srs, c.id)) {
    capToast(`${LEECH_AT}번 넘게 틀렸습니다 — 카드 관리에서 "자주 틀림"으로 모아 볼 수 있습니다`, 2400);
  }
  if (cardDeck.idx + 1 >= cardDeck.cards.length) { finishDeck(); return; }
  cardDeck.idx++;
  renderCard();
}

function finishDeck() {
  const s = srsStats(cardDeck.all, cardDeck.srs);
  const back = cardDeck.backTo;
  toast(`끝! 처음 ${s.new} · 학습중 ${s.learning} · 익힘 ${s.mature}`);
  cardDeck = null;
  // 읽다가 만든 카드면 **읽던 자리로** 돌아간다(2026-10-10 버그: 목록으로 나가버렸다)
  if (back === 'reader' && reader) {
    show('readScreen');
    if (readerPen) requestAnimationFrame(() => readerPen.resize());
  } else if (back === 'deck') openDeck();
  else show('listScreen');
}

// ---------- 카드 관리 ----------
// 네모로 만들면 카드가 수백 장이 된다. 다 소화할 수 없으니 **성격별로 모아 보고
// 직접 골라낼 수 있는** 화면이 필요하다(2026-10-10 요청).
const DECK_GROUPS = [
  ['star', '★ 중요', '내가 고른 것 — 복습 때 가장 먼저 나옵니다'],
  ['leech', `자주 틀림 (${LEECH_AT}회 이상)`, '약점. 여기부터 보면 효율이 좋습니다'],
  ['due', '오늘 볼 것', '새 카드와 복습 기한이 지난 카드'],
  ['later', '학습 중', '아직 기한이 안 된 카드'],
  ['mature', '익힘', '3번 이상 연속으로 맞힌 카드'],
  ['suspended', '버린 것', '다시 안 나옵니다 — 되살릴 수 있습니다'],
];

// deck  : 고른 덱 키(s:과목 / n:노트경로). null이면 전부.
// sel   : 선택 모드. null이면 꺼짐, Set이면 켜짐(안에 고른 카드 id).
// archived: 보관한 덱 키들 — 끝난 과목을 눈에서 치운다.
let deckView = {
  group: 'due', deck: null, cards: [], srs: {}, exam: null,
  archived: new Set(), showArchived: false, sel: null, openSubs: new Set(), confirmDel: false,
};

const ARCHIVE_KEY = 'deck_archived';

async function loadArchived() {
  const saved = await kvGet(ARCHIVE_KEY);
  deckView.archived = new Set(Array.isArray(saved) ? saved : []);
}
async function saveArchived() {
  await kvSet(ARCHIVE_KEY, [...deckView.archived]);
  backup.scheduleBackup();
}

async function openDeck(keep = false) {
  show('deckScreen');
  const body = document.getElementById('deckBody');
  if (!keep) body.innerHTML = '<p class="muted">불러오는 중…</p>';
  let cards, srs;
  try { cards = await allCards(); srs = await loadSrs(); await loadArchived(); }
  catch (e) { body.innerHTML = `<div class="warn-box">${escapeText(e.message)}</div>`; return; }
  deckView.cards = cards;
  deckView.srs = srs;
  // 시험 날짜를 못 읽어도 카드 화면은 열려야 한다(배지만 안 뜰 뿐)
  if (!deckView.exam) loadExamDate().then(() => paintExamBar()).catch(() => {});

  // 카드가 0장이면 **가져오기로 보낸다** — 여기서 그냥 멈추면 노트의 Q&A를
  // 끌어올 입구가 없다(처음 쓰는 사람이 딱 이 상태다).
  if (!cards.length) {
    document.getElementById('deckSide').innerHTML = '';
    document.getElementById('deckStats').innerHTML = '';
    document.getElementById('deckSelBar').classList.add('hidden');
    clearSel();
    body.innerHTML = '';
    body.appendChild(muted('아직 카드가 없습니다. 노트에 써둔 Q&A를 가져오거나, 노트 읽기에서 펜으로 네모를 쳐 만들 수 있습니다.'));
    const b = document.createElement('button');
    b.className = 'btn primary full';
    b.style.marginTop = '10px';
    b.textContent = '📥 노트에서 Q&A 가져오기';
    b.onclick = () => { deckView.group = 'import'; renderQaImport(); };
    body.appendChild(b);
    paintExamBar();
    return;
  }
  paintExamBar();
  renderDeck();
}

/** 시험까지 며칠 남았는지 — 복습 간격이 이 날짜를 넘기지 않는다. */
async function loadExamDate() {
  try {
    const files = await listDir('00_Raw_Text/시간표');
    const all = [];
    for (const f of files.filter((x) => x.type === 'file' && x.name.endsWith('.md'))) {
      all.push(...parseExamDates(await getText(f.path)));
    }
    deckView.exam = nextExam(all);
    await kvSet('next_exam', deckView.exam);
  } catch {
    deckView.exam = (await kvGet('next_exam')) || null;   // 오프라인이면 기억해둔 것
  }
}

function paintExamBar() {
  const bar = document.getElementById('deckExam');
  const e = deckView.exam;
  if (!e || e.at < Date.now()) { bar.classList.add('hidden'); return; }
  const days = Math.ceil((e.at - Date.now()) / 86400000);
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  const d = document.createElement('span');
  d.className = 'deck-exam-d';
  d.textContent = `D-${days}`;
  const t = document.createElement('span');
  t.textContent = `${e.name} (${e.date}) — 복습 간격을 시험 전으로 당깁니다`;
  bar.append(d, t);
}

// ── 노트에 손으로 쓴 Q&A 가져오기 (2026-10-10) ──
//
// 임종평·위키 노트에 `**Q. …?**` 꼴로 직접 쓴 문답이 4,800장 가까이 있는데 앱이
// 한 장도 몰랐다. 하이라이트에서 기계적으로 뽑은 카드와는 질이 다르다.
//
// 개수를 미리 보여주려면 노트 192개를 전부 내려받아야 해서 과목을 누를 때 가져온다.

const ROOT_LABEL = {
  '98_예습노트_보관': '예습노트',
  '02_Wiki': '위키',
  '01_임종평_전범위': '임종평 전범위',
};

/** 다가오는 시험과 얼마나 겹치나 — 과목 순서를 정하는 데만 쓴다(정확할 필요는 없다). */
function overlapScore(subject, lectures) {
  const words = new Set();
  for (const l of lectures || []) {
    for (const w of String(l.name).split(/[^가-힣A-Za-z]+/)) {
      if (w.length >= 2) words.add(w.toLowerCase());
    }
  }
  const s = String(subject).replace(/^\d+_/, '').toLowerCase();
  let hit = 0;
  for (const w of words) if (s.includes(w) || w.includes(s)) hit++;
  return hit;
}

async function renderQaImport() {
  const body = document.getElementById('deckBody');
  const stats = document.getElementById('deckStats');
  stats.innerHTML = '';
  const have = deckView.cards.filter((c) => c.kind === 'qa').length;
  const head = document.createElement('p');
  head.className = 'muted';
  head.innerHTML = '노트에 <b>Q. …?</b> 꼴로 직접 쓴 문답을 카드로 가져옵니다.'
    + ' 🔴(실제 기출 근거)이 붙은 것은 중요 표시로 들어옵니다.'
    + (have ? `<br>지금까지 가져온 Q&A 카드 ${have}장.` : '');
  stats.appendChild(head);

  body.innerHTML = '<p class="muted">노트 목록을 불러오는 중…</p>';
  let groups;
  try { groups = await noteList(false); }
  catch (e) { body.innerHTML = ''; body.appendChild(muted(`노트 목록을 못 읽었습니다: ${e.message}`)); return; }

  // 시험이 가까운 과목의 강의 이름으로 순서를 정한다 — 내가 과목 목록을 박아두지 않게
  let lectures = [];
  try {
    const { schedule, exams } = await todayData(false);
    const next = nextExam(exams);
    const norm = (s) => String(s || '').replace(/[_\s]/g, '');
    lectures = next ? schedule.filter((l) => norm(l.src) === norm(next.src)) : [];
  } catch { /* 순서만 못 정할 뿐이라 그냥 넘어간다 */ }

  const byRoot = new Map();
  for (const g of groups) {
    if (!byRoot.has(g.root)) byRoot.set(g.root, []);
    byRoot.get(g.root).push(g);
  }

  body.innerHTML = '';
  for (const [root, gs] of byRoot) {
    const h = document.createElement('div');
    h.className = 'today-h';
    h.textContent = ROOT_LABEL[root] || root.replace(/^\d+_/, '');
    body.appendChild(h);

    gs.slice().sort((a, b) => overlapScore(b.subject, lectures) - overlapScore(a.subject, lectures)
      || a.subject.localeCompare(b.subject, 'ko')).forEach((g) => {
      const row = document.createElement('button');
      row.className = 'exam-item';
      const hot = overlapScore(g.subject, lectures) > 0;
      const name = document.createElement('span');
      name.className = 'exam-name';
      name.innerHTML = `<b>${escapeHtml(g.subject.replace(/^\d+_/, ''))}</b>`
        + `<span class="exam-meta">노트 ${g.notes.length}개${hot ? ' · 이번 시험과 겹침' : ''}</span>`;
      const tail = document.createElement('span');
      tail.className = 'exam-progress';
      tail.textContent = '가져오기 ›';
      row.append(name, tail);
      row.onclick = () => importQa(g, row);
      body.appendChild(row);
    });
  }
}

/** 과목 하나의 노트를 모두 읽어 Q&A 카드를 담는다. */
async function importQa(group, row) {
  const tail = row.querySelector('.exam-progress');
  row.disabled = true;
  const cards = [];
  let done = 0;
  for (const n of group.notes) {
    tail.textContent = `${done}/${group.notes.length}…`;
    try {
      const md = await getText(n.path);
      cards.push(...qaCards(md, { path: n.path, title: n.name }));
    } catch { /* 한 노트를 못 읽어도 나머지는 가져온다 */ }
    done++;
  }
  if (!cards.length) {
    tail.textContent = 'Q&A 없음';
    row.disabled = false;
    toast(`${group.subject}에는 Q. 꼴 문답이 없습니다.`);
    return;
  }

  // 🔴 실제 기출 근거가 있는 것은 중요 표시로 들어온다 — 우선순위를 노트가 이미 알고 있다
  const srs = deckView.srs || (await loadSrs());
  let starred = 0;
  for (const c of cards) {
    if ((c.examBacked || c.starred) && !isStarred(srs, c.id)) { toggleStar(srs, c.id); starred++; }
  }
  await saveCards(cards);
  await saveSrs(srs);
  backup.scheduleBackup();

  tail.textContent = `${cards.length}장 ✓`;
  toast(`${cards.length}장 가져왔습니다${starred ? ` (기출 ${starred}장은 중요 표시)` : ''}.`);
  await openDeck(true);          // 목록을 새로 읽어 개수를 갱신한다
  deckView.group = 'import';
  renderDeck();
}

/** 지금 보고 있는 범위의 카드 — 보관된 과목은 "보관함 보기"를 켰을 때만 나온다. */
function deckScope() {
  const { cards, deck, archived, showArchived } = deckView;
  const base = showArchived || (deck && archived.has(deck)) ? cards : liveCards(cards, archived);
  return cardsInDeck(base, deck);
}

function renderDeck() {
  renderDeckSide();
  // 가져오기는 카드 목록이 아니라 "어느 노트에서 끌어올까"를 고르는 화면이다
  if (deckView.group === 'import') {
    document.getElementById('deckSelBar').classList.add('hidden');
    renderQaImport();
    return;
  }
  renderDeckMain();
  renderSelBar();
}

// ── 왼쪽: 상태 탭 + 과목 트리 ──
const DECK_TABS = [
  ['due', '오늘 볼 것', '🗓'],
  ['star', '중요', '★'],
  ['leech', '자주 틀림', '⚠'],
  ['later', '학습 중', '📘'],
  ['mature', '익힘', '✓'],
  ['suspended', '버림', '🗑'],
  ['all', '전체', '📚'],
  ['import', '가져오기', '📥'],
];

function renderDeckSide() {
  const side = document.getElementById('deckSide');
  side.innerHTML = '';
  const { cards, srs, archived } = deckView;
  const scoped = deckScope();
  const g = groupCards(scoped, srs);

  side.appendChild(sideHead('상태'));
  const tabs = document.createElement('div');
  tabs.className = 'deck-tabs';
  for (const [key, label, icon] of DECK_TABS) {
    const n = key === 'all' ? scoped.length
      : key === 'import' ? scoped.filter((c) => c.kind === 'qa').length
        : (g[key] || []).length;
    const b = document.createElement('button');
    b.className = `deck-tab${deckView.group === key ? ' active' : ''}`;
    b.innerHTML = `<span class="dt-ico">${icon}</span><span class="dt-l">${label}</span><span class="dt-n">${n}</span>`;
    b.onclick = () => { deckView.group = key; clearSel(); renderDeck(); };
    tabs.appendChild(b);
  }
  side.appendChild(tabs);

  // ── 과목 › 노트 트리 ──
  const tree = deckTree(cards, srs, { archived });
  const live = tree.filter((t) => !t.archived);
  const gone = tree.filter((t) => t.archived);

  side.appendChild(sideHead('과목'));
  const nodes = document.createElement('div');
  nodes.className = 'deck-nodes';
  nodes.appendChild(deckNodeAll(liveCards(cards, archived).length));
  live.forEach((t) => appendSubject(nodes, t));
  side.appendChild(nodes);

  if (gone.length) {
    const h = document.createElement('button');
    h.className = `deck-arch-h${deckView.showArchived ? ' open' : ''}`;
    const goneN = gone.reduce((a, t) => a + t.n, 0);
    h.innerHTML = `<span>지난 과목 ${gone.length}개</span><span class="dt-n">${goneN}</span>`;
    h.onclick = () => { deckView.showArchived = !deckView.showArchived; renderDeck(); };
    side.appendChild(h);
    if (deckView.showArchived) {
      const box = document.createElement('div');
      box.className = 'deck-nodes';
      gone.forEach((t) => appendSubject(box, t));
      side.appendChild(box);
    }
  }
}

function sideHead(text) {
  const h = document.createElement('div');
  h.className = 'deck-sec-h';
  h.textContent = text;
  return h;
}

function deckNodeAll(n) {
  const b = document.createElement('button');
  b.className = `deck-node${deckView.deck === null ? ' active' : ''}`;
  b.innerHTML = `<span class="dn-caret"></span><span class="dn-name">전체</span><span class="dt-n">${n}</span>`;
  b.onclick = () => { deckView.deck = null; clearSel(); renderDeck(); };
  return b;
}

function appendSubject(host, t) {
  const open = deckView.openSubs.has(t.key);
  const row = document.createElement('div');
  row.className = 'deck-node-row';

  const b = document.createElement('button');
  b.className = `deck-node${deckView.deck === t.key ? ' active' : ''}${t.archived ? ' archived' : ''}`;
  const caret = t.notes.length > 1 ? (open ? '▾' : '▸') : '';
  b.innerHTML = `<span class="dn-caret">${caret}</span><span class="dn-name"></span>${countHtml(t)}`;
  b.querySelector('.dn-name').textContent = t.subject;
  b.onclick = () => { deckView.deck = t.key; clearSel(); renderDeck(); };

  if (t.notes.length > 1) {
    const c = b.querySelector('.dn-caret');
    c.classList.add('tap');
    c.onclick = (e) => {
      e.stopPropagation();
      if (open) deckView.openSubs.delete(t.key); else deckView.openSubs.add(t.key);
      renderDeck();
    };
  }
  row.appendChild(b);
  row.appendChild(archBtn(t.key, t.archived, t.subject));
  host.appendChild(row);

  if (!open) return;
  for (const n of t.notes) {
    const nrow = document.createElement('div');
    nrow.className = 'deck-node-row';
    const nb = document.createElement('button');
    nb.className = `deck-node sub${deckView.deck === n.key ? ' active' : ''}${n.archived ? ' archived' : ''}`;
    nb.innerHTML = `<span class="dn-caret"></span><span class="dn-name"></span>${countHtml(n)}`;
    nb.querySelector('.dn-name').textContent = n.group ? `${n.name} (${n.group})` : n.name;
    nb.onclick = () => { deckView.deck = n.key; clearSel(); renderDeck(); };
    nrow.appendChild(nb);
    nrow.appendChild(archBtn(n.key, n.archived, n.name));
    host.appendChild(nrow);
  }
}

/**
 * 덱 한 칸의 숫자. 파란 알약이 **오늘 볼 장수**, 회색이 전체.
 * 둘이 같으면(= 전부 새 카드) 같은 수가 두 번 찍혀서 지저분하다 — 하나만 쓴다.
 */
function countHtml(d) {
  if (d.due && d.due === d.n) return `<span class="dn-due">${d.due}</span>`;
  return (d.due ? `<span class="dn-due">${d.due}</span>` : '') + `<span class="dt-n">${d.n}</span>`;
}

/** 보관/되돌리기 — 지우는 게 아니라 숨기는 것이라 기록은 그대로 남는다. */
function archBtn(key, archived, label) {
  const a = document.createElement('button');
  a.className = `deck-arch${archived ? ' on' : ''}`;
  a.textContent = archived ? '복원' : '보관';
  a.title = archived ? `${label} 되돌리기` : `${label} 보관 — 오늘 볼 것에서 빠집니다`;
  a.onclick = async (e) => {
    e.stopPropagation();
    if (archived) deckView.archived.delete(key); else deckView.archived.add(key);
    if (!archived && deckView.deck === key) deckView.deck = null;
    await saveArchived();
    toast(archived ? `${label}을(를) 되살렸습니다.` : `${label}을(를) 보관했습니다 — 오늘 볼 것에서 빠집니다.`);
    renderDeck();
  };
  return a;
}

// ── 오른쪽: 요약 + 카드 ──
function renderDeckMain() {
  const { srs, archived } = deckView;
  const scoped = deckScope();
  const g = groupCards(scoped, srs);
  const stats = document.getElementById('deckStats');
  stats.innerHTML = '';

  // 어디를 보고 있는지 — 덱을 고르면 제목과 빠져나갈 길을 보여준다
  if (deckView.deck) {
    const crumb = document.createElement('div');
    crumb.className = 'deck-crumb';
    const name = document.createElement('b');
    const t = deckView.deck.startsWith('s:')
      ? deckView.deck.slice(2)
      : (scoped[0] ? deckOf(scoped[0]).note : deckView.deck.slice(2));
    name.textContent = t;
    const up = document.createElement('button');
    up.className = 'deck-btn';
    up.textContent = '전체 보기';
    up.onclick = () => { deckView.deck = null; clearSel(); renderDeck(); };
    crumb.append(name, up);
    if (archived.has(deckView.deck)) {
      const tag = document.createElement('span');
      tag.className = 'deck-arch-tag';
      tag.textContent = '보관됨 — 오늘 볼 것에서 빠져 있습니다';
      crumb.appendChild(tag);
    }
    stats.appendChild(crumb);
  }

  const startable = studyQueue(scoped, srs);
  if (startable.length) {
    const go = document.createElement('button');
    go.className = 'btn primary full';
    const n = Math.min(startable.length, 40);
    go.textContent = `오늘 분량 풀기 (${n}장${startable.length > n ? ` / ${startable.length}` : ''})`;
    go.onclick = () => startDeck(startable.slice(0, 40), '카드 복습', { backTo: 'deck' });
    stats.appendChild(go);
  } else {
    stats.appendChild(muted('오늘 볼 카드가 없습니다 — 잘 하고 있습니다.'));
  }

  const body = document.getElementById('deckBody');
  body.innerHTML = '';
  const list = deckView.group === 'all' ? scoped : (g[deckView.group] || []);
  deckView.list = list;                      // 전체 선택이 쓴다(화면에 그린 120장 말고 전부)
  if (!list.length) {
    body.appendChild(muted('이 칸에는 카드가 없습니다.'));
    return;
  }
  if (!deckView.sel) {
    const hint = document.createElement('p');
    hint.className = 'muted deck-hint';
    hint.textContent = '카드를 길게 누르면 여러 장을 골라 한꺼번에 처리할 수 있습니다.';
    body.appendChild(hint);
  }
  const grid = document.createElement('div');
  grid.className = 'deck-grid';
  list.slice(0, 120).forEach((c, i) => grid.appendChild(deckCard(c, srs, i)));
  bindSweep(grid);                       // 고르기 중에는 쓸어서 여러 장
  body.appendChild(grid);
  if (list.length > 120) {
    const more = document.createElement('p');
    more.className = 'muted deck-hint';
    more.textContent = `… 외 ${list.length - 120}장 (전체 선택은 ${list.length}장 모두에 적용됩니다)`;
    body.appendChild(more);
  }
}

// ── 여러 장 고르기 (2026-10-12) ──
//
// 한 장씩 ★·버리기를 누르는 건 카드가 20장일 때 이야기다. 수천 장에서는
// "이 노트 카드 전부 버리기"가 필요하다. Anki의 카드 브라우저가 하는 일이다.
// 아이패드에는 오른쪽 클릭이 없으니 **길게 누르기**로 들어간다.

const LONG_PRESS_MS = 420;

// 길게 누르면 손을 뗄 때 click이 따라온다 — 그대로 두면 "범위 선택" 직후에 그 카드가
// 다시 토글돼 한 장이 빠진다. 게다가 길게 누르기 핸들러가 화면을 다시 그리므로
// 그 click이 **새로 그려진 카드**에 떨어지기도 한다. 그래서 요소에 거는 대신
// 잠깐 동안 탭 자체를 무시한다.
let tapDeadline = 0;
const swallowTap = () => { tapDeadline = Date.now() + 450; };
const tapSwallowed = () => Date.now() < tapDeadline;

function selOn() { return !!deckView.sel; }
function clearSel() { deckView.sel = null; deckView.lastIdx = null; deckView.confirmDel = false; }

function startSel(id, idx) {
  deckView.sel = new Set(id ? [id] : []);
  deckView.lastIdx = idx == null ? null : idx;
  deckView.confirmDel = false;
  renderDeck();
}

function toggleSel(id, idx) {
  if (!deckView.sel || tapSwallowed()) return;
  if (deckView.sel.has(id)) deckView.sel.delete(id); else deckView.sel.add(id);
  deckView.lastIdx = idx;
  deckView.confirmDel = false;
  renderDeck();
}

/**
 * 범위 선택 — 고르기 중에 다른 카드를 길게 누르면 **마지막으로 누른 것부터 거기까지** 전부.
 * 아이패드에는 shift+클릭이 없어서(Anki 브라우저의 그 동작) 길게 누르기에 얹었다.
 * 한 장씩 40번 두드리는 것과 두 번 누르는 것의 차이다.
 */
function selectRange(idx) {
  const list = deckView.list || [];
  const from = deckView.lastIdx == null ? idx : deckView.lastIdx;
  const [a, b] = from <= idx ? [from, idx] : [idx, from];
  for (let i = a; i <= b && i < list.length; i++) deckView.sel.add(list[i].id);
  deckView.lastIdx = idx;
  deckView.confirmDel = false;
  toast(`${b - a + 1}장을 한 번에 골랐습니다.`);
  renderDeck();
}

/** 길게 누르면 선택 모드. 손가락이 움직이면(스크롤) 취소한다. */
let _lpCancel = null;                  // 지금 돌고 있는 길게누르기 타이머를 끊는 함수
function cancelLongPress() { if (_lpCancel) _lpCancel(); }

function bindLongPress(el, onLong) {
  let timer = null;
  let sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); timer = null; if (_lpCancel === stop) _lpCancel = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      el.classList.remove('pressing');
      swallowTap();
      onLong();
    }, LONG_PRESS_MS);
    el.classList.add('pressing');
    _lpCancel = stop;
  });
  function stop() { cancel(); el.classList.remove('pressing'); }
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('pointermove', (e) => {
    if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) stop();
  });
}

// ── 쓸어서 여러 장 고르기 (2026-10-13) ──
//
// 고르기 모드에서는 **손가락이 지나간 카드가 그대로 골라진다**. 한 장씩 탭하면
// 20장에 20번을 두드려야 한다 — 쓸면 한 번이다(사진 앱의 다중 선택과 같은 동작).
//
// 첫 카드에서 정해진 방향(켠다/끈다)을 끝까지 유지한다. 이게 없으면 손가락이
// 떨려 같은 카드를 두 번 지날 때 켰다 껐다 해서 결과를 예측할 수 없다.
let sweep = null;      // {mode:'on'|'off', seen:Set}

function sweepAt(x, y) {
  if (!sweep) return;
  const el = document.elementFromPoint(x, y);
  const card = el && el.closest && el.closest('.deck-card');
  if (!card || !card.dataset.i) return;
  const id = (deckView.list || [])[Number(card.dataset.i)]?.id;
  if (!id || sweep.seen.has(id)) return;
  sweep.seen.add(id);
  if (sweep.mode === 'on') deckView.sel.add(id); else deckView.sel.delete(id);
  card.classList.toggle('picked', deckView.sel.has(id));
  const tick = card.querySelector('.deck-tick');
  if (tick) tick.textContent = deckView.sel.has(id) ? '✓' : '';
  document.querySelector('#deckSelBar .sel-n')
    && (document.querySelector('#deckSelBar .sel-n').textContent = `${deckView.sel.size}장 선택`);
}

/**
 * 고르기 모드일 때만 — 카드 격자 위를 쓸면 지나간 카드가 골라진다.
 *
 * ⚠️ **움직이기 전에는 아무것도 하지 않는다.** 누르자마자 고르면 기존 동작 둘을
 * 망가뜨린다: ① 탭 한 번으로 켜고 끄기 ② 길게 눌러 범위 선택. 손가락이 실제로
 * 10px 넘게 움직인 순간에야 쓸기로 넘어간다(2026-10-13에 이 충돌을 그대로 겪음).
 */
function bindSweep(grid) {
  let armed = null;        // {x, y, id} — 누르긴 했는데 아직 안 움직였다
  let active = false;

  grid.addEventListener('pointerdown', (e) => {
    if (!selOn() || (e.button != null && e.button !== 0)) return;
    const card = e.target.closest && e.target.closest('.deck-card');
    if (!card || !card.dataset.i) return;
    const id = (deckView.list || [])[Number(card.dataset.i)]?.id;
    if (!id) return;
    armed = { x: e.clientX, y: e.clientY, id, pointerId: e.pointerId };
  });

  grid.addEventListener('pointermove', (e) => {
    if (!armed && !active) return;
    if (!active) {
      if (Math.abs(e.clientX - armed.x) < 10 && Math.abs(e.clientY - armed.y) < 10) return;
      // 이제야 쓸기다 — 길게 누르기 타이머를 끊고 시작한다
      cancelLongPress();
      // 첫 카드의 현재 상태가 방향을 정한다(켜는 쓸기 / 끄는 쓸기).
      // 이게 없으면 손이 떨려 같은 카드를 두 번 지날 때 켰다 껐다 한다.
      sweep = { mode: deckView.sel.has(armed.id) ? 'off' : 'on', seen: new Set() };
      active = true;
      try { grid.setPointerCapture(armed.pointerId); } catch {}
      sweepAt(armed.x, armed.y);
    }
    e.preventDefault();                 // 세로 스크롤에 뺏기지 않게
    sweepAt(e.clientX, e.clientY);
  });

  const end = () => {
    armed = null;
    if (!active) return;                // 안 움직였으면 탭·길게누르기에 맡긴다
    active = false;
    swallowTap();                       // 손을 뗄 때 따라오는 click을 먹는다
    sweep = null;
    deckView.confirmDel = false;
    renderDeck();
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
}

function renderSelBar() {
  const bar = document.getElementById('deckSelBar');
  bar.innerHTML = '';
  if (!selOn()) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const ids = deckView.sel;
  const list = deckView.list || [];
  const allSelected = list.length > 0 && list.every((c) => ids.has(c.id));

  const n = document.createElement('span');
  n.className = 'sel-n';
  n.textContent = `${ids.size}장 선택`;
  bar.appendChild(n);

  const btn = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = `sel-btn2${cls ? ' ' + cls : ''}`;
    b.textContent = label;
    b.disabled = !ids.size && !/전체|취소/.test(label);
    b.onclick = fn;
    bar.appendChild(b);
    return b;
  };

  btn(allSelected ? '전체 해제' : `전체 선택 (${list.length})`, () => {
    if (allSelected) deckView.sel = new Set();
    else deckView.sel = new Set(list.map((c) => c.id));
    deckView.confirmDel = false;
    renderDeck();
  });
  btn('★ 중요', () => bulk((srs, id) => { if (!isStarred(srs, id)) toggleStar(srs, id); }, '중요 표시했습니다'));
  btn('☆ 해제', () => bulk((srs, id) => { if (isStarred(srs, id)) toggleStar(srs, id); }, '중요 표시를 뺐습니다'));
  btn('💤 내일로', () => bulk((srs, id) => buryCard(srs, id), '내일 다시 나옵니다'));
  btn('🗑 버리기', () => bulk((srs, id) => suspendCard(srs, id), '버렸습니다 — 다시 안 나옵니다'));
  btn('↩ 되살리기', () => bulk((srs, id) => unsuspendCard(srs, id), '되살렸습니다'));
  btn('▶ 선택만 풀기', () => {
    const picked = (deckView.cards || []).filter((c) => ids.has(c.id));
    if (picked.length) startDeck(picked, `고른 카드 ${picked.length}장`, { backTo: 'deck' });
  }, 'primary');

  // 되돌릴 수 있으니 두 번 묻지 않는다 — 묻고 또 묻는 것보다 손이 덜 간다(2026-10-14)
  btn(`삭제 (${ids.size}장)`, async () => {
    const all = await allCards();
    const picked2 = all.filter((c) => ids.has(c.id));
    clearSel();
    await deleteCardsUndoable(picked2, () => openDeck(true));
  }, 'danger');

  btn('취소', () => { clearSel(); renderDeck(); });
}

async function bulk(fn, msg) {
  const { srs } = deckView;
  const ids = [...deckView.sel];
  ids.forEach((id) => fn(srs, id));
  await saveSrs(srs);
  backup.scheduleBackup();
  toast(`${ids.length}장 — ${msg}.`);
  clearSel();
  renderDeck();
}

/** 카드 미리보기 한 장 — 눌러서 답을 열어보고, 거기서 바로 골라낸다. */
function deckCard(c, srs, idx = 0) {
  const st = srs[c.id] || {};
  const card = document.createElement('div');
  const picked = selOn() && deckView.sel.has(c.id);
  card.className = `deck-card${selOn() ? ' selectable' : ''}${picked ? ' picked' : ''}`;
  card.dataset.i = String(idx);          // 쓸어서 고르기가 이걸로 카드를 찾는다

  const topic = document.createElement('div');
  topic.className = 'deck-topic';
  topic.textContent = c.topic || c.heading || c.noteTitle || '';

  const q = document.createElement('div');
  q.className = 'deck-q';
  setCardBody(q, c.contextHtml);
  q.querySelectorAll('.cloze').forEach((el) => { el.textContent = '____'; });

  const a = document.createElement('div');
  a.className = 'deck-a hidden';
  a.textContent = (c.answers || []).join('  /  ');

  const meta = document.createElement('div');
  meta.className = 'deck-meta';
  const bits = [];
  if (st.due) {
    const d = Math.ceil((st.due - Date.now()) / 86400000);
    bits.push(d <= 0 ? '오늘' : `${d}일 뒤`);
  } else bits.push('새 카드');
  if (st.S != null) bits.push(`기억 ${Math.round(retrievability(st) * 100)}%`);
  if (st.lapses) bits.push(`${st.lapses}번 틀림`);
  // 어느 덱에서 왔는지 — 전체 보기에서 섞여 있으면 이게 없으면 분간이 안 된다
  if (!deckView.deck) bits.push(deckOf(c).subject);
  meta.textContent = bits.join(' · ');

  card.append(topic, q, a, meta);

  if (selOn()) {
    const tick = document.createElement('span');
    tick.className = 'deck-tick';
    tick.textContent = picked ? '✓' : '';
    card.appendChild(tick);
    card.onclick = () => toggleSel(c.id, idx);
    bindLongPress(card, () => selectRange(idx));   // 길게 = 여기까지 한 번에
    return card;
  }

  const acts = document.createElement('div');
  acts.className = 'deck-acts';
  const peek = document.createElement('button');
  peek.className = 'deck-btn';
  peek.textContent = '답';
  peek.onclick = () => { a.classList.toggle('hidden'); peek.classList.toggle('on'); };
  const star = document.createElement('button');
  star.className = `deck-btn${isStarred(srs, c.id) ? ' on' : ''}`;
  star.textContent = isStarred(srs, c.id) ? '★' : '☆';
  star.onclick = async () => { toggleStar(srs, c.id); await saveSrs(srs); backup.scheduleBackup(); renderDeck(); };
  const dropped = isSuspended(srs, c.id);
  const drop = document.createElement('button');
  drop.className = 'deck-btn';
  drop.textContent = dropped ? '되살리기' : '버리기';
  drop.onclick = async () => {
    if (dropped) unsuspendCard(srs, c.id); else suspendCard(srs, c.id);
    await saveSrs(srs); backup.scheduleBackup(); renderDeck();
  };
  const pick = document.createElement('button');
  pick.className = 'deck-btn';
  pick.textContent = '선택';
  pick.title = '여러 장 고르기 — 카드를 길게 눌러도 됩니다';
  pick.onclick = () => startSel(c.id, idx);
  acts.append(peek, star, drop, pick);
  if (dropped) {
    const del = document.createElement('button');
    del.className = 'deck-btn danger';
    del.textContent = '삭제';
    del.onclick = () => deleteCardsUndoable(c, () => openDeck(true));
    acts.appendChild(del);
  }

  card.appendChild(acts);
  bindLongPress(card, () => startSel(c.id, idx));
  return card;
}

document.getElementById('deckBack').onclick = () => {
  // 고르던 중이면 먼저 고르기부터 빠져나온다 — 실수로 화면을 떠나지 않게
  if (selOn()) { clearSel(); renderDeck(); return; }
  show('listScreen');
};
document.getElementById('deckRefresh').onclick = () => { deckView.exam = null; clearSel(); openDeck(); };

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ═══════════ Phase 5 — 검색 ═══════════

// ── 찾기 ───────────────────────────────────────────────────
// 범위를 고르게 한 이유: "이 문서 안에서"가 압도적으로 많은데 전체 검색만 있어서
// 결과가 딴 데 것으로 뒤덮였다. obsidian-another-quick-switcher의 custom search처럼
// 범위(이 문서/이 폴더/전체)와 정규식을 앞에 꺼내 뒀다(2026-10-13 요청).

const sEl = (id) => document.getElementById(id);
let searchScope = 'all';        // doc | dir | all
let searchOpt = { regex: false, caseSensitive: false };
let docHits = [];               // 이 문서 안에서 찾은 자리들
let docHitAt = -1;

/**
 * 지금 화면에 떠 있는 "그 문서".
 *
 * 노트 읽기면 읽는 노트, **퀴즈·모의고사면 옆에 뜬 관련 노트**다.
 * 문제는 그 위키를 바탕으로 만들어지므로, 풀다가 찾을 곳도 거기다 — 그런데
 * 퀴즈 화면에서는 "이 문서"가 아예 안 눌렸다(2026-10-13 지적).
 * @returns {{title, path, sections}|null}
 */
function currentDoc() {
  if (reader && reader.note && document.body.dataset.screen === 'readScreen') {
    return { title: reader.note.title, path: reader.note.path, sections: reader.note.sections };
  }
  const r = wikiState && wikiState.refs;
  if (r && r.sections && r.sections.length) {
    return { title: r.noteName, path: r.notePath || '', sections: r.sections };
  }
  if (reader && reader.note) {
    return { title: reader.note.title, path: reader.note.path, sections: reader.note.sections };
  }
  return null;
}

/** 그 문서가 들어 있는 폴더. 없으면 null. */
function currentDir() {
  const d = currentDoc();
  if (!(d && d.path)) return null;
  return d.path.slice(0, d.path.lastIndexOf('/'));
}

function setScope(scope) {
  // 볼 문서가 없으면 "이 문서"·"이 폴더"는 의미가 없다 — 전체로 돌린다
  const doc = currentDoc();
  const canDoc = !!doc;
  searchScope = (scope === 'doc' || scope === 'dir') && !canDoc ? 'all' : scope;
  document.querySelectorAll('#searchSheet .scope-btn[data-scope]').forEach((b) => {
    b.classList.toggle('on', b.dataset.scope === searchScope);
    b.disabled = !canDoc && b.dataset.scope !== 'all';
  });
  const dir = currentDir();
  sEl('searchInput').placeholder =
    searchScope === 'doc' ? `${doc.title} 안에서 찾기`
      : searchScope === 'dir' ? `${(dir || '').split('/').pop()} 폴더에서 찾기`
        : '열어본 모든 자료에서 찾기';
  runSearch(sEl('searchInput').value);
}

/**
 * 찾기 열기.
 * @param {string} [scope] 'doc'이면 이 문서 안에서(⌘F), 'all'이면 전체(⌘⇧F)
 */
function openSearch(scope) {
  sEl('searchSheet').classList.remove('hidden');
  document.body.classList.add('finding');
  setScope(scope || (currentDoc() ? 'doc' : 'all'));
  const inp = sEl('searchInput');
  inp.focus();
  inp.select();
}
/**
 * 찾기 창을 닫는다.
 * @param {{keepMarks?:boolean}} [opt] 칠해둔 자리를 잠깐 남길지 —
 *        결과를 눌러 그리로 갈 때는 남겨야 눈이 따라간다. 잠시 뒤 스스로 사라진다.
 */
function closeSearch({ keepMarks = false } = {}) {
  sEl('searchSheet').classList.add('hidden');
  document.body.classList.remove('finding');
  if (keepMarks) fadeDocMarks(); else clearDocMarks();
  paintFindFab();
}

const MARK_LINGER = 4000;      // 칠해둔 자리를 이만큼 두고 지운다
let markTimer = 0;
/** 칠해둔 자리를 잠깐 두었다가 스르르 지운다. */
function fadeDocMarks() {
  clearTimeout(markTimer);
  const marks = [...document.querySelectorAll('mark.find-mark')];
  if (!marks.length) return;
  markTimer = setTimeout(() => {
    marks.forEach((m) => m.classList.add('fading'));
    markTimer = setTimeout(clearDocMarks, 600);
  }, MARK_LINGER);
}
sEl('searchBtn').onclick = () => openSearch();
document.getElementById('toolFind').onclick = () => openSearch();
// 늘 떠 있는 돋보기 — 그냥 누르면 보던 문서 안에서, 길게 누르면 vault 전체에서
{
  const fab = document.getElementById('findFab');
  if (fab) {
    fab.onclick = () => openSearch();
    longPress(fab, () => openSearch('all'));
  }
}
sEl('searchClose').onclick = closeSearch;
sEl('searchSheet').onclick = (e) => { if (e.target.id === 'searchSheet') closeSearch(); };
document.querySelectorAll('#searchSheet .scope-btn[data-scope]')
  .forEach((b) => { b.onclick = () => setScope(b.dataset.scope); });
sEl('searchRegex').onclick = (e) => {
  searchOpt.regex = !searchOpt.regex;
  e.currentTarget.classList.toggle('on', searchOpt.regex);
  runSearch(sEl('searchInput').value);
};
sEl('searchCase').onclick = (e) => {
  searchOpt.caseSensitive = !searchOpt.caseSensitive;
  e.currentTarget.classList.toggle('on', searchOpt.caseSensitive);
  runSearch(sEl('searchInput').value);
};

// ── 말로 받아쓰기 ────────────────────────────────────────
// 아이패드에서 쓸 수 있는 길은 둘이다:
//   ① 웹 음성 인식(webkitSpeechRecognition) — 되는 기기에서는 이 단추로 바로 받는다.
//   ② 안 되면 키보드의 🎤(시스템 받아쓰기) — 글자 칸에 커서를 두고 쓰면 된다.
// 마우스 버튼 하나를 AssistiveTouch로 "보조 클릭"에 걸어두면 ①까지 손 안 떼고 간다.
let recog = null;
function dictate(input, onDone) {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) {
    toast('이 기기는 앱 받아쓰기를 지원하지 않습니다 — 글자 칸을 누르고 키보드의 🎤 를 쓰세요.');
    input.focus();
    return;
  }
  if (recog) { try { recog.stop(); } catch {} recog = null; return; }
  recog = new Rec();
  recog.lang = 'ko-KR';
  recog.interimResults = true;
  recog.continuous = false;
  const mic = document.getElementById('searchMic');
  mic && mic.classList.add('on');
  recog.onresult = (e) => {
    input.value = [...e.results].map((r) => r[0].transcript).join('');
    onDone && onDone(input.value);
  };
  const end = () => { mic && mic.classList.remove('on'); recog = null; };
  recog.onerror = end;
  recog.onend = end;
  try { recog.start(); } catch { end(); }
}
sEl('searchMic').onclick = () =>
  dictate(sEl('searchInput'), (v) => runSearch(v));

let searchTimer = null;
sEl('searchInput').oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 200);
};
// Enter로 다음, Shift+Enter로 이전 — 브라우저 찾기와 같은 손버릇
sEl('searchInput').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stepDocHit(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
};

async function runSearch(q) {
  const msg = sEl('searchMsg');
  const box = sEl('searchResults');
  if (String(q).trim().length < 2) {
    box.innerHTML = ''; msg.textContent = ''; clearDocMarks(); return;
  }
  if (searchScope === 'doc') { runDocSearch(q); return; }
  clearDocMarks();
  msg.textContent = '찾는 중…';
  const hits = await search(q, 60, { ...searchOpt, dir: searchScope === 'dir' ? currentDir() : null });
  box.innerHTML = '';
  if (!hits.length) {
    if (searchOpt.regex && !matcher(q, searchOpt)) { msg.textContent = '정규식이 올바르지 않습니다.'; return; }
    const info = await indexInfo();
    if (info.built) { msg.textContent = `결과가 없습니다. (글 ${info.files}개를 뒤졌습니다)`; return; }
    // 아직 전체를 안 받았으면 **여기서 바로** 받게 한다 — 설정까지 찾아가게 하지 않는다
    msg.textContent = '결과가 없습니다 — 아직 열어본 자료만 찾고 있습니다.';
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.style.marginTop = '10px';
    b.textContent = '📚 vault 글 전체 받아두기 (한 번만)';
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '받는 중… 잠시만';
      const r = await runIndex({ quiet: true });
      b.remove();
      if (r) { msg.textContent = `글 ${r.total}개를 받았습니다 — 다시 찾습니다.`; runSearch(q); }
      else msg.textContent = '받지 못했습니다 — 연결을 확인해 주세요.';
    };
    box.appendChild(b);
    return;
  }
  msg.textContent = `${hits.length}건`;
  for (const h of hits) {
    const b = document.createElement('button');
    b.className = 'search-hit';
    const t = document.createElement('div');
    t.className = 'sh-title';
    t.textContent = `${h.kind === 'question' ? '📝' : '📖'} ${h.title}`;
    const s = document.createElement('div');
    s.className = 'sh-snip';
    s.append(h.snippet.before);
    const mk = document.createElement('mark');
    mk.textContent = h.snippet.match;
    s.append(mk, h.snippet.after);
    b.append(t, s);
    b.onclick = () => {
      closeSearch();
      // 같은 노트에서 여러 건이 나오면 **그 자리**로 간다 — 열어놓고 다시 찾게 하지 않는다
      if (h.kind === 'note') openNote(h.path).then(() => { if (h.at != null) jumpToOffset(h.at); });
      else openExamAt(h.path, h.qnum);
    };
    // 오래 누르면 **열지 않고 들러본다** — 읽던 자리를 잃지 않게(2026-10-15 요청)
    if (h.kind === 'note') {
      b.title = '길게 누르면 열지 않고 들러봅니다';
      longPress(b, () => openPeek(h));
    }
    box.appendChild(b);
  }
}

// ═══════════ 살짝 들러보기 (2026-10-15 요청) ═══════════
//
// "노트 읽다가 다른 내용 잠깐 찾아보고 싶을 때가 꽤 많은데 지금 찾기에서는 아주 불편함."
// 맞다 — 지금은 결과를 누르면 **읽던 문서를 떠나** 그리로 간다. 잠깐 확인하려던 것이
// 자리를 잃게 만든다. 옵시디언의 [Cmd ,] preview가 푸는 문제가 정확히 이것이다.
//
// 세 길을 한 창에 모았다. 결과를 **오래 누르면** 뜨고,
//   · 그 자리에서 읽는다(걸린 곳이 노랗게 칠해져 있다)
//   · ‹ 앞 / 뒤 › 로 앞뒤 장을 넘겨본다 — 맥락이 필요할 때가 많다
//   · 마음에 들면 "여기서 열기" 또는 "⫽ 옆에 띄우기"
// 그냥 누르면 전처럼 바로 연다 — 빠른 길을 잃지 않게.

let peekFloat = null;
let peekState = null;      // {note, secIdx, at, len}

function initPeek() {
  peekFloat = makeFloat({
    panel: 'peekFloat', head: 'pkHead', grip: 'pkResize', key: 'peek_float_box',
    def: { w: Math.min(620, innerWidth * 0.94), h: Math.min(520, innerHeight * 0.64) },
  });
  document.getElementById('pkClose').onclick = closePeek;
  const step = (d) => {
    if (peekState && (peekState.hits || []).length > 1) movePeekHit(d);
    else movePeek(d);
  };
  document.getElementById('pkPrev').onclick = () => step(-1);
  document.getElementById('pkNext').onclick = () => step(1);
  document.getElementById('pkOpen').onclick = () => {
    if (!peekState) return;
    const { note, secIdx } = peekState;
    closePeek();
    closeSearch();
    openNote(note.path).then(() => {
      if (reader && reader.note && reader.note.path === note.path && reader.secIdx !== secIdx) {
        reader.secIdx = secIdx;
        renderReader();
      }
    });
  };
  document.getElementById('pkSplit').onclick = async () => {
    if (!peekState) return;
    const { note, secIdx } = peekState;
    closePeek();
    closeSearch();
    // 읽기 화면이 아직 아니면 먼저 세운다 — 옆칸만 띄울 수는 없다
    if (document.body.dataset.screen !== 'readScreen' || !reader) { await openNote(note.path); return; }
    if (paneCount() >= 2) openInPane(note, { pane: 1, secIdx });
    else await splitPane(note);
    const p2 = panes[1];
    if (p2 && p2.tabs.length) {
      const t = p2.tabs.find((x) => x.note.path === note.path);
      if (t) t.secIdx = secIdx;
    }
    renderPanes();
  };
}

function closePeek() {
  document.getElementById('peekFloat').classList.add('hidden');
  peekState = null;
}

/** 앞뒤 장을 넘겨본다 — 걸린 자리만 보면 무슨 이야기인지 모를 때가 있다. */
function movePeek(d) {
  if (!peekState) return;
  const n = peekState.note;
  const i = Math.max(0, Math.min(n.sections.length - 1, peekState.secIdx + d));
  if (i === peekState.secIdx) return;
  peekState.secIdx = i;
  paintPeek();                      // 찾던 말이 그 장에도 있으면 거기서도 칠해진다
}

/**
 * 찾기 결과 한 건을 창에 띄운다.
 * @param {{path,title,at}} hit  search()가 준 것
 */
async function openPeek(hit) {
  const body = document.getElementById('pkBody');
  document.getElementById('peekFloat').classList.remove('hidden');
  if (peekFloat) peekFloat.place();
  document.getElementById('pkTitle').textContent = hit.title || '들러보기';
  body.innerHTML = '<p class="muted">여는 중…</p>';
  try {
    const note = await loadNote(hit.path);
    // 걸린 글자가 몇 번째 장에 있는지 — jumpToOffset과 같은 셈법
    let secIdx = 0;
    let seen = 0;
    for (let i = 0; i < note.sections.length; i++) {
      const len = note.sections[i].text.length + 1;
      if ((hit.at || 0) < seen + len) { secIdx = i; break; }
      seen += len;
    }
    showPeek(note, secIdx, hit.snippet ? hit.snippet.match : '', hit.title);
  } catch (e) {
    body.innerHTML = `<p class="muted">열지 못했습니다: ${escapeHtml(e.message)}</p>`;
  }
}

/**
 * 이미 들고 있는 문서를 그 자리에서 들러본다 — 다시 받지 않는다.
 *
 * "이 문서" 범위로 찾을 때 쓴다. 그 범위는 **지금 열려 있는 문서** 안에서 찾는 것이라
 * 경로로 다시 불러올 이유가 없다(2026-10-16 신고: "이 문서에서 검색하면 오래 눌러도
 * 해당 창이 안보이네?" — 전체 검색 쪽에만 들러보기를 달아뒀었다).
 *
 * @param {{title,path,sections}} note
 * @param {number} secIdx  보여줄 장
 * @param {string} needle  노랗게 칠할 말
 */
function showPeek(note, secIdx, needle, title) {
  document.getElementById('peekFloat').classList.remove('hidden');
  if (peekFloat) peekFloat.place();
  document.getElementById('pkTitle').textContent = title || note.title || '들러보기';
  const at = Math.max(0, Math.min(secIdx || 0, note.sections.length - 1));
  // 찾던 말이 **이 문서 전체에 몇 군데** 있는지 미리 센다 — 한 장만 보고 끝낼 일이 아니다
  // (2026-10-17 요청: "몇개 중에 몇번째 찾는건지? 다음 검색 이전검색 되게 해줘").
  const hits = peekHits(note, needle);
  // 열어준 장에 걸린 자리부터 보여준다 — 누른 그 자리에서 시작해야 말이 된다
  let hitAt = hits.findIndex((h) => h.sec === at);
  if (hitAt < 0) hitAt = hits.length ? 0 : -1;
  peekState = { note, secIdx: hitAt >= 0 ? hits[hitAt].sec : at, needle: needle || '', hits, hitAt };
  paintPeek();
}

/** 문서 전체에서 그 말이 나오는 자리 — [{sec, ord}] (ord는 그 장 안에서 몇 번째인가). */
function peekHits(note, needle) {
  const want = String(needle || '').normalize('NFC').trim();
  if (want.length < 1) return [];
  const out = [];
  note.sections.forEach((sec, si) => {
    const hay = String(sec.text || '').normalize('NFC');
    let from = 0;
    let ord = 0;
    for (;;) {
      const i = hay.indexOf(want, from);
      if (i < 0) break;
      out.push({ sec: si, ord });
      ord++;
      from = i + want.length;
    }
  });
  return out;
}

/** 찾은 자리 사이를 오간다. 끝에서 넘기면 처음으로 돌아온다(문서 안 찾기와 같다). */
function movePeekHit(d) {
  if (!peekState || !peekState.hits.length) return;
  const n = peekState.hits.length;
  peekState.hitAt = ((peekState.hitAt + d) % n + n) % n;
  peekState.secIdx = peekState.hits[peekState.hitAt].sec;
  paintPeek();
}

function paintPeek() {
  if (!peekState) return;
  const { note, secIdx } = peekState;
  const sec = note.sections[secIdx] || { heading: '', text: '' };
  document.getElementById('pkWhere').textContent =
    `${secIdx + 1}/${note.sections.length}${sec.heading ? ` · ${sec.heading}` : ''}`;
  const body = document.getElementById('pkBody');
  // ⚠️ renderSection이 **이미** 그림을 불러온다(reader.js). 여기서 또 부르면 안 된다 —
  //    hydrateEmbeds의 둘째 인자는 경로가 아니라 **이름 → 주소 함수**라, 경로 문자열을
  //    넘기면 resolve(name)이 터지고 그 catch가 멀쩡히 뜨던 그림을 "불러오지 못했습니다"로
  //    갈아치웠다(2026-10-16 신고: "팝업으로 띄운 창에서는 왜 이미지 로드가 안됨?").
  renderSection(body, sec);

  // 걸린 자리가 있으면 ‹/›는 **자리 사이**를 오간다(장을 넘나든다). 없으면 장을 넘긴다.
  const hits = peekState.hits || [];
  const many = hits.length > 1;
  const prev = document.getElementById('pkPrev');
  const next = document.getElementById('pkNext');
  prev.disabled = many ? false : secIdx === 0;
  next.disabled = many ? false : secIdx >= note.sections.length - 1;
  prev.textContent = many ? '‹ 이전' : '‹ 앞';
  next.textContent = many ? '다음 ›' : '뒤 ›';
  prev.title = many ? '이전으로 찾은 곳' : '앞 장';
  next.title = many ? '다음으로 찾은 곳' : '뒤 장';

  // 몇 개 중 몇 번째인지 — 이게 없으면 더 있는지조차 모른다
  const where = `${secIdx + 1}/${note.sections.length}장${sec.heading ? ` · ${sec.heading}` : ''}`;
  document.getElementById('pkWhere').textContent = hits.length
    ? `찾은 곳 ${peekState.hitAt + 1}/${hits.length} · ${where}`
    : where;

  // 걸린 말을 **이 장에서 전부** 칠하고 지금 자리만 진하게 — 어디어디 있는지 보이게
  if (peekState.needle) {
    const cur = hits[peekState.hitAt];
    const ord = cur && cur.sec === secIdx ? cur.ord : 0;
    const active = markAllIn(body, peekState.needle, ord);
    if (active) requestAnimationFrame(() => active.scrollIntoView({ block: 'center' }));
    else body.scrollTop = 0;
  } else body.scrollTop = 0;
}

/**
 * 본문에서 그 말이 나오는 자리를 **전부** 칠한다. `ord`번째가 지금 자리(.on).
 * @returns 지금 자리의 요소(없으면 null)
 */
function markAllIn(root, needle, ord = 0) {
  const want = String(needle).normalize('NFC');
  if (!want.trim()) return null;
  // 뒤에서부터 바꾼다 — 앞을 먼저 바꾸면 뒤쪽 자리 번호가 밀린다
  const jobs = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walk.nextNode())) {
    const v = node.nodeValue.normalize('NFC');
    let from = 0;
    for (;;) {
      const i = v.indexOf(want, from);
      if (i < 0) break;
      jobs.push({ node, i });
      from = i + want.length;
    }
  }
  let active = null;
  for (let k = jobs.length - 1; k >= 0; k--) {
    const { node: n, i } = jobs[k];
    try {
      const after = n.splitText(i);
      after.splitText(want.length);
      const m = document.createElement('mark');
      m.className = `peek-hit${k === ord ? ' on' : ''}`;
      after.replaceWith(m);
      m.textContent = want;
      if (k === ord) active = m;
    } catch { /* 태그를 가로지르는 자리는 건너뛴다 */ }
  }
  return active;
}

/**
 * 노트를 연 뒤 **글자 위치**로 간다. 전체 검색 결과에서 넘어올 때 쓴다.
 * 섹션이 여럿이면 그 글자가 든 섹션을 찾아 넘긴다.
 */
function jumpToOffset(at) {
  if (!(reader && reader.note)) return;
  let seen = 0;
  for (let i = 0; i < reader.note.sections.length; i++) {
    const len = reader.note.sections[i].text.length + 1;
    if (at < seen + len) {
      if (reader.secIdx !== i) { reader.secIdx = i; renderReader(); }
      return;
    }
    seen += len;
  }
}

/** 이 문서 안에서 — 섹션별로 몇 군데 걸렸는지 보여주고 눌러서 그 자리로 간다. */
function runDocSearch(q) {
  const msg = sEl('searchMsg');
  const box = sEl('searchResults');
  box.innerHTML = '';
  docHits = []; docHitAt = -1;
  const match = matcher(q, searchOpt);
  if (!match) { msg.textContent = '정규식이 올바르지 않습니다.'; return; }
  const doc = currentDoc();
  if (!doc) { msg.textContent = '열려 있는 노트가 없습니다.'; return; }

  doc.sections.forEach((sec, i) => {
    for (const at of findAll(sec.text, match, 50)) docHits.push({ sec: i, ...at });
  });
  if (!docHits.length) { msg.textContent = '이 문서에는 없습니다.'; clearDocMarks(); return; }
  msg.textContent = `${docHits.length}군데 — Enter로 다음, Shift+Enter로 이전`;

  let lastSec = -1;
  docHits.forEach((h, idx) => {
    const sec = doc.sections[h.sec];
    if (h.sec !== lastSec) {
      lastSec = h.sec;
      const head = document.createElement('div');
      head.className = 'sh-group';
      head.textContent = `${h.sec + 1}. ${sec.heading}`;
      box.appendChild(head);
    }
    const b = document.createElement('button');
    b.className = 'search-hit';
    const s = document.createElement('div');
    s.className = 'sh-snip';
    const start = Math.max(0, h.at - 40);
    s.append((start ? '…' : '') + sec.text.slice(start, h.at).replace(/\n+/g, ' '));
    const mk = document.createElement('mark');
    mk.textContent = sec.text.slice(h.at, h.at + h.len);
    s.append(mk, sec.text.slice(h.at + h.len, h.at + h.len + 60).replace(/\n+/g, ' ') + '…');
    b.append(s);
    // 줄을 누르면 **그리로 가고 창을 닫는다**. 찾기 창은 화면의 3/4를 덮으므로
    // 열어둔 채로 보내면 간 자리가 창 뒤에 숨는다(2026-10-16 지적: "눌렀을 때 그 쪽으로
    // 가야지"). 칠해둔 자리는 잠깐 남겨 눈이 따라가게 한다.
    // 이어서 다음 자리로 넘길 때(Enter)는 창을 그대로 둔다 — 그건 훑는 손짓이다.
    b.onclick = () => { goDocHit(idx, { keepFocus: true }); closeSearch({ keepMarks: true }); };
    // 오래 누르면 **옮겨가지 않고** 그 장을 들러본다 — 전체 검색 쪽과 같은 손짓
    b.title = '길게 누르면 옮겨가지 않고 들러봅니다';
    longPress(b, () => showPeek(doc, h.sec, sec.text.slice(h.at, h.at + h.len), doc.title));
    box.appendChild(b);
  });
  goDocHit(0, { keepFocus: true });
}

/** n번째 자리로 간다 — 섹션을 넘기고, 그 글자에 표시를 남긴다. */
function goDocHit(idx, { keepFocus = false } = {}) {
  if (!docHits.length) return;
  docHitAt = (idx + docHits.length) % docHits.length;
  const h = docHits[docHitAt];
  const go = () => {
    markDocHit(h);
    sEl('searchMsg').textContent =
      `${docHitAt + 1}/${docHits.length}군데 — Enter로 다음, Shift+Enter로 이전`;
    if (!keepFocus) sEl('searchInput').focus();
  };
  // 그 자리가 다른 섹션이면 먼저 그리로 넘긴다. 노트 읽기와 퀴즈 옆 위키 패널은
  // 넘기는 방법이 다르다 — 어느 쪽이 떠 있든 같은 Enter로 다음 자리에 가야 한다.
  if (document.body.dataset.screen === 'readScreen' && reader) {
    if (reader.secIdx !== h.sec) { reader.secIdx = h.sec; renderReader(); setTimeout(go, 80); return; }
  } else if (wikiState && wikiState.refs) {
    if (wikiState.secIdx !== h.sec) {
      wikiState.secIdx = h.sec;
      wikiState.unlocked = true;        // 찾아서 간 자리는 보여줘야 뜻이 있다
      renderWikiSection();
      setTimeout(go, 80);
      return;
    }
  }
  go();
}
function stepDocHit(d) {
  if (!docHits.length) { runSearch(sEl('searchInput').value); return; }
  goDocHit(docHitAt + d);
}

/** 본문에서 그 자리를 노랗게 칠한다. 읽기 화면이면 본문, 퀴즈면 옆 위키 패널. */
/**
 * 걸린 자리를 칠한다 — **보이는 장의 것을 전부**, 지금 자리는 더 진하게.
 *
 * 전에는 지금 자리 하나만 칠하고 끝냈다(찾자마자 `break`). 그러면 한 장에 여러 군데가
 * 걸려도 눈에는 하나뿐이라, 어디어디 있는지 훑어볼 수가 없었다(2026-10-16 요청:
 * "찾은것들은 좀 하이라이트를 일시적이라도 띄워줘야 금방찾겠지").
 */
function markDocHit(h) {
  clearDocMarks();
  const body = document.body.dataset.screen === 'readScreen'
    ? document.getElementById('readBody')
    : (document.getElementById('wikiBody') || document.getElementById('readBody'));
  const doc = currentDoc();
  if (!body || !doc) return;
  const sec = doc.sections[h.sec];
  if (!sec) return;

  // 같은 장에 걸린 자리들을 **글 안에서의 차례대로** 모은다
  const here = docHits.filter((x) => x.sec === h.sec).sort((a, b) => a.at - b.at);
  const wanted = here.map((x) => ({
    hit: x,
    text: sec.text.slice(x.at, x.at + x.len).replace(/\s+/g, ''),
  })).filter((x) => x.text);
  if (!wanted.length) return;

  let active = null;
  let k = 0;                                  // 몇 번째 자리를 찾는 중인가
  const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const jobs = [];
  let node;
  while ((node = walk.nextNode()) && k < wanted.length) {
    let from = 0;
    while (k < wanted.length) {
      const want = wanted[k].text;
      const probe = want.slice(0, Math.min(want.length, 12));
      const i = node.nodeValue.indexOf(probe, from);
      if (i < 0) break;
      jobs.push({ node, i, len: Math.min(node.nodeValue.length - i, want.length), hit: wanted[k].hit });
      from = i + Math.max(1, probe.length);
      k++;
    }
  }
  // 뒤에서부터 감싼다 — 앞에서 바꾸면 뒤쪽 자리 번호가 밀린다
  for (let j = jobs.length - 1; j >= 0; j--) {
    const { node: n, i, len, hit } = jobs[j];
    const r = document.createRange();
    try {
      r.setStart(n, i);
      r.setEnd(n, i + len);
      const mk = document.createElement('mark');
      mk.className = `find-mark${hit === h ? ' on' : ''}`;
      r.surroundContents(mk);
      if (hit === h) active = mk;
    } catch { /* 태그를 가로지르는 자리는 건너뛴다 */ }
  }
  (active || document.querySelector('mark.find-mark'))
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function clearDocMarks() {
  clearTimeout(markTimer);
  markTimer = 0;
  document.querySelectorAll('mark.find-mark').forEach((m) => {
    const t = document.createTextNode(m.textContent);
    m.replaceWith(t);
    t.parentNode && t.parentNode.normalize();
  });
}

/** 검색 결과에서 특정 문항으로 바로 이동 */
async function openExamAt(path, qnum) {
  const subject = path.split('/')[1];
  const file = path.split('/').pop();
  await openExam(subject, { file, path });
  if (quiz) {
    const i = quiz.all.findIndex((x) => x.num === qnum);
    if (i >= 0) { quiz.cur = quiz.order.indexOf(i); if (quiz.cur < 0) quiz.cur = 0; quiz.render(); }
  }
}

// ---------- 결과 ----------

/** 결과·오답노트에 쓰는 정답 표기. 족보에는 정답이 둘 이상인 문항이 흔하다. */
function ansText(q) {
  const list = q.ansAll || [q.ans];
  return list.map((i) => `${i + 1}번`).join('·');
}

function showResult(res) {
  lastResult = res;
  document.getElementById('resultTitle').textContent = currentExam.title;
  document.getElementById('finalScore').textContent = `${res.correct}/${res.total}`;
  const pct = res.answered ? Math.round((res.correct / res.answered) * 100) : 0;
  document.getElementById('finalPct').textContent =
    `푼 문항 ${res.answered}/${res.total}${res.answered ? ` · 정답률 ${pct}%` : ''}`
    // 족보에는 채점할 수 없는 서술형 복원 문항이 섞여 있다 — 점수 밖이라고 숨기면
    // "40문항이라더니 왜 28문항이지?"가 된다
    + (res.openTotal ? ` · 읽기 문항 ${res.read || 0}/${res.openTotal}` : '');
  document.getElementById('saveMsg').textContent = '';

  const wl = document.getElementById('wrongList');
  wl.innerHTML = '';
  if (res.wrong.length) {
    const head = document.createElement('div');
    head.style.fontWeight = '700';
    head.textContent = `틀린 문제 ${res.wrong.length}개`;
    wl.appendChild(head);
    res.wrong.forEach((x) => {
      const d = document.createElement('div');
      const picked = x.q.type === 'ox' ? (x.picked === 0 ? 'O' : 'X') : `${x.picked + 1}번`;
      const ans = x.q.type === 'ox' ? (x.q.ans === 0 ? 'O' : 'X') : ansText(x.q);
      d.textContent = `${x.q.num}. ${x.q.q.slice(0, 60)}… (내 답 ${picked} / 정답 ${ans})`;
      wl.appendChild(d);
    });
  } else if (res.answered) {
    wl.innerHTML = '<div style="font-weight:700">전부 맞혔습니다 🎉</div>';
  }

  // 찍어서 맞춘 문항 — 점수에는 안 보이지만 제일 위험한 칸이라 따로 보여준다
  if (res.lucky && res.lucky.length) {
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:700;margin-top:10px';
    head.textContent = `🎲 찍어서 맞춘 문제 ${res.lucky.length}개`;
    wl.appendChild(head);
    res.lucky.forEach((x) => {
      const d = document.createElement('div');
      d.textContent = `${x.q.num}. ${x.q.q.slice(0, 60)}…`;
      wl.appendChild(d);
    });
  }

  const again = res.wrong.length + (res.lucky ? res.lucky.length : 0);
  const rb = document.getElementById('retryWrongBtn');
  rb.style.display = again ? '' : 'none';
  rb.textContent = res.lucky && res.lucky.length ? `틀린 것 + 찍은 것 ${again}개 다시` : '틀린 문제만 다시';
  quiz.destroy();
  show('resultScreen');
}

document.getElementById('resultBackBtn').onclick = () => loadList(false);
document.getElementById('restartBtn').onclick = () => {
  quiz.restart();
  show('quizScreen');
  quiz.start();
};
document.getElementById('retryWrongBtn').onclick = () => {
  if (quiz.retryWrong()) { show('quizScreen'); quiz.start(); toast('틀린 문제만 다시 풉니다.'); }
};

// ---------- vault 저장 ----------

/** 문항 앞에 붙는 표시 — 앱에서 칠한 색·★을 Obsidian에서도 눈으로 보게. */
function markOf(x) {
  const bits = [];
  if (x.color) bits.push(OV_TAGS[x.color - 1].emoji);
  if (x.bookmarked) bits.push('★');
  return bits.length ? `${bits.join('')} ` : '';
}

function buildMarkdown(res) {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const dateStr = `${yy}-${mm}-${dd}`;
  const subject = currentExam.subject;
  const topic = prettyExamName(currentExam.file);

  const lines = [];
  lines.push('---');
  lines.push(`출처: 아이패드 모의고사 풀이 (${currentExam.path})`);
  lines.push(`과목: ${subject}`);
  lines.push(`강의: ${topic}`);
  lines.push(`풀이일시: 20${yy}-${mm}-${dd} ${hh}:${mi}`);
  lines.push(`점수: ${res.correct}/${res.total}`);
  // 앱에서 칠한 색을 Obsidian 태그로도 남긴다 — 노트 검색·Dataview에서 바로 걸린다
  const usedColors = [...new Set(res.items.map((x) => x.color).filter(Boolean))].sort();
  const tagList = ['달모/모의고사풀이', ...usedColors.map((c) => `달모/${OV_TAGS[c - 1].name}`)];
  if (res.items.some((x) => x.bookmarked)) tagList.push('달모/다시볼것');
  lines.push(`tags: [${tagList.join(', ')}]`);
  // vault 쪽이 "아직 안 본 것"을 확실히 찾게 하는 표시. 사람이 세는 목록(처리기록 파일)은
  // 반드시 어긋난다 — 파일 자신이 상태를 들고 있게 한다(2026-10-13).
  //
  // 한 파일이 **두 군데로 간다**(2026-10-14). 시험을 풀면서 남기는 건 틀린 문제만이
  // 아니다 — 메모·북마크·색·찍어서 맞힌 것은 "몰랐던 것"이라 위키에도 들어가야 한다.
  // 그래서 갈 곳마다 따로 적는다. 하나가 끝나도 나머지가 `대기`로 남는다.
  const memoN = res.items.filter((x) => x.memo).length;
  const markN = res.items.filter((x) => x.bookmarked).length;
  const luckyN = (res.lucky || []).length;
  const toWiki = memoN + markN + luckyN + usedColors.length;
  lines.push('처리:');
  if (res.wrong.length) lines.push(`  오답: 대기        # 틀린 문항 ${res.wrong.length}개`);
  if (toWiki) {
    lines.push(`  위키: 대기        # 메모 ${memoN} · 북마크 ${markN} · 찍어맞힘 ${luckyN} · 색 ${usedColors.length}`);
  }
  if (!res.wrong.length && !toWiki) lines.push('  없음: 해당없음     # 다 맞았고 남긴 것도 없다');
  lines.push('---');
  lines.push('');
  lines.push(`# ${topic} 모의고사 풀이 기록`);
  lines.push('');
  lines.push(`- **점수**: ${res.correct}/${res.total} (푼 문항 ${res.answered}개)`);
  lines.push(`- **원본**: \`${currentExam.path}\``);
  lines.push('');

  if (res.wrong.length) {
    lines.push(`## ❌ 틀린 문제 ${res.wrong.length}개`);
    lines.push('');
    res.wrong.forEach((x) => {
      const picked = x.q.type === 'ox' ? (x.picked === 0 ? 'O' : 'X') : `${x.picked + 1}번`;
      const ans = x.q.type === 'ox' ? (x.q.ans === 0 ? 'O' : 'X') : ansText(x.q);
      lines.push(`### ${markOf(x)}${x.q.num}. (내 답 ${picked} → 정답 ${ans})`);
      if (x.q.source || x.q.srcTag) lines.push(`*출처: ${x.q.source || x.q.srcTag}*`);
      lines.push('');
      lines.push(x.q.q);
      if (Array.isArray(x.q.opts)) {
        lines.push('');
        lines.push(x.q.opts.map((o, i) => `${['①','②','③','④','⑤'][i] || i + 1} ${o}`).join(' '));
      }
      if (x.q.explain) { lines.push(''); lines.push(`> ${x.q.explain.replace(/\n/g, '\n> ')}`); }
      if (x.memo) { lines.push(''); lines.push(`🧩 *내 메모: ${x.memo}*`); }
      lines.push('');
    });
  }

  const marked = res.items.filter((x) => x.bookmarked);
  if (marked.length) {
    lines.push(`## ☆ 북마크한 문제 ${marked.length}개`);
    lines.push('');
    marked.forEach((x) => lines.push(`- ${markOf(x)}${x.q.num}. ${x.q.q.slice(0, 80)}…`));
    lines.push('');
  }

  // 색으로 표시한 문제 — 색마다 묶어서, Obsidian에서 그대로 읽히게
  if (usedColors.length) {
    lines.push('## 🎨 색으로 표시한 문제');
    lines.push('');
    for (const c of usedColors) {
      const tag = OV_TAGS[c - 1];
      const mine = res.items.filter((x) => x.color === c);
      lines.push(`### ${tag.emoji} ${tag.name} (${mine.length}개) #달모/${tag.name}`);
      mine.forEach((x) => lines.push(`- ${x.q.num}. ${x.q.q.slice(0, 80)}…`));
      lines.push('');
    }
  }

  // 맞았지만 찍은 것 — 점수에는 안 보이지만 **다음에 틀릴 것**이다. 오답과 같은 무게로 남긴다.
  if (res.lucky && res.lucky.length) {
    lines.push(`## 🎲 찍어서 맞힌 문제 ${res.lucky.length}개`);
    lines.push('');
    lines.push('> 점수에는 안 들어갔지만 모르고 맞힌 것이다 — 노트에 반영할 후보.');
    lines.push('');
    res.lucky.forEach((x) => {
      lines.push(`### ${markOf(x)}${x.q.num}. ${x.q.q.slice(0, 100)}`);
      if (x.q.explain) lines.push(`> ${x.q.explain.slice(0, 300).replace(/\n/g, '\n> ')}`);
      if (x.memo) lines.push(`🧩 *내 메모: ${x.memo}*`);
      lines.push('');
    });
  }

  const memos = res.items.filter((x) => x.memo && !res.wrong.includes(x));
  if (memos.length) {
    lines.push('## ✎ 메모');
    lines.push('');
    memos.forEach((x) => lines.push(`- **${x.q.num}번**: ${x.memo}`));
    lines.push('');
  }

  if (res.unanswered.length) {
    lines.push(`> 아직 안 푼 문항 ${res.unanswered.length}개: ${res.unanswered.map((x) => x.q.num).join(', ')}`);
    lines.push('');
  }

  const path = `${LOG_DIR}/${vaultName(subject, `${dateStr}_${hh}${mi}`, topic, '모의고사풀이')}`;
  return { path, content: lines.join('\n'), message: `iPad 모의고사 풀이: ${topic} ${res.correct}/${res.total}` };
}

document.getElementById('saveToVaultBtn').onclick = async (e) => {
  if (!lastResult) return;
  const btn = e.currentTarget;
  if (btn.disabled) return;                 // 두 번 눌러 같은 걸 두 번 올리지 않게
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '저장 중…';
  try {
    // 풀이기록 + (물어본 게 있으면) 질문기록을 각각 새 파일로 저장한다.
    const payloads = [buildMarkdown(lastResult)];
    if (askItems.length) {
      payloads.push(buildQaMarkdown({
        subject: currentExam.subject,
        lecture: prettyExamName(currentExam.file),
        examPath: currentExam.path,
        items: askItems,
      }));
    }
    // 기다리지 않는다 — 어차피 대기열이 받쳐주므로 **잃는 것이 없다**(2026-10-14).
    // 눌렀다는 표시만 바로 주고, 안 됐을 때만 붙잡는다.
    askItems = [];
    clearSession(currentExam.path).catch(() => {});
    btn.textContent = '✅ 저장됨';
    const msg = document.getElementById('saveMsg');
    msg.textContent = '저장 중…';
    setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2000);

    const r = await pushToVault(payloads);
    const m = vaultSaveMessage(r);
    msg.textContent = m.text;
    msg.classList.toggle('save-ok', !!m.ok);
    msg.classList.toggle('save-warn', !m.ok);
    if (r.queued.length) alertSheet('저장하지 못했습니다', m.text, m.needSetup ? openSetup : null);
  } catch (err) {
    btn.textContent = label;
    btn.disabled = false;
    throw err;
  }
};

document.getElementById('exportBtn').onclick = async () => {
  if (!lastResult) return;
  const { content } = buildMarkdown(lastResult);
  try {
    await navigator.clipboard.writeText(content);
    document.getElementById('saveMsg').textContent = '📋 클립보드에 복사했습니다.';
  } catch {
    // 클립보드가 막힌 경우 파일로 내려받기
    const blob = new Blob([content], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '모의고사풀이.md';
    a.click();
  }
};


// ═══════════ vault로 보내기 — 한 군데서 ═══════════
//
// 왜 모았나(2026-10-13): 저장 경로가 세 군데(모의고사 풀이·모아두기·질문기록)로 흩어져
// 있었고, 각자 조금씩 다르게 알려줬다. 사용자는 **눌렀는데 아무 일도 안 일어난 것처럼**
// 느꼈다("저장이 되었는지 피드백이 없어서 혼란스러움").
//
// 실패도 한 가지가 아니다. 셋을 구별해서 말해야 한다:
//   ① 인터넷이 없다      → 대기열. 연결되면 알아서 올라간다. **잃는 것이 없다.**
//   ② 토큰이 없다/만료    → 대기열에 넣되 설정을 열어줘야 한다.
//   ③ 그 밖의 거절(권한·충돌) → 대기열에 넣고 이유를 보여준다.
// 전부 "대기열로"라고만 하면 ②는 영영 안 올라간다.

/** 지금 인터넷이 끊긴 상태인가. navigator.onLine은 거짓 양성이 많아 오류 문구도 같이 본다. */
function looksOffline(err) {
  if (navigator.onLine === false) return true;
  return /NetworkError|Failed to fetch|Load failed|ERR_INTERNET|network|offline|타임아웃|timeout/i
    .test(String((err && err.message) || err || ''));
}

/**
 * 파일 여러 개를 vault로 보낸다. 실패하면 대기열에 넣는다 — **내용은 절대 버리지 않는다**.
 * @returns {{saved:string[], queued:string[], offline:boolean, needSetup:boolean, why:string}}
 */
async function pushToVault(payloads) {
  const saved = [];
  const queued = [];
  let offline = false;
  let needSetup = false;
  let why = '';
  for (const p of payloads) {
    try {
      const r = await createFile(p.path, p.content, p.message);
      saved.push(r.path.split('/').pop());
    } catch (e) {
      const m = String((e && e.message) || e);
      if (looksOffline(e)) offline = true;
      else if (/NO_TOKEN|401|403|Bad credentials/i.test(m)) needSetup = true;
      else if (!why) why = m.slice(0, 90);
      await enqueue(p);                       // 어떤 경우든 큐에 남긴다
      queued.push(p.path.split('/').pop());
    }
  }
  if (queued.length) refreshSyncBar();
  return { saved, queued, offline, needSetup, why };
}

/** 저장 결과를 사람 말로. 화면 글귀와 토스트가 **같은 말**을 하게 한다. */
function vaultSaveMessage(r) {
  if (!r.queued.length) {
    return { ok: true, text: `✅ vault에 저장했습니다 — ${r.saved.join(', ')}` };
  }
  if (r.offline) {
    return { ok: false, text: `📥 인터넷이 없어 ${r.queued.length}건을 기기에 넣어뒀습니다 — 연결되면 자동으로 올라갑니다. 앱을 꺼도 남아 있습니다.` };
  }
  if (r.needSetup) {
    return { ok: false, needSetup: true,
      text: `🔑 저장 권한이 없어 ${r.queued.length}건을 기기에 넣어뒀습니다 — 설정에서 토큰을 다시 넣어주세요.` };
  }
  return { ok: false,
    text: `⚠️ ${r.saved.length}건 저장, ${r.queued.length}건은 기기에 넣어뒀습니다${r.why ? ` (${r.why})` : ''} — 위의 "지금 보내기"로 다시 시도할 수 있습니다.` };
}

/**
 * 보내고, **보이게** 알려준다.
 * 토스트를 항상 띄운다 — 결과 화면 아래쪽 작은 글씨는 눈에 안 들어온다.
 */
async function saveToVault(payloads, { statusEl = null } = {}) {
  if (statusEl) statusEl.textContent = '저장 중…';
  const r = await pushToVault(payloads);
  const m = vaultSaveMessage(r);
  if (statusEl) {
    statusEl.textContent = m.text;
    statusEl.classList.toggle('save-ok', !!m.ok);
    statusEl.classList.toggle('save-warn', !m.ok);
  }
  toast(m.text);
  // 설정 화면으로 끌고 가는 건 **그 자리에 그대로 있을 때만**. 1.4초 뒤에 열다 보면
  // 그 사이 다른 걸 하고 있을 수 있는데, 보던 화면을 뺏는 건 저장 실패보다 더 나쁘다.
  if (m.needSetup) {
    const where = document.body.dataset.screen;
    setTimeout(() => { if (document.body.dataset.screen === where) openSetup(); }, 1400);
  }
  return { ...r, ...m };
}

// ---------- 아웃박스(동기화 대기열) ----------
const STUCK_AT = 4;        // 이만큼 실패하면 "네트워크 탓"이 아니다 — 사람이 봐야 한다

async function refreshSyncBar() {
  const items = await listOutbox();
  const bar = document.getElementById('syncBar');
  if (!items.length) { bar.classList.add('hidden'); return; }
  // 띠를 눌러도 열리게 — "지금 보내기"만 있으면 안 되는 걸 계속 누르게 된다
  bar.onclick = (e) => { if (e.target === bar || e.target.id === 'syncText') openOutbox(); };
  const stuck = items.filter((x) => (x.tries || 0) >= STUCK_AT);
  document.getElementById('syncText').textContent = stuck.length
    ? `저장 대기 ${items.length}건 — ${stuck.length}건이 막혀 있습니다`
    : `저장 대기 ${items.length}건`;
  bar.classList.toggle('stuck', stuck.length > 0);
  bar.classList.remove('hidden');
  // 여러 번 실패한 게 있으면 **한 번은** 직접 보여준다. 띠만 띄워두면 "계속 안 없어진다"로
  // 끝나고 아무도 손대지 않는다(2026-10-14 겪음). 한 번 보여준 뒤로는 조용히 둔다.
  if (stuck.length && !sessionStorage.getItem('outbox_shown')) {
    sessionStorage.setItem('outbox_shown', '1');
    setTimeout(openOutbox, 900);
  }
}

/**
 * 대기열을 비운다.
 *
 * ⚠️ 전에는 **첫 실패에서 통째로 멈췄다**. 그래서 영영 못 올라갈 항목 하나가 뒤의 멀쩡한
 *    것들까지 막았고, "저장 대기 1건"이 사라지지 않았다(2026-10-14 겪음).
 *    이제 끊긴 것(네트워크)만 멈추고, 그 밖의 거절은 **건너뛰고 다음 걸 보낸다**.
 */
async function flushOutbox() {
  if (!(await hasToken())) return;
  const items = await listOutbox();
  let sent = 0;
  for (const it of items) {
    try {
      await createFile(it.path, it.content, it.message);
      await dequeue(it.id);
      sent++;
    } catch (e) {
      await bumpTries(it.id, e.message);
      if (looksOffline(e)) break;        // 끊긴 상태면 뒤엣것도 어차피 안 된다
    }
  }
  refreshSyncBar();
  return sent;
}

document.getElementById('syncNowBtn').onclick = async () => {
  document.getElementById('syncText').textContent = '보내는 중…';
  const before = (await listOutbox()).length;
  const sent = await flushOutbox();
  const left = (await listOutbox()).length;
  if (left && !sent) {
    const why = (await listOutbox())[0].lastError || '';
    toast(`${left}건이 아직 안 올라갑니다${why ? ` — ${why.slice(0, 60)}` : ''}`);
    openOutbox();
  } else if (sent) {
    toast(`${sent}건을 보냈습니다${left ? ` · ${left}건 남음` : ''}`);
  } else if (!before) toast('보낼 게 없습니다.');
};

// ── 대기열 속사정 ──
// "저장 대기 1건이 계속 안 없어짐" — 왜인지 안 보이면 손쓸 방법이 없다(2026-10-14).
document.getElementById('syncWhyBtn').onclick = () => openOutbox();
document.getElementById('outboxClose').onclick = () =>
  document.getElementById('outboxSheet').classList.add('hidden');
document.getElementById('outboxSheet').onclick = (e) => {
  if (e.target.id === 'outboxSheet') e.target.classList.add('hidden');
};
document.getElementById('outboxRetry').onclick = async () => {
  await flushOutbox();
  openOutbox();
};
document.getElementById('outboxSaveAll').onclick = async () => {
  for (const it of await listOutbox()) downloadPayload(it);
};

/** 대기 중인 것을 파일로 받아둔다 — 끝내 안 올라가도 **내용은 건진다**. */
function downloadPayload(it) {
  const name = it.path.split('/').pop();
  const isB64 = it.content && typeof it.content === 'object' && it.content.base64;
  let blob;
  if (isB64) {
    const bin = atob(it.content.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: it.content.mime || 'application/octet-stream' });
  } else {
    blob = new Blob([String(it.content)], { type: 'text/markdown' });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function openOutbox() {
  const items = await listOutbox();
  const box = document.getElementById('outboxList');
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<p class="muted">비어 있습니다 — 전부 올라갔습니다.</p>';
  }
  // 여러 번 막힌 게 있으면 **뭘 해야 하는지** 먼저 말해준다
  const stuck = items.filter((x) => (x.tries || 0) >= STUCK_AT);
  if (stuck.length) {
    const tip = document.createElement('div');
    tip.className = 'warn-box';
    tip.style.marginBottom = '10px';
    const why = stuck[0].lastError || '';
    tip.textContent = /401|403|credential|권한|NO_TOKEN/i.test(why)
      ? '저장 권한이 막혀 있습니다 — 설정에서 토큰을 다시 넣은 뒤 "전부 다시 보내기"를 누르세요.'
      : '여러 번 보내봤지만 안 올라갑니다. 내용은 아래에서 파일로 받아둘 수 있습니다.';
    box.appendChild(tip);
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = `ob-row${(it.tries || 0) >= STUCK_AT ? ' stuck' : ''}`;
    const t = document.createElement('div');
    t.className = 'ob-name';
    t.textContent = it.path.split('/').pop();
    const d = document.createElement('div');
    d.className = 'ob-why muted';
    d.textContent = it.tries
      ? `${it.tries}번 시도${it.lastError ? ` · ${it.lastError.slice(0, 70)}` : ''}`
      : '아직 보내기 전';
    const acts = document.createElement('div');
    acts.className = 'ob-acts';
    const dl = document.createElement('button');
    dl.className = 'btn small';
    dl.textContent = '내려받기';
    dl.onclick = () => downloadPayload(it);
    const rm = document.createElement('button');
    rm.className = 'btn small danger';
    rm.textContent = '버리기';
    rm.onclick = async () => {
      // 버리기 전에 내용을 꼭 손에 쥐여준다 — 지우고 나면 되돌릴 수 없다
      downloadPayload(it);
      await dequeue(it.id);
      toast('파일로 내려받고 대기열에서 뺐습니다.');
      refreshSyncBar();
      openOutbox();
    };
    acts.append(dl, rm);
    row.append(t, d, acts);
    box.appendChild(row);
  }
  document.getElementById('outboxSheet').classList.remove('hidden');
}

window.addEventListener('online', flushOutbox);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushOutbox(); });

// ---------- 잡다 ----------
// 버튼 핸들러 17개가 async인데 try/catch가 없다. 하나하나 감싸는 대신 여기서
// 받는다 — 저장소가 꽉 차거나(iOS에서 실제로 일어난다) 네트워크가 끊겼을 때
// **아무 반응이 없는** 것이 가장 나쁘다. 눌렀는데 조용하면 계속 누르게 된다.
//
// 조용히 넘길 것은 걸러낸다: 백업·이력 저장처럼 사용자가 시키지 않은 뒷일이
// 실패했다고 공부 중에 배지를 띄우면 방해만 된다.
const QUIET_ERRORS = /AbortError|NetworkError when attempting|Load failed|The operation was aborted/i;

export function reportError(reason) {
  const msg = String((reason && (reason.message || reason)) || '알 수 없는 오류');
  if (msg === 'NO_TOKEN') { openSetup(); return 'setup'; }
  if (QUIET_ERRORS.test(msg)) return 'quiet';
  toast(`처리하지 못했습니다: ${msg.slice(0, 80)}`);
  return 'toast';
}

window.addEventListener('unhandledrejection', (e) => reportError(e.reason));

function toast(text) {
  const el = document.createElement('div');
  el.textContent = text;
  Object.assign(el.style, {
    position: 'fixed', left: '50%', bottom: '90px', transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,.82)', color: '#fff', padding: '10px 18px', borderRadius: '20px',
    fontSize: '14px', zIndex: 99, pointerEvents: 'none',
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

/**
 * 되돌릴 수 있는 알림 — "지웠습니다 · 되돌리기".
 *
 * 카드 삭제가 세 군데에서 **되돌릴 길 없이** 일어나고 있었다(2026-10-14 점검).
 * 묻고 또 묻는 것보다, 일단 하고 되돌릴 수 있게 하는 쪽이 손이 덜 간다 — 상용 앱이
 * 다 그렇게 한다. 되돌리기를 누르지 않고 지나가면 그대로 지워진 채 남는다.
 */
function toastUndo(text, undo, { ms = 6000, onExpire = null } = {}) {
  document.getElementById('undoToast')?.remove();
  const el = document.createElement('div');
  el.id = 'undoToast';
  el.className = 'undo-toast';
  const t = document.createElement('span');
  t.textContent = text;
  const b = document.createElement('button');
  b.textContent = '되돌리기';
  let done = false;
  // 되돌릴 틈이 지나면 그때서야 진짜로 치운다 — 무거운 뒷정리(본문 삭제 등)를 여기 건다
  const close = () => { if (!done) { done = true; el.remove(); if (onExpire) Promise.resolve(onExpire()).catch(() => {}); } };
  b.onclick = async () => {
    if (done) return;
    done = true;
    el.remove();
    try { await undo(); toast('되돌렸습니다.'); }
    catch (e) { toast(`되돌리지 못했습니다: ${e.message}`); }
  };
  el.append(t, b);
  document.body.appendChild(el);
  setTimeout(close, ms);
}

/** 카드를 지우되 되돌릴 수 있게. 지운 카드를 들고 있다가 그대로 되살린다. */
async function deleteCardsUndoable(cards, after = () => {}) {
  const list = (Array.isArray(cards) ? cards : [cards]).filter(Boolean);
  if (!list.length) return;
  for (const c of list) await deleteCard(c.id);
  backup.scheduleBackup();
  after();
  toastUndo(`${list.length}장을 지웠습니다.`, async () => {
    await saveCards(list);
    backup.scheduleBackup();
    after();
  });
}

function alertBox(text) {
  const body = document.getElementById('listBody');
  const box = document.createElement('div');
  box.className = 'warn-box';
  box.style.marginBottom = '12px';
  box.textContent = text;
  body.prepend(box);
}


// ═══════════ 손으로 만드는 빈칸 카드 (2026-10-14 요청) ═══════════
//
// 자동 추천은 그대로 둔다 — 대개 맞고, 빠르다. 다만 빗나가는 문장이 있기 마련인데
// 그때 손볼 길이 없었다("카드 만들기가 잘 안 됨... 내가 특정 단어 범위 지정해서
// 빈칸 만드는 게 나을 듯").
//
// 이제 긁은 글이 **낱말 칩**으로 뜨고, 눌러서 가릴 것을 고른다. 이어진 낱말을 고르면
// 한 빈칸으로 묶인다 — "체온 >40℃"처럼 두 낱말이 한 답인 경우가 많다.

let czWords = [];        // [{t, blank}]
let czCtx = null;        // {notePath, noteTitle, heading}

function openClozeMaker(text, ctx) {
  czCtx = ctx;
  // 괄호·숫자는 따로 고를 수 있게 쪼갠다 — "15:2로"에서 묻고 싶은 건 15:2다(2026-10-14)
  // 쪼개면서 **원래 띄어쓰기**를 기억한다 — 안 그러면 "함몰 (umbilication) 이"가 된다
  czWords = [];
  String(text).replace(/\s+/g, ' ').trim().split(' ').forEach((w, wi) => {
    splitWord(w).forEach((t, pi) => {
      czWords.push({ t, blank: false, sp: wi > 0 && pi === 0 });   // 낱말 사이에만 공백
    });
  });
  if (!czWords.length) { toast('고른 글이 없습니다.'); return; }
  suggestCloze();                       // 처음엔 추천을 얹어둔다 — 손댈 게 적게
  renderCloze();
  document.getElementById('clozeFloat').classList.remove('hidden');
  if (clozeFloat) clozeFloat.place();
}
function closeCloze() { document.getElementById('clozeFloat').classList.add('hidden'); }

/**
 * 추천 — **물어볼 만한 것**을 고른다(2026-10-14 재설계).
 *
 * 전에는 문장 단위 규칙(splitAnswer)이 준 덩어리를 글자로 맞춰 찾았는데, 조각 단위로
 * 쪼갠 뒤로는 거의 안 맞았다("추천대로도 아주 형편없이 동작").
 * 이제 조각마다 점수를 매겨(wordScore) 높은 것부터 고른다 — 숫자·영문 용어·괄호 원어.
 * 아무것도 못 고르면 **맨 앞 명사**를 가린다(설명문이면 그게 주제어다).
 */
function suggestCloze() {
  czWords.forEach((w) => { w.blank = false; });
  const scored = czWords.map((w, i) => ({ i, s: wordScore(w.t) })).filter((x) => x.s > 0);
  if (!scored.length) return;
  const top = Math.max(...scored.map((x) => x.s));
  // 가장 값진 것만 — 다만 너무 많으면(열거) 네 개까지
  let pick = scored.filter((x) => x.s === top).slice(0, 4);
  // 숫자가 하나도 없고 평범한 명사뿐이면 맨 앞 하나만 — 설명문의 주제어
  if (top <= 2) pick = pick.slice(0, 1);
  for (const x of pick) {
    czWords[x.i].blank = true;
    // 바로 뒤에 붙은 괄호 원어는 같이 가린다 — "함몰(umbilication)"은 한 개념이다
    const nx = czWords[x.i + 1];
    if (nx && !nx.sp && /^[([{]/.test(nx.t)) nx.blank = true;
  }
}

function renderCloze() {
  const box = document.getElementById('czBody');
  box.innerHTML = '';
  czWords.forEach((w) => {
    // 원래 띄어쓰기를 그대로 — 붙어 있던 조각은 붙여서 보여줘야 읽힌다
    if (w.sp) box.appendChild(document.createTextNode(' '));
    const b = document.createElement('button');
    b.className = `cz-w${w.blank ? ' on' : ''}`;
    b.textContent = w.t;
    b.onclick = () => { w.blank = !w.blank; renderCloze(); };
    box.appendChild(b);
  });
  const n = czGroups().length;
  document.getElementById('czStatus').textContent = n > 1
    ? `빈칸 ${n}개 — 하나씩 ${n}장으로 나눠 담습니다`
    : n ? '빈칸 1개 — 눌러서 더하거나 뺍니다'
      : '가릴 낱말을 눌러 고르세요';
  // 빈칸이 둘 이상이면 **나눠 담기가 기본**이다 — 한 장에 다 가리면 물음이 사라진다
  const add = document.getElementById('czAdd');
  add.disabled = !n;
  add.textContent = n > 1 ? `＋ 하나씩 ${n}장` : '＋ 카드 추가';
  document.getElementById('czAll').classList.toggle('hidden', n < 2);
}

/**
 * 이어진 낱말을 한 빈칸으로 묶는다 → `[{t, i0, i1}]`.
 *
 * 조각 번호(i0~i1)까지 들고 있는 이유: 빈칸이 여럿일 때 **하나씩 따로 가린 카드**를
 * 만들려면 "이 묶음만 가리고 나머지는 보이게"를 할 수 있어야 한다(아래 addClozeCards).
 */
function czGroups() {
  const out = [];
  let run = null;
  czWords.forEach((w, i) => {
    if (w.blank) {
      if (run === null) run = { t: w.t, i0: i, i1: i };
      else { run.t += (w.sp ? ' ' : '') + w.t; run.i1 = i; }
    } else if (run !== null) { out.push(run); run = null; }
  });
  if (run !== null) out.push(run);
  return out;
}

/** 고른 묶음만 가린 본문 HTML — 나머지 빈칸은 **단서로 보이게** 둔다. */
function czBodyHtml(groups, pick) {
  const on = new Set();
  pick.forEach((gi) => { for (let i = groups[gi].i0; i <= groups[gi].i1; i++) on.add(i); });
  const frag = document.createElement('div');
  let run = null;
  czWords.forEach((w, i) => {
    if (on.has(i)) { run = run === null ? w.t : run + (w.sp ? ' ' : '') + w.t; return; }
    if (run !== null) { frag.appendChild(blankSpan(run)); run = null; }
    if (w.sp) frag.appendChild(document.createTextNode(' '));
    frag.appendChild(document.createTextNode(w.t));
  });
  if (run !== null) frag.appendChild(blankSpan(run));
  return frag.innerHTML;
}

/**
 * 고른 빈칸으로 카드를 만든다.
 *
 * `split`이면 **빈칸 하나짜리 여러 장**으로 나눈다 (2026-10-15 지적:
 * "4시간에 200을 기준으로 이거 만들라니까 둘 다 가려져서 뭔지 모르겠네").
 * 숫자가 둘이면 둘 다 가려버리니 `___에 ___을 기준으로`가 되어 물음이 사라진다.
 * 나눠 담으면 `___에 200을 기준으로` · `4시간에 ___을 기준으로` 두 장이 되고,
 * 서로가 서로의 단서가 된다 — 한 번에 하나만 묻는다는 원칙(최소 정보)과도 맞는다.
 */
function buildClozeCards(split) {
  const groups = czGroups();
  if (!groups.length) return [];
  const sets = split ? groups.map((_, i) => [i]) : [groups.map((_, i) => i)];
  const stamp = Date.now();
  return sets.map((pick, n) => {
    const answers = pick.map((i) => groups[i].t);
    let html = czBodyHtml(groups, pick);
    // 블록을 알면 **그 서식 그대로** 담는다 — 펜으로 네모 쳐 만든 카드와 같은 모양이
    // 되게(2026-10-14: "긁기로 만드는 건 아주 형편없음. 통일성 가지게").
    if (czCtx.block) {
      const clone = czCtx.block.cloneNode(true);
      if (placeBlanksIn(clone, answers)) html = clone.outerHTML;
    }
    return {
      id: `${czCtx.notePath || ''}#${czCtx.heading || ''}#m${stamp}${sets.length > 1 ? `-${n}` : ''}`,
      notePath: czCtx.notePath || '', noteTitle: czCtx.noteTitle || '',
      heading: czCtx.heading || '',
      // 맥락도 같이 — 무슨 이야기인지 모르면 맞힐 수가 없다
      trail: czCtx.trail || [],
      topic: [czCtx.heading, ...(czCtx.trail || [])].filter(Boolean).join('  ›  '),
      contextHtml: tidyCardHtml(html),
      answers,
      starred: false,
      kind: 'block',
    };
  });
}

function initClozeMaker() {
  clozeFloat = makeFloat({
    panel: 'clozeFloat', head: 'czHead', grip: 'czResize', key: 'cloze_float_box',
    def: { w: Math.min(560, innerWidth * 0.92), h: Math.min(420, innerHeight * 0.55) },
  });
  document.getElementById('czClose').onclick = closeCloze;
  document.getElementById('czSuggest').onclick = () => { suggestCloze(); renderCloze(); };
  document.getElementById('czClear').onclick = () => {
    czWords.forEach((w) => { w.blank = false; }); renderCloze();
  };
  const add = async (split) => {
    const cards = buildClozeCards(split);
    if (!cards.length) return;
    await saveCards(cards);
    backup.scheduleBackup();
    closeCloze();
    toast(cards.length > 1
      ? `빈칸 하나짜리로 ${cards.length}장을 넣었습니다.`
      : `빈칸 ${cards[0].answers.length}개짜리 카드를 넣었습니다.`);
  };
  document.getElementById('czAdd').onclick = () => add(czGroups().length >= 2);
  document.getElementById('czAll').onclick = () => add(false);
}

/**
 * 블록 사본 안에서 고른 말을 찾아 빈칸으로 바꾼다.
 * 하나라도 못 찾으면 false — 그때는 맨 글자로 만든 본문을 쓴다(엉뚱한 자리를 가리지 않게).
 */
function placeBlanksIn(clone, answers) {
  let done = 0;
  for (const ans of answers) {
    const want = String(ans).replace(/\s+/g, ' ').trim();
    if (!want) continue;
    if (placeOneBlank(clone, want)) done++;
  }
  return done === answers.length;
}

const RE_ESC = /[.*+?^${}()|[\]\\]/g;

/**
 * 그 말이 있는 자리를 빈칸으로 바꾼다 — **여러 텍스트 노드에 걸쳐 있어도**.
 *
 * 전에는 노드 하나 안에서만 찾았다. 그런데 읽기 화면의 글은 낱말마다 `.tok`으로
 * 쪼개져 있고 굵게·괄호에서 또 갈린다. 그래서 "체온 >40℃"처럼 **두 조각에 걸친 답**은
 * 영영 못 찾았고, 그때마다 블록 서식을 통째로 포기하고 맨 글자 본문으로 떨어졌다
 * (2026-10-15). 노드를 이어 붙인 한 줄에서 자리를 찾고, 걸친 노드들을 함께 들어낸다.
 * 사이 공백은 몇 칸이든 한 칸으로 본다 — 원문 줄바꿈이 공백으로 들어오기 때문이다.
 */
function placeOneBlank(root, want) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let flat = '';
  let node;
  while ((node = walk.nextNode())) {
    nodes.push({ node, at: flat.length, len: node.nodeValue.length });
    flat += node.nodeValue;
  }
  if (!flat) return false;
  const re = new RegExp(want.split(/\s+/).map((w) => w.replace(RE_ESC, '\\$&')).join('\\s+'));
  const m = re.exec(flat);
  if (!m) return false;
  const s = m.index;
  const e = s + m[0].length;
  const hit = nodes.filter((n) => n.at < e && n.at + n.len > s);
  if (!hit.length) return false;
  const blank = blankSpan(m[0].replace(/\s+/g, ' '));
  const first = hit[0];
  const last = hit[hit.length - 1];
  if (first === last) {                       // 한 노드 안 — 쪼개서 가운데만 바꾼다
    const after = first.node.splitText(s - first.at);
    after.splitText(e - s);
    after.replaceWith(blank);
    return true;
  }
  // 여러 노드에 걸친 경우 — 첫 노드 뒤에 빈칸을 넣고 걸린 부분을 덜어낸다
  last.node.nodeValue = last.node.nodeValue.slice(e - last.at);
  for (let i = 1; i < hit.length - 1; i++) hit[i].node.remove();
  first.node.nodeValue = first.node.nodeValue.slice(0, s - first.at);
  first.node.parentNode.insertBefore(blank, first.node.nextSibling);
  return true;
}

/** 카드 본문에 들어갈 빈칸 — 읽기 화면의 것과 **같은 함수**를 쓴다(모양이 어긋나지 않게). */
const blankSpan = blankNode;
let clozeFloat = null;

// ═══════════ 번호로 가기 ═══════════
//
// 40문항짜리 시험에서 12번으로 돌아가려면 화살표를 스물여덟 번 눌러야 했다
// (2026-10-14 요청). 번호 칸을 눌러 바로 간다. 섹션이 많은 노트에서도 같다.

/** 지금 화면에서 "몇 번째 / 전부 몇 개"와, 그 번호로 가는 법. */
function jumpTarget() {
  if (document.body.dataset.screen === 'quizScreen' && quiz) {
    return {
      what: '문항',
      total: quiz.all.length,
      // 화면에 보이는 건 **문항 번호**(q.num)다 — 섞어 푸는 중이면 순서와 다르다.
      // 사람이 아는 번호로 찾고, 없으면 순서대로 센다.
      go: (n) => {
        let i = quiz.all.findIndex((q) => Number(q.num) === n);
        if (i < 0 && n >= 1 && n <= quiz.all.length) i = n - 1;
        if (i < 0) return false;
        const at = quiz.order.indexOf(i);
        quiz.cur = at >= 0 ? at : 0;
        quiz.render();
        return true;
      },
    };
  }
  if (document.body.dataset.screen === 'readScreen' && reader) {
    return {
      what: '섹션',
      total: reader.note.sections.length,
      go: (n) => {
        if (n < 1 || n > reader.note.sections.length) return false;
        reader.secIdx = n - 1;
        renderReader();
        return true;
      },
    };
  }
  return null;
}

function openJump() {
  const t = jumpTarget();
  if (!t || !t.total) return;
  document.getElementById('jumpTitle').textContent = `${t.what}으로 이동`;
  document.getElementById('jumpHint').textContent = `1 ~ ${t.total} 중에서 — Enter로 바로 이동`;
  const inp = document.getElementById('jumpInput');
  inp.value = '';
  inp.placeholder = `번호 (1~${t.total})`;
  document.getElementById('jumpSheet').classList.remove('hidden');
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
}
function closeJump() { document.getElementById('jumpSheet').classList.add('hidden'); }

function doJump() {
  const t = jumpTarget();
  const n = parseInt(document.getElementById('jumpInput').value, 10);
  if (!t) return;
  if (!Number.isFinite(n)) { toast('번호를 넣어주세요.'); return; }
  if (!t.go(n)) { toast(`${n}번 ${t.what}이 없습니다 (1~${t.total}).`); return; }
  closeJump();
}

document.getElementById('posLabel').onclick = openJump;
document.getElementById('readPos').onclick = openJump;
document.getElementById('jumpClose').onclick = closeJump;
document.getElementById('jumpGo').onclick = doJump;
document.getElementById('jumpSheet').onclick = (e) => { if (e.target.id === 'jumpSheet') closeJump(); };
document.getElementById('jumpInput').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doJump(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeJump(); }
};

// ═══════════ 타이머 ═══════════
//
// "딴짓을 많이해서리" — 점수에 반영하는 물건이 아니다(2026-10-13 요청). 한 세트를
// 정해둔 시간 안에 끝내자는 **스스로와의 약속**이고, 지나면 조용히 알려주기만 한다.
// 그래서 일부러 안 넣은 것들: 자동 제출, 남은 시간으로 채점, 못 지켰다는 기록.
// 공부를 재촉하는 장치가 되면 오히려 안 켜게 된다.

let timer = null;      // {min, perQ, endAt, paused, left}
let timerTick = 0;

const mmss = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

function paintTimer() {
  const pill = document.getElementById('timerPill');
  if (!timer) { pill.classList.add('hidden'); return; }
  pill.classList.remove('hidden');
  const left = timer.paused ? timer.left : timer.endAt - Date.now();
  pill.textContent = (timer.paused ? '⏸ ' : '') + mmss(left);
  // 1분 남으면 노랑, 지나면 빨강 — 숫자만으로는 곁눈으로 안 보인다
  pill.classList.toggle('warn', left <= 60000 && left > 0);
  pill.classList.toggle('over', left <= 0);
  if (left <= 0 && !timer.rang) {
    timer.rang = true;
    toast(`⏰ ${timer.min}분이 지났습니다 — 마무리하고 넘어갈까요?`);
    try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch {}
  }
}

function startTimer(min, perQ) {
  timer = { min, perQ, endAt: Date.now() + min * 60000, paused: false, left: 0, rang: false };
  clearInterval(timerTick);
  timerTick = setInterval(paintTimer, 1000);
  paintTimer();
  localStorage.setItem('timer_pref', JSON.stringify({ min, perQ }));
}
function stopTimer() {
  timer = null;
  clearInterval(timerTick);
  timerTick = 0;
  paintTimer();
}
/** 문항을 넘길 때 — "문항마다 다시 시작"이 켜져 있으면 되감는다. */
function resetTimerForQuestion() {
  if (!timer || !timer.perQ) return;
  timer.endAt = Date.now() + timer.min * 60000;
  timer.rang = false;
  timer.paused = false;
  paintTimer();
}

function openTimerSheet() {
  const sheet = document.getElementById('timerSheet');
  let pref = { min: 20, perQ: false };
  try { pref = { ...pref, ...JSON.parse(localStorage.getItem('timer_pref') || '{}') }; } catch {}
  const cur = timer ? timer.min : pref.min;
  document.querySelectorAll('#timerSeg .btn').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.min) === cur));
  document.getElementById('timerPerQ').checked = timer ? timer.perQ : pref.perQ;
  document.getElementById('timerOff').disabled = !timer;
  sheet.classList.remove('hidden');
}

function initTimer() {
  document.getElementById('toolTimer').onclick = openTimerSheet;
  document.getElementById('timerClose').onclick = () =>
    document.getElementById('timerSheet').classList.add('hidden');
  document.getElementById('timerSheet').onclick = (e) => {
    if (e.target.id === 'timerSheet') e.target.classList.add('hidden');
  };
  document.querySelectorAll('#timerSeg .btn').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#timerSeg .btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
  });
  document.getElementById('timerStart').onclick = () => {
    const on = document.querySelector('#timerSeg .btn.active');
    startTimer(Number(on ? on.dataset.min : 20), document.getElementById('timerPerQ').checked);
    document.getElementById('timerSheet').classList.add('hidden');
    document.getElementById('toolTimer').classList.add('active');
    toast(`${timer.min}분 타이머를 켰습니다${timer.perQ ? ' (문항마다 다시 시작)' : ''}.`);
  };
  document.getElementById('timerOff').onclick = () => {
    stopTimer();
    document.getElementById('timerSheet').classList.add('hidden');
    document.getElementById('toolTimer').classList.remove('active');
  };
  // 알약을 누르면 잠깐 멈춤 — 화장실 다녀오는 동안 타이머가 도는 건 의미가 없다
  document.getElementById('timerPill').onclick = () => {
    if (!timer) return;
    if (timer.paused) { timer.endAt = Date.now() + timer.left; timer.paused = false; }
    else { timer.left = timer.endAt - Date.now(); timer.paused = true; }
    paintTimer();
  };
}

// ═══════════ 떠 있는 도구막대 · 창 버튼 자리 ═══════════
//
// 왜 이렇게 바꿨나(2026-10-13): 아이패드에서 창을 줄여 쓰면 시스템이 왼쪽 위에
// ●●● 창 버튼을 그려 넣는다. 그게 **뒤로가기와 찾기를 덮어서 아예 못 눌렀다**.
// 다른 앱들은 머리줄을 그 아래로 한 칸 내려서 푼다 — 같은 방식을 쓴다.
// 그리고 도구는 머리줄에서 떼어내 떠 있게 했다. 네 변 중 아무 데나 붙일 수 있어서
// 가려지면 옮기면 된다. (사용자 제안: "드래그해서 좌 우 상 하 고정된 폭으로 위치바꾸기")

let winMode = 'auto';            // auto | on | off

/** 창 버튼이 머리줄을 덮는 상황인가 — 그러면 머리줄을 그만큼 내린다. */
function updateWinControls() {
  let on;
  if (winMode === 'on') on = true;
  else if (winMode === 'off') on = false;
  else {
    const standalone = matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    // 전체 화면이면 창 버튼이 없다. 조금이라도 줄여 쓰면 생긴다.
    on = standalone && (window.innerWidth < screen.width - 8 || window.innerHeight < screen.height - 8);
  }
  document.body.toggleAttribute('data-win-controls', on);
}
addEventListener('resize', updateWinControls);

async function loadWinMode() {
  winMode = (await kvGet('win_controls')) || 'auto';
  document.querySelectorAll('#winSeg .btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.win === winMode));
  document.getElementById('winVal').textContent =
    { auto: '자동', on: '비움', off: '안 비움' }[winMode];
  updateWinControls();
}
document.querySelectorAll('#winSeg .btn').forEach((b) => {
  b.onclick = async () => { await kvSet('win_controls', b.dataset.win); await loadWinMode(); };
});

// ── 도구막대 옮기기 ──
// 네 변 중 하나에 붙는다(tl/tr/bl/br은 모서리, l/r은 세로 막대).
const DOCKS = ['tr', 'tl', 'br', 'bl', 'l', 'r'];

function dockTools(dock, el = document.getElementById('readTools'), key = 'read_tools_dock') {
  if (!el || !DOCKS.includes(dock)) return;
  el.dataset.dock = dock;
  el.style.removeProperty('--rt-x');
  el.style.removeProperty('--rt-y');
  localStorage.setItem(key, dock);
  reserveForTools(el);
}

/**
 * 머리줄 오른쪽 끝(점수·타이머)이 떠 있는 막대에 **가리지 않게** 자리를 비운다.
 *
 * 막대가 뜨면서 생긴 문제다 — 머리줄은 자기 위에 뭐가 떠 있는지 모른다(2026-10-13).
 * 막대를 옮기면 비웠던 자리도 같이 돌려준다.
 */
function reserveForTools(el) {
  const screen = el.closest('section');
  if (!screen) return;
  const head = screen.querySelector(':scope > header');
  if (!head) return;
  const top = el.dataset.dock === 'tr' || el.dataset.dock === 'tl';
  requestAnimationFrame(() => {
    const w = top ? Math.round(el.getBoundingClientRect().width) + 20 : 0;
    head.style.setProperty(el.dataset.dock === 'tl' ? 'padding-left' : 'padding-right',
      w ? `${w}px` : '');
    // 반대쪽에 남아 있던 여백은 돌려준다
    head.style.setProperty(el.dataset.dock === 'tl' ? 'padding-right' : 'padding-left', '');
    // 위에 붙였으면 **머리줄 줄에 맞춰 앉힌다**. 그냥 top:8px로 두면 머리줄보다 키가 커서
    // 아래 패널 제목을 덮는다(2026-10-14: 관련 노트 제목이 가려졌다).
    if (top) {
      // **바닥을 머리줄 바닥에 맞춘다.** 가운데 맞추면 막대가 머리줄보다 키가 클 때
      // 아래로 비어져 나와 패널 제목을 덮는다(2026-10-14에 실제로 그랬다).
      // 위로 비어져 나오는 건 머리줄 위 빈 자리라 아무것도 안 가린다.
      // 막대 **바닥**이 놓일 자리만 준다. 높이는 CSS가 translateY(-100%)로 알아서 뺀다 —
      // 높이를 재서 top을 계산하면 버튼이 늘었다 줄 때마다 어긋났다(2026-10-14).
      //
      // ⚠️ 바로 위에서 머리줄 padding을 바꿨다 — 그 반영이 끝난 **다음 프레임**에 재야
      //    맞는 값이 나온다. 같은 프레임에서 재면 4px쯤 어긋나 패널을 덮는다.
      requestAnimationFrame(() => {
        el.style.setProperty('--rt-base', `${Math.round(head.getBoundingClientRect().bottom - 2)}px`);
      });
    } else el.style.removeProperty('--rt-base');
  });
}

/** 놓은 자리에서 가장 가까운 변을 고른다. */
function nearestDock(cx, cy) {
  const W = innerWidth, H = innerHeight;
  const d = { 좌: cx, 우: W - cx, 상: cy, 하: H - cy };
  const side = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
  if (side === '좌') return cy < H / 2 ? 'l' : 'bl';
  if (side === '우') return cy < H / 2 ? 'r' : 'br';
  if (side === '상') return cx < W / 2 ? 'tl' : 'tr';
  return cx < W / 2 ? 'bl' : 'br';
}

function initReadTools(panelId = 'readTools', gripId = 'rtGrip', key = 'read_tools_dock') {
  const el = document.getElementById(panelId);
  const grip = document.getElementById(gripId);
  if (!el || !grip) return;
  dockTools(localStorage.getItem(key) || 'tr', el, key);
  // 막대는 그 화면일 때만 보인다 — 숨어 있을 땐 폭이 0이라 지금 재면 소용없다.
  // 보이게 되는 순간 다시 재서 머리줄 자리를 비운다(2026-10-13).
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => reserveForTools(el)).observe(el);
  }

  grip.addEventListener('pointerdown', (e) => {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    // 포인터를 묶어둬야 손이 막대 밖으로 나가도 move가 계속 온다.
    // 합성 이벤트(테스트)로는 묶을 포인터가 없어 던진다 — 그래도 끌기는 돼야 한다.
    try { grip.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('dragging');
    const move = (ev) => {
      el.dataset.dock = 'free';
      el.style.setProperty('--rt-x', `${Math.max(4, Math.min(ev.clientX - dx, innerWidth - r.width - 4))}px`);
      el.style.setProperty('--rt-y', `${Math.max(4, Math.min(ev.clientY - dy, innerHeight - r.height - 4))}px`);
    };
    const up = (ev) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      const rr = el.getBoundingClientRect();
      dockTools(nearestDock(rr.left + rr.width / 2, rr.top + rr.height / 2), el, key);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
    e.preventDefault();
  });
  // 두 번 누르면 원래 자리(오른쪽 위)로 — 어디로 갔는지 모를 때 되돌리는 길
  grip.addEventListener('dblclick', () => dockTools('tr', el, key));
}
initReadTools();
initReadTools('quizTools', 'qtGrip', 'quiz_tools_dock');

// ═══════════ 키보드 · 마우스 ═══════════
//
// 왜 필요한가: 아이패드에 키보드를 붙이거나 MX Master 같은 버튼 많은 마우스를
// 붙여 쓴다(2026-10-13 요청). 손이 화면에서 떨어져 있을 때도 찾기·뒤로·섹션 넘기기가
// 되어야 한다. 단축키는 **Obsidian과 같게** 잡았다 — 평소 쓰던 손버릇 그대로.

/** 지금 글자를 치고 있는 중인가 — 그럴 땐 단축키를 가로채면 안 된다. */
function typingNow(t) {
  return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
}
const inReader = () => document.body.dataset.screen === 'readScreen';

function prevSection() { document.getElementById('readPrev').click(); }
function nextSection() { document.getElementById('readNext').click(); }

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const typing = typingNow(e.target);

  // 들러보기 창이 떠 있으면 Enter로 다음 찾은 곳, Shift+Enter로 이전 —
  // 문서 안 찾기와 같은 손놀림이라 따로 외울 게 없다(2026-10-17 요청)
  if (!typing && e.key === 'Enter' && peekState && (peekState.hits || []).length > 1
      && !document.getElementById('peekFloat').classList.contains('hidden')) {
    e.preventDefault();
    movePeekHit(e.shiftKey ? -1 : 1);
    return;
  }

  // Esc는 어디서든 — 지금 열려 있는 것 하나를 닫는다
  if (e.key === 'Escape') {
    const layers = [
      ['searchSheet', closeSearch],
      ['peekFloat', closePeek],
      ['jumpSheet', closeJump],
      ['keySheet', () => document.getElementById('keySheet').classList.add('hidden')],
      ['selPop', () => document.getElementById('selCancel').click()],
      ['askFloat', closeAskFloat],
      ['docDrawer', () => document.getElementById('docClose').click()],
    ];
    for (const [id, close] of layers) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) { e.preventDefault(); close(); return; }
    }
    return;
  }

  if (mod && (e.key === 'f' || e.key === 'F')) {       // ⌘F / ⌘⇧F
    e.preventDefault();
    openSearch(e.shiftKey ? 'all' : undefined);        // 기본은 "지금 떠 있는 문서"
    return;
  }
  if (mod && (e.key === 'o' || e.key === 'O')) {                // ⌘O — 다른 노트
    if (inReader() || document.body.dataset.screen === 'quizScreen') {
      e.preventDefault(); openDocDrawer(); return;
    }
  }
  if (mod && e.key === '\\' && inReader()) {           // ⌘\ — 화면 나누기
    e.preventDefault(); document.getElementById('readSplitBtn').click(); return;
  }
  if (mod && (e.key === '[' || e.key === ']') && inReader()) {
    e.preventDefault(); (e.key === '[' ? prevSection : nextSection)(); return;
  }
  if (mod && e.shiftKey && (e.key === 'a' || e.key === 'A')) {   // ⌘⇧A — 긁은 곳에 질문
    const ask = document.getElementById('selAsk');
    if (ask && !document.getElementById('selPop').classList.contains('hidden')) {
      e.preventDefault(); ask.click();
    }
    return;
  }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); openSearch(); return; }
  if (e.key === '?') { e.preventDefault(); showKeyHelp(); return; }
  if (inReader() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault(); (e.key === 'ArrowLeft' ? prevSection : nextSection)();
  }
});

// ── 마우스 보조 버튼 ──────────────────────────────────────
//
// 아이패드에서 실제로 앱까지 오는 것만 쓴다(2026-10-13 조사):
//   · 오른쪽 버튼  → contextmenu 로 온다. 가장 믿을 만하다.
//   · 가운데·4·5번 → auxclick / pointerdown 의 button 1·3·4. 기종에 따라
//     시스템이 먼저 먹기도 해서, 오면 쓰고 안 와도 다른 길을 남겨 둔다.
//   · 엄지 휠(좌우) → wheel 의 deltaX. 이건 거의 항상 온다.
// 버튼이 시스템에 막히면 설정 › 손쉬운 사용 › 터치 › AssistiveTouch › 기기 에서
// 그 버튼을 "보조 클릭"으로 바꿔 두면 오른쪽 버튼 경로로 들어온다.

function initMouse() {
  // 오른쪽 버튼 — 찾기. 글을 긁어 둔 채 누르면 그 말로 바로 찾는다.
  document.addEventListener('contextmenu', (e) => {
    if (typingNow(e.target) || !inReader()) return;
    e.preventDefault();
    const picked = String(window.getSelection() || '').trim();
    openSearch(picked ? 'doc' : undefined);
    if (picked) {
      const inp = document.getElementById('searchInput');
      inp.value = picked.slice(0, 60);
      runSearch(inp.value);
    }
  });

  document.addEventListener('auxclick', (e) => {
    if (!inReader()) return;
    if (e.button === 1) { e.preventDefault(); document.getElementById('readBack').click(); }
    else if (e.button === 3) { e.preventDefault(); prevSection(); }
    else if (e.button === 4) { e.preventDefault(); nextSection(); }
  });
  // 브라우저가 auxclick을 안 주는 경우를 위한 두 번째 길
  document.addEventListener('pointerdown', (e) => {
    if (!inReader() || e.pointerType !== 'mouse') return;
    if (e.button === 3) { e.preventDefault(); prevSection(); }
    else if (e.button === 4) { e.preventDefault(); nextSection(); }
  });

  // 엄지 휠(좌우 스크롤) — 섹션 넘기기. 한 번 넘기면 잠깐 쉰다(한 번에 주르륵 넘어가지 않게)
  let wheelAt = 0;
  document.addEventListener('wheel', (e) => {
    if (!inReader()) return;
    if (Math.abs(e.deltaX) < 24 || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) return;
    const now = Date.now();
    if (now - wheelAt < 420) return;
    wheelAt = now;
    (e.deltaX < 0 ? prevSection : nextSection)();
  }, { passive: true });

  // 마우스로 글을 긁어도 펜과 **같은 팝업**이 뜬다 — 질문·복사·카드를 그대로 쓴다
  document.addEventListener('mouseup', (e) => {
    if (!inReader() || e.button !== 0) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = String(sel || '').trim();
      const body = document.getElementById('readBody');
      if (text.length < 2 || !body || !sel.rangeCount) return;
      if (!body.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (!(reader && reader.note)) return;
      openAskFromReader(text, null);          // 펜으로 긁었을 때와 **같은 길**로 보낸다
      const pop = document.getElementById('selPop');
      requestAnimationFrame(() => {
        const pr = pop.getBoundingClientRect();
        pop.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - pr.width / 2, innerWidth - pr.width - 8))}px`;
        pop.style.top = `${Math.max(8, Math.min(r.bottom + 10, innerHeight - pr.height - 8))}px`;
      });
    }, 10);
  });
}
initMouse();

// ---------- 서비스워커 · 업데이트 ----------
// 배포해도 아이패드에서 안 바뀌는 일이 있었다. 두 겹의 캐시가 원인이다:
//   ① GitHub Pages의 max-age=600 → sw.js가 fetch해도 HTTP 캐시가 옛 파일을 준다(sw.js에서 해결)
//   ② 이미 켜져 있는 앱은 새 워커가 대기만 하고 교체되지 않는다(여기서 해결)
// 새 버전이 준비되면 **알려주고 한 번 눌러 바로 넘어가게** 한다.
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // 앱을 켤 때마다, 그리고 다시 포그라운드로 올 때마다 새 버전을 확인한다
    const check = () => reg.update().catch(() => {});
    check();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        // 이미 쓰던 앱이 있을 때만 "새 버전" — 첫 설치는 그냥 쓰면 된다
        if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(reg);
      });
    });
  }).catch(() => {});
  // 새 워커가 제어권을 잡으면 화면을 새로 그린다
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

function showUpdateBar(reg) {
  if (document.getElementById('updateBar')) return;
  const bar = document.createElement('div');
  bar.id = 'updateBar';
  const txt = document.createElement('span');
  txt.textContent = '새 버전이 준비됐습니다';
  const btn = document.createElement('button');
  btn.textContent = '지금 적용';
  btn.onclick = () => {
    btn.disabled = true;
    btn.textContent = '적용 중…';
    const sw = reg.waiting || reg.installing;
    if (sw) sw.postMessage('SKIP_WAITING');
    setTimeout(() => location.reload(), 1200);   // 메시지가 묻혀도 결국 새로고침
  };
  bar.append(txt, btn);
  document.body.appendChild(bar);
}

/** 지금 돌고 있는 앱 버전 — 설정에 표시해 "배포됐는데 안 바뀐다"를 바로 확인한다. */
async function runningVersion() {
  const r = await runningBuild();
  return r.version;
}

/** 지금 돌고 있는 버전과 그게 올라간 시각. */
async function runningBuild() {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    return { version: '(서비스워커 없음)', built: '' };
  }
  return new Promise((res) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => res({
      version: (e.data && e.data.version) || '?',
      built: (e.data && e.data.built) || '',
    });
    navigator.serviceWorker.controller.postMessage('VERSION', [ch.port2]);
    setTimeout(() => res({ version: '?', built: '' }), 1000);
  });
}

/**
 * 머리줄 구석의 작은 버전 칩 — "내가 뭘 보고 있는지"를 알려준다(2026-10-14 요청).
 * 주 정보가 아니니 작게. 누르면 새 버전이 있는지 확인하고 받아온다.
 */
async function paintVersionChip() {
  const chip = document.getElementById('verChip');
  if (!chip) return;
  const { version, built } = await runningBuild();
  chip.textContent = version;
  chip.title = built ? `앱 ${version} · ${built} 배포 — 눌러서 새 버전 확인` : `앱 ${version}`;
}
document.getElementById('verChip').onclick = async () => {
  const chip = document.getElementById('verChip');
  const old = chip.textContent;
  chip.textContent = '확인 중…';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
    await new Promise((r) => setTimeout(r, 900));
    // 새 워커가 대기 중이면 업데이트 띠가 알아서 뜬다(showUpdateBar)
    await paintVersionChip();
    if (chip.textContent === old) toast(`최신입니다 (${old})`);
  } catch { chip.textContent = old; }
};

// 앱이 가려질 때 대기 중인 백업을 밀어낸다 — iOS는 백그라운드 타이머를 멈춘다.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') backup.flushBackup().catch(() => {});
});

/** 스플래시를 치운다 — 짧게 보여주되, 준비가 늦으면 그만큼만 더 기다린다. */
function hideSplash() {
  const el = document.getElementById('splash');
  if (!el || el.classList.contains('gone')) return;
  const MIN = 900;                       // 그림이 한 번 움직일 만큼
  const wait = Math.max(0, MIN - (Date.now() - (window.__t0 || Date.now())));
  setTimeout(() => {
    el.classList.add('gone');
    setTimeout(() => el.remove(), 500);  // 사라진 뒤 DOM에서도 뺀다
  }, wait);
}

// ---------- 시작 ----------
(async function init() {
  window.__t0 = Date.now();
  await applyTheme();
  await loadDisplay();
  await loadWinMode();
  await loadSplitMem();
  initTimer();
  initClozeMaker();
  paintVersionChip();
  await loadReadPos();
  await loadReadPass();
  initServiceWorker();
  gem.loadDeadModels().catch(() => {});
  gem.loadBodyTiers().catch(() => {});   // 어떤 모델에 어떤 본문이 통했는지 기억해둔 것
  initResizers();
  initAskFloat();
  initCardFloat();
  initPeek();
  initScrap();
  initDisplayUI();
  initDocDrop();
  // 지난번에 맞춰둔 창 비율을 되살린다
  { const v = localStorage.getItem('pane_split'); if (v) document.documentElement.style.setProperty('--pane-split', v); }
  refreshSyncBar();
  flushOutbox();
  try {
    if (await hasToken()) await loadList(false);
    else openSetup();
  } finally {
    hideSplash();                        // 실패해도 스플래시에 갇히지 않게
  }
  // 전체 색인을 한 번 받아둔 사람이면 **조용히 맞춰둔다** — 요청 한 번(git tree)으로
  // 달라진 파일만 가려내므로, 보통 아무것도 안 받고 끝난다. 오늘 올라온 노트가
  // 검색에 안 걸리는 일을 없애려는 것이다(2026-10-15).
  if (await hasToken()) {
    const info = await indexInfo();
    if (info.built && Date.now() - (info.at || 0) > 30 * 60 * 1000) {
      setTimeout(() => runIndex({ quiet: true }), 2500);
    }
  }
})();

// 어떤 이유로든 초기화가 멈추면 3초 뒤엔 무조건 치운다
setTimeout(hideSplash, 3000);
