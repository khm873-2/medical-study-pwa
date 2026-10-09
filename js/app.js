// 메인 — 화면 전환, 모의고사 목록, 결과 저장, 동기화 큐.

import { hasToken, setToken, clearToken, verifyToken, getRepo, setRepo } from './auth.js';
import { listDir, getText, getBlobUrl, createFile } from './github.js';
import { parseExamHtml, prettyExamName, examDate } from './parser.js';
import { Quiz } from './quiz.js';
import { PenLayer } from './pen.js';
import { wikiFor } from './wiki.js';
import { renderMarkdown, hydrateEmbeds } from './markdown.js';
import { buildPrompt, appList, sendTo, share, buildQaMarkdown } from './ask.js';
import {
  kvGet, kvSet, cacheClear, enqueue, listOutbox, dequeue, bumpTries,
  allSessions, clearSession,
} from './db.js';

const EXAM_ROOT = '06_모의고사';
const LOG_DIR = '00_Raw_Text/AI대화로그';

const screens = ['setupScreen', 'listScreen', 'quizScreen', 'resultScreen'];
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
  show('setupScreen');
}

async function updateStorageInfo() {
  const el = document.getElementById('storageInfo');
  try {
    const est = await navigator.storage?.estimate?.();
    const mb = est?.usage ? (est.usage / 1024 / 1024).toFixed(1) : '?';
    const outbox = await listOutbox();
    const sessions = Object.keys(await allSessions()).length;
    el.textContent = `사용 중 ${mb}MB · 저장 대기 ${outbox.length}건 · 풀던 시험 ${sessions}개`;
  } catch {
    el.textContent = '확인할 수 없음';
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
  const card = document.getElementById('qcard');
  pen = new PenLayer(card, {
    onLasso: handleLasso,
    onChange: () => { if (quiz) penStrokes[quiz.qIndex] = pen.serialize(); },
  });
  setPenMode('touch');
}
function destroyPen() {
  if (pen) { pen.destroy(); pen = null; }
  penStrokes = {};
  closeWiki();
}

function setPenMode(m) {
  if (!pen) return;
  pen.setMode(m);
  document.querySelectorAll('#penBar .tool[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === m);
  });
}

document.querySelectorAll('#penBar .tool[data-mode]').forEach((b) => {
  b.onclick = () => setPenMode(b.dataset.mode);
});
document.getElementById('toolUndo').onclick = () => pen && pen.undo();
document.getElementById('toolClear').onclick = () => pen && pen.clear();
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
    // 가로·넓은 화면에서는 문제와 노트를 나란히 놓는다(CSS .with-wiki .split)
    document.getElementById('quizScreen').classList.add('with-wiki');
    document.getElementById('toolWiki').classList.add('active');
    loadWiki(quiz.q, quiz.answers[quiz.qIndex] !== null);
    requestAnimationFrame(() => pen && pen.resize()); // 폭이 바뀌었으니 캔버스 재계산
  } else {
    closeWiki();
  }
}
function closeWiki() {
  document.getElementById('wikiPanel').classList.add('hidden');
  document.getElementById('quizScreen').classList.remove('with-wiki');
  document.getElementById('toolWiki').classList.remove('active');
  requestAnimationFrame(() => pen && pen.resize());
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

// ---------- 동그라미 → 질문 ----------
function handleLasso(text, box) {
  if (!text && !(box && box.image)) { toast('글자를 동그라미 안에 넣어주세요.'); return; }
  openAsk(text, box && box.image ? '(이미지 영역)' : null);
}

function openAsk(term, imageNote) {
  const q = quiz.q;
  askCtx = { term, qnum: q.num, qtext: q.q, question: q };
  document.getElementById('askTerm').textContent = term || imageNote || '(선택 없음)';
  document.getElementById('askAnswer').value = '';
  document.getElementById('askMsg').textContent = '';

  const prompt = buildPrompt({
    term,
    question: q,
    subject: currentExam.subject,
    lecture: prettyExamName(currentExam.file),
  });
  askCtx.prompt = prompt;

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
