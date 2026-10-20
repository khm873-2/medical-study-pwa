// 문항 ↔ 노트 섹션 연결.
//
// 두 경로를 쓴다:
//   1) 문항에 `wikiRefs`가 있으면 그걸 그대로 쓴다(앞으로 /mock-exam이 채울 예정).
//   2) 없으면(= 기존 392문항 전부) 모의고사 md의 `연계노트` 위키링크로 노트를 찾아
//      `## 대단원`으로 쪼갠 뒤, 문항 지문·해설과 키워드가 가장 많이 겹치는 섹션을 고른다.
//
// 2)를 넣은 이유: 소급 작업 없이 지금 있는 문항 전부에서 바로 동작하기 때문이다.
// 실측(ACLS 8문항)에서 7개가 사람 판단과 일치했고, 나머지 1개는 동점이었다 —
// 그래서 "1등만 보여주고 끝"이 아니라 다른 섹션으로 넘겨볼 수 있게 UI를 만든다.

import { listDir, getText } from './github.js';
import { linkedNoteFromMd, prettyExamName } from './parser.js';

// `01_임종평_전범위`도 넣는다 — build_mock_exam_html.py는 이미 여기까지 뒤져서
// wikiRefs를 검증한다. 앱만 안 보면 빌드는 통과했는데 화면에선 조용히 자동매칭으로
// 떨어진다(= 틀린 섹션이 떠도 아무도 모른다). 두 쪽의 탐색 범위는 같아야 한다.
const NOTE_DIRS = ['98_예습노트_보관', '02_Wiki', '01_임종평_전범위'];

let _noteIndex = null; // {노트이름: vault경로}

// 한글 파일명은 자소 분리형(NFD)과 결합형(NFC) 두 가지로 적힐 수 있다 — 맥 파일시스템은
// NFD로, 사람이 타이핑한 `연계노트`는 NFC로 적힌다. 눈에는 똑같은데 문자열로는 다르다.
// 한쪽이라도 NFD로 올라오면 매칭이 **조용히** 실패하므로 양쪽을 맞춰둔다(2026-10-12).
const nfc = (s) => String(s).normalize('NFC');


/**
 * 한 루트 아래의 노트 파일을 모은다 — `{루트}/{과목}/*.md`와 **그 아래 한 겹 더**까지.
 *
 * 한 겹 더 들어가는 이유: /lecture-integrate가 위키를 만들 때마다 Q&A 보조본을
 * `02_Wiki/{과목}/QA/{주제}_QA.md`에 같이 만든다(명령 9번). 2단만 훑으면 그 폴더가
 * 통째로 안 보여서, **앞으로 만드는 위키의 절반이 앱에 안 올라온다**(2026-10-12).
 * @returns {Promise<Array<{subject, group, name, path}>>}
 */
export async function listNoteFiles(root) {
  const out = [];
  let subs;
  try { subs = await listDir(root); } catch { return out; }
  for (const s of subs.filter((e) => e.type === 'dir')) {
    let files;
    try { files = await listDir(s.path); } catch { continue; }
    const push = (f, group) => {
      if (f.type === 'file' && f.name.endsWith('.md')) {
        out.push({ subject: s.name, group, name: nfc(f.name.replace(/\.md$/, '')), path: f.path });
      }
    };
    files.forEach((f) => push(f, null));
    for (const d of files.filter((e) => e.type === 'dir')) {
      let inner;
      try { inner = await listDir(d.path); } catch { continue; }
      inner.forEach((f) => push(f, d.name));
    }
  }
  return out;
}

/** 노트 이름 → 경로 인덱스를 한 번만 만든다. */
async function noteIndex() {
  if (_noteIndex) return _noteIndex;
  const idx = {};
  for (const root of NOTE_DIRS) {
    for (const f of await listNoteFiles(root)) {
      if (!(f.name in idx)) idx[f.name] = f.path; // 98_예습노트_보관이 먼저라 우선
    }
  }
  _noteIndex = idx;
  return idx;
}

