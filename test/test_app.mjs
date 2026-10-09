// PWA 로직 테스트 — 브라우저 없이 실제 모듈(quiz.js/parser.js)을 DOM 스텁 위에서 돌린다.
// check_mock_exam_render.js가 쓰는 것과 같은 전략.
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
const VAULT = '/Users/hyunminkang/Documents/Medical_vault';

// ---------- DOM 스텁 ----------
function makeEl(id = '') {
  const el = {
    id, style: {}, dataset: {}, _children: [], _classes: new Set(), _text: '', _html: '',
    disabled: false, value: '',
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      toggle: (c, f) => { if (f === undefined) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); } else { f ? el._classes.add(c) : el._classes.delete(c); } },
      contains: (c) => el._classes.has(c),
    },
    appendChild(c) { el._children.push(c); return c; },
    prepend(c) { el._children.unshift(c); return c; },
    remove() {},
    focus() {},
    querySelectorAll: (sel) => el._children.filter((c) => c._classes.has(sel.replace('.', ''))),
    addEventListener() {},
    set innerHTML(v) { el._html = v; el._children = []; },
    get innerHTML() { return el._html; },
    set textContent(v) { el._text = String(v); },
    get textContent() { return el._text; },
  };
  return el;
}
const registry = {};
const ids = ['quizScreen','quizTitle','qnum','qsource','qtext','qimgContainer','optsContainer',
  'ox-row','explainBox','expExplain','memoBox','memoInput','scoreBadge','posLabel','prevBtn',
  'nextBtn','bookmarkBtn','memoBtn','resultBtn','backToListBtn'];
ids.forEach((i) => { registry[i] = makeEl(i); });
// ox-row는 ox-btn 자식 2개를 가져야 한다
const oxA = makeEl(); oxA.dataset.ox = '0'; oxA._classes.add('ox-btn');
const oxB = makeEl(); oxB.dataset.ox = '1'; oxB._classes.add('ox-btn');
registry['ox-row']._children = [oxA, oxB];
registry['ox-row'].querySelectorAll = () => [oxA, oxB];

global.document = {
  getElementById: (id) => registry[id] || (registry[id] = makeEl(id)),
  createElement: (t) => makeEl('new-' + t),
  // quiz.js가 pen.js의 tokenize()를 쓰면서 필요해졌다(지문을 단어 span으로 감싼다)
  createDocumentFragment: () => { const f = makeEl('frag'); f.isFrag = true; return f; },
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  // tokenizeTree()가 해설·노트 본문을 토큰화할 때 쓴다. 스텁에선 순회할 게 없으므로 빈 워커.
  createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener() {},
};
global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
global.window = { scrollTo() {}, addEventListener() {} };
global.indexedDB = undefined; // db.js의 saveSession 등은 try/catch로 삼켜짐
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;

// db.js / github.js는 브라우저 전용이라 가짜로 대체
const fakeMods = new Map([
  ['./db.js', { saveSession: async () => {}, loadSession: async () => null, clearSession: async () => {} }],
  ['./github.js', { getBlobUrl: async () => 'blob:fake' }],
]);

// ---------- 테스트 ----------
let pass = 0, fail = [];
function check(name, cond, detail) {
  if (cond) pass++; else fail.push(`${name}${detail ? ' — ' + detail : ''}`);
}

const { parseExamHtml, imagePaths, prettyExamName, examDate, linkedNoteFromMd } =
  await import(`${PWA}/js/parser.js`);

// --- parser: 실제 50개 시험 전부 ---
let parsed = 0, qTotal = 0, imgCount = 0;
for (const d of readdirSync(`${VAULT}/06_모의고사`)) {
  let files;
  try { files = readdirSync(`${VAULT}/06_모의고사/${d}`).filter((f) => f.endsWith('.html')); }
  catch { continue; }
  for (const f of files) {
    const html = readFileSync(`${VAULT}/06_모의고사/${d}/${f}`, 'utf8');
    try {
      const { questions, title } = parseExamHtml(html);
      parsed++; qTotal += questions.length;
      check(`${f}: 제목 있음`, !!title);
      for (const q of questions) {
        imgCount += imagePaths(q).length;
        // 이미지 경로가 vault 기준으로 변환되는지
        for (const p of imagePaths(q)) {
          check(`${f} #${q.num}: 이미지 경로 상대표기 제거`, !p.startsWith('..'), p);
          check(`${f} #${q.num}: attachments로 시작`, p.startsWith('attachments/'), p);
        }
      }
    } catch (e) { fail.push(`${d}/${f} 파싱: ${e.message}`); }
  }
}
check('50개 시험 전부 파싱', parsed === 50, `실제 ${parsed}`);
console.log(`  파싱: 시험 ${parsed}개 · 문항 ${qTotal}개 · 이미지 ${imgCount}장`);

