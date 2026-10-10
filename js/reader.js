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

// ───────────── 노트에 손으로 쓴 Q&A → 카드 (2026-10-10) ─────────────
//
// 왜 따로 만드나: 임종평·위키 노트는 이미 `**Q. …?**` 다음 줄에 답이 오는 꼴로
// 4,800장 넘게 쓰여 있다. 하이라이트에서 기계적으로 뽑은 카드와 달리 **질문을
// 직접 쓴 것**이라 품질이 비교가 안 되는데, 앱이 한 장도 모르고 있었다.
//
// 🔴 = 실제 기출에 근거가 있는 항목, ⭐ = AI가 고른 핵심. 이 두 마커가 노트에
// 이미 깔려 있으므로 우선순위를 따로 매길 필요가 없다.

const QA_Q = /^\*\*Q\.\s*([\s\S]+?)\*\*\s*$/;
const MD_HEAD = /^(#{1,6})\s+(.*)$/;
/** 카드 하나가 지나치게 길면 외울 단위가 아니다 — 잘라서 "노트에서 보기"로 넘긴다. */
export const QA_MAX = 700;

/**
 * 마크다운 강조·링크 기호를 떼고 사람이 읽는 글자만 남긴다.
 *
 * ⚠️ 내용 안에 `=`나 `*`가 하나 들어간 경우가 흔하다
 * (`==IgG↑=자가면역간염==`, `==3cm 초과=피부경유배액술==`).
 * `[^=]+` 처럼 잡으면 이것들이 안 벗겨져 카드에 `==`가 그대로 남는다 —
 * 실측 4,716장 중 56장이 그랬다. 그래서 비탐욕 `[\s\S]*?`로 잡는다(2026-10-10).
 */
function plainMd(s) {
  return String(s)
    .replace(/!\[\[[^\]]+\]\]/g, '')                   // 임베드 이미지
    .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')  // 위키링크
    .replace(/`([^`]+)`/g, '$1')
    .replace(/==([\s\S]*?)==/g, '$1')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^\s*>\s?/gm, '')
    // 노트에 짝이 안 맞는 기호가 남은 경우(실측 4,716장 중 4장) 그냥 떼어낸다 —
    // 카드는 평문으로 보여주므로 기호를 남겨둘 이유가 없다.
    .replace(/==|\*\*|\[\[|\]\]/g, '')
    .trim();
}

/**
 * 노트 마크다운에서 `**Q. …**` + 다음 줄들을 카드로 뽑는다.
 *
 * @param {string} md
 * @param {object} [meta] {path, title}
 * @returns {Array} 카드 배열(카드 화면이 쓰는 스키마: topic/contextHtml/answers)
 */
export function qaCards(md, { path = '', title = '' } = {}) {
  const lines = String(md).split('\n');
  const out = [];
  const trail = [];            // 현재 위치의 제목 사슬

  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(MD_HEAD);
    if (h) {
      const level = h[1].length;
      trail.length = Math.max(0, level - 1);
      trail[level - 1] = plainMd(h[2]);
      continue;
    }
    const q = lines[i].match(QA_Q);
    if (!q) continue;

    // 답 = 빈 줄이 나오거나 다음 질문·제목이 나올 때까지
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) break;
      if (QA_Q.test(l) || MD_HEAD.test(l)) break;
      body.push(l);
    }
    i += body.length;
    if (!body.length) continue;              // 답이 비면 카드가 안 된다

    const rawAnswer = body.join('\n');
    const examBacked = /🔴/.test(rawAnswer);
    const starred = /⭐/.test(rawAnswer);
    let answer = plainMd(rawAnswer).replace(/^[🔴⭐\s]+/, '').trim();
    let truncated = false;
    if (answer.length > QA_MAX) { answer = answer.slice(0, QA_MAX).trim() + ' …'; truncated = true; }

    const question = plainMd(q[1]).replace(/^[🔴⭐\s]+/, '').trim();
    if (!question || !answer) continue;

    const heading = trail.filter(Boolean).join(' › ');
    out.push({
      id: `qa:${path}#${out.length}`,
      kind: 'qa',
      notePath: path,
      noteTitle: title,
      heading,
      topic: heading,
      question,
      // 카드 화면은 contextHtml을 그대로 넣는다 — 질문은 평문이므로 이스케이프한다
      contextHtml: escapeForCard(question),
      answers: [answer],
      starred,
      examBacked,
      truncated,
    });
  }
  return out;
}

