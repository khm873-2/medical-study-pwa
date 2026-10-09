// 메인 — 화면 전환, 모의고사 목록, 결과 저장, 동기화 큐.

import { hasToken, setToken, clearToken, verifyToken, getRepo, setRepo } from './auth.js';
import { listDir, getText, getBlobUrl, createFile } from './github.js';
import { parseExamHtml, prettyExamName, examDate, examSortKey, teacherName } from './parser.js';
import { Quiz } from './quiz.js';
import { PenLayer, tokenizeTree } from './pen.js';
import * as gem from './gemini.js';
import { wikiFor, fitLabel } from './wiki.js';
import * as backup from './backup.js';
import { captureRect, canvasToBlob, copyBlobToClipboard } from './capture.js';
import { renderMarkdown, hydrateEmbeds } from './markdown.js';
import { buildPrompt, appList, sendTo, share, buildQaMarkdown } from './ask.js';
import {
  noteList, loadNote, renderSection, extractCards,
  loadSrs, saveSrs, dueCards, gradeCard, srsStats, keepAwake, cardsFromBox,
} from './reader.js';
import { search, cacheSubject, storageInfo } from './search.js';
import {
  kvGet, kvSet, cacheClear, enqueue, listOutbox, dequeue, bumpTries,
  allSessions, clearSession,
} from './db.js';

// 모의고사와 퀴즈를 둘 다 읽는다 — vault에서 내가 만든 퀴즈도 앱에서 풀 수 있어야 한다.
// 두 폴더의 HTML이 같은 QUESTIONS 스키마를 쓰므로 파서는 그대로 재사용한다(2026-10-10).
const EXAM_ROOTS = [
  { root: '06_모의고사', kind: '모의고사' },
  { root: '05_퀴즈', kind: '퀴즈' },
];
const LOG_DIR = '00_Raw_Text/AI대화로그';

const screens = ['setupScreen', 'listScreen', 'quizScreen', 'resultScreen', 'readScreen', 'cardScreen'];
let quiz = null;
let lastResult = null;
let currentExam = null; // {subject, file, path, title}

// ---------- 화면 전환 ----------
function show(id) {
  screens.forEach((s) => document.getElementById(s).classList.toggle('hidden', s !== id));
  window.scrollTo(0, 0);
}

