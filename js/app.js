// 메인 — 화면 전환, 모의고사 목록, 결과 저장, 동기화 큐.

import { hasToken, setToken, clearToken, verifyToken, getRepo, setRepo } from './auth.js';
import { listDir, getText, getBlobUrl, createFile } from './github.js';
import { parseExamHtml, prettyExamName, examDate } from './parser.js';
import { Quiz } from './quiz.js';
import { PenLayer, tokenizeTree } from './pen.js';
import * as gem from './gemini.js';
import { wikiFor } from './wiki.js';
import { renderMarkdown, hydrateEmbeds } from './markdown.js';
import { buildPrompt, appList, sendTo, share, buildQaMarkdown } from './ask.js';
import {
  noteList, loadNote, renderSection, extractCards,
  loadSrs, saveSrs, dueCards, gradeCard, srsStats, keepAwake,
} from './reader.js';
import { search, cacheSubject, storageInfo } from './search.js';
import {
  kvGet, kvSet, cacheClear, enqueue, listOutbox, dequeue, bumpTries,
  allSessions, clearSession,
} from './db.js';

const EXAM_ROOT = '06_모의고사';
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
  setTimeout(() => loadList(true), 700);
};

document.getElementById('saveGeminiBtn').onclick = async () => {
  const msg = document.getElementById('geminiMsg');
  const key = document.getElementById('geminiKeyInput').value.trim();
  if (!key) {
    await gem.clearKey();
    msg.style.color = 'var(--sub)';
    msg.textContent = '키를 비웠습니다 — 질문은 앱으로 넘기는 방식으로 동작합니다.';
    return;
  }
  msg.style.color = ''; msg.textContent = '확인 중…';
  const r = await gem.verifyKey(key);
  if (!r.ok) { msg.style.color = 'var(--wrong)'; msg.textContent = r.error; return; }
  await gem.setKey(key);
  msg.style.color = 'var(--correct)';
  msg.textContent = `연결됐습니다 (모델: ${r.model}). 이제 밑줄을 그으면 옆에 바로 답변이 뜹니다.`;
};

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
  const body = document.getElementById('listBody');
  body.innerHTML = '<p class="muted">불러오는 중…</p>';

  try {
    const cacheKey = 'exam_index';
    let index = force ? null : await kvGet(cacheKey);
    if (!index) {
      const subjects = (await listDir(EXAM_ROOT)).filter((e) => e.type === 'dir');
      index = [];
      for (const s of subjects) {
        const files = (await listDir(s.path)).filter(
          (f) => f.type === 'file' && f.name.endsWith('.html')
        );
        if (files.length) {
          index.push({
            subject: s.name,
            exams: files
              .map((f) => ({ file: f.name, path: f.path }))
              .sort((a, b) => a.file.localeCompare(b.file, 'ko')),
          });
        }
      }
      await kvSet(cacheKey, index);
    }
    renderList(index, await allSessions());
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

function renderList(index, sessions) {
  const body = document.getElementById('listBody');
  body.innerHTML = '';
  if (!index.length) {
    body.innerHTML = '<p class="muted">모의고사를 찾지 못했습니다.</p>';
    return;
  }
  index.forEach((group) => {
    const h = document.createElement('div');
    h.className = 'subject-head';
    h.textContent = group.subject.replace(/_/g, ' ');
    body.appendChild(h);

    group.exams.forEach((ex) => {
      const btn = document.createElement('button');
      btn.className = 'exam-item';

      const d = document.createElement('span');
      d.className = 'exam-date';
      d.textContent = examDate(ex.file);

      const nameWrap = document.createElement('span');
      nameWrap.className = 'exam-name';
      nameWrap.textContent = prettyExamName(ex.file);

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
      body.appendChild(btn);
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

async function loadWiki(q, answered) {
  const body = document.getElementById('wikiBody');
  const lock = document.getElementById('wikiLock');
  document.getElementById('wikiHeading').textContent = '불러오는 중…';
  document.getElementById('wikiNote').textContent = '';
  body.innerHTML = '';
  lock.classList.add('hidden');

  let refs;
  try {
    refs = await wikiFor(q, currentExam.path);
  } catch (e) {
    document.getElementById('wikiHeading').textContent = '노트를 불러오지 못했습니다';
    body.innerHTML = `<p class="muted">${e.message}</p>`;
    return;
  }
  if (!refs || !refs.sections.length) {
    document.getElementById('wikiHeading').textContent = '연결된 노트 없음';
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
  document.getElementById('wikiHeading').textContent = sec.heading;
  document.getElementById('wikiNote').textContent =
    `${refs.noteName}  ·  ${secIdx + 1}/${refs.sections.length}${refs.auto ? '  · 자동 매칭' : ''}`;

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

// ---------- 밑줄/올가미로 긁기 → 질문 ----------
function handleSelect(text) {
  if (!text) { toast('글자 위에 밑줄을 그어보세요.'); return; }
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
  askNow(text);
}

/**
 * 질문한다 — Gemini 키가 있으면 사이드 패널에 바로 답을, 없으면 기존 앱 전달 시트를 연다.
 */
async function askNow(term) {
  if (!(await gem.hasKey())) { fillAskSheet(term); return; }
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
    status.textContent = '저장하지 않으면 사라집니다';
  } catch (e) {
    if (e.message === 'NO_KEY') { closeAi(); fillAskSheet(term); return; }
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
  const render = () => {
    body.innerHTML =
      `<div class="warn-box">무료 한도(분당 ${'8'}회)에 걸렸습니다. ` +
      `<b>${left}초</b> 뒤 자동으로 다시 묻습니다.<br>` +
      `급하면 아래 "앱에서 이어보기"로 바로 물어볼 수 있습니다.</div>`;
    status.textContent = `대기 중 · 남은 호출 ${gem.callsLeft()}회`;
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
document.getElementById('aiRetry').onclick = () => askCtx && askNow(askCtx.term);
document.getElementById('aiSave').onclick = () => {
  if (!askCtx || !askCtx.answer) { toast('저장할 답변이 없습니다.'); return; }
  askItems.push({ ...askCtx });
  toast(`기록했습니다 (${askItems.length}건) — 결과 화면에서 vault에 저장됩니다.`);
};
document.getElementById('aiOpenApp').onclick = () => { if (askCtx) fillAskSheet(askCtx.term); };

/** 사이드 칼럼에 보이는 게 하나도 없으면 2단 레이아웃을 푼다. */
function syncSideCol() {
  const anyOpen =
    !document.getElementById('aiPanel').classList.contains('hidden') ||
    !document.getElementById('wikiPanel').classList.contains('hidden');
  document.getElementById('quizScreen').classList.toggle('with-side', anyOpen);
  requestAnimationFrame(() => pen && pen.resize());
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
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    const which = t.dataset.tab;
    document.getElementById('listBody').classList.toggle('hidden', which !== 'exams');
    document.getElementById('notesBody').classList.toggle('hidden', which !== 'notes');
    document.getElementById('cardsBody').classList.toggle('hidden', which !== 'cards');
    if (which === 'notes') loadNotesTab();
    if (which === 'cards') loadCardsTab();
  };
});

// ---- 노트 목록 ----
async function loadNotesTab(force) {
  const body = document.getElementById('notesBody');
  body.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const groups = await noteList(force);
    body.innerHTML = '';
    if (!groups.length) { body.innerHTML = '<p class="muted">노트를 찾지 못했습니다.</p>'; return; }
    for (const g of groups) {
      const h = document.createElement('div');
      h.className = 'subject-head';
      h.textContent = `${g.subject.replace(/_/g, ' ')}  ·  ${g.root.replace(/^\d+_/, '')}`;
      body.appendChild(h);
      for (const n of g.notes) {
        const b = document.createElement('button');
        b.className = 'exam-item';
        const name = document.createElement('span');
        name.className = 'exam-name';
        name.textContent = n.name.replace(/^\d{4}_/, '');
        const arrow = document.createElement('span');
        arrow.className = 'exam-progress';
        arrow.textContent = '›';
        b.appendChild(name); b.appendChild(arrow);
        b.onclick = () => openNote(n.path);
        body.appendChild(b);
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
    renderReader();
    ensureReaderPen();
  } catch (e) {
    body.innerHTML = prev;
    toast(`노트를 열지 못했습니다: ${e.message}`);
  }
}

function renderReader() {
  if (!reader) return;
  const { note, secIdx } = reader;
  const sec = note.sections[secIdx];
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
    onSelect: (text) => { if (text) openAskFromReader(text); },
  });
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
  openAskFromReader(sel);
};

async function openAskFromReader(term) {
  const { note, secIdx } = reader;
  const sec = note.sections[secIdx];
  askCtx = { term, qnum: '—', qtext: `${note.title} · ${sec.heading}`, question: null };
  askCtx.prompt = buildPrompt({ term, question: null, subject: note.title, lecture: sec.heading });

  if (!(await gem.hasKey())) { fillAskSheet(term); return; }
  // 읽기 모드에선 전용 패널이 없으니 시트 안에 답변을 띄운다(화면은 그대로).
  fillAskSheet(term);
  const ta = document.getElementById('askAnswer');
  const msg = document.getElementById('askMsg');
  msg.textContent = '묻는 중…';
  try {
    const answer = await gem.ask({
      term, question: null, noteText: sec.text, subject: note.title, lecture: sec.heading,
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
      const h = document.createElement('div');
      h.className = 'subject-head';
      h.textContent = g.subject.replace(/_/g, ' ');
      body.appendChild(h);
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
        body.appendChild(b);
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
document.getElementById('cardBack').onclick = () => { cardDeck = null; show('listScreen'); };

async function advanceCard(remembered) {
  if (!cardDeck) return;
  const c = cardDeck.cards[cardDeck.idx];
  gradeCard(cardDeck.srs, c.id, remembered);
  await saveSrs(cardDeck.srs);
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

// ---------- 시작 ----------
(async function init() {
  await applyTheme();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  refreshSyncBar();
  flushOutbox();
  if (await hasToken()) loadList(false);
  else openSetup();
})();
