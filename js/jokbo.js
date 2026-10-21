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
 * 선지가 **한 줄에 몰려 있는** 경우를 가른다 → 선지 배열 또는 null.
 *
 *   "1. atropine / 2. dobutamine / 3. dopamine / 4. epinephrine / 5. amiodarone"
 *   "① 압박:호흡을 15:2로 / ② 30:2로 / ③ …"
 *
 * 왜 따로 다루나: 복원자가 줄을 안 바꾸고 `/`로 이어 적은 문항이 꽤 된다. 줄 단위로만
 * 찾으면 **선지가 멀쩡히 있는데도** "서술로만 복원된 문항"으로 떨어져 풀 수가 없다
 * (2026-10-21 지적. 재어 보니 응급_중환자 25문항, 그중 22개가 08_PALS 한 챕터에 몰려 있다).
 *
 * 번호가 1부터 차례로 **4개 이상** 이어질 때만 선지로 본다 — "100% O2를 7L/min"처럼
 * 지문에 섞인 숫자를 선지로 오인하지 않기 위해서다.
 */
export function splitInlineOptions(line) {
  const t = String(line).trim();
  // 번호 표시의 위치를 모은다. 숫자형은 **구분자 뒤**에 올 때만 — "15:2로 / 2." 처럼
  // 지문 속 숫자가 걸리지 않게 한다. 동그라미는 그 자체로 분명해서 아무 데나 받는다.
  const marks = [];
  // 점 뒤 공백은 없을 수도 있다("1.10J / 2.20J"). 대신 번호 **앞**은 반드시
  // 줄머리나 구분자여야 한다 — 지문 속 "100% O2를 7L"의 숫자가 걸리지 않게.
  const re = /(?:^|[\s\/·,])([1-6])\s*[\.\)）]\s*|[①②③④⑤⑥]/g;
  let m;
  while ((m = re.exec(t))) {
    const circ = '①②③④⑤⑥'.indexOf(m[0].trim()[0]);
    const n = circ >= 0 ? circ + 1 : Number(m[1]);
    // 표시가 시작하는 자리(앞의 구분자는 뺀다)
    const at = m.index + (/^[\s\/·,]/.test(m[0]) ? 1 : 0);
    marks.push({ n, at, end: m.index + m[0].length });
  }
  // 1부터 차례로 이어지는 가장 긴 묶음을 찾는다
  let best = null;
  for (let s = 0; s < marks.length; s++) {
    if (marks[s].n !== 1) continue;
    const run = [marks[s]];
    for (let i = s + 1; i < marks.length && marks[i].n === run.length + 1; i++) run.push(marks[i]);
    if (run.length >= 4 && (!best || run.length > best.length)) best = run;
  }
  if (!best) return null;
  const opts = best.map((mk, i) => {
    const to = i + 1 < best.length ? best[i + 1].at : t.length;
    return t.slice(mk.end, to).replace(/[\s\/·,]+$/, '').trim();
  });
  // 빈 선지가 섞이면 복원이 덜 된 것이다 — 억지로 세우면 못 푸는 문항이 된다
  if (opts.some((o) => !o)) return null;
  return { opts, stem: t.slice(0, best[0].at).trim() };
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
  // 줄 단위로 못 찾았으면 **한 줄에 몰려 적힌** 선지를 찾는다(2026-10-21).
  for (let i = lines.length - 1; i >= 0; i--) {
    const got = splitInlineOptions(lines[i]);
    if (!got) continue;
    const stem = [...lines.slice(0, i), got.stem].filter((s) => s.trim()).join('\n').trim();
    return { stem, opts: got.opts, tail: lines.slice(i + 1).join('\n').trim() };
  }
  return { stem: String(text).trim(), opts: [], tail: '' };
}

