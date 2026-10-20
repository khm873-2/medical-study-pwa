// vault의 모의고사·퀴즈 HTML에서 문항 데이터를 뽑아낸다.
//
// 06_모의고사는 build_mock_exam_html.py가 한 템플릿으로 찍어내서 형식이 일정하지만,
// 05_퀴즈는 여러 시기에 손으로 만들어져 **세 가지 형식이 섞여 있다**(2026-10-10 실측):
//
//   A) const QUESTIONS = [{num,type,q,opts,ans,opt,explain,summary}]   (24개) ← 표준
//   B) const QUESTIONS = [{q,options|choices,correct|answer,optExplain,explain}]
//   C) const Q = [{t,o,a,sum,exp}] + const OX = [{t,a:bool,exp}]       (16개)
//
// 게다가 상당수가 **JSON이 아니라 JS 객체 리터럴**이다(키에 따옴표가 없다).
// 그래서 JSON.parse가 실패하면 리터럴을 평가한다 — 이 HTML은 원래 브라우저에서
// 그대로 실행되라고 만든 내 vault의 파일이고, 비공개 저장소에서 내 토큰으로만
// 받아오므로 새로 생기는 위험이 없다(이미 같은 신뢰 경계 안이다).

// 어느 강의인가 — 파일이 스스로 적어둔 값. 시기마다 이름이 달라서 셋 다 받는다
// (실측: LECTURE_NAME 97개 · LECTURE_TITLE 8개 · SUBJECT_LABEL 7개 / 전체 128개).
const LECTURE_RE = /const (?:LECTURE_NAME|LECTURE_TITLE|SUBJECT_LABEL)\s*=\s*"([^"]*)"/;

