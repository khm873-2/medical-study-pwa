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
import { linkedNoteFromMd } from './parser.js';

const NOTE_DIRS = ['98_예습노트_보관', '02_Wiki'];

let _noteIndex = null; // {노트이름: vault경로}

/** 노트 이름 → 경로 인덱스를 한 번만 만든다. */
async function noteIndex() {
  if (_noteIndex) return _noteIndex;
  const idx = {};
  for (const root of NOTE_DIRS) {
    let subs;
    try { subs = await listDir(root); } catch { continue; }
    for (const s of subs.filter((e) => e.type === 'dir')) {
      let files;
      try { files = await listDir(s.path); } catch { continue; }
      for (const f of files) {
        if (f.type === 'file' && f.name.endsWith('.md')) {
          const name = f.name.replace(/\.md$/, '');
          if (!(name in idx)) idx[name] = f.path; // 98_예습노트_보관이 먼저라 우선
        }
      }
    }
  }
  _noteIndex = idx;
  return idx;
}

export async function resolveNotePath(noteName) {
  const idx = await noteIndex();
  return idx[noteName] || null;
}

/** 모의고사 html 경로 → 짝이 되는 md에서 연계노트 이름을 얻는다. */
export async function linkedNoteName(examHtmlPath) {
  const mdPath = examHtmlPath.replace(/\.html$/, '.md');
  try {
    const md = await getText(mdPath);
    return linkedNoteFromMd(md);
  } catch {
    return null;
  }
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
        .map((r) => all.find((s) => s.heading.trim() === String(r.heading).trim()))
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

  // ② 폴백 — 연계노트에서 자동 매칭
  const noteName = await linkedNoteName(examHtmlPath);
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
  return {
    noteName, notePath: path, auto: true,
    sections: [...rankSections(question, secs), ...extra],
  };
}