/**
 * "모두 고르시오" 꼴인가 — 답을 **전부** 골라야 맞는 문항.
 *
 * 정답이 여럿인 문항은 두 종류다(2026-10-21 지적):
 *   ① 족보가 답을 확신 못 해 여럿 적어둔 것 → 그중 아무거나 고르면 맞다.
 *   ② 문제가 애초에 "모두 고르시오"인 것 → 전부 골라야 맞다.
 * 지금까지 둘을 똑같이 다뤄서 ②를 하나만 찍어도 정답 처리됐다. 지문으로 가른다.
 */
export function isSelectAll(stem) {
  const t = String(stem || '');
  return /모두\s*고르|모두\s*고름|전부\s*고르|모두\s*선택|있는\s*대로\s*고르/.test(t)
    || /것들[은로]?\s*(?:모두)?\s*고르/.test(t)
    || /옳은\s*것을\s*모두/.test(t);
}

/** "3", "3번", "③", "3 (VF)" → 2(0-based). 숫자를 못 찾으면 -1. */
export function answerIndex(raw) {
  return answerIndices(raw)[0] ?? -1;
}

/**
 * "2, 4", "1,3,5", "②④" → [1,3] / [0,2,4] — **정답이 여럿인 문항**.
 *
 * 응급_중환자만 116개가 "답 2개" 꼴이다. 첫 번째만 보면 나머지를 고른 사람은
 * 정답인데 오답 처리된다(2026-10-13 전수 대조에서 드러남).
 * "3번??(확실한 듯?)"처럼 뒤에 말이 붙는 것도 있어서, **번호 나열이 끝나는 지점까지**만 읽는다.
 */
export function answerIndices(raw) {
  const t = String(raw || '').trim();
  const out = [];
  // 앞머리에서 "번호 + 구분자"가 이어지는 동안만 모은다
  const head = t.match(/^(?:[①②③④⑤⑥]|[1-6])(?:\s*(?:번|,|·|&|\/|와|및|\s)\s*(?:[①②③④⑤⑥]|[1-6])|[①②③④⑤⑥])*/);
  if (!head) return [];
  for (const m of head[0].matchAll(/[①②③④⑤⑥]|[1-6]/g)) {
    const c = '①②③④⑤⑥'.indexOf(m[0]);
    const i = c >= 0 ? c : Number(m[0]) - 1;
    if (!out.includes(i)) out.push(i);
  }
  return out;
}