/** `const 이름 = [ ... ];` 의 배열 리터럴을 통째로 떼어낸다(괄호 짝을 세어 정확히). */
function sliceArray(html, name) {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\[`);
  const m = re.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1;      // '[' 위치
  let depth = 0, inStr = null, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (!depth) return html.slice(start, i + 1); }
  }
  return null;
}

/**
 * JSON이면 JSON으로, 아니면 JS 리터럴로 읽는다.
 *
 * ⚠️ 리터럴이 **그 파일 안의 도우미**를 쓸 수 있다. 실제로 CRRT 퀴즈는
 *    `function wr(h){...}` 와 `const H1 = "..."` 를 만들어 `wikiRefs: wr(H1)` 로
 *    쓴다 — 배열만 떼어 평가하면 "wr is not defined"로 통째로 실패하고,
 *    앱에는 "문항 데이터를 찾지 못했습니다"로 떠서 **퀴즈가 아예 안 열렸다**
 *    (2026-10-21 신고). 그럴 땐 앞에 선언된 것들을 함께 읽는다(`head`).
 */
function readLiteral(text, head) {
  try { return JSON.parse(text); } catch { /* JS 리터럴로 재시도 */ }
  try {
    // eslint-disable-next-line no-new-func
    const v = new Function(`"use strict"; return (${text});`)();
    return Array.isArray(v) ? v : null;
  } catch { /* 도우미를 쓰는 파일이다 — 아래에서 같이 읽는다 */ }
  if (!head) return null;
  try {
    // 앞쪽의 **선언만** 추린다(const·let·var·function). document를 만지는 줄은
    // 섞이면 안 되므로 가져오지 않는다 — 선언은 불러야 돌아가니 안전하다.
    const decls = (head.match(/^[ \t]*(?:const|let|var|function)\s[\s\S]*?$/gm) || []).join('\n');
    // eslint-disable-next-line no-new-func
    const v = new Function(`"use strict"; ${decls}\nreturn (${text});`)();
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** 여러 형식을 하나로 맞춘다. */
/**
 * OX 답을 자리 번호로 — 0이 O, 1이 X.
 *
 * 글자로 적힌 꼴(`ans:"X"`)을 놓치면 `Number("X")`가 NaN이 되어 **전부 O로** 읽힌다.
 * 그러면 X가 답인 문항을 풀 때마다 맞는 걸 틀렸다고 한다(2026-10-16 점검에서 드러남).
 */
function oxIndex(v) {
  if (typeof v === 'boolean') return v ? 0 : 1;
  if (typeof v === 'number') return v ? 1 : 0;
  const t = String(v ?? '').trim().toUpperCase();
  if (/^(O|ⓞ|TRUE|T|참|예|Y|YES)$/.test(t)) return 0;
  if (/^(X|✕|✗|FALSE|F|거짓|아니오|N|NO)$/.test(t)) return 1;
  return Number(t) ? 1 : 0;        // "0"·"1"처럼 숫자를 글자로 적은 것
}

function normalize(raw, i, forcedType) {
  const q = raw.q ?? raw.t ?? '';
  const opts = raw.opts ?? raw.options ?? raw.choices ?? raw.o ?? null;
  const rawAns = raw.ans ?? raw.correct ?? raw.answer ?? raw.a;
  // ⚠️ `type: "ox"`도 OX로 쳐야 한다. 전에는 **참·거짓(boolean)으로 적힌 것만** OX로 봤는데,
  //    vault의 OX 문항은 대부분 `{"type":"ox","correct":1}`처럼 **번호로** 적혀 있다.
  //    그러면 선지가 없는 객관식으로 읽혀 `opts`가 빈 배열이 되고, 아래 거르개가
  //    "읽을 수 없는 문항"이라며 조용히 버렸다 — **vault 전체에서 216문항이 그렇게
  //    사라지고 있었다**(2026-10-16 점검). 퀴즈마다 끝의 OX 열 문항이 통째로 안 나왔다.
  const isOx = forcedType === 'ox' || raw.type === 'ox' || typeof rawAns === 'boolean';
  // OX의 답은 vault에 **세 가지 꼴**로 적혀 있다(2026-10-16 실측):
  //   참·거짓  {ans:true}      → 참이 O(자리 0)
  //   번호     {correct:1}     → 그 번호가 곧 자리 (0=O, 1=X)
  //   글자     {ans:"X"}       → ← 이걸 놓쳐서 Number("X")=NaN → 전부 O로 읽혔다
  const oxAns = oxIndex(rawAns);
  return {
    num: raw.num ?? i + 1,
    type: isOx ? 'ox' : 'mc',
    q: String(q),
    opts: isOx ? ['O', 'X'] : (Array.isArray(opts) ? opts.map(String) : []),
    ans: isOx ? oxAns : Number(rawAns ?? 0),
    explain: raw.explain ?? raw.exp ?? '',
    opt: raw.opt ?? raw.optExplain ?? raw.optExp ?? [],
    summary: raw.summary ?? raw.sum ?? '',
    ...(raw.img ? { img: raw.img } : {}),
    ...(raw.imgs ? { imgs: raw.imgs } : {}),
    ...(raw.srcTag ? { srcTag: raw.srcTag } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.wikiRefs ? { wikiRefs: raw.wikiRefs } : {}),
  };
}

/**
 * 정답 번호를 **1부터 세어 적어둔 파일**을 바로잡는다.
 *
 * 2026-10-16 신고: "퀴즈가 답이 하나씩 밀려있음." 실제로 그랬다. `ans`는 **0부터 세는
 * 자리 번호**인데(파일 안의 채점 코드도 `i === q.ans`로 0부터 센다), 다섯 파일이
 * 1부터 세어 적어뒀다 — `ans: 2`인데 정답은 두 번째(자리 0 기준 1)였다. 그 파일들은
 * 브라우저에서 바로 열어도 틀리게 채점된다. **파일이 틀린 것이지 앱이 틀린 게 아니다.**
 *
 * 그래도 앱이 바로잡는다. 앞으로 만들 파일에서 또 그럴 수 있고, 공부하다 틀린 답을
 * 외우는 건 되돌릴 수 없는 손해다.
 *
 * 어떻게 아는가: 선지 해설(`opt`)에서 **"정답."으로 시작하는 칸**이 진짜 정답 자리다.
 * 그 자리와 `ans`를 견줘 파일 전체가 한 칸씩 밀렸는지 센다.
 *
 * ⚠️ **한 문항만 보고 고치지 않는다.** `opt` 표시가 어긋난 파일이 따로 있다
 * (천경아 영상의학 18번 — 해설은 ans와 맞는데 opt만 밀려 있다). 한 문항씩 믿으면
 * 그런 데서 멀쩡한 답을 망가뜨린다. **파일 전체가 한 목소리일 때만** 옮긴다.
 */
// "정답." "정답 —" "정답:" 은 정답 표시. "정답의 반대" "정답과 반대"는 정답을 가리키는
// 말이 아니라 **참조**다 — 조사가 붙으면 뺀다.
const ANS_MARK = /^\s*[✅⭕○◎▶]?\s*정답\s*([.\-—:·,)]|$)/;
const SHIFT_MIN = 3;            // 이만큼은 모여야 "파일이 그렇다"고 본다
const SHIFT_RATIO = 0.8;        // 이 비율 넘게 한 목소리여야 한다

export function fixOneBased(items) {
  let zero = 0;
  let one = 0;
  for (const q of items) {
    const opt = Array.isArray(q.opt) ? q.opt : [];
    if (!q.opts || opt.length !== q.opts.length) continue;
    const idx = opt.findIndex((t) => ANS_MARK.test(String(t)));
    if (idx < 0) continue;
    if (q.ans === idx) zero++;
    else if (q.ans === idx + 1) one++;
  }
  const seen = zero + one;
  if (one >= SHIFT_MIN && seen && one / seen >= SHIFT_RATIO) {
    for (const q of items) {
      if (q.type !== 'ox' && Number.isInteger(q.ans) && q.ans > 0) q.ans -= 1;
    }
    return true;
  }
  // 표시가 아예 없는 파일을 위한 안전망 — **자리를 벗어난 답**은 1부터 센 것이 확실하다
  // (선지가 5개인데 ans가 5면 0부터 세는 자리로는 있을 수 없다). 전에는 이런 문항을
  // "읽을 수 없다"며 조용히 버렸다.
  if (!seen && items.length) {
    const over = items.filter((q) => q.type !== 'ox' && q.opts && q.opts.length
      && Number.isInteger(q.ans) && q.ans >= q.opts.length);
    const zeroish = items.some((q) => q.type !== 'ox' && q.ans === 0);
    if (over.length && !zeroish) {
      for (const q of items) {
        if (q.type !== 'ox' && Number.isInteger(q.ans) && q.ans > 0) q.ans -= 1;
      }
      return true;
    }
  }
  return false;
}

export function parseExamHtml(html) {
  let items = [];
  // ① 표준·변형 A/B
  for (const name of ['QUESTIONS', 'questions']) {
    const lit = sliceArray(html, name);
    // 리터럴 **앞쪽**을 같이 넘긴다 — 거기 도우미가 선언돼 있을 수 있다.
    // ⚠️ 자르는 자리는 `const QUESTIONS` **문장 앞**이다. 리터럴(`[`) 앞에서 자르면
    //    `const QUESTIONS = ` 토막이 끼어들어 그 자체가 문법 오류가 된다.
    const stmt = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\[`).exec(html);
    const arr = lit && readLiteral(lit, stmt ? html.slice(0, stmt.index) : '');
    if (arr && arr.length) { items = arr.map((r, i) => normalize(r, i)); break; }
  }
  // ② Q + OX 분할 형식
  if (!items.length) {
    const mc = readLiteral(sliceArray(html, 'Q') || '') || [];
    const ox = readLiteral(sliceArray(html, 'OX') || '') || [];
    items = [
      ...mc.map((r, i) => normalize(r, i, 'mc')),
      ...ox.map((r, i) => normalize(r, mc.length + i, 'ox')),
    ];
    items.forEach((q, i) => { q.num = i + 1; });
  }
  if (!items.length) throw new Error('문항 데이터를 찾지 못했습니다.');
  fixOneBased(items);

  // 쓸 수 없는 문항(선지가 없거나 정답 번호가 범위를 벗어남)은 버린다 — 조용히 깨지는 것보다 낫다
  const good = items.filter((q) => q.q && q.opts.length >= 2
    && Number.isInteger(q.ans) && q.ans >= 0 && q.ans < q.opts.length);
  if (!good.length) throw new Error('읽을 수 있는 문항이 없습니다.');
  good.forEach((q, i) => { q.num = q.num || i + 1; });

  const lm = html.match(LECTURE_RE);
  const lectureName = lm ? lm[1] : '';
  const titles = titleCandidates(html, lectureName);
  return { questions: good, lectureName, title: titles[0] || '', titles,
    dropped: items.length - good.length };
}