// --- parser: 파일명 유틸 ---
check('prettyExamName', prettyExamName('1012_기본소생술BLS_모의고사.html') === '기본소생술BLS',
  prettyExamName('1012_기본소생술BLS_모의고사.html'));
check('examDate', examDate('1012_기본소생술BLS_모의고사.html') === '10/12');
check('examDate(없음)', examDate('foo.html') === '');
const mdSample = readFileSync(`${VAULT}/06_모의고사/응급_중환자/1012_기본소생술BLS_모의고사.md`, 'utf8');
check('linkedNoteFromMd', linkedNoteFromMd(mdSample) === '1012_응급중환자_기본소생술BLS',
  String(linkedNoteFromMd(mdSample)));

// --- quiz: 실제 문항으로 풀이 시뮬레이션 ---
// quiz.js는 db.js/github.js를 import하므로, loader hook 대신 소스를 치환해서 로드한다.
// quiz.js는 브라우저 전용 모듈(db.js/github.js)을 import하므로, 그 두 줄만 스텁으로 바꾼
// 복사본을 같은 폴더에 써서 로드한다(parser.js는 상대경로 그대로 해결되게).
const quizSrc = readFileSync(`${PWA}/js/quiz.js`, 'utf8')
  .replace("import { getBlobUrl } from './github.js';", 'const getBlobUrl = async () => "blob:fake";')
  .replace("import { saveSession, loadSession, clearSession } from './db.js';",
    'const saveSession=async()=>{},loadSession=async()=>null,clearSession=async()=>{};');
const shimPath = `${PWA}/js/__test_quiz_shim.mjs`;
writeFileSync(shimPath, quizSrc);
let Quiz;
try {
  ({ Quiz } = await import(pathToFileURL(shimPath).href));
} finally {
  rmSync(shimPath, { force: true });
}

const examHtml = readFileSync(`${VAULT}/06_모의고사/응급_중환자/1015_전문심장소생술ACLS_모의고사.html`, 'utf8');
const { questions } = parseExamHtml(examHtml);

let finished = null;
const q = new Quiz({
  examKey: 'test', questions, title: 'ACLS',
  onFinish: (r) => { finished = r; }, onExit: () => {},
});
q.start();

check('첫 문항 렌더: 번호 표시', registry.qnum.textContent.startsWith('문제 1'), registry.qnum.textContent);
// 지문은 이제 단어 단위 <span class="tok">으로 들어간다(올가미 hit-test용) —
// 스텁에선 프래그먼트 자식으로 쌓이므로 그걸 다시 이어붙여 원문과 대조한다.
const qtextJoined = (registry.qtext._children[0]?._children || [])
  .map((c) => c.textContent || '')
  .join('');
check('첫 문항 렌더: 지문 표시', qtextJoined === questions[0].q,
  `"${qtextJoined.slice(0, 40)}…"`);
check('첫 문항 렌더: 단어가 tok span으로 감싸짐',
  (registry.qtext._children[0]?._children || []).some((c) => c.className === 'tok'));
check('출처 표시(풀기 전부터)', registry.qsource.textContent.startsWith('📚'), registry.qsource.textContent);
check('5지선다 렌더', registry.optsContainer._children.length === questions[0].opts.length,
  `${registry.optsContainer._children.length}개`);
check('진행 표시', registry.posLabel.textContent === `1/${questions.length}`);

// 전부 정답으로 풀기
for (let i = 0; i < questions.length; i++) {
  q.cur = i; q.render();
  q.select(questions[i].ans);
}
check('전부 정답 → 점수', registry.scoreBadge.textContent === `${questions.length}/${questions.length}`,
  registry.scoreBadge.textContent);
