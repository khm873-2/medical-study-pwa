// 읽기 모드 — 노트를 처음부터 읽는 화면(누워서 쓰는 용도).
//
// 모의고사 모드와 다른 점:
//  - 문항이 아니라 노트 전체를 섹션 단위로 넘겨 본다.
//  - 올가미 대신 **네이티브 텍스트 선택**으로 질문한다(브라우저가 Range를 주므로 훨씬 정확).
//  - 화면이 꺼지지 않게 Wake Lock을 건다.
//  - ⭐ ==하이라이트== 를 뽑아 플래시카드로 돌릴 수 있다(노트에 이미 818개 깔려 있다).

import { listDir, getText, getBlobUrl } from './github.js';
import { splitSections } from './wiki.js';
import { renderMarkdown, hydrateEmbeds } from './markdown.js';
import { kvGet, kvSet } from './db.js';

const NOTE_ROOTS = ['98_예습노트_보관', '02_Wiki', '01_임종평_전범위'];

/** 노트 목록(과목별). 캐시해두고 새로고침 때만 다시 긁는다. */
export async function noteList(force) {
  const KEY = 'note_index';
  if (!force) {
    const hit = await kvGet(KEY);
    if (hit) return hit;
  }
  const groups = [];
  for (const root of NOTE_ROOTS) {
    let subs;
    try { subs = await listDir(root); } catch { continue; }
    for (const s of subs.filter((e) => e.type === 'dir')) {
      let files;
      try { files = await listDir(s.path); } catch { continue; }
      const notes = files
        .filter((f) => f.type === 'file' && f.name.endsWith('.md') && !f.name.startsWith('_'))
        .map((f) => ({ name: f.name.replace(/\.md$/, ''), path: f.path }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      if (notes.length) groups.push({ root, subject: s.name, notes });
    }
  }
  await kvSet(KEY, groups);
  return groups;
}

/** 노트 하나를 섹션으로 쪼개 읽을 준비를 한다. */
export async function loadNote(path) {
  const md = await getText(path);
  const secs = splitSections(md);
  // ## 가 아예 없는 노트는 통째로 한 섹션으로
  const sections = secs.length ? secs : [{ heading: '전문', text: md }];
  return { path, sections, raw: md, title: frontTitle(md) || path.split('/').pop().replace(/\.md$/, '') };
}

function frontTitle(md) {
  const h1 = md.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : null;
}

/** 섹션 본문을 화면에 그린다. */
export function renderSection(container, section) {
  container.innerHTML = renderMarkdown(section.text);
  hydrateEmbeds(container, (name) => getBlobUrl(`attachments/${name}`)).catch(() => {});
}

// ───────────── 하이라이트 → 플래시카드 ─────────────

/**
 * 노트에서 `⭐ ==내용==` / `==내용==` 을 뽑아 카드로 만든다.
 * 카드는 "이 문장에서 가린 부분이 뭐였지?" 형태 — 앞뒤 문맥을 단서로 준다.
 */
export function extractCards(note) {
  const cards = [];
  for (const sec of note.sections) {
    const lines = sec.text.split('\n');
    for (const line of lines) {
      // 최소 2글자 — 실측(818개)상 짧은 것도 "반점"처럼 의미 있는 핵심어다.
      // 다만 공백·구두점만 있는 건(노트의 오탈자) 거른다.
      const re = /(⭐\s*)?==([^=]{2,})==/g;
      let m;
      while ((m = re.exec(line))) {
        const answer = m[2].trim();
        if (!/[\w가-힣]/.test(answer)) continue;   // "==을, ==" 같은 오탈자 제외
        const starred = !!m[1];
        // 같은 줄의 나머지를 문맥으로 쓰되, 다른 하이라이트는 ___ 로 가린다.
        const context = line
          .replace(/(⭐\s*)?==([^=]+)==/g, (全, s, t) => (t.trim() === answer ? '____' : t))
          .replace(/[*`>#]/g, '')
          .trim();
        cards.push({
          id: `${note.path}#${sec.heading}#${cards.length}`,
          notePath: note.path,
          noteTitle: note.title,
          heading: sec.heading,
          context,
          answer,
          starred,
        });
      }
    }
  }
  return cards;
}

// ───────────── 복습 주기(가벼운 Leitner) ─────────────
//
// SM-2를 그대로 쓰기엔 과하다. 상자 5개짜리 Leitner로 충분하고, 사용자가
// Obsidian Spaced Repetition 플러그인을 비활성화해둔 상태라 여기서 대신 돌린다.

const BOX_DAYS = [0, 1, 3, 7, 21]; // 상자별 다음 복습까지 일수

export async function loadSrs() {
  return (await kvGet('srs')) || {};
}
export async function saveSrs(srs) {
  return kvSet('srs', srs);
}

export function dueCards(cards, srs, now = Date.now()) {
  return cards.filter((c) => {
    const s = srs[c.id];
    if (!s) return true;                 // 처음 보는 카드
    return (s.due || 0) <= now;
  });
}

export function gradeCard(srs, cardId, remembered) {
  const s = srs[cardId] || { box: 0, seen: 0 };
  s.box = remembered ? Math.min(s.box + 1, BOX_DAYS.length - 1) : 0;
  s.seen = (s.seen || 0) + 1;
  s.last = Date.now();
  s.due = Date.now() + BOX_DAYS[s.box] * 86400000;
  srs[cardId] = s;
  return s;
}

export function srsStats(cards, srs) {
  let newCount = 0, learning = 0, mature = 0;
  for (const c of cards) {
    const s = srs[c.id];
    if (!s) newCount++;
    else if (s.box >= 3) mature++;
    else learning++;
  }
  return { total: cards.length, new: newCount, learning, mature };
}

// ───────────── Wake Lock ─────────────

let _lock = null;
export async function keepAwake(on) {
  try {
    if (on) {
      if (!('wakeLock' in navigator)) return false;
      _lock = await navigator.wakeLock.request('screen');
      // 탭이 백그라운드로 갔다 오면 풀리므로 다시 건다.
      document.addEventListener('visibilitychange', reacquire);
      return true;
    }
    document.removeEventListener('visibilitychange', reacquire);
    if (_lock) { await _lock.release(); _lock = null; }
    return false;
  } catch {
    return false;
  }
}
async function reacquire() {
  if (!document.hidden && _lock !== null) {
    try { _lock = await navigator.wakeLock.request('screen'); } catch {}
  }
}

/**
 * 화면에 그려진 범위 안의 **강조된 말**을 가려 플래시카드를 만든다.
 *
 * 설계 원칙(2026-10-10 재작성):
 *   ① **블록 하나 = 카드 하나.** 한 문장에 강조가 셋이면 빈칸 셋짜리 카드 한 장이다.
 *      강조마다 카드를 쪼개면 같은 문장을 세 번 보게 되고 카드 수가 폭발한다.
 *   ② **라벨은 가리지 않는다.** "**정의**:", "**병태생리**:" 처럼 줄머리에 콜론이 붙는
 *      굵은 글씨는 목차 역할이지 외울 내용이 아니다(vault 실측 3,917회).
 *   ③ **표는 모양을 지킨다.** 표 안의 칸을 물을 때 표를 글로 풀어버리면 뭘 묻는지
 *      알 수 없다. 표 전체를 그대로 두고 그 칸만 가린다.
 *
 * 마크다운 원문이 아니라 **지금 보고 있는 DOM**에서 뽑는다 — 사용자가 친 네모와
 * 어긋나지 않으려면 화면이 기준이어야 한다.
 *
 * @param {HTMLElement} root  본문 요소(#readBody)
 * @param {{l,t,r,b}} box     **뷰포트** 좌표
 * @param {object} meta       {notePath, noteTitle, heading}
 * @returns {Array<{id,contextHtml,answers,heading,...}>}
 */
export function cardsFromBox(root, box, meta = {}) {
  const hits = emphasisIn(root, box);
  if (!hits.length) return [];

  // 블록(문단·목록항목·표의 행) 단위로 묶는다
  const groups = new Map();
  for (const el of hits) {
    const block = blockOf(el);
    if (!block) continue;
    if (!groups.has(block)) groups.set(block, []);
    groups.get(block).push(el);
  }

  const cards = [];
  let n = 0;
  for (const [block, els] of groups) {
    const card = block.tagName === 'TR'
      ? tableCard(block, els, meta, n)
      : blockCard(block, els, meta, n);
    if (!card) continue;
    // 무슨 이야기인지 위로 거슬러 붙인다 — 이게 없으면 맞힐 수가 없다
    card.trail = contextTrail(block.tagName === 'TR' ? (block.closest('table') || block) : block, root);
    card.topic = [meta.heading, ...card.trail].filter(Boolean).join('  ›  ');
    cards.push(card);
    n++;
  }
  return cards;
}

/** 네모에 걸린 강조 요소들(라벨 제외). */
function emphasisIn(root, box) {
  const out = [];
  root.querySelectorAll('mark, strong, b, em, i').forEach((el) => {
    if (el.querySelector('mark, strong, b, em, i')) return;   // 중첩이면 안쪽만
    const text = el.textContent.trim();
    if (text.length < 2 || !/[\w가-힣]/.test(text)) return;
    if (isLabel(el, text)) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (r.right < box.l || r.left > box.r || r.bottom < box.t || r.top > box.b) return;
    out.push(el);
  });
  return out;
}

/** 외울 내용이 아니라 **목차 역할**인 굵은 글씨인가? */
const LABEL_WORDS = new Set([
  '정의', '병태생리', '기전', '원인', '증상', '진단', '치료', '예후', '합병증', '감별',
  '분류', '역학', '검사', '소견', '처치', '수술', '약물', '예방', '경과', '특징',
  '오답노트', '정답', '출처', '담당교수', '족보', '왕족', '족보 타당도', '통합출처',
  '핵심', '요약', '정리', '참고', '주의', '암기', '암기법', '팁', '표기 규칙',
  '소스 종류', '기출', '빈출', '포인트', '비고', '결론',
]);

/**
 * 답으로 쓰기엔 너무 막연한 말. 실제로 카드를 만들어 풀어보고 추린 것이다 —
 * "전신 저관류의 **결과**(허혈성 간손상)이지" 같은 게 카드가 되면 풀 수가 없다.
 */
const VAGUE_ANSWERS = new Set([
  '결과', '원인', '이유', '차이', '특징', '목적', '방법', '경우', '내용', '부분',
  '전부', '모두', '일부', '관계', '상태', '문제', '중요', '필수', '금기', '가능',
  '증가', '감소', '상승', '저하', '정상', '비정상', '양성', '음성', '있음', '없음',
]);

/** 이 블록이 **족보 문제·해설**인가? 그 안은 외울 지식이 아니라 문제 그 자체다. */
function isQuizBlock(block) {
  if (!block) return false;
  const t = block.textContent.trim();
  if (/^(오답노트|정답|해설|선지)\s*[:：]/.test(t)) return true;
  if (/^정답\s*[:：]?\s*[①-⑩\d]/.test(t)) return true;
  return false;
}

export function isLabel(el, text) {
  const t = text.replace(/[:：]\s*$/, '').trim();
  // ① 사전에 있는 구조어
  if (LABEL_WORDS.has(t)) return true;
  // ② "정답 ①", "정답: 1, 5" 류 — 족보의 정답 번호지 지식이 아니다
  if (/^정답\s*[:：]?/.test(t)) return true;
  // ③ 답으로 쓰기엔 막연한 말
  if (VAGUE_ANSWERS.has(t)) return true;
  // ④ "백화점 AED asystole 케이스" 같은 **별명** — 외울 건 케이스 이름이 아니라 내용이다
  if (/(케이스|사례|증례|문항|문제)$/.test(t)) return true;
  // ⑤ "A1.", "Q3", "①" 같은 번호 매김 — 지식이 아니다
  if (/^[A-Za-z]?\s*\d+\s*[.)]?$/.test(t) || /^[①-⑳]+$/.test(t)) return true;
  // ⑥ 족보 문제·해설 블록 안은 통째로 제외
  if (isQuizBlock(blockOf(el))) return true;
  // ③ 줄(블록) 맨 앞에 있고 바로 뒤가 콜론 — vault에서 가장 흔한 라벨 형태
  const block = blockOf(el);
  if (block) {
    const txt = block.textContent;
    const idx = txt.indexOf(text);
    const head = idx <= 1;                       // 블록 시작
    const after = txt.slice(idx + text.length, idx + text.length + 2).trimStart();
    if (head && (after.startsWith(':') || after.startsWith('：'))) return true;
    // ④ 블록 전체가 이 강조뿐 — 소제목처럼 쓰인 것
    if (txt.trim() === text) return true;
  }
  return false;
}

/**
 * 이 블록이 **무엇에 대한 이야기인지** 위로 거슬러 모은다.
 *
 * 왜 필요한가: "주로 ____에 호발하는 얕은 화농성 감염"만 떼어 놓으면 무슨 병인지 몰라
 * 맞힐 수가 없다(2026-10-10). 노트는 보통 이렇게 생겼다:
 *     ### 1. 세균성 피부질환
 *     **① 농가진(고름딱지증, Impetigo)**     ← 줄 전체가 굵은 글씨 = 소제목 노릇
 *     - 주로 **여름철 소아·영유아**에 호발하는 …
 * 그래서 제목(h1~h6)뿐 아니라 **줄 전체가 강조인 문단**도 제목으로 쳐서 함께 보여준다.
 *
 * @returns {string[]} 바깥 → 안쪽 순서의 문맥 조각(최대 3개)
 */
export function contextTrail(block, root) {
  const trail = [];
  const seenLevel = [];
  let node = block;
  let guard = 0;

  const headingLevel = (el) => {
    const m = /^H([1-6])$/.exec(el.tagName);
    if (m) return Number(m[1]);
    // 줄 전체가 굵은 글씨인 문단 = 소제목. 제목보다 안쪽(7)으로 친다.
    if (/^(P|DIV)$/.test(el.tagName)) {
      const t = el.textContent.trim();
      if (!t || t.length > 60) return 0;
      const em = el.querySelector('strong, b, mark');
      if (em && em.textContent.trim() === t) return 7;
    }
    return 0;
  };

  while (node && node !== root && guard++ < 400) {
    let prev = node.previousElementSibling;
    while (prev && guard++ < 400) {
      const lv = headingLevel(prev);
      // 더 바깥(작은 번호) 제목만 새로 받는다 — 같은 층을 여러 개 주우면 어지럽다
      if (lv && (!seenLevel.length || lv < seenLevel[seenLevel.length - 1])) {
        seenLevel.push(lv);
        trail.push(prev.textContent.trim().replace(/\s+/g, ' '));
        if (trail.length >= 3) return trail.reverse();
      }
      prev = prev.previousElementSibling;
    }
    // 목록 안이면 상위 항목도 문맥이다
    const li = node.parentElement && node.parentElement.closest ? node.parentElement.closest('li') : null;
    node = li || node.parentElement;
  }
  return trail.reverse();
}

/** 이 강조가 속한 블록. 표 안이면 **행(TR)** 을 돌려준다(표 모양을 지키려고). */
function blockOf(el) {
  let p = el.parentElement;
  let cell = null;
  while (p) {
    if (/^(TD|TH)$/.test(p.tagName)) cell = p;
    if (cell && p.tagName === 'TR') return p;
    if (/^(P|LI|BLOCKQUOTE|H1|H2|H3|H4|H5|DIV)$/.test(p.tagName)) return p;
    p = p.parentElement;
  }
  return null;
}

/** 보통 문단·목록 — 블록 하나를 빈칸 여럿짜리 카드 한 장으로. */
function blockCard(block, els, meta, n) {
  const answers = [];
  const html = cloneWithBlanks(block, els, answers);
  if (!answers.length) return null;
  const plain = block.textContent.replace(/\s+/g, ' ').trim();
  // 가린 글자가 문단의 거의 전부면 풀 수가 없다
  const hidden = answers.join('').length;
  if (plain.length - hidden < 6) return null;
  return {
    id: `${meta.notePath || ''}#${meta.heading || ''}#b${n}#${answers.join('|').slice(0, 40)}`,
    notePath: meta.notePath || '', noteTitle: meta.noteTitle || '',
    heading: meta.heading || '',
    contextHtml: html,
    answers,
    starred: els.some((e) => e.tagName === 'MARK'),
    kind: 'block',
  };
}

/** 표 — 표 전체를 그대로 두고 그 행의 강조만 가린다. */
function tableCard(tr, els, meta, n) {
  const table = tr.closest('table');
  if (!table) return blockCard(tr, els, meta, n);
  const answers = [];
  const rowIdx = [...table.querySelectorAll('tr')].indexOf(tr);
  const clone = table.cloneNode(true);
  const cloneRow = clone.querySelectorAll('tr')[rowIdx];
  if (!cloneRow) return null;
  // 원본 행과 복제 행의 강조를 같은 순서로 대응시킨다
  const origEm = [...tr.querySelectorAll('mark, strong, b, em, i')];
  const cloneEm = [...cloneRow.querySelectorAll('mark, strong, b, em, i')];
  origEm.forEach((o, i) => {
    if (!els.includes(o) || !cloneEm[i]) return;
    answers.push(o.textContent.trim());
    cloneEm[i].replaceWith(blankNode(o.textContent.trim()));
  });
  if (!answers.length) return null;
  cloneRow.classList.add('card-row-focus');
  const wrap = document.createElement('div');
  wrap.className = 'tablewrap';
  wrap.appendChild(clone);
  return {
    id: `${meta.notePath || ''}#${meta.heading || ''}#t${n}#${answers.join('|').slice(0, 40)}`,
    notePath: meta.notePath || '', noteTitle: meta.noteTitle || '',
    heading: meta.heading || '',
    contextHtml: wrap.outerHTML,
    answers,
    starred: els.some((e) => e.tagName === 'MARK'),
    kind: 'table',
  };
}

/** 블록을 복제하면서 대상 강조만 빈칸으로 바꾼다. 나머지 서식은 그대로 둔다. */
function cloneWithBlanks(block, els, answers) {
  const clone = block.cloneNode(true);
  const orig = [...block.querySelectorAll('mark, strong, b, em, i')];
  const copy = [...clone.querySelectorAll('mark, strong, b, em, i')];
  orig.forEach((o, i) => {
    if (!els.includes(o) || !copy[i]) return;
    const t = o.textContent.trim();
    answers.push(t);
    copy[i].replaceWith(blankNode(t));
  });
  return clone.outerHTML;
}

/** 빈칸. 글자 수만큼 넓이를 줘서 "몇 자쯤인지"가 힌트가 되게 한다. */
function blankNode(answer) {
  const b = document.createElement('span');
  b.className = 'cloze';
  b.dataset.answer = answer;
  b.textContent = ' '.repeat(Math.min(14, Math.max(4, answer.length)));
  return b;
}
