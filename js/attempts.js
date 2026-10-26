// 문항별 풀이 이력에서 "다시 봐야 할 문항"을 골라내는 순수 로직.
//
// 왜 db.js와 나눠놨나: 여기 들어있는 판단(무엇이 약한 문항인가, 어떤 순서로 꺼낼 것인가)이
// 실제로 공부 효과를 가르는 부분이라 노드에서 테스트할 수 있어야 한다. db.js는 indexedDB를
// 쓰기 때문에 import하는 순간 테스트가 안 돌아간다.
//
// 설계 근거(공부법):
//  - 찍어서 맞춘 문항은 "정답"으로 기록되면 약점이 숨는다 → unsure를 오답과 같은 급으로 본다.
//  - 틀린 직후 다시 풀면 정답 번호를 외우는 것에 가깝다 → 하루 이상 지난 것을 먼저 꺼낸다.
//  - 반복해서 틀리는 문항(leech)은 앞으로 당긴다.
//  - ★ 북마크("다시보고 싶어서 찍음")도 오답·확신없음과 같은 급으로 본다 — 맞고
//    확신도 있었는데 북마크만 찍은 문항이 그냥 "solid"로 내려가 버리면 표시한 의미가
//    없다(2026-10-26).

export const DAY = 86400000;

/** 마지막 시도를 기준으로 "다시 봐야 하는가". */
export function isWeak(a) {
  if (!a || !a.last) return false;
  return !a.last.correct || !!a.last.unsure || !!a.bookmarked;
}

/** 확신까지 있는 정답이고 북마크도 없는 것 — 큐에서 내려간 문항. */
export function isSolid(a) {
  return !!(a && a.last && a.last.correct && !a.last.unsure && !a.bookmarked);
}

/**
 * 꺼내는 순서를 정하는 점수 — **클수록 먼저**.
 *
 * 1순위 오답 > 확신없음, 2순위 하루 이상 묵은 것, 3순위 반복해서 틀린 것.
 */
export function weakScore(a, now = Date.now()) {
  if (!isWeak(a)) return -1;
  const wrong = !a.last.correct;
  const aged = now - a.last.at >= DAY;
  let s = wrong ? 400 : 200;          // 오답이 확신없음보다 위
  if (aged) s += 100;                 // 하루 지난 것을 먼저(즉시 재시도는 효과가 낮다)
  s += Math.min(60, (a.wrongN || 0) * 20);  // 반복해서 틀리는 문항을 당긴다
  s += Math.min(20, (a.unsureN || 0) * 5);
  return s;
}

/**
 * 다시 풀 문항 큐.
 *
 * @param {Array} attempts  allAttempts() 결과
 * @param {object} opts
 * @param {string} [opts.subject] 과목으로 좁힌다(없으면 전체)
 * @param {string} [opts.kind]    종류(퀴즈/모의고사/드릴/족보)로 좁힌다
 * @param {string} [opts.exam]    한 시험으로 좁힌다
 * @param {number} [opts.limit]
 * @param {number} [opts.now]
 */
export function weakQueue(attempts, { subject, kind, exam, limit = 0, now = Date.now() } = {}) {
  let list = (attempts || []).filter(isWeak);
  if (subject) list = list.filter((a) => a.subject === subject);
  if (kind) list = list.filter((a) => a.kind === kind);
  if (exam) list = list.filter((a) => a.exam === exam);
  list.sort((x, y) => {
    const d = weakScore(y, now) - weakScore(x, now);
    if (d) return d;
    return (x.last?.at || 0) - (y.last?.at || 0);   // 같은 점수면 오래된 것 먼저
  });
  return limit > 0 ? list.slice(0, limit) : list;
}

/**
 * 과목×종류별 요약 — 홈 화면 배지와 모아보기 목록에 쓴다.
 *
 * ⚠️ **과목 단위가 아니라 "과목|종류" 단위로 묶는다**(2026-10-26) — 전에는 퀴즈·모의고사·
 * 드릴·족보가 한 과목 밑에 전부 섞여서 "과목별/드릴별/모의고사별로 나눠서 오답을 모으고
 * 싶다"는 요청에 답할 수 없었다. 과목 전체 합계가 필요하면 [[sumBySubject]]로 다시 묶는다 —
 * 반환 배열의 각 항목 모양(subject/weak/wrong/...)은 그대로라 기존 호출부도 깨지지 않는다.
 */
export function weakBySubject(attempts, now = Date.now()) {
  const by = new Map();
  for (const a of attempts || []) {
    if (!a.subject) continue;
    const key = `${a.subject}|${a.kind || ''}`;
    if (!by.has(key)) {
      by.set(key, { subject: a.subject, kind: a.kind || '', weak: 0, wrong: 0, unsure: 0, star: 0, solid: 0, total: 0, aged: 0 });
    }
    const g = by.get(key);
    g.total += 1;
    if (isSolid(a)) { g.solid += 1; continue; }
    if (!isWeak(a)) continue;
    g.weak += 1;
    // 오답 > 찍음(확신없음) > 북마크만 있는 경우 순으로 분류한다 — 셋 다 isWeak지만
    // 한 문항이 동시에 여럿일 수 있어도 집계는 가장 급한 사유 하나로만 센다.
    if (!a.last.correct) g.wrong += 1;
    else if (a.last.unsure) g.unsure += 1;
    else g.star += 1;             // 맞고 확신도 있었는데 ★ 북마크만 찍힌 경우
    if (now - a.last.at >= DAY) g.aged += 1;
  }
  return [...by.values()].sort((x, y) => y.weak - x.weak);
}

/**
 * [[weakBySubject]]가 돌려준 과목×종류별 묶음을 과목 단위로 다시 합친다 — 종류 구분
 * 없이 "이 과목 전체에 다시 볼 문항이 몇 개인가"가 필요한 자리(예: 시험 임박 과목을
 * 맨 위로 올리는 정렬)에 쓴다. 종류별 소계는 `g.byKind`에 그대로 남겨둔다.
 */
export function sumBySubject(groups) {
  const by = new Map();
  for (const g of groups || []) {
    if (!by.has(g.subject)) {
      by.set(g.subject, { subject: g.subject, weak: 0, wrong: 0, unsure: 0, star: 0, solid: 0, total: 0, aged: 0, byKind: [] });
    }
    const s = by.get(g.subject);
    s.weak += g.weak; s.wrong += g.wrong; s.unsure += g.unsure; s.star += g.star;
    s.solid += g.solid; s.total += g.total; s.aged += g.aged;
    s.byKind.push(g);
  }
  return [...by.values()].sort((x, y) => y.weak - x.weak);
}

/** 한 시험을 얼마나 소화했나 — 목록 화면에 "12/20 · 약한 3" 처럼 붙인다. */
export function examProgress(attempts, exam) {
  const list = (attempts || []).filter((a) => a.exam === exam);
  return {
    seen: list.length,
    solid: list.filter(isSolid).length,
    weak: list.filter(isWeak).length,
  };
}
