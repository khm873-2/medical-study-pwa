// 족보(학교 기출) — 가공된 마크다운을 퀴즈 화면이 아는 문항 배열로 바꾼다.
//
// 원본은 `99_2026_2학기_족보/응급, 중환자 통합교육 족보.pdf`이고, vault의
// `00_Raw_Text/기출문제_학교/{과목}/NN_챕터.md`에 챕터별로 가공돼 있다.
// 가공 규칙은 같은 폴더의 `_FORMAT_GUIDE.md`가 기준이며, 이 파서는 그 규칙을 읽는다.
//
// 왜 따로 파서가 필요한가: 06_모의고사·05_퀴즈는 `const QUESTIONS = [...]`가 박힌
// HTML이지만 족보는 **사람이 읽으라고 만든 마크다운**이다. 포맷은 일정하지만
// (실측 658블록 중 652개가 `**정답 (족보)**`를 가진다) 문제가 둘 있다:
//
//   ① 정답이 숫자가 아닌 게 135개다 — "복원 x", "답이었던거같습니다" 같은
//      **서술형 복원**. 버리면 실제 시험장 정보를 버리는 거라, 채점 없이
//      읽고 넘기는 'open' 문항으로 살린다.
//   ② 선지 번호가 `1.` `1)` `①`로 섞여 있다. 셋 다 받는다.
//
// 이미지(107장)는 챕터 파일 기준 상대경로(`images/NN_챕터/pXX-000.png`)라
// vault 절대경로로 바꿔야 앱이 GitHub에서 받아올 수 있다.

import { listDir, getText } from './github.js';

export const JOKBO_ROOT = '00_Raw_Text/기출문제_학교';

/** 챕터 파일인가 — `_가공현황`·`00_과목소개` 같은 메타 문서는 뺀다. */
const isChapter = (name) => /^\d{2}_.+\.md$/.test(name) && !/^00_/.test(name);