export async function resolveNotePath(noteName) {
  const idx = await noteIndex();
  return idx[nfc(noteName)] || null;
}

// ───────────── 족보 ↔ 강의 노트 짝짓기 (2026-10-12) ─────────────
//
// 족보 챕터(`00_Raw_Text/기출문제_학교/{과목}/16_체외막산소장치_ECMO.md`)에는
// 모의고사와 달리 `연계노트` frontmatter가 없다. 대신 **챕터 제목과 노트 이름이
// 사실상 같은 말**이라 이름으로 맞출 수 있다:
//     16_체외막산소장치_ECMO        ↔ 1021_응급중환자_ECMO
//     13_중환자실환자의통증진정및섬망관리 ↔ 1016_응급중환자_중환자실통증진정섬망관리
//
// 띄어쓰기·조사("의", "및")가 들쭉날쭉해서 완전일치로는 21개 중 13개만 붙는다.
// 포함관계 + 글자 2-gram 유사도(Dice)를 같이 쓰면 17개까지 붙고, 나머지 4개는
// **실제로 예습노트가 없는 챕터**(Acute stroke·의료인문학 등)라 안 붙는 게 맞다.
// 억지로 붙이면 엉뚱한 노트가 뜨므로 문턱(0.5) 아래는 포기한다.

const JOKBO_PREFIX = '00_Raw_Text/기출문제_학교/';
const DICE_MIN = 0.5;

export function isJokboPath(path) { return String(path || '').startsWith(JOKBO_PREFIX); }

/** 비교용으로 다듬는다 — 번호·과목 접두어·기호를 떼고 붙여 쓴다. */
function nameKey(s) {
  return nfc(String(s || ''))
    .replace(/\.md$/, '')
    .replace(/^\d{2,6}_/, '')          // 16_ / 1021_
    .replace(/^응급중환자_?/, '')
    .replace(/[^0-9A-Za-z가-힣]/g, '')
    .toLowerCase();
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out.size ? out : new Set([s]);
}

/** 두 이름이 얼마나 같은 말인가(0~1). 띄어쓰기에 흔들리지 않게 2-gram으로 본다. */
export function nameSimilarity(a, b) {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return 0;
  if (x === y || x.includes(y) || y.includes(x)) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let hit = 0;
  A.forEach((g) => { if (B.has(g)) hit++; });
  return (2 * hit) / (A.size + B.size);
}

/** 족보 챕터 경로 → 가장 잘 맞는 강의 노트 이름(없으면 null). */
export async function noteForJokbo(path) {
  const parts = String(path).split('/');
  const subject = parts[2];
  const chapter = parts[parts.length - 1];
  if (!subject || !chapter) return null;

  const cands = [];
  for (const root of NOTE_DIRS) {
    for (const f of await listNoteFiles(root)) {
      if (f.subject === subject && !f.group) cands.push(f.name);   // QA본은 산문이 아니라 뺀다
    }
  }
  let best = null;
  let bestScore = 0;
  for (const n of cands) {
    const sc = nameSimilarity(chapter, n);
    if (sc > bestScore) { bestScore = sc; best = n; }
  }
  return bestScore >= DICE_MIN ? best : null;
}

/**
 * 모의고사·퀴즈 html 경로 → 짝이 되는 노트 이름.
 *
 * 먼저 짝 md의 `연계노트: "[[...]]"`를 본다. 그런데 **그게 없는 파일이 있다**
 * (2026-10-20 신고: PALS 퀴즈에서 "연계노트가 지정돼 있지 않습니다").
 * vault를 세어 보니 퀴즈 4개가 그 꼴이었다 — 적어줄 때 빠뜨린 것이다.
 *
 * 그럴 때 그냥 포기하면 옆칸이 통째로 쓸모없어진다. 퀴즈 **파일 이름**이
 * 이미 강의 이름이므로(`261016_조태진_소아전문소생술PALS_퀴즈`), 족보 챕터에
 * 쓰던 이름 맞추기를 그대로 써서 노트를 찾는다. 문턱(0.5) 아래면 포기한다 —
 * 억지로 붙이면 엉뚱한 노트가 뜬다.
 */