/** 블록을 `**필드**` 단위로 나눈다. */
function fields(block) {
  const out = {};
  let cur = null;
  const buf = [];
  // 한 블록에 같은 이름의 필드가 두 번 나오는 경우가 있다 — 같은 문항을 두 사람이
  // 각기 다르게 복원한 것(05_Acute_stroke 33번/60번). 덮어쓰면 앞엣것이 통째로 사라진다.
  const flush = () => {
    if (cur) {
      const v = buf.join('\n').trim();
      out[cur] = out[cur] ? `${out[cur]}\n\n${v}` : v;
    }
    buf.length = 0;
  };
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

  // 챕터 머리말 — "이 챕터는 매년 ①②③ 세 축에서 나온다" 식의 출제 경향 분석이다.
  // 응급_중환자만 20,424자가 여기 있는데 앱에는 한 줄도 안 나왔다(2026-10-13 전수 대조).
  // 문항보다 먼저 읽어야 할 내용이라 따로 꺼내 둔다.
  const intro = text
    .split(BLOCK)[0]
    .replace(/^---[\s\S]*?\n---\n/, '')          // 앞머리(강의주제·교수·PDF 쪽수)
    .replace(/^#\s+.+$/m, '')                     // 제목
    .replace(/^검증 상태 범례.*$/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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
    // 한 블록에 복원본이 둘일 수 있다(05_Acute_stroke 33번/60번). 선지 묶음 뒤에 남은 글도
    // 지문에 이어 붙인다 — 안 그러면 두 번째 복원본이 통째로 사라진다(2026-10-13).
    const first = splitStemOptions(stripImages(body));
    const stem = [first.stem, ...restStems(first.tail)].filter(Boolean).join('\n\n');
    const opts = first.opts;
    const ansRaw = f['정답'] || '';
    const all = answerIndices(ansRaw).filter((i) => i < opts.length);
    const ai = all.length ? all[0] : -1;
    const graded = opts.length >= 4 && ai >= 0;

    const stemText = stem || stripImages(body).trim();
    // 지문이 통째로 비어 있으면 문항이 아니다("복원 x"만 있는 블록은 해설로 남는다)
    if (!stemText && !ansRaw) continue;

    // "모두 고르시오"는 답을 전부 골라야 맞다 — 체크로 풀린다(2026-10-21 요청)
    const selectAll = graded && all.length > 1 && isSelectAll(stemText);

    questions.push({
      num: questions.length + 1,
      type: !graded ? 'open' : (selectAll ? 'multi' : 'mc'),
      q: stemText || '(족보 원문에 문제 지문이 복원되지 않았습니다)',
      opts: graded ? opts : [],
      ans: graded ? ai : -1,
      // 정답이 여럿이면 전부. type이 'mc'면 "어느 것이든 정답",
      // 'multi'면 "이걸 다 골라야 정답"이다.
      ansAll: graded && all.length > 1 ? all : null,
      opt: [],
      explain: explainOf(f, ansRaw, graded, notes, all.length > 1),
      imgs,
      srcTag: who,
      source: `족보 ${who}${label ? ` · ${label}` : ''}`,
      year: meta.year || (who.match(/\d{4}/) || [''])[0],
      professor: meta.professor || '',
      qno: meta.qno || label,
    });
  }
  return { title, intro, questions };
}

/** 선지 묶음 뒤에 남은 글에서 지문만 더 캐낸다(선지가 같으면 한 번만 보여주면 된다). */
function restStems(tail) {
  const out = [];
  let rest = String(tail || '').trim();
  for (let i = 0; rest && i < 4; i++) {
    const r = splitStemOptions(rest);
    if (r.stem) out.push(r.stem);
    if (!r.opts.length) break;
    rest = r.tail.trim();
  }
  return out;
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
function explainOf(f, ansRaw, graded, imgNotes, multi = false) {
  const parts = [];
  // 번호 말고 **딸린 말**이 있으면 그것도 보여준다. "3번??(확실한 듯?)", "2, 4 (최초 항목 참조)"
  // 처럼 족보가 남긴 불확실 표시를 지우면 학생이 그 문항을 믿어버린다(2026-10-13).
  const bare = /^(?:[①②③④⑤⑥]|[1-6])(?:\s*(?:번|,|·|&|\/|와|및|\s)\s*(?:[①②③④⑤⑥]|[1-6]))*\s*번?\s*$/;
  if (ansRaw && (!graded || multi || !bare.test(ansRaw.trim()))) parts.push(`정답(족보): ${ansRaw}`);
  if (f['원본 해설']) parts.push(`원본 해설 — ${f['원본 해설']}`);
  if (f['교정 해설']) parts.push(`교정 해설 — ${f['교정 해설']}`);
  if (f['검증']) parts.push(`검증 — ${f['검증']}`);
  // 과목마다 가공본이 조금씩 다르다. 아는 이름만 골라 담으면 그 과목에만 있는 필드가
  // 통째로 사라진다 — 근골격계의 "2022 스캔 원본 대조 결과"가 125건 그랬다(2026-10-13).
  // 그래서 **모르는 필드는 이름 그대로 붙인다**. 빠지는 것보다 길어지는 게 낫다.
  const KNOWN = new Set(['문제', '원문', '정답', '첨부 이미지', '원본 해설', '교정 해설', '검증', '비고']);
  for (const [k, v] of Object.entries(f)) {
    if (KNOWN.has(k) || !String(v).trim()) continue;
    parts.push(`${k} — ${v}`);
  }
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