function escapeForCard(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 노트 하나에 Q&A가 몇 장 들어있나 — 가져오기 화면에 개수를 보여주려고. */
export function countQa(md) {
  let n = 0;
  const lines = String(md).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!QA_Q.test(lines[i])) continue;
    const next = lines[i + 1];
    if (next && next.trim() && !QA_Q.test(next) && !MD_HEAD.test(next)) n++;
  }
  return n;
}

export async function loadSrs() {
  return (await kvGet('srs')) || {};
}
export async function saveSrs(srs) {
  return kvSet('srs', srs);
}

// ───────────── 간격 반복 (FSRS 간소판, 2026-10-10) ─────────────
//
// 왜 바꿨나: 라이트너 상자(0·1·3·7·21일)는 **카드마다 난이도가 다르다는 걸 모른다.**
// 쉬운 카드는 더 길게, 어려운 카드는 더 자주 봐야 하는데 전부 같은 간격을 쓴다.
//
// FSRS(Free Spaced Repetition Scheduler)의 뼈대만 가져왔다:
//   · S(안정성) — 이 기억이 얼마나 오래 가는가. 맞히면 늘고 틀리면 줄어든다.
//   · D(난이도) — 이 카드가 나에게 얼마나 어려운가(1~10). 틀리면 올라간다.
//   · 복습 간격 = S를 목표 기억률(90%)로 환산한 날수.
// 원본의 17개 파라미터 최적화는 뺐다 — 카드 수천 장의 로그가 있어야 의미가 있고,
// 없으면 기본값이 더 안전하다. 핵심인 "S·D를 각 카드가 따로 갖는다"만 취한다.
//
// **시험 일정 연동**: 시험까지 N일 남았으면 그 뒤로 넘어가는 복습은 의미가 없다.
// 간격을 시험 전으로 당겨서, 남은 기간 안에 최소 한 번은 더 보게 만든다.

const TARGET_RETENTION = 0.9;   // 복습 시점에 90% 기억하고 있도록
const MIN_S = 0.3, MAX_S = 365 * 2;
const DAY = 86400000;

/** 안정성 S → 다음 복습까지 날수. */
function intervalOf(S) {
  // FSRS의 forgetting curve를 뒤집은 식. R=0.9면 대략 S와 비슷한 날수가 나온다.
  return Math.max(1, Math.round(S * (Math.pow(TARGET_RETENTION, -1 / 0.5) - 1) / (Math.pow(0.9, -1 / 0.5) - 1)));
}

/** 처음 본 카드의 초기 상태. 답을 맞혔는지에 따라 출발점이 다르다. */
function initState(remembered) {
  return remembered
    ? { S: 3.0, D: 4.5 }     // 바로 맞혔으면 꽤 안다
    : { S: 0.6, D: 6.5 };    // 틀렸으면 거의 모른다
}