export async function linkedNoteName(examHtmlPath) {
  const mdPath = examHtmlPath.replace(/\.html$/, '.md');
  try {
    const md = await getText(mdPath);
    const named = linkedNoteFromMd(md);
    if (named) return named;
  } catch { /* 짝 md가 아예 없을 수도 있다 — 아래 이름 맞추기로 간다 */ }
  return noteByExamName(examHtmlPath);
}

/** 시험 파일 이름으로 노트를 찾는다(연계노트가 안 적혀 있을 때). */
export async function noteByExamName(examHtmlPath) {
  const parts = String(examHtmlPath).split('/');
  const subject = parts.length >= 3 ? parts[1] : '';
  const topic = prettyExamName(parts[parts.length - 1] || '');
  if (!topic) return null;
  const cands = [];
  for (const root of NOTE_DIRS) {
    for (const f of await listNoteFiles(root)) {
      // 같은 과목의 **산문 노트**만 본다(암기법·QA는 짝이 아니다)
      if (!f.group && (!subject || f.subject === subject)) cands.push(f.name);
    }
  }
  let best = null;
  let bestScore = 0;
  for (const n of cands) {
    const sc = nameSimilarity(topic, n);
    if (sc > bestScore) { bestScore = sc; best = n; }
  }
  return bestScore >= DICE_MIN ? best : null;
}