/** 이 과목의 족보 챕터 목록(번호순). */
export async function listChapters(subject) {
  const files = await listDir(`${JOKBO_ROOT}/${subject}`);
  return files
    .filter((f) => f.type === 'file' && isChapter(f.name))
    .map((f) => ({ file: f.name, path: f.path, title: chapterTitle(f.name) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** "16_체외막산소장치_ECMO.md" → "체외막산소장치 ECMO" */
export function chapterTitle(file) {
  return file.replace(/\.md$/, '').replace(/^\d{2}_/, '').replace(/_/g, ' ').trim();
}

/** 챕터 하나를 통째로 읽어 문항 배열로. */
export async function loadChapter(path) {
  return parseJokbo(await getText(path), path);
}

// ───────────── 파싱 ─────────────

const BLOCK = /\n(?=##\s*\[)/;
// "## [2025 · 박형복] 문항2 (V-A ECMO의 장단점, 서술형 복원)"
const HEAD = /^##\s*\[([^\]]*)\]\s*(.*)$/;
const META = /<!--\s*meta:\s*([^>]*?)\s*-->/;
const FIELD = /^\*\*(.+?)\*\*\s*[:：]?\s*/;
// `![](images/...)` — 설명문(`*이미지 분석*: …`)은 따로 뽑는다
const IMG = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const IMG_NOTE = /^\*이미지 분석\*\s*[:：]\s*(.+)$/;

/** `1.` `1)` `１.` `①` 로 시작하는 선지 줄인가 → [번호(1-base), 본문] 또는 null */
export function optionLine(line) {
  const t = line.trim();
  const circ = '①②③④⑤⑥'.indexOf(t[0]);
  if (circ >= 0) {
    const body = t.slice(1).replace(/^[\.\)．、]\s*/, '').trim();
    return body ? [circ + 1, body] : null;
  }
  const m = t.match(/^([1-6])\s*[\.\)）．、]\s*(.+)$/) || t.match(/^([1-6])\s{1,3}(\S.*)$/);
  if (!m) return null;
  return [Number(m[1]), m[2].trim()];
}

/**
 * 지문과 선지를 가른다.
 * 선지는 **1번부터 차례로 이어지는 줄 묶음**이어야 한다 — 본문에 섞인
 * "1. 첫째로" 같은 열거를 선지로 오인하지 않기 위해서다.
 */
export function splitStemOptions(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  // 뒤에서부터 "1로 시작하는 연속 묶음"을 찾는다(선지는 항상 지문 뒤에 온다)
  for (let start = 0; start < lines.length; start++) {
    const first = optionLine(lines[start]);
    if (!first || first[0] !== 1) continue;
    const opts = [first[1]];
    let i = start + 1;
    let want = 2;
    while (i < lines.length) {
      const raw = lines[i];
      if (!raw.trim()) { i++; continue; }
      const o = optionLine(raw);
      if (o && o[0] === want) { opts.push(o[1]); want++; i++; continue; }
      // 번호 없는 줄은 바로 앞 선지의 이어진 부분으로 본다(선지가 두 줄인 경우)
      if (opts.length && !o && want > 2 && raw.startsWith(' ')) {
        opts[opts.length - 1] += ' ' + raw.trim();
        i++;
        continue;
      }
      break;
    }
    if (opts.length >= 4) {
      return { stem: lines.slice(0, start).join('\n').trim(), opts, tail: lines.slice(i).join('\n').trim() };
    }
  }
  return { stem: String(text).trim(), opts: [], tail: '' };
}

/** "3", "3번", "③", "3 (VF)" → 2(0-based). 숫자를 못 찾으면 -1. */
export function answerIndex(raw) {
  const t = String(raw || '').trim();
  const circ = '①②③④⑤⑥'.indexOf(t[0]);
  if (circ >= 0) return circ;
  const m = t.match(/^([1-6])\s*(번|[\.\)）,·&/]|$|\s)/);
  return m ? Number(m[1]) - 1 : -1;
}

/** 블록을 `**필드**` 단위로 나눈다. */
function fields(block) {
  const out = {};
  let cur = null;
  const buf = [];
  const flush = () => { if (cur) out[cur] = buf.join('\n').trim(); buf.length = 0; };
  for (const line of block.split('\n')) {
    const m = line.match(FIELD);
    if (m) {
      flush();
      cur = m[1].split('(')[0].trim();
      buf.push(line.slice(m[0].length));
    } else if (cur) buf.push(line);
  }
  flush();
  return out;
}

function metaOf(block) {
  const m = block.match(META);
  const out = {};
  if (!m) return out;
  for (const kv of m[1].split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/** 이미지 상대경로 → vault 절대경로. 설명문은 해설 꼬리에 붙인다. */
function imagesOf(block, dir) {
  const imgs = [];
  let m;
  IMG.lastIndex = 0;
  while ((m = IMG.exec(block))) {
    const p = m[1].replace(/^\.\//, '');
    imgs.push(/^(https?:|\/)/.test(p) ? p : `${dir}/${p}`);
  }
  const notes = block.split('\n').map((l) => l.trim().match(IMG_NOTE)).filter(Boolean).map((x) => x[1]);
  return { imgs, notes };
}

/**
 * 족보 챕터 마크다운 → {title, questions}
 * @param {string} md
 * @param {string} path  `00_Raw_Text/기출문제_학교/응급_중환자/16_….md`
 */
export function parseJokbo(md, path = '') {
  const text = String(md).replace(/\r\n/g, '\n');
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const h1 = text.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1].trim() : chapterTitle(path.split('/').pop() || '');

  const questions = [];
  for (const block of text.split(BLOCK).slice(1)) {
    const head = block.split('\n')[0].match(HEAD);
    if (!head) continue;
    const who = head[1].replace(/\s*·\s*/g, ' · ').trim();     // "2025 · 박형복"
    const label = head[2].replace(/\s*\(.*\)\s*$/, '').trim(); // "문항2" / "90번"
    const f = fields(block);
    const meta = metaOf(block);
    const { imgs, notes } = imagesOf(block, dir);

    const body = f['문제'] || f['원문'] || '';
    const { stem, opts } = splitStemOptions(stripImages(body));
    const ansRaw = f['정답'] || '';
    const ai = answerIndex(ansRaw);
    const graded = opts.length >= 4 && ai >= 0 && ai < opts.length;

    const stemText = stem || stripImages(body).trim();
    // 지문이 통째로 비어 있으면 문항이 아니다("복원 x"만 있는 블록은 해설로 남는다)
    if (!stemText && !ansRaw) continue;

    questions.push({
      num: questions.length + 1,
      type: graded ? 'mc' : 'open',
      q: stemText || '(족보 원문에 문제 지문이 복원되지 않았습니다)',
      opts: graded ? opts : [],
      ans: graded ? ai : -1,
      opt: [],
      explain: explainOf(f, ansRaw, graded, notes),
      imgs,
      srcTag: who,
      source: `족보 ${who}${label ? ` · ${label}` : ''}`,
      year: meta.year || (who.match(/\d{4}/) || [''])[0],
      professor: meta.professor || '',
      qno: meta.qno || label,
    });
  }
  return { title, questions };
}

/** `![](...)`와 그 설명 줄을 지문에서 걷어낸다 — 이미지는 따로 보여준다. */
function stripImages(s) {
  return String(s)
    .split('\n')
    .filter((l) => !/!\[[^\]]*\]\(/.test(l) && !IMG_NOTE.test(l.trim()))
    .join('\n')
    .trim();
}

/**
 * 해설을 한 덩어리로 모은다.
 * 족보 가공본은 원본 해설을 **고치지 않고 보존**하고 그 옆에 검증·교정을 덧붙인다
 * (_FORMAT_GUIDE 0절). 그 구조가 보이게 이름표를 붙여서 이어 쓴다.
 */
function explainOf(f, ansRaw, graded, imgNotes) {
  const parts = [];
  if (!graded && ansRaw) parts.push(`정답(족보): ${ansRaw}`);
  if (f['원본 해설']) parts.push(`원본 해설 — ${f['원본 해설']}`);
  if (f['교정 해설']) parts.push(`교정 해설 — ${f['교정 해설']}`);
  if (f['검증']) parts.push(`검증 — ${f['검증']}`);
  if (f['비고'] && !/^없음\.?$/.test(f['비고'].trim())) parts.push(`비고 — ${f['비고']}`);
  if (imgNotes.length) parts.push(`이미지 — ${imgNotes.join(' / ')}`);
  return parts.join('\n\n');
}

/** 챕터 여러 개를 한 묶음으로 — "이 과목 족보 전부" 모드. */
export function mergeChapters(chapters) {
  const questions = [];
  for (const { title, questions: qs, path } of chapters) {
    for (const q of qs) {
      questions.push({ ...q, num: questions.length + 1, __exam: path, __title: title,
        source: `${title} · ${q.source}` });
    }
  }
  return questions;
}
