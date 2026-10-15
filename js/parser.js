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

/** JSON이면 JSON으로, 아니면 JS 리터럴로 읽는다. */
function readLiteral(text) {
  try { return JSON.parse(text); } catch { /* JS 리터럴로 재시도 */ }
  try {
    // eslint-disable-next-line no-new-func
    const v = new Function(`"use strict"; return (${text});`)();
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** 여러 형식을 하나로 맞춘다. */
function normalize(raw, i, forcedType) {
  const q = raw.q ?? raw.t ?? '';
  const opts = raw.opts ?? raw.options ?? raw.choices ?? raw.o ?? null;
  const isOx = forcedType === 'ox' || typeof (raw.ans ?? raw.correct ?? raw.answer ?? raw.a) === 'boolean';
  const rawAns = raw.ans ?? raw.correct ?? raw.answer ?? raw.a;
  return {
    num: raw.num ?? i + 1,
    type: isOx ? 'ox' : (raw.type === 'ox' ? 'ox' : 'mc'),
    q: String(q),
    opts: isOx ? ['O', 'X'] : (Array.isArray(opts) ? opts.map(String) : []),
    ans: isOx ? (rawAns === true ? 0 : 1) : Number(rawAns ?? 0),
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

export function parseExamHtml(html) {
  let items = [];
  // ① 표준·변형 A/B
  for (const name of ['QUESTIONS', 'questions']) {
    const lit = sliceArray(html, name);
    const arr = lit && readLiteral(lit);
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
export function imagePaths(q) {
  const raw = q.imgs && q.imgs.length ? q.imgs : q.img ? [q.img] : [];
  return raw.map((p) => p.replace(/^(\.\.\/)+/, ''));
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