export function gradeCard(srs, cardId, remembered, opts = {}) {
  const now = opts.now || Date.now();
  const prev = srs[cardId];
  const s = prev || { seen: 0 };

  if (!prev || prev.S == null) {
    Object.assign(s, initState(remembered));
  } else {
    const elapsed = Math.max(0, (now - (s.last || now)) / DAY);
    // 복습 시점의 기억률 — 늦게 볼수록 낮다. 낮을 때 맞히면 그만큼 크게 는다.
    const R = Math.pow(1 + elapsed / Math.max(s.S, 0.1), -0.5);
    if (remembered) {
      const ease = 1 + (11 - s.D) * 0.08 * (1 - R);   // 어려운 카드일수록 덜 는다
      s.S = Math.min(MAX_S, s.S * Math.max(1.05, ease));
      s.D = Math.max(1, s.D - 0.15);
    } else {
      s.S = Math.max(MIN_S, Math.min(s.S * 0.35, 2));  // 잊었으면 크게 줄인다
      s.D = Math.min(10, s.D + 1.0);
    }
  }

  s.seen = (s.seen || 0) + 1;
  if (!remembered) s.lapses = (s.lapses || 0) + 1;
  s.last = now;
  let days = remembered ? intervalOf(s.S) : 1;        // 틀리면 내일 다시

  // 시험이 코앞이면 그 뒤로 미루지 않는다 — 시험 전에 한 번은 더 봐야 한다
  if (opts.examAt) {
    const left = Math.ceil((opts.examAt - now) / DAY);
    if (left > 0 && days > left) days = Math.max(1, Math.ceil(left / 2));
  }
  s.due = now + days * DAY;
  s.box = boxOf(s.S);                                  // 화면 표시용(처음·학습중·익힘)
  delete s.buried;
  srs[cardId] = s;
  return s;
}

/** S를 사람이 읽는 단계로. 기존 화면·통계가 box를 쓰므로 유지한다. */
function boxOf(S) {
  if (S < 1) return 0;
  if (S < 4) return 1;
  if (S < 10) return 2;
  if (S < 30) return 3;
  return 4;
}

/** 이 카드를 지금 보면 얼마나 기억하고 있을까(0~1). 관리 화면에서 보여준다. */
export function retrievability(st, now = Date.now()) {
  if (!st || st.S == null || !st.last) return 0;
  const elapsed = Math.max(0, (now - st.last) / DAY);
  return Math.pow(1 + elapsed / Math.max(st.S, 0.1), -0.5);
}

/** 오늘 볼 카드(기한이 지났거나 처음 보는 것). studyQueue가 순서까지 정해준다. */
export function dueCards(cards, srs, now = Date.now()) {
  return cards.filter((c) => {
    const s = srs[c.id];
    if (!s) return true;                 // 처음 보는 카드
    if (s.suspended) return false;
    return (s.due || 0) <= now;
  });
}

// ───────────── 카드 다루기 (2026-10-10) ─────────────
// 네모로 만들면 카드가 쏟아진다. 다 외울 수는 없으니 **골라낼 수단**이 필요하다.
// Anki가 오래 검증한 방식을 가져오되 이름과 개수를 줄였다:
//   · 버리기(suspend)  — 쓸모없는 카드. 다시는 안 나온다(목록에는 남아 되살릴 수 있다)
//   · 나중에(bury)     — 지금은 말고. 내일 다시 나온다
//   · 중요(star)       — 먼저 보여준다
//   · 자주 틀림(leech) — 3번 넘게 틀리면 자동으로 붙는 표시. 따로 모아 볼 수 있다

export const LEECH_AT = 3;

export function cardState(srs, id) { return srs[id] || null; }
export function isSuspended(srs, id) { return !!(srs[id] && srs[id].suspended); }
export function isStarred(srs, id) { return !!(srs[id] && srs[id].star); }
export function isLeech(srs, id) { return !!(srs[id] && (srs[id].lapses || 0) >= LEECH_AT); }
export function isBuried(srs, id, now = Date.now()) {
  return !!(srs[id] && srs[id].buried && srs[id].buried > now);
}

/** 쓸모없는 카드 — 다시 안 나온다. */
export function suspendCard(srs, id) {
  const s = srs[id] || { box: 0, seen: 0 };
  s.suspended = true;
  srs[id] = s;
  return s;
}
export function unsuspendCard(srs, id) {
  if (srs[id]) delete srs[id].suspended;
  return srs[id];
}
/** 지금은 말고 — 내일 아침에 다시. */
export function buryCard(srs, id) {
  const s = srs[id] || { box: 0, seen: 0 };
  const t = new Date();
  t.setHours(4, 0, 0, 0);                            // 새벽 4시를 하루 경계로 본다
  s.buried = (t.getTime() <= Date.now() ? t.getTime() + 86400000 : t.getTime());
  srs[id] = s;
  return s;
}
export function toggleStar(srs, id) {
  const s = srs[id] || { box: 0, seen: 0 };
  s.star = !s.star;
  srs[id] = s;
  return s;
}