/** 노트 본문을 `## 대단원` 단위로 쪼갠다(### 소제목은 섹션 안에 그대로 둔다). */
export function splitSections(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const secs = [];
  let cur = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^##\s+(?!#)(.+)$/);
    if (m) {
      if (cur) secs.push(cur);
      cur = { heading: m[1].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) secs.push(cur);
  return secs.map((s) => ({ heading: s.heading, text: s.body.join('\n').trim() }));
}

/** 본문 섹션만 — 목차·치트시트·부록은 매칭 후보에서 뺀다(어느 문항에나 걸려서 노이즈가 된다). */
export function contentSections(secs) {
  return secs.filter((s) => !/^(0\.|목차|🎯|Advanced|참고|Take Home)/i.test(s.heading.trim()));
}

const STOP = new Set(
  ('환자 치료 진단 가장 적절한 것은 무엇 다음 중 이때 시행 해야 한다 경우 위해 대한 있다 없다 ' +
   '되는 하는 그리고 하지만 또는 등의 때문 통해 따라 보인다 나타난다 관찰 시행한다 투여 검사 ' +
   '소견 상태 가능 필요 확인 대해 이상 이하 정도 모두 각각 아래 위의 다른 같은 바로 먼저 ' +
   '여자 남자 여아 남아 세의 내원 방문 병원 응급실 호소 증상 주소 받고 보였다 왔다 했다 진단은 ' +
   '치료는 치료로 다음은 의심 기전 특징 원인 방법 사용 중단 추가 고려 권장 가능성 설명 선택').split(/\s+/)
);

// 조사·어미를 떼어낸다. "알레르기비염으로" → "알레르기비염"
// 이걸 안 해서 문항의 "알레르기 비염"이 노트 제목 "알레르기비염"과 한 번도 안 맞았고,
// 짧은 "비염"만 걸려 엉뚱한 "미각성 비염"이 1등으로 올라왔다(2026-10-09 버그).
const JOSA = ['으로써', '으로서', '에서는', '에게서', '이라는', '라고는', '으로', '에서', '에게',
  '부터', '까지', '보다', '처럼', '이나', '께서', '한테', '마다', '조차', '밖에', '이란', '이라',
  '라는', '으로도', '에는', '에도', '과는', '와는', '이고', '이며', '하고', '한다', '된다', '한',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '들'];

function stem(w) {
  for (const j of JOSA) {
    if (w.length >= j.length + 2 && w.endsWith(j)) return w.slice(0, -j.length);
  }
  return w;
}

/**
 * 비교 단위(feature)를 뽑는다.
 * 한국어는 띄어쓰기가 들쭉날쭉해서("알레르기 비염" vs "알레르기비염") 단어만으로는 못 맞춘다.
 * → 단어(조사 제거) + **글자 2-gram**을 함께 쓴다. 2-gram은 띄어쓰기에 영향받지 않는다.
 */
function features(s) {
  const out = [];
  const words = String(s).toLowerCase().replace(/[^\w가-힣a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
  for (const raw of words) {
    if (/^\d+$/.test(raw)) continue;                 // 숫자만은 의미 없다
    const w = /[가-힣]/.test(raw) ? stem(raw) : raw;
    if (w.length >= 2 && !STOP.has(w) && !STOP.has(raw)) out.push(w);
    if (/^[가-힣]+$/.test(w) && w.length >= 2) {
      for (let i = 0; i < w.length - 1; i++) out.push('§' + w.slice(i, i + 2));
    }
  }
  return out;
}

function featCount(s) {
  const m = new Map();
  for (const f of features(s)) m.set(f, (m.get(f) || 0) + 1);
  return m;
}

/** 족보 콜아웃의 "(선지: a/b/c)" 오답 목록은 그 섹션의 주제가 아니다 —
 *  이것 때문에 "미각성 비염" 섹션이 항히스타민제 문항에 걸렸다(2026-10-09). */
function matchText(t) {
  return String(t).replace(/\(선지[:：][^)]*\)/g, ' ');
}

/**
 * 문항에 가장 잘 맞는 섹션 순위. BM25 + 제목 필드 가중.
 *
 * 왜 BM25인가: 예전 방식("겹치는 단어 수")은 긴 섹션이 무조건 이겼고,
 * 코사인으로 바꾸면 반대로 **짧은 섹션이 과대평가**됐다(400자짜리 미각성 비염이
 * 모든 비염 문항에서 1등). BM25의 길이 정규화(b)는 이 양쪽을 동시에 눌러준다.
 * 제목은 곧 섹션의 주제이므로 별도 필드로 3배 가중한다.
 */
const K1 = 1.2, B = 0.6, HEAD_REPEAT = 3;

export function rankSections(question, secs) {
  if (!secs.length) return [];
  const qFeat = new Set(features(
    matchText(`${question.q} ${question.explain || ''} ${(question.opts || []).join(' ')}`)));

  // 섹션별 feature 빈도 — 제목은 HEAD_REPEAT번 넣은 셈 친다
  const docs = secs.map((s) => {
    const m = featCount(matchText(s.text));
    for (const f of features(s.heading)) m.set(f, (m.get(f) || 0) + HEAD_REPEAT);
    let len = 0;
    m.forEach((v) => { len += v; });
    return { m, len };
  });
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / docs.length || 1;

  const df = new Map();
  docs.forEach((d) => d.m.forEach((_, f) => df.set(f, (df.get(f) || 0) + 1)));
  const N = secs.length;
  // 섹션이 적어(보통 7~10개) 표준 BM25 idf는 음수가 되기 쉬우므로 로그 안을 +1 해 양수로 둔다
  const idf = (f) => Math.log(1 + (N - (df.get(f) || 0) + 0.5) / ((df.get(f) || 0) + 0.5));

  const raw = docs.map((d) => {
    let sc = 0;
    qFeat.forEach((f) => {
      const tf = d.m.get(f);
      if (!tf) return;
      sc += idf(f) * (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / avgLen));
    });
    return sc;
  });

  // 0~1로 읽히게 정규화 — 순위는 그대로이고 UI에서 "얼마나 확신하는지" 보여주기 좋다
  const max = Math.max(...raw, 1e-9);

  // ★ 절대 관련도(fit). 위 score는 "이 노트 안에서 몇 등인가"일 뿐이라
  // 노트에 아예 그 주제가 없어도 1등은 반드시 나온다 — 실제로 환경의학 노트에는
  // 익수·저체온 섹션이 없는데 그 문항 8개에 엉뚱한 섹션을 자신 있게 띄우고 있었다.
  // fit은 "제목이 문항과 겹치는가 + 문항의 특징적인 말이 본문에 있는가"를 본다.
  const headFeats = secs.map((s) => new Set(features(s.heading)));
  const distinctive = [...qFeat].filter((f) => (df.get(f) || 0) > 0 && (df.get(f) || 0) <= Math.max(1, N * 0.4));

  const fits = secs.map((s, i) => {
    const hf = headFeats[i];
    let hHit = 0;
    hf.forEach((f) => { if (qFeat.has(f)) hHit++; });
    const headCover = hf.size ? hHit / hf.size : 0;
    const bodyCover = distinctive.length
      ? distinctive.filter((f) => docs[i].m.has(f)).length / distinctive.length
      : 0;
    return Math.round((0.6 * headCover + 0.4 * bodyCover) * 1000) / 1000;
  });

  return secs
    .map((s, i) => ({
      ...s,
      score: Math.round((raw[i] / max) * 1000) / 1000,
      fit: fits[i],
      _raw: raw[i],
    }))
    .sort((a, b) => b._raw - a._raw)
    .map(({ _raw, ...rest }) => rest);
}

/**
 * fit을 사람이 읽는 말로. 자동 매칭은 본질적으로 추정이라 **감추지 않고 그대로 보여준다.**
 * (완전 자동 판정은 포기했다 — 열사병 문항처럼 제목이 영어이고 지문이 한국어면
 *  "관련 있음"과 "관련 없음"이 수치상 겹친다. 대신 사용자가 바로 고를 수 있게 만들었다.)
 */
export function fitLabel(fit) {
  if (fit >= 0.45) return '잘 맞음';
  if (fit >= 0.25) return '추정';
  return '약한 추정';
}

/**
 * 노트에서 그 대목을 찾는다 — **제목이 조금 바뀌었어도** 찾아낸다.
 *
 * 전에는 글자가 똑같아야만 찾았다. 그런데 노트는 계속 자라서 제목이 바뀐다 —
 * `13. 🔥 오늘 퀴즈 11문항 · 증례 4건 […]`이 수업 뒤 `… 27문항 · 증례 5건 […]`이 됐다.
 * 그러면 시험에 적어둔 참조가 **조용히 떨어져** 노트 전체 자동매칭으로 넘어간다 —
 * 화면에는 엉뚱한 대목이 뜨는데 왜 그런지 알 길이 없다(2026-10-16 점검).
 *
 * 그래서 세 단계로 본다: 글자가 같은 것 → **앞 번호가 같은 것**(`13.`) → 많이 닮은 것.
 * 번호는 제목이 바뀌어도 잘 안 바뀌는 데다 노트 안에서 유일하다.
 */
const HEAD_FIT = 0.55;
export function findHeading(sections, want) {
  const w = String(want || '').trim();
  if (!w) return null;
  const exact = sections.find((s) => s.heading.trim() === w);
  if (exact) return exact;
  const num = w.match(/^\s*(\d+(?:[.-]\d+)*)\s*[.)]?\s/);
  if (num) {
    const same = sections.filter((s) => {
      const m = s.heading.match(/^\s*(\d+(?:[.-]\d+)*)\s*[.)]?\s/);
      return m && m[1] === num[1];
    });
    if (same.length === 1) return same[0];
    if (same.length > 1) {
      return same.reduce((a, b) => (nameSimilarity(w, b.heading) > nameSimilarity(w, a.heading) ? b : a));
    }
  }
  let best = null;
  let bestSim = 0;
  for (const s of sections) {
    const sim = nameSimilarity(w, s.heading);
    if (sim > bestSim) { bestSim = sim; best = s; }
  }
  return bestSim >= HEAD_FIT ? best : null;
}