/**
 * 제목 후보를 **믿을 만한 순서로** 모은다.
 *
 * 하나만 뽑지 않는 이유(2026-10-15): 퀴즈 HTML을 베껴 만들면서 `<h1>`만 앞 강의 것이
 * 남은 파일이 있다 — 임상독성학 총론·각론 퀴즈 둘 다 머리말이 "소아기본소생술 PBLS…"다.
 * 같은 파일의 `<title>`과 `LECTURE_NAME`은 멀쩡하므로, 부르는 쪽(app.js의 examTitle)이
 * 파일 이름과 견줘 **말이 되는 첫 후보**를 고를 수 있게 셋 다 넘긴다.
 */
function titleCandidates(html, lectureName) {
  const out = [];
  const h1 = html.match(/<h1>([^<]*)<\/h1>/);
  if (h1) out.push(cleanTitle(h1[1]));
  const t = html.match(/<title>([^<]*)<\/title>/);
  if (t) out.push(cleanTitle(t[1]));
  if (lectureName) out.push(cleanTitle(lectureName));
  return out.filter(Boolean);
}

/**
 * 제목에서 **문제집 상표**를 걷어낸다 (2026-10-14 요청).
 *
 * "중이염 모의고사 (SSD 알렌/QBOOK 기반)" → "중이염 모의고사"
 *
 * 출처를 지우는 게 아니다 — 문항마다 붙은 `source`("퍼시픽 내장문제 A1")는 그대로 둔다.
 * 제목 줄에까지 상표가 붙어 있으면 목록이 전부 같은 꼬리로 끝나 **정작 무슨 강의인지가
 * 안 보인다**. 어디서 왔는지는 문항을 열면 나온다.
 */
