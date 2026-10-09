// vault의 모의고사 HTML에서 문항 데이터를 뽑아낸다.
//
// 모의고사 HTML은 `.claude/scripts/build_mock_exam_html.py`가 베이스라인 템플릿의
// QUESTIONS 배열만 갈아끼워 만든 것이라 형식이 일정하다:
//     const QUESTIONS = [ ... ];
//     const LECTURE_NAME = "...";
// 문항 스키마: {num, type:'mc'|'ox', q, opts[], ans(0-indexed), explain, opt[],
//              img?, imgs?, srcTag?, source?, wikiRefs?}

const QUESTIONS_RE = /const QUESTIONS = (\[[\s\S]*?\]);\s*\nconst LECTURE_NAME = "([^"]*)";/;

export function parseExamHtml(html) {
  const m = html.match(QUESTIONS_RE);
  if (!m) throw new Error('문항 데이터를 찾지 못했습니다(QUESTIONS 배열 없음).');
  let questions;
  try {
    questions = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`문항 데이터 형식 오류: ${e.message}`);
  }
  const title = extractTitle(html);
  return { questions, lectureName: m[2], title };
}

function extractTitle(html) {
  const h1 = html.match(/<h1>([^<]*)<\/h1>/);
  if (h1) return h1[1].trim();
  const t = html.match(/<title>([^<]*)<\/title>/);
  return t ? t[1].trim() : '';
}

/**
 * 문항의 이미지 경로를 vault 기준 경로로 바꾼다.
 * HTML 안에서는 "../../attachments/foo.png"처럼 해당 html 파일 기준 상대경로다.
 */
export function imagePaths(q) {
  const raw = q.imgs && q.imgs.length ? q.imgs : q.img ? [q.img] : [];
  return raw.map((p) => p.replace(/^(\.\.\/)+/, ''));
}

/** 모의고사 파일명 → 사람이 읽는 제목. "1012_기본소생술BLS_모의고사.html" → "기본소생술BLS" */
export function prettyExamName(filename) {
  return filename
    .replace(/\.html$/, '')
    .replace(/_모의고사$/, '')
    .replace(/^\d{4}_/, '');
}

/** 모의고사 파일명 앞 4자리(MMDD) → "10/12". 없으면 빈 문자열. */
export function examDate(filename) {
  const m = filename.match(/^(\d{2})(\d{2})_/);
  return m ? `${m[1]}/${m[2]}` : '';
}

/** 모의고사 md의 frontmatter에서 연계노트(위키링크) 추출 — 위키 패널 폴백용. */
export function linkedNoteFromMd(md) {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(/연계노트:\s*"?\[\[([^\]]+)\]\]"?/);
  return m ? m[1] : null;
}