/**
 * 문항에 대한 위키 참조를 만든다.
 * @returns {{noteName, notePath, sections:[{heading,text,score}], auto:boolean}|null}
 */
export async function wikiFor(question, examHtmlPath) {
  // ① 문항에 명시된 wikiRefs가 있으면 그걸 우선한다.
  if (Array.isArray(question.wikiRefs) && question.wikiRefs.length) {
    const first = question.wikiRefs[0];
    const path = await resolveNotePath(first.note);
    if (path) {
      const md = await getText(path);
      const all = splitSections(md);
      const picked = question.wikiRefs
        .map((r) => findHeading(all, String(r.heading)))
        .filter(Boolean)
        .map((s) => ({ ...s, score: 1, fit: 1 }));
      if (picked.length) {
        // 지정된 섹션 → 나머지 본문 → 참고(Cheat Sheet·목차) 순. 자동 매칭 경로와 목록 구성을 맞춘다.
        const isPicked = (s) => picked.some((p) => p.heading === s.heading);
        const body = contentSections(all).filter((s) => !isPicked(s)).map((s) => ({ ...s, score: 0, fit: 0 }));
        const extra = all
          .filter((s) => !isPicked(s) && !body.some((b) => b.heading === s.heading))
          .map((s) => ({ ...s, score: 0, fit: 0, extra: true }));
        return {
          noteName: first.note, notePath: path, auto: false,
          sections: [...picked, ...body, ...extra],
        };
      }
    }
  }

  // ② 폴백 — 연계노트에서 자동 매칭.
  //    족보 챕터에는 연계노트가 없으므로 챕터 제목으로 노트를 찾는다.
  const noteName = isJokboPath(examHtmlPath)
    ? await noteForJokbo(examHtmlPath)
    : await linkedNoteName(examHtmlPath);
  if (!noteName) return null;
  const path = await resolveNotePath(noteName);
  if (!path) return null;
  const md = await getText(path);
  const all = splitSections(md);
  const secs = contentSections(all);
  if (!secs.length) return null;
  // 매칭 후보에서 뺀 Cheat Sheet·목차도 **목록 끝에 붙여** 손으로 고를 수 있게 둔다.
  // 환경의학 노트처럼 저체온·뱀물림이 대단원에는 없고 Cheat Sheet 표에만 있는 경우가 있다.
  const extra = all
    .filter((s) => !secs.some((c) => c.heading === s.heading))
    .map((s) => ({ ...s, score: 0, fit: 0, extra: true }));
  // ⚠️ 목록은 **문서 차례 그대로** 준다. 전에는 관련도 순으로 섞어 줘서 목차가
  //    "2 · 한눈에 · 4 · 8 · 7 · 5 · 3 …"처럼 나왔다 — 목차인데 차례가 없으니
  //    어디쯤인지 가늠이 안 된다(2026-10-20 신고). 맞추는 셈(rankSections)은 그대로
  //    쓰되, 그 결과는 **어디를 먼저 펼지**(bestIdx)에만 쓴다.
  const ranked = rankSections(question, secs);
  const scoreOf = new Map(ranked.map((r) => [r.heading, r]));
  const inOrder = secs.map((x) => {
    const r = scoreOf.get(x.heading);
    return { ...x, score: r ? r.score : 0, fit: r ? r.fit : 0 };
  });
  const best = ranked[0] ? inOrder.findIndex((x) => x.heading === ranked[0].heading) : 0;
  return {
    noteName, notePath: path, auto: true,
    bestIdx: Math.max(0, best),
    sections: [...inOrder, ...extra],
  };
}