// ---------- 테마 ----------
async function applyTheme() {
  const t = (await kvGet('theme')) || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
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
  runningVersion().then((v) => {
    const el = document.getElementById('appVersion');
    if (el) el.textContent = `앱 버전 ${v}`;
  });
  document.getElementById('backupMsg').textContent = '';
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
    state.textContent = k.ok ? `${k.limit - k.used}회 남음` : `${k.waitSec}초 쉬는 중`;
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
  restoreTab();
  // 로딩·오류 문구는 **지금 보고 있는 탭**에 띄운다
  const body = document.getElementById(
    document.querySelector('.tab.active')?.dataset.tab === 'exams' ? 'listBody' : 'quizBody');
  body.innerHTML = '<p class="muted">불러오는 중…</p>';

  try {
    const cacheKey = 'exam_index_v2';     // 퀴즈가 들어오면서 구조가 바뀌어 키를 올린다
    let index = force ? null : await kvGet(cacheKey);
    if (!index) {
      const byKey = new Map();            // "과목 · 종류" 단위로 묶는다
      for (const { root, kind } of EXAM_ROOTS) {
        let subjects;
        try { subjects = (await listDir(root)).filter((e) => e.type === 'dir'); }
        catch { continue; }               // 폴더가 없는 과목도 있다 — 조용히 넘어간다
        for (const sub of subjects) {
          let files;
          try { files = await listDir(sub.path); } catch { continue; }
          const items = files
            .filter((f) => f.type === 'file' && f.name.endsWith('.html') && !f.name.startsWith('_'))
            .map((f) => ({ file: f.name, path: f.path, kind }));
          if (!items.length) continue;
          const k = `${sub.name}|${kind}`;
          if (!byKey.has(k)) byKey.set(k, { subject: sub.name, kind, exams: [] });
          byKey.get(k).exams.push(...items);
        }
      }
      index = [...byKey.values()];
      for (const g of index) {
        // 날짜 **내림차순** — 최근에 배운 것부터 복습한다(2026-10-10 요청)
        g.exams.sort((a, b) => examSortKey(b.file).localeCompare(examSortKey(a.file))
          || a.file.localeCompare(b.file, 'ko'));
      }
      // 모의고사를 먼저, 그 다음 퀴즈. 같은 종류 안에서는 과목 이름순.
      index.sort((a, b) => (a.kind === b.kind ? a.subject.localeCompare(b.subject, 'ko')
        : a.kind === '모의고사' ? -1 : 1));
      await kvSet(cacheKey, index);
    }
    const sessions = await allSessions();
    renderList(index, sessions, '퀴즈');
    renderList(index, sessions, '모의고사');
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
 * 시험 목록을 그린다. 퀴즈와 모의고사는 **탭이 다르므로 따로** 그린다(2026-10-10 요청).
 * @param {string} kind '모의고사' | '퀴즈'
 */
function renderList(index, sessions, kind = '모의고사') {
  const bodyId = kind === '퀴즈' ? 'quizBody' : 'listBody';
  const body = document.getElementById(bodyId);
  body.innerHTML = '';
  index = index.filter((g) => (g.kind || '모의고사') === kind);
  if (!index.length) {
    body.innerHTML = `<p class="muted">${kind}를 찾지 못했습니다.</p>`;
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

      const d = document.createElement('span');
      d.className = 'exam-date';
      d.textContent = examDate(ex.file);

      const nameWrap = document.createElement('span');
      nameWrap.className = 'exam-name';
      nameWrap.textContent = prettyExamName(ex.file);
      const who = teacherName(ex.file);
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

// ---------- 시험 열기 ----------
async function openExam(subject, ex) {
  const body = document.getElementById('listBody');
  const prev = body.innerHTML;
  body.innerHTML = '<p class="muted">시험을 불러오는 중…</p>';
  try {
    const html = await getText(ex.path);
    const { questions, title } = parseExamHtml(html);
    currentExam = { subject, file: ex.file, path: ex.path, title: title || prettyExamName(ex.file) };

    if (quiz) quiz.destroy();
    destroyPen();
    quiz = new Quiz({
      examKey: ex.path,
      questions,
      title: currentExam.title,
      onFinish: showResult,
      onExit: () => { quiz.destroy(); destroyPen(); loadList(false); },
      onRender: onQuestionRender,
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
document.getElementById('toolErase').onclick = () => {
  if (!pen) return;
  const on = !pen.erasing;
  pen.setErasing(on);
  document.getElementById('toolErase').classList.toggle('active', on);
};
document.getElementById('toolWiki').onclick = () => toggleWiki();
// AI 해설도 위키처럼 탭으로 — 질문할 때마다 자동으로 열리기만 하던 걸 직접 열고 닫게 한다
document.getElementById('toolAi').onclick = () => {
  const p = document.getElementById('aiPanel');
  if (p.classList.contains('hidden')) {
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

/** 문항이 바뀔 때마다 — 필기 복원 + 위키 갱신 */
function onQuestionRender(q, idx, { answered }) {
  if (pen) {
    pen.load(penStrokes[idx] || null);
    requestAnimationFrame(() => pen && pen.resize());
  }
  if (!document.getElementById('wikiPanel').classList.contains('hidden')) {
    loadWiki(q, answered);
  }
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

function renderWikiSection() {
  if (!wikiState) return;
  const { refs, secIdx, unlocked } = wikiState;
  const sec = refs.sections[secIdx];

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

/** 선택한 자리 근처에 팝업을 띄운다. */
function showSelPop(text, box) {
  const pop = document.getElementById('selPop');
  document.getElementById('selPopText').textContent = text;
  pop.classList.remove('hidden');

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
  hideSelPop();
  if (!selTerm()) return;
  try { await navigator.clipboard.writeText(selTerm()); toast('📋 복사했습니다.'); }
  catch { toast('복사에 실패했습니다.'); }
};
document.getElementById('selNote').onclick = () => {
  hideSelPop();
  if (!quiz) { toast('메모는 문제 화면에서만 됩니다.'); return; }
  if (!selTerm()) return;
  const i = quiz.qIndex;
  quiz.memos[i] = (quiz.memos[i] ? quiz.memos[i] + '\n' : '') + selTerm();
  quiz.persist();
  document.getElementById('memoInput').value = quiz.memos[i];
  document.getElementById('memoBox').style.display = 'block';
  toast('메모에 넣었습니다.');
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
    const answer = await gem.ask({
      term,
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
  const render = async () => {
    const keys = (await gem.getKeys()).length;
    body.innerHTML =
      `<div class="warn-box">넣어둔 키 ${keys}개가 모두 한도에 걸렸습니다. ` +
      `<b>${left}초</b> 뒤 자동으로 다시 묻습니다.<br>` +
      `설정에서 <b>키를 더 넣으면</b> 이런 일이 줄어듭니다 — 키마다 한도가 따로입니다.</div>`;
    status.textContent = `대기 중 · 남은 호출 ${await gem.callsLeft()}회`;
  };
  render();
  clearInterval(rateTimer);
  rateTimer = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(rateTimer);
      askNow(term);
      return;
    }
    render();
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
    !document.getElementById('wikiPanel').classList.contains('hidden');
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

async function handleCapture(box) {
  const r = pen.canvas.getBoundingClientRect();
  const rect = {
    left: r.left + box.l, top: r.top + box.t,
    width: box.r - box.l, height: box.b - box.t,
  };
  const busy = capToast('캡처하는 중…', 20000);
  try {
    const cv = await captureRect(rect);
    const blob = await canvasToBlob(cv);
    if (!blob) throw new Error('이미지를 만들지 못했습니다.');
    lastCapture = blob;                       // 복사에 실패해도 손에 남겨둔다
    try {
      await copyBlobToClipboard(Promise.resolve(blob));
      busy.remove();
      capToast('📋 복사했습니다');
    } catch {
      busy.remove();
      capToast('캡처했지만 복사 권한이 없습니다 — 길게 눌러 복사하세요', 2600);
    }
  } catch (e) {
    busy.remove();
    capToast(`캡처 실패 — ${e.message}`, 2400);
  }
}
let lastCapture = null;

document.getElementById('toolCapture').onclick = () => {
  if (!pen) return;
  const on = !pen.capturing;
  pen.setCapturing(on);
  document.getElementById('toolCapture').classList.toggle('active', on);
  document.getElementById('toolErase').classList.remove('active');
  capToast(on ? '펜으로 네모를 그리면 복사됩니다' : '캡처 모드 끔');
};

// ---------- 문제 뜯어보기 ----------
// 지문을 단서별로 끊어 "시험에서 이게 뭘 뜻하는지"를 붙인다.
// 답을 알려주는 게 아니라 읽는 법을 훈련하는 용도(2026-10-10 요청).
let breakdownBusy = false;

async function runBreakdown() {
  if (!quiz || breakdownBusy) return;
  const q = quiz.all[quiz.order[quiz.cur]];
  const el = document.getElementById('breakdown');

  // 이미 떠 있으면 토글로 닫는다
  if (!el.classList.contains('hidden') && el.dataset.forNum === String(q.num)) {
    el.classList.add('hidden');
    document.getElementById('toolBreak').classList.remove('active');
    return;
  }
  if (!(await gem.hasKey())) { askNoKey(q.q); return; }

  breakdownBusy = true;
  el.dataset.forNum = String(q.num);
  el.classList.remove('hidden');
  el.innerHTML = '<div class="bd-loading">지문을 뜯어보는 중…</div>';
  document.getElementById('toolBreak').classList.add('active');
  try {
    renderBreakdown(el, await gem.breakdown(q), q);
  } catch (e) {
    const wait = /^RATE_WAIT:(\d+)$/.exec(e.message);
    el.innerHTML = '';
    const w = document.createElement('div');
    w.className = 'warn-box';
    w.textContent = wait ? `요청이 많습니다 — ${wait[1]}초 뒤에 다시 눌러주세요.` : e.message;
    el.appendChild(w);
  } finally {
    breakdownBusy = false;
    if (pen) requestAnimationFrame(() => pen.resize());
  }
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
  head.innerHTML = '<span>🔍 지문 뜯어보기</span>';
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
    drag = {
      kind, x: e.clientX, y: e.clientY,
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

let reader = null;      // {note, secIdx}
let readerPen = null;
let cardDeck = null;    // {cards, idx, srs, title}

// ---- 탭 ----
const TAB_BODY = { quizzes: 'quizBody', exams: 'listBody', notes: 'notesBody', cards: 'cardsBody' };

function showTab(which, { remember = true } = {}) {
  if (!TAB_BODY[which]) which = 'quizzes';
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === which));
  for (const [k, id] of Object.entries(TAB_BODY)) {
    document.getElementById(id).classList.toggle('hidden', k !== which);
  }
  if (remember) localStorage.setItem('last_tab', which);
  if (which === 'notes') loadNotesTab();
  if (which === 'cards') loadCardsTab();
}

/** 마지막으로 보던 탭으로 돌아간다 — 매번 퀴즈 탭부터 찾아 들어가지 않게. */
function restoreTab() {
  showTab(localStorage.getItem('last_tab') || 'quizzes', { remember: false });
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => showTab(t.dataset.tab);
});

// ---- 노트 목록 ----
async function loadNotesTab(force) {
  const body = document.getElementById('notesBody');
  body.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const groups = await noteList(force);
    body.innerHTML = '';
    if (!groups.length) { body.innerHTML = '<p class="muted">노트를 찾지 못했습니다.</p>'; return; }

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
    reader = { note, secIdx: 0 };
    show('readScreen');
    // 넓은 화면은 목차를 펴놓고, 좁은 화면은 본문을 가리지 않게 접어둔다(기억값 우선)
    const saved = localStorage.getItem('toc_open');
    tocOpen(saved === null ? window.innerWidth >= 900 : saved === '1');
    renderReader();
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
  const cur = list.querySelector('.toc-link.current');   // 긴 목차에서 현재 항목 끌어오기
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

document.getElementById('readTocBtn').onclick = () => tocOpen(!tocIsOpen());
document.getElementById('readTocHide').onclick = () => tocOpen(false);
document.getElementById('readTocScrim').onclick = () => tocOpen(false);

function renderReader() {
  if (!reader) return;
  const { note, secIdx } = reader;
  const sec = note.sections[secIdx];
  renderToc();
  document.getElementById('readTitle').textContent = note.title;
  document.getElementById('readHeading').textContent = sec.heading;
  document.getElementById('readPos').textContent = `${secIdx + 1}/${note.sections.length}`;
  const rb = document.getElementById('readBody');
  renderSection(rb, sec);
  tokenizeTree(rb);   // 노트 본문도 밑줄로 긁을 수 있게
  document.getElementById('readPrev').disabled = secIdx === 0;
  document.getElementById('readNext').disabled = secIdx === note.sections.length - 1;
  window.scrollTo(0, 0);
  if (readerPen) requestAnimationFrame(() => readerPen.resize());
}

function ensureReaderPen() {
  if (readerPen) return;
  readerPen = new PenLayer(document.getElementById('readCard'), {
    onSelect: (text, info) => { if (text) openAskFromReader(text, info); },
    onCard: (box) => makeCardsFromBox(box),
  });
}

// ---------- 읽다가 바로 카드 만들기 ----------
// "이 부분 외웠나?" 싶을 때 펜으로 네모 → 그 안의 **굵게·기울임·하이라이트**가
// 빈칸이 되고 나머지 문장이 문제가 된다. 되새김질용(2026-10-10 요청).
function readerCardMode(on) {
  if (!readerPen) return;
  readerPen.setCarding(on);
  document.getElementById('readMakeCard').classList.toggle('active', on);
  document.getElementById('readPen').classList.remove('active');
  capToast(on ? '펜으로 네모를 치면 그 범위로 카드를 만듭니다' : '카드 만들기 끔');
}

document.getElementById('readMakeCard').onclick = () => {
  if (!readerPen) return;
  readerCardMode(!readerPen.carding);
};

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
  startDeck(cards, reader.note.title, { backTo: 'reader' });
  capToast(`카드 ${cards.length}장을 만들었습니다`);
}

/** 카드 묶음을 띄운다. 돌아갈 곳을 기억해 읽던 자리로 복귀한다. */
async function startDeck(cards, title, { backTo = 'list' } = {}) {
  const srsNow = await loadSrs();
  cardDeck = { cards, idx: 0, srs: srsNow, title, all: cards, backTo };
  show('cardScreen');
  renderCard();
}

document.getElementById('readBack').onclick = () => {
  if (readerPen) { readerPen.destroy(); readerPen = null; }
  keepAwake(false);
  stopTts();
  reader = null;
  show('listScreen');
};
document.getElementById('readPrev').onclick = () => {
  if (reader && reader.secIdx > 0) { reader.secIdx--; renderReader(); }
};
document.getElementById('readNext').onclick = () => {
  if (reader && reader.secIdx < reader.note.sections.length - 1) { reader.secIdx++; renderReader(); }
};
// 읽기 모드에선 펜이 항상 살아 있다 — 이 버튼은 지우개 토글로만 쓴다.
document.getElementById('readPen').onclick = () => {
  if (!readerPen) return;
  const on = !readerPen.erasing;
  readerPen.setErasing(on);
  document.getElementById('readPen').classList.toggle('active', on);
  toast(on ? '지우개 켜짐' : '펜으로 돌아왔습니다');
};
document.getElementById('readAwake').onclick = async () => {
  const btn = document.getElementById('readAwake');
  const on = !btn.classList.contains('active');
  const ok = await keepAwake(on);
  btn.classList.toggle('active', ok && on);
  toast(ok && on ? '화면이 꺼지지 않습니다.' : on ? '이 기기에서는 지원되지 않습니다.' : '해제했습니다.');
};

// 선택한 텍스트로 질문 — 올가미보다 정확해서 읽기 모드에선 이쪽을 쓴다
document.getElementById('readAsk').onclick = () => {
  const sel = String(window.getSelection() || '').trim();
  if (!sel) { toast('먼저 궁금한 부분을 드래그해서 선택하세요.'); return; }
  openAskFromReader(sel, null);
};

/** 읽기 모드에서 긁었을 때 — 여기서도 바로 묻지 않고 팝업으로 고르게 한다. */
function openAskFromReader(term, info) {
  const { note, secIdx } = reader;
  const sec = note.sections[secIdx];
  askCtx = { term, qnum: '—', qtext: `${note.title} · ${sec.heading}`, question: null, noteText: sec.text };
  askCtx.prompt = buildPrompt({ term, question: null, subject: note.title, lecture: sec.heading });
  showSelPop(term, info && info.box);
}

/** 읽기 모드에서 "여기서 질문"을 고른 경우 — 시트 안에 답변을 띄운다(화면 전환 없음). */
async function askInReader(term) {
  if (!(await gem.hasKey())) { fillAskSheet(term); return; }
  fillAskSheet(term);
  const ta = document.getElementById('askAnswer');
  const msg = document.getElementById('askMsg');
  msg.textContent = '묻는 중…';
  try {
    const answer = await gem.ask({
      term, question: null, noteText: askCtx.noteText || '',
      subject: reader ? reader.note.title : '', lecture: askCtx.qtext || '',
    });
    askCtx.answer = answer;
    ta.value = answer;
    msg.textContent = '답변을 받았습니다. "답변 저장"을 누르면 vault에 기록됩니다.';
  } catch (e) {
    const w = /^RATE_WAIT:(\d+)$/.exec(e.message);
    msg.textContent = e.message === 'NO_KEY' ? ''
      : w ? `무료 한도에 걸렸습니다 — ${w[1]}초 뒤 다시 시도하거나 아래 앱으로 물어보세요.`
      : `오류: ${e.message}`;
  }
}

// ---- TTS ----
let ttsOn = false;
function stopTts() {
  try { window.speechSynthesis.cancel(); } catch {}
  ttsOn = false;
  document.getElementById('readTts').classList.remove('active');
}
document.getElementById('readTts').onclick = () => {
  if (!('speechSynthesis' in window)) { toast('이 기기는 읽어주기를 지원하지 않습니다.'); return; }
  if (ttsOn) { stopTts(); return; }
  const text = document.getElementById('readBody').textContent.replace(/\s+/g, ' ').trim();
  if (!text) return;
  const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
  u.lang = 'ko-KR';
  u.rate = 1.05;
  u.onend = () => stopTts();
  window.speechSynthesis.speak(u);
  ttsOn = true;
  document.getElementById('readTts').classList.add('active');
};

// ---- 플래시카드 ----
async function loadCardsTab() {
  const body = document.getElementById('cardsBody');
  body.innerHTML = '<p class="muted">카드를 세는 중…</p>';
  try {
    const groups = await noteList(false);
    const srs = await loadSrs();
    body.innerHTML = '';

    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = '노트의 ⭐ ==하이라이트== 를 그대로 카드로 씁니다. 노트를 고르면 복습이 시작됩니다.';
    body.appendChild(hint);

    for (const g of groups) {
      const det = document.createElement('details');
      det.className = 'subject-group';
      const sum = document.createElement('summary');
      sum.className = 'subject-head';
      sum.innerHTML = '<span class="head-row">' +
        `<span>${escapeText(g.subject.replace(/_/g, ' '))}</span>` +
                      `<span class="subject-count">${g.notes.length}개</span>` + '</span>';
      det.appendChild(sum);
      body.appendChild(det);
      for (const n of g.notes) {
        const b = document.createElement('button');
        b.className = 'exam-item';
        const name = document.createElement('span');
        name.className = 'exam-name';
        name.textContent = n.name.replace(/^\d{4}_/, '');
        const meta = document.createElement('span');
        meta.className = 'exam-progress';
        meta.textContent = '›';
        b.appendChild(name); b.appendChild(meta);
        b.onclick = () => startCards(n.path, srs);
        det.appendChild(b);
      }
    }
  } catch (e) {
    body.innerHTML = `<div class="warn-box">${e.message}</div>`;
  }
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
  document.getElementById('cardSource').textContent = c.heading;
  document.getElementById('cardContext').textContent = c.context;
  document.getElementById('cardAnswer').textContent = c.answer;
  document.getElementById('cardAnswer').classList.add('hidden');
  document.getElementById('cardShow').classList.remove('hidden');
  document.getElementById('cardGrade').classList.add('hidden');
  window.scrollTo(0, 0);
}

document.getElementById('cardShow').onclick = () => {
  document.getElementById('cardAnswer').classList.remove('hidden');
  document.getElementById('cardShow').classList.add('hidden');
  document.getElementById('cardGrade').classList.remove('hidden');
};
document.getElementById('cardAgain').onclick = () => advanceCard(false);
document.getElementById('cardGot').onclick = () => advanceCard(true);
document.getElementById('cardBack').onclick = () => {
  const back = cardDeck && cardDeck.backTo;
  cardDeck = null;
  // 읽다가 만든 카드면 읽던 자리로 돌아간다
  if (back === 'reader' && reader) { show('readScreen'); if (readerPen) requestAnimationFrame(() => readerPen.resize()); }
  else show('listScreen');
};

async function advanceCard(remembered) {
  if (!cardDeck) return;
  const c = cardDeck.cards[cardDeck.idx];
  gradeCard(cardDeck.srs, c.id, remembered);
  await saveSrs(cardDeck.srs);
  backup.scheduleBackup();       // 외운 기록은 되찾을 수 없다 — 모아서 vault에 올린다
  if (cardDeck.idx + 1 >= cardDeck.cards.length) {
    const s = srsStats(cardDeck.all, cardDeck.srs);
    toast(`끝! 처음 ${s.new} · 학습중 ${s.learning} · 익힘 ${s.mature}`);
    cardDeck = null;
    show('listScreen');
    return;
  }
  cardDeck.idx++;
  renderCard();
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ═══════════ Phase 5 — 검색 ═══════════

document.getElementById('searchBtn').onclick = () => {
  document.getElementById('searchSheet').classList.remove('hidden');
  document.getElementById('searchInput').focus();
};
document.getElementById('searchClose').onclick = () =>
  document.getElementById('searchSheet').classList.add('hidden');
document.getElementById('searchSheet').onclick = (e) => {
  if (e.target.id === 'searchSheet') e.target.classList.add('hidden');
};

let searchTimer = null;
document.getElementById('searchInput').oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 250);
};

async function runSearch(q) {
  const msg = document.getElementById('searchMsg');
  const box = document.getElementById('searchResults');
  if (String(q).trim().length < 2) { box.innerHTML = ''; msg.textContent = ''; return; }
  msg.textContent = '찾는 중…';
  const hits = await search(q);
  box.innerHTML = '';
  if (!hits.length) {
    msg.textContent = '결과가 없습니다. (한 번도 열어보지 않은 자료는 검색되지 않습니다 — 설정에서 과목을 오프라인 저장하면 전체가 검색됩니다.)';
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
      document.getElementById('searchSheet').classList.add('hidden');
      if (h.kind === 'note') openNote(h.path);
      else openExamAt(h.path, h.qnum);
    };
    box.appendChild(b);
  }
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
function showResult(res) {
  lastResult = res;
  document.getElementById('resultTitle').textContent = currentExam.title;
  document.getElementById('finalScore').textContent = `${res.correct}/${res.total}`;
  const pct = res.answered ? Math.round((res.correct / res.answered) * 100) : 0;
  document.getElementById('finalPct').textContent =
    `푼 문항 ${res.answered}/${res.total}${res.answered ? ` · 정답률 ${pct}%` : ''}`;
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
      const ans = x.q.type === 'ox' ? (x.q.ans === 0 ? 'O' : 'X') : `${x.q.ans + 1}번`;
      d.textContent = `${x.q.num}. ${x.q.q.slice(0, 60)}… (내 답 ${picked} / 정답 ${ans})`;
      wl.appendChild(d);
    });
  } else if (res.answered) {
    wl.innerHTML = '<div style="font-weight:700">전부 맞혔습니다 🎉</div>';
  }

  document.getElementById('retryWrongBtn').style.display = res.wrong.length ? '' : 'none';
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
      const ans = x.q.type === 'ox' ? (x.q.ans === 0 ? 'O' : 'X') : `${x.q.ans + 1}번`;
      lines.push(`### ${x.q.num}. (내 답 ${picked} → 정답 ${ans})`);
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
    marked.forEach((x) => lines.push(`- ${x.q.num}. ${x.q.q.slice(0, 80)}…`));
    lines.push('');
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

  const safeTopic = topic.replace(/[\/\\:*?"<>|]/g, '_');
  const path = `${LOG_DIR}/${subject}_${dateStr}_${safeTopic}_모의고사풀이.md`;
  return { path, content: lines.join('\n'), message: `iPad 모의고사 풀이: ${topic} ${res.correct}/${res.total}` };
}

document.getElementById('saveToVaultBtn').onclick = async () => {
  if (!lastResult) return;
  const msg = document.getElementById('saveMsg');
  msg.textContent = '저장 중…';

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

  const saved = [];
  const queued = [];
  for (const p of payloads) {
    try {
      const r = await createFile(p.path, p.content, p.message);
      saved.push(r.path.split('/').pop());
    } catch (e) {
      await enqueue(p);
      queued.push(p.path.split('/').pop());
    }
  }
  if (queued.length) {
    msg.textContent = `⚠️ ${saved.length}건 저장, ${queued.length}건은 대기열로 (네트워크 복구 시 자동 전송)`;
    refreshSyncBar();
  } else {
    msg.textContent = `✅ 저장됨 — ${saved.join(', ')}`;
    askItems = [];
    clearSession(currentExam.path).catch(() => {});
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

// ---------- 아웃박스(동기화 대기열) ----------
async function refreshSyncBar() {
  const items = await listOutbox();
  const bar = document.getElementById('syncBar');
  if (!items.length) { bar.classList.add('hidden'); return; }
  document.getElementById('syncText').textContent = `저장 대기 ${items.length}건`;
  bar.classList.remove('hidden');
}

async function flushOutbox() {
  if (!(await hasToken())) return;
  const items = await listOutbox();
  for (const it of items) {
    try {
      await createFile(it.path, it.content, it.message);
      await dequeue(it.id);
    } catch (e) {
      await bumpTries(it.id, e.message);
      break; // 하나 실패하면 이번 회차는 중단(네트워크 문제일 가능성이 높음)
    }
  }
  refreshSyncBar();
}

document.getElementById('syncNowBtn').onclick = async () => {
  document.getElementById('syncText').textContent = '보내는 중…';
  await flushOutbox();
};

window.addEventListener('online', flushOutbox);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushOutbox(); });

// ---------- 잡다 ----------
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

function alertBox(text) {
  const body = document.getElementById('listBody');
  const box = document.createElement('div');
  box.className = 'warn-box';
  box.style.marginBottom = '12px';
  box.textContent = text;
  body.prepend(box);
}

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
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return '(서비스워커 없음)';
  return new Promise((res) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => res((e.data && e.data.version) || '?');
    navigator.serviceWorker.controller.postMessage('VERSION', [ch.port2]);
    setTimeout(() => res('?'), 1000);
  });
}

// 앱이 가려질 때 대기 중인 백업을 밀어낸다 — iOS는 백그라운드 타이머를 멈춘다.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') backup.flushBackup().catch(() => {});
});

// ---------- 시작 ----------
(async function init() {
  await applyTheme();
  initServiceWorker();
  initResizers();
  refreshSyncBar();
  flushOutbox();
  if (await hasToken()) loadList(false);
  else openSetup();
})();
