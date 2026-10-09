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
   '소견 상태 가능 필요 확인 대해 이상 이하 정도 모두 각각 아래 위의 다른 같은 바로 먼저').split(/\s+/)
);

function tokens(s) {
  return String(s)
    .replace(/[^\w가-힣A-Za-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

/**
 * 문항에 가장 잘 맞는 섹션 순위.
 * 헤딩에 겹치는 단어는 가중치를 더 준다(섹션 제목이 곧 주제라서).
 */
export function rankSections(question, secs) {
  const qt = new Set(tokens(`${question.q} ${question.explain || ''} ${(question.opts || []).join(' ')}`));
  return secs
    .map((s) => {
      const headTok = new Set(tokens(s.heading));
      const bodyTok = new Set(tokens(s.text));
      let score = 0;
      headTok.forEach((w) => { if (qt.has(w)) score += 4; });
      bodyTok.forEach((w) => { if (qt.has(w)) score += 1; });
      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score);
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
        .map((s) => ({ ...s, score: 999 }));
      if (picked.length) {
        const rest = contentSections(all).filter((s) => !picked.some((p) => p.heading === s.heading));
        return { noteName: first.note, notePath: path, sections: [...picked, ...rest], auto: false };
      }
    }
  }

  // ② 폴백 — 연계노트에서 자동 매칭
  const noteName = await linkedNoteName(examHtmlPath);
  if (!noteName) return null;
  const path = await resolveNotePath(noteName);
  if (!path) return null;
  const md = await getText(path);
  const secs = contentSections(splitSections(md));
  if (!secs.length) return null;
  return { noteName, notePath: path, sections: rankSections(question, secs), auto: true };
}
