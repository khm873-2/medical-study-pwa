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

export const DAY = 86400000;

/** 마지막 시도를 기준으로 "다시 봐야 하는가". */
export function isWeak(a) {
  if (!a || !a.last) return false;
  return !a.last.correct || !!a.last.unsure;
}

/** 확신까지 있는 정답 — 큐에서 내려간 문항. */
export function isSolid(a) {
  return !!(a && a.last && a.last.correct && !a.last.unsure);
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
 * @param {string} [opts.exam]    한 시험으로 좁힌다
 * @param {number} [opts.limit]
 * @param {number} [opts.now]
 */
export function weakQueue(attempts, { subject, exam, limit = 0, now = Date.now() } = {}) {
  let list = (attempts || []).filter(isWeak);
  if (subject) list = list.filter((a) => a.subject === subject);
  if (exam) list = list.filter((a) => a.exam === exam);
  list.sort((x, y) => {
    const d = weakScore(y, now) - weakScore(x, now);
    if (d) return d;
    return (x.last?.at || 0) - (y.last?.at || 0);   // 같은 점수면 오래된 것 먼저
  });
  return limit > 0 ? list.slice(0, limit) : list;
}

/** 과목별 요약 — 홈 화면 배지와 모아보기 목록에 쓴다. */
export function weakBySubject(attempts, now = Date.now()) {
  const by = new Map();
  for (const a of attempts || []) {
    if (!a.subject) continue;
    if (!by.has(a.subject)) by.set(a.subject, { subject: a.subject, weak: 0, wrong: 0, unsure: 0, solid: 0, total: 0, aged: 0 });
    const g = by.get(a.subject);
    g.total += 1;
    if (isSolid(a)) { g.solid += 1; continue; }
    if (!isWeak(a)) continue;
    g.weak += 1;
    if (!a.last.correct) g.wrong += 1; else g.unsure += 1;
    if (now - a.last.at >= DAY) g.aged += 1;
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