/**
 * 오늘 풀 카드를 **우선순위 순서로** 고른다.
 *
 * 카드가 수백 장이면 전부 보는 건 불가능하다. 그래서 순서를 정해준다:
 *   ① 중요 표시한 것          — 내가 직접 고른 것이 가장 먼저
 *   ② 자주 틀리는 것          — 약점부터
 *   ③ 복습 기한이 지난 것     — 잊기 직전이 가장 효율적인 시점(간격 반복의 핵심)
 *   ④ 아직 안 본 새 카드
 * 버린 카드·오늘 미룬 카드는 빠진다.
 */
export function studyQueue(cards, srs, { limit = 0, now = Date.now() } = {}) {
  const live = cards.filter((c) => !isSuspended(srs, c.id) && !isBuried(srs, c.id, now));
  const rank = (c) => {
    const s = srs[c.id];
    if (isStarred(srs, c.id)) return 0;
    if (isLeech(srs, c.id)) return 1;
    if (!s) return 3;                                 // 새 카드
    return (s.due || 0) <= now ? 2 : 4;               // 기한 지남 / 아직
  };
  const sorted = live
    .map((c, i) => ({ c, r: rank(c), due: (srs[c.id] && srs[c.id].due) || 0, i }))
    .sort((a, b) => a.r - b.r || a.due - b.due || a.i - b.i)
    .map((x) => x.c);
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

/**
 * **오늘 꼭 봐야 하는** 카드만. studyQueue는 기한이 안 된 카드까지 뒤에 붙여주므로
 * (분량이 모자랄 때 채우려고) 개수를 세는 데 쓰면 "4,716장 남음"처럼 나온다.
 * 숫자를 보여줄 때는 이걸 쓴다(2026-10-10).
 */
export function dueToday(cards, srs, now = Date.now()) {
  return (cards || []).filter((c) => {
    if (isSuspended(srs, c.id) || isBuried(srs, c.id, now)) return false;
    const s = srs[c.id];
    if (!s) return true;                                  // 새 카드
    if (isStarred(srs, c.id) || isLeech(srs, c.id)) return true;
    return (s.due || 0) <= now;
  });
}

/** 관리 화면용 — 카드를 성격별로 나눈다. */
export function groupCards(cards, srs, now = Date.now()) {
  const g = { star: [], leech: [], due: [], later: [], mature: [], suspended: [] };
  for (const c of cards) {
    const s = srs[c.id];
    if (s && s.suspended) { g.suspended.push(c); continue; }
    if (s && s.star) { g.star.push(c); continue; }
    if (s && (s.lapses || 0) >= LEECH_AT) { g.leech.push(c); continue; }
    if (!s || (s.due || 0) <= now) { g.due.push(c); continue; }
    if (s.box >= 3) { g.mature.push(c); continue; }
    g.later.push(c);
  }
  return g;
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

  // SuperMemo의 "최소 정보 원칙" — 한 번에 묻는 게 많으면 카드가 아니라 시험이 된다.
  // 한 블록에 빈칸이 많으면 여러 장으로 쪼개고, 나머지는 **보이게 남겨** 단서로 쓴다
  // (Anki의 Cloze Overlapper가 열거를 다루는 방식).
  const MAX_BLANKS = 4;
  const split = [];
  for (const [block, els] of groups) {
    if (els.length <= MAX_BLANKS) { split.push([block, els]); continue; }
    for (let i = 0; i < els.length; i += MAX_BLANKS) split.push([block, els.slice(i, i + MAX_BLANKS)]);
  }
  const cards = [];
  let n = 0;
  for (const [block, els] of split) {
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

const EMPH_SEL = '.ask, mark, strong, b, em, i';

/**
 * 네모에 걸린 강조 요소들.
 *
 * `{{...}}`로 **직접 지정한 빈칸(.ask)**이 하나라도 있으면 그것만 쓴다 —
 * 자동 탐지가 빗나갈 때 노트에서 바로잡는 수단이고, 지정했으면 그 뜻을 따라야 한다.
 */
function emphasisIn(root, box) {
  const inBox = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return !(r.right < box.l || r.left > box.r || r.bottom < box.t || r.top > box.b);
  };
  const explicit = [...root.querySelectorAll('.ask')].filter((el) => {
    const t = el.textContent.trim();
    return t.length >= 1 && inBox(el);
  });
  if (explicit.length) return explicit;

  const out = [];
  root.querySelectorAll(EMPH_SEL).forEach((el) => {
    if (el.querySelector(EMPH_SEL)) return;   // 중첩이면 안쪽만
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
    const after = txt.slice(idx + text.length, idx + text.length + 3).trimStart();
    // 줄머리 + 콜론/대시 = 라벨. "**악화·유발 요인** — 하나씩 짝지어 기억"처럼
    // 대시로 받는 꼴이 흔해서 콜론만 보면 놓친다(2026-10-10).
    if (head && /^[:：\-–—]/.test(after)) return true;
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
  // 가리고 남는 글이 거의 없으면 단서가 없어 못 푼다.
  // (너무 빡빡하게 잡으면 "심인성쇼크는 ___이고 심장지수 ___이며 ___이다" 같은
  //  **정상적인 조밀한 카드**까지 날아간다 — 라벨 자체는 위 isLabel에서 거른다.)
  if (plain.length - hidden < 8) return null;
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
  const origEm = [...tr.querySelectorAll(EMPH_SEL)];
  const cloneEm = [...cloneRow.querySelectorAll(EMPH_SEL)];
  origEm.forEach((o, i) => {
    if (!els.includes(o) || !cloneEm[i]) return;
    answers.push(replaceWithCloze(cloneEm[i], o.textContent.trim()));
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
  const orig = [...block.querySelectorAll(EMPH_SEL)];
  const copy = [...clone.querySelectorAll(EMPH_SEL)];
  orig.forEach((o, i) => {
    if (!els.includes(o) || !copy[i]) return;
    answers.push(replaceWithCloze(copy[i], o.textContent.trim()));
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

/**
 * 강조 덩어리에서 **실제로 물어볼 핵심어**만 떼어낸다.
 *
 * 노트에는 서술부까지 통째로 굵게 쓴 곳이 많다:
 *   "**중앙부 배꼽모양 함몰(umbilication)이 진단의 핵심 소견**"
 * 이걸 통째로 가리면 문장 하나가 사라져 맞힐 수가 없다(2026-10-10).
 * "____이 진단의 핵심 소견"이 되어야 답할 수 있다.
 *
 * 두 가지를 떼어낸다:
 *   (1) 뒤쪽 서술부 — 조사 뒤에 설명이 이어지면 거기서 끊는다.
 *   (2) 앞쪽 한정어 — "AIDS 환자의 10~30%"처럼 "~의"로 한정하면 단서로 남긴다.
 *
 * @returns {{lead:string, answer:string, tail:string}}
 */
export function splitAnswer(text) {
  let lead = '';
  let core = String(text).trim();
  let tail = '';
  if (core.length < 10) return { lead, answer: core, tail };

  // (1) 뒤쪽 서술부. 괄호 안의 조사에 걸리지 않게 괄호를 가린 사본에서 위치를 찾는다.
  const masked = core.replace(/\([^)]*\)/g, (m) => ' '.repeat(m.length));
  const JOSA = /(이|가|은|는|을|를|로|으로|에서|에|와|과)\s+(?=\S)/g;
  // "압박골절 있는 요추"의 "있**는**"은 조사가 아니라 관형형이다 — 여기서 끊으면
  // "[압박골절 있]는" 처럼 말이 잘린다. 흔한 관형형을 걸러낸다(2026-10-10).
  const ADNOM = /(있|없|하|되|가|오|보|주|쓰|같|다르|많|적|높|낮|좋|나쁘|크|작|어리|늙)$/;
  // **가장 앞선** 조사에서 끊는다. 뒤쪽을 고르면 "…ROM가 모든 방향" 처럼
  // 서술부 일부가 답에 섞여 어색해진다(2026-10-10).
  let cut = -1;
  let m;
  while ((m = JOSA.exec(masked))) {
    const after = core.slice(m.index + m[0].length).trim();
    if (after.length < 2 || m.index < 4) continue;
    // 조사 앞 글자가 용언 어간이면 관형형이다 — 건너뛴다
    if (/^[은는]$/.test(m[1]) && ADNOM.test(core.slice(0, m.index))) continue;
    cut = m.index; break;
  }
  if (cut > 0) {
    const rest = core.slice(cut);
    if (rest.trim().length >= 4) { tail = rest; core = core.slice(0, cut); }
  }

  // (2) 앞쪽 한정어 — "X의 Y" 꼴이면 "X의"는 단서로 남긴다
  const q = core.match(/^(.{2,}?의)\s+(\S.*)$/);
  if (q && q[2].trim().length >= 2) { lead = q[1] + ' '; core = q[2]; }

  return { lead, answer: core.trim(), tail };
}

/** 강조 요소를 "앞말 + 빈칸 + 뒷말"로 바꾼다. */
function replaceWithCloze(el, fullText) {
  const parts = splitAnswer(fullText);
  const frag = document.createDocumentFragment();
  if (parts.lead) frag.appendChild(document.createTextNode(parts.lead));
  frag.appendChild(blankNode(parts.answer));
  if (parts.tail) frag.appendChild(document.createTextNode(parts.tail));
  el.replaceWith(frag);
  return parts.answer;
}

// ───────────── 시험 일정 ─────────────
// vault의 `00_Raw_Text/시간표/*.md`에 "| 2026-10-23 | 금 | … | 종합 시험(90분) |" 꼴로
// 적혀 있다. 그걸 읽어 **다음 시험일**을 찾고, 복습 간격이 시험을 넘기지 않게 한다.

const EXAM_ROW = /\|\s*(\d{4}-\d{2}-\d{2})\s*\|[^\n|]*\|[^\n|]*\|\s*([^|\n]+?)\s*\|/g;
// "시험"·"형성평가"는 실제 평가, 그냥 "평가"는 강의 제목일 수 있다
// ("중환자 중증도 분류 및 **평가**"가 시험으로 잡혔다 — 2026-10-10)
const EXAM_WORD = /(시험|형성평가|종합평가|중간고사|기말고사)/;

/** 시간표 마크다운에서 시험 일정을 뽑는다. */
export function parseExamDates(md) {
  const out = [];
  let m;
  EXAM_ROW.lastIndex = 0;
  while ((m = EXAM_ROW.exec(String(md)))) {
    const name = m[2].trim();
    if (!name || /해당없음|^—$/.test(name)) continue;
    if (!EXAM_WORD.test(name)) continue;
    // 강의 제목은 길고 여러 주제를 '&'·','로 잇는다. 시험 칸은 짧다.
    if (name.length > 24 || /[&,]/.test(name)) continue;
    const t = Date.parse(`${m[1]}T09:00:00`);
    if (!Number.isNaN(t)) out.push({ date: m[1], at: t, name });
  }
  return out;
}

/** 오늘 이후로 가장 가까운 시험. 없으면 null. */
export function nextExam(exams, now = Date.now()) {
  const future = (exams || []).filter((e) => e.at > now).sort((a, b) => a.at - b.at);
  return future[0] || null;
}

// ---------- 시간표 → 날짜별 강의 ----------
//
// 왜 열 이름으로 찾나: 시간표 세 개의 열 구조가 서로 다르다. 응급중환자·근골격은
// `날짜 | 요일 | 교시 | 강의명 | 담당`, 두경부는 `날짜(요일) | 교시 | 강의명 | 담당`이고
// 날짜에 연도가 없다(`09-28(월)`). 위치로 자르면 과목마다 틀어진다(2026-10-10).

const CELLS = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
const BLANK = (s) => !s || /^[—\-–]+$/.test(s);

// 공부 대상이 아닌 칸 — 시험·피드백·휴강·자습은 "오늘 할 것"에 올리지 않는다.
// ⚠️ 그냥 `평가`로 거르면 안 된다: "중환자실의 구조와 운영 & 중환자 중증도 분류 및 평가"는
// 실제 강의다. 그래서 `형성평가`처럼 좁게 잡는다(2026-10-10).
const NOT_LECTURE = /자기주도학습|시험|피드백|휴강|형성평가|기념일|공휴일/;

/**
 * 시간표 표에서 강의를 날짜별로 뽑는다.
 *
 * @param {string} md
 * @param {object} [opts]
 * @param {number} [opts.year]  날짜에 연도가 없는 표(두경부)에서 쓸 연도
 * @returns {Array<{date:string, at:number, period:string, name:string, teacher:string, note:string}>}
 */
export function parseSchedule(md, { year } = {}) {
  const lines = String(md).split('\n');
  // 연도 없는 표를 위해, 파일 안에서 보이는 완전한 날짜의 연도를 먼저 빌린다
  const seen = String(md).match(/\b(20\d{2})-\d{2}-\d{2}\b/);
  const baseYear = seen ? Number(seen[1]) : (year || new Date().getFullYear());

  const out = [];
  let cols = null;

  for (const line of lines) {
    if (!/^\s*\|/.test(line)) { cols = null; continue; }
    if (/^[\s:|-]+$/.test(line.replace(/\|/g, ''))) continue;   // ---- 구분선
    const cells = CELLS(line);

    // 머리글 줄이면 열 위치를 기억한다
    if (cells.some((c) => /강의명/.test(c))) {
      cols = {
        date: cells.findIndex((c) => /날짜/.test(c)),
        period: cells.findIndex((c) => /^교시/.test(c)),
        name: cells.findIndex((c) => /강의명/.test(c)),
        teacher: cells.findIndex((c) => /^담당/.test(c)),
        note: cells.findIndex((c) => /예습노트/.test(c)),
      };
      continue;
    }
    if (!cols || cols.date < 0 || cols.name < 0) continue;

    const rawDate = cells[cols.date] || '';
    const name = (cells[cols.name] || '').replace(/\\\|/g, '|').trim();
    if (BLANK(name) || NOT_LECTURE.test(name)) continue;

    let date = null;
    let m = rawDate.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
    else if ((m = rawDate.match(/\b(\d{1,2})-(\d{1,2})\b/))) {
      date = `${baseYear}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    }
    if (!date) continue;
    const at = Date.parse(`${date}T09:00:00`);
    if (Number.isNaN(at)) continue;

    const noteCell = cols.note >= 0 ? (cells[cols.note] || '') : '';
    const link = noteCell.match(/\[\[([^\]|]+)/);
    out.push({
      date,
      at,
      period: cols.period >= 0 ? (cells[cols.period] || '') : '',
      name,
      teacher: cols.teacher >= 0 ? (cells[cols.teacher] || '').replace(/^[-—]$/, '') : '',
      note: link ? link[1].trim() : '',
    });
  }
  return out;
}

/** 로컬 시각을 YYYY-MM-DD로 — Date.toISOString()은 UTC라 한국에서 하루가 밀린다. */
export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * "오늘 할 것"에 올릴 강의 — 오늘 것이 없으면 가장 가까운 지난 수업일로 물러난다.
 *
 * 왜 물러나나: 강의가 없는 주말에 앱을 열어도 화면이 비면 쓸모가 없다. 직전 수업일을
 * 보여주면 그게 바로 복습 대상이다(2026-10-10).
 */
export function lecturesFor(schedule, now = Date.now()) {
  const key = dayKey(now);
  const pick = (list, when) => ({ date: list[0].date, when, lectures: list.filter((l) => l.date === list[0].date) });

  const today = (schedule || []).filter((l) => l.date === key);
  if (today.length) return { date: key, when: 'today', lectures: today };

  const past = (schedule || []).filter((l) => l.date < key).sort((a, b) => b.date.localeCompare(a.date));
  if (past.length) return pick(past, 'past');

  const future = (schedule || []).filter((l) => l.date > key).sort((a, b) => a.date.localeCompare(b.date));
  if (future.length) return pick(future, 'future');

  return { date: key, when: 'none', lectures: [] };
}