const BRANDS = /(SSD\s*알렌|SSD\s*문제은행|SSD|알렌이론|알렌|Q-?BOOK|메디톡|퍼시픽)/gi;
const MARK = '\u0000';        // 지울 자리 표시 — `·`를 쓰면 "피부구조·기능"이 망가진다

export function cleanTitle(raw) {
  let t = String(raw || '').trim();
  // ① 상표 낱말을 표시로 바꾼다
  t = t.replace(BRANDS, MARK);
  // ② 표시끼리 이어진 것(`SSD 알렌/QBOOK`)을 하나로 모으고, 딸린 말도 흡수한다
  t = t.replace(new RegExp(`${MARK}(\\s*[/+,·]?\\s*${MARK})+`, 'g'), MARK);
  t = t.replace(new RegExp(`${MARK}\\s*(문제은행|내장문제|기반|문제)`, 'g'), MARK);
  t = t.replace(new RegExp(`(문제은행|기반)\\s*${MARK}`, 'g'), MARK);
  // ③ 표시만 남은 괄호는 통째로 — "(SSD 알렌/QBOOK 기반)"
  t = t.replace(/\s*[(（]([^)）]*)[)）]/g, (m, inner) =>
    (inner.replace(new RegExp(`[${MARK}\\s/+,·—–-]`, 'g'), '') ? m : ''));
  // ④ 표시 주변 구분자 정리 — "— ␀ 모의고사" → "— 모의고사"
  t = t.replace(new RegExp(`\\s*${MARK}\\s*`, 'g'), ' ');
  return t
    .replace(/\s*([—–])\s*(?=[—–]|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s/+—–]+|[\s/+—–]+$/g, '')
    .trim();
}

