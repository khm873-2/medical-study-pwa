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
 * 노트를 읽다가 "이 부분 외웠나?" 싶을 때 펜으로 네모를 치면, 그 안의
 * **굵게**·*기울임*·==하이라이트== 가 빈칸이 되고 나머지 문장이 문제가 된다.
 * 되새김질용이라 노트를 떠나지 않고 바로 확인한다(2026-10-10 요청).
 *
 * 왜 DOM에서 뽑나: 마크다운 원문이 아니라 **지금 보고 있는 화면**이 기준이어야
 * 사용자가 친 네모와 어긋나지 않는다.
 *
 * @param {HTMLElement} root   본문 요소(#readBody)
 * @param {{l:number,t:number,r:number,b:number}} box  root 기준이 아니라 **뷰포트** 좌표
 * @param {object} meta  {notePath, noteTitle, heading}
 */
export function cardsFromBox(root, box, meta = {}) {
  const EMPH = 'mark, strong, b, em, i';
  const picked = [];
  root.querySelectorAll(EMPH).forEach((el) => {
    // 강조 안에 강조가 또 있으면(**==x==**) 가장 안쪽만 쓴다 — 중복 카드를 막는다
    if (el.querySelector(EMPH)) return;
    const text = el.textContent.trim();
    if (text.length < 2 || !/[\w가-힣]/.test(text)) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 네모와 겹치면 채택(완전히 들어가야 한다고 하면 쓰기 어렵다)
    if (r.right < box.l || r.left > box.r || r.bottom < box.t || r.top > box.b) return;
    picked.push({ el, text });
  });
  if (!picked.length) return [];

  // 같은 문장 안의 강조끼리는 서로를 가려줘야 문제가 된다
  const cards = [];
  const seen = new Set();
  picked.forEach(({ el, text }, i) => {
    const key = `${sentenceOf(el)}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const context = buildContext(el, text, picked.map((p) => p.el));
    if (!context) return;
    cards.push({
      id: `${meta.notePath || ''}#${meta.heading || ''}#box#${text}#${i}`,
      notePath: meta.notePath || '',
      noteTitle: meta.noteTitle || '',
      heading: meta.heading || '',
      context,
      answer: text,
      starred: el.tagName === 'MARK',
    });
  });
  return cards;
}

/** 이 강조가 속한 문장(또는 블록) 요소. */
function sentenceOf(el) {
  let p = el.parentElement;
  while (p && !/^(P|LI|TD|TH|DIV|BLOCKQUOTE|H1|H2|H3|H4)$/.test(p.tagName)) p = p.parentElement;
  return p || el.parentElement;
}

/** 같은 블록의 글을 가져오되, 이 답은 ____ 로, 다른 강조는 그대로 둔다. */
function buildContext(el, answer, allEmph) {
  const block = sentenceOf(el);
  if (!block) return '';
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    if (node === el) { parts.push('____'); return; }
    // 같은 블록 안의 **다른** 강조는 남겨둔다 — 문맥이 너무 비면 풀 수 없다
    node.childNodes.forEach(walk);
  };
  block.childNodes.forEach(walk);
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  if (!text.includes('____')) return '';
  // 문맥이 답만 덩그러니면 카드로 쓸모가 없다
  if (text.replace(/____/g, '').trim().length < 4) return '';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