check('정답 후 해설 노출', registry.explainBox.style.display === 'block');

q.finish();
check('결과 집계: 정답수', finished && finished.correct === questions.length);
check('결과 집계: 오답 0', finished && finished.wrong.length === 0);

// 전부 오답으로 풀기
const q2 = new Quiz({ examKey: 't2', questions, title: 'ACLS', onFinish: (r) => { finished = r; }, onExit: () => {} });
q2.start();
for (let i = 0; i < questions.length; i++) {
  q2.cur = i; q2.render();
  const wrongPick = (questions[i].ans + 1) % questions[i].opts.length;
  q2.select(wrongPick);
}
q2.finish();
check('전부 오답: correct 0', finished.correct === 0, `${finished.correct}`);
check('전부 오답: wrong = 전체', finished.wrong.length === questions.length);

// ★ 한 문항만 다시 풀기 — 선지를 잘못 눌렀을 때(2026-10-09 추가)
{
  const q4 = new Quiz({ examKey: 't4', questions, title: 'T', onFinish: () => {}, onExit: () => {} });
  q4.start();
  const wrongPick = (questions[0].ans + 1) % questions[0].opts.length;
  q4.select(wrongPick);
  check('잘못 고른 뒤 답이 기록됨', q4.answers[0] === wrongPick);
  check('오답으로 잠김', !q4.isCorrect(0));
  q4.resetOne();
  check('resetOne: 답이 비워짐', q4.answers[0] === null);
  check('resetOne: 제거선지도 초기화', q4.eliminated[0].size === 0);
  q4.select(questions[0].ans);
  check('resetOne 후 다시 고를 수 있음', q4.isCorrect(0));
  // 다른 문항은 건드리지 않는다
  q4.cur = 1; q4.render();
  q4.select(questions[1].ans);
  q4.cur = 0; q4.render();
  q4.resetOne();
  check('resetOne은 현재 문항만', q4.answers[1] !== null && q4.answers[0] === null);
}

// 틀린 문제 재시도
const ok = q2.retryWrong();
check('retryWrong 동작', ok === true);
check('retryWrong: 순회 대상이 오답만', q2.order.length === questions.length);
check('retryWrong: 답안 비워짐', q2.order.every((i) => q2.answers[i] === null));

// OX 경로 — 현재 vault 392문항은 전부 'mc'라 실데이터가 없다(확인함).
// 템플릿은 OX를 지원하므로(05_퀴즈가 쓸 수 있음) 합성 문항으로 코드 경로만 검증한다.
{
  const oxQs = [
    { num: 1, type: 'ox', q: '가슴압박 깊이는 5~6cm다.', opts: ['O', 'X'], ans: 0, explain: '맞다.', opt: null },
    { num: 2, type: 'ox', q: '영아에게 복부 밀어내기를 한다.', opts: ['O', 'X'], ans: 1, explain: '금기다.', opt: null },
  ];
  const q3 = new Quiz({ examKey: 't3', questions: oxQs, title: 'ox', onFinish: () => {}, onExit: () => {} });
  q3.start();
  check('OX: 번호에 (O/X) 표기', registry.qnum.textContent.includes('(O/X)'), registry.qnum.textContent);
  check('OX: ox-row 노출', !registry['ox-row']._classes.has('hidden'));
  check('OX: 선지 컨테이너 숨김', registry.optsContainer.style.display === 'none');
  q3.select(0);
  check('OX: 정답 처리', q3.isCorrect(0));
  check('OX: 정답 버튼에 correct', oxA._classes.has('correct'));
  q3.cur = 1; q3.render();
  q3.select(0); // 오답
  check('OX: 오답 처리', !q3.isCorrect(1));
  check('OX: 오답 버튼에 wrong', oxA._classes.has('wrong'));
  check('OX: 정답 버튼에 correct(2번)', oxB._classes.has('correct'));
  const r3 = q3.results();
  check('OX: 집계 1/2', r3.correct === 1 && r3.total === 2, `${r3.correct}/${r3.total}`);
}

// ---------- 결과 ----------
console.log(`\n통과 ${pass}건`);
if (fail.length) {
  console.log(`실패 ${fail.length}건:`);
  fail.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('✅ 전부 통과');
}