/**
 * 문항의 이미지 경로를 vault 기준 경로로 바꾼다.
 * HTML 안에서는 "../../attachments/foo.png"처럼 해당 html 파일 기준 상대경로다.
 */
const IMG_DIR = 'attachments/';

export function imagePaths(q) {
  const raw = q.imgs && q.imgs.length ? q.imgs : q.img ? [q.img] : [];
  return raw.map((p) => {
    // `../../attachments/x.png` 처럼 적힌 것 — 올라가는 부분만 뗀다
    let s = String(p || '').trim().replace(/^(\.\.?\/)+/, '');
    // ⚠️ **폴더 없이 이름만** 적힌 것도 있다(vault 실측 45건: "응급중환자…NAPQI.png").
    //    그러면 저장소 꼭대기에서 찾다 못 찾고 "이미지를 불러오지 못했습니다"가 떴다
    //    — 옆 노트에서는 같은 그림이 멀쩡히 보이는데(2026-10-19 신고). vault에서 그림이
    //    사는 곳은 attachments 한 군데뿐이니 이름만 있으면 거기로 본다.
    if (s && !s.includes('/')) s = IMG_DIR + s;
    // 한글 이름은 자소 분리형(NFD)으로 적혀 올 수 있다 — GitHub은 NFC로 답한다
    return s.normalize('NFC');
  });
}

/**
 * 파일명 → 사람이 읽는 제목.
 *   "1012_기본소생술BLS_모의고사.html"          → "기본소생술BLS"
 *   "260917_박희완_소아외상_퀴즈.html"          → "소아외상"  (교수 이름은 따로 뺀다)
 * 날짜는 YYMMDD(새 형식)와 MMDD(옛 형식)를 모두 받는다.
 */
export function prettyExamName(filename) {
  let n = filename.replace(/\.html$/, '').replace(/^(\d{6}|\d{4})_/, '');
  n = n.replace(/_(모의고사|예습퀴즈|퀴즈)$/, '');
  // 퀴즈 파일은 "교수명_주제" 꼴이라 앞의 사람 이름을 뗀다(2~4자 한글 + _)
  n = n.replace(/^[가-힣]{2,4}_/, '');
  return n;
}

/** 퀴즈 파일명에서 교수 이름. 없으면 빈 문자열. */
export function teacherName(filename) {
  const m = filename.replace(/^(\d{6}|\d{4})_/, '').match(/^([가-힣]{2,4})_/);
  return m ? m[1] : '';
}

/** 파일명 앞 날짜 → "10/12". YYMMDD·MMDD 둘 다 받는다. 없으면 빈 문자열. */
export function examDate(filename) {
  const m = filename.match(/^(?:(\d{2}))?(\d{2})(\d{2})_/);
  if (!m) return '';
  return `${m[2]}/${m[3]}`;
}

/** 날짜순 정렬용 키. YYMMDD면 그대로, MMDD면 26을 붙여 본다(이 vault는 전부 2026년). */
export function examSortKey(filename) {
  const six = filename.match(/^(\d{6})_/);
  if (six) return six[1];
  const four = filename.match(/^(\d{4})_/);
  return four ? `26${four[1]}` : '999999';
}

/** 모의고사 md의 frontmatter에서 연계노트(위키링크) 추출 — 위키 패널 폴백용. */
export function linkedNoteFromMd(md) {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(/연계노트:\s*"?\[\[([^\]]+)\]\]"?/);
  return m ? m[1] : null;
}
