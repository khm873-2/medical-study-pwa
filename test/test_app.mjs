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
    appendChild(c) { el._children.push(c); c.parentNode = el; return c; },
    prepend(c) { el._children.unshift(c); c.parentNode = el; return c; },
    closest: () => null,
    parentNode: null,
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
// _renderInlineNext가 memoBox의 부모(카드)에 버튼 바를 붙인다
registry.memoBox.parentNode = makeEl('qcard');
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

// ---------- vault 파일 이름 길이 ----------
//
// 2026-10-15에 실제로 데이터를 잃을 뻔했다: 강의 제목을 그대로 넣은 긴 이름을
// 맥의 문서 동기화가 제멋대로 줄여버려서, 같은 날 올린 6개 파일의 끝 네 글자가
// ` 2`·`ᄆ` 따위로 바뀌고 `_모아두기`가 통째로 날아갔다. 이름이 뭉개지면 git은
// "지워졌다"고 보고, 서로 이름이 겹치면 **덮어쓴다**. 그래서 길이를 검사로 묶는다.
{
  const src = readFileSync(`${PWA}/js/app.js`, 'utf8');
  const m = src.match(/const NAME_BYTES[\s\S]*?\n}\n/);
  check('app.js에 vaultName이 있다', !!m);
  if (m) {
    // eslint-disable-next-line no-eval
    const vaultName = eval(`(() => { ${m[0]} return vaultName; })()`);
    const bytes = (s) => Buffer.byteLength(s, 'utf8');
    const cases = [
      ['응급_중환자', '26-10-14', '응급_중환자 — 소아기본소생술(PBLS) 및 이물질 기도폐쇄 (차민수 교수)', '모아두기'],
      ['응급_중환자', '26-10-14', '응급중환자_소아기본소생술PBLS및이물질기도폐쇄 — 암기법 후보', '채택'],
      ['응급_중환자', '26-10-14', '소아기본소생술PBLS및이물질기도폐쇄', '모의고사풀이'],
      ['두경부_피부', '26-10-14', '두경부피부 — 구진비늘모반종양색소이상증피부노화 (아주 긴 제목이 들어와도)', '모아두기'],
      ['', '26-10-15', '', '모아두기'],
    ];
    let worst = 0;
    for (const c of cases) {
      const n = vaultName(...c);
      worst = Math.max(worst, bytes(n));
      check(`이름이 100바이트 안: ${n}`, bytes(n) <= 100, `${bytes(n)}B`);
      check(`종류가 이름에 남는다: ${n}`, n.endsWith(`_${c[3]}.md`));
      check(`이음표로 끝나지 않는다: ${n}`, !/[_\-—·]_/.test(n.replace(`_${c[3]}.md`, '_')));
    }
    check('가장 긴 이름도 90바이트 이하', worst <= 90, `${worst}B`);
    // 제목이 과목으로 시작하면 한 번만 적는다 — 전에는 "응급_중환자"가 두 번 들어갔다
    const dup = vaultName('응급_중환자', '26-10-14', '응급_중환자 — 환경의학 (송명제 교수)', '모아두기');
    check('과목을 두 번 적지 않는다', dup.split('응급_중환자').length - 1 === 1, dup);
    check('빈 제목도 이름이 된다', vaultName('', '26-10-15', '', '모아두기') === '26-10-15_메모_모아두기.md');
  }
  // 세 저장 경로가 전부 이 함수를 쓰는지 — 하나라도 빠지면 그 경로만 다시 길어진다
  for (const kind of ['모아두기', '채택', '모의고사풀이']) {
    check(`${kind} 경로가 vaultName을 쓴다`,
      new RegExp(`vaultName\\([\\s\\S]{0,160}?'${kind}'\\)`).test(src));
  }
  // 이름에 **시각**이 들어가야 같은 날 두 번 모아도 안 부딪힌다 (2026-10-15:
  // "저장 실패 — 같은 이름의 파일이 너무 많습니다"로 떨어졌다)
  for (const kind of ['모아두기', '채택', '모의고사풀이']) {
    const m = src.match(new RegExp(`vaultName\\(([\\s\\S]{0,160}?)'${kind}'\\)`));
    check(`${kind} 이름에 시각이 들어간다`, !!m && /getHours\(\)|\$\{hh\}/.test(m[1]),
      m ? m[1].slice(0, 70) : '없음');
  }
  check('옛 slice(0, 40) 방식이 남아있지 않다', !/slug\s*=\s*\(ctx\.title/.test(src));
}

// ---------- 오늘 탭: 시험을 강의에 붙이기 ----------
// 2026-10-15: "퀴즈가 두개나 있고 누르니까 다른강의가 나옴".
// 임상독성학총론 ↔ 임상독성학각론은 이름이 0.67만큼 닮아서, 강의마다 "닮은 시험"을
// 긁어모으던 옛 방식에서는 두 줄이 서로의 퀴즈까지 집어갔다.
{
  const src = readFileSync(`${PWA}/js/app.js`, 'utf8');
  const { nameSimilarity } = await import(`${PWA}/js/wiki.js`);
  const { examSortKey } = await import(`${PWA}/js/parser.js`);

  const fn = src.match(/const SAME_SIM[\s\S]*?\n}\n/);
  check('app.js에 assignExams가 있다', !!fn);
  check('강의마다 긁어모으던 옛 함수는 없앴다', !/function examsForLecture/.test(src));
  if (fn) {
    // eslint-disable-next-line no-eval
    const assignExams = eval(
      `(() => { ${fn[0]} return assignExams; })()`,
    );
    const quiz = (file) => ({ file, path: `05_퀴즈/응급_중환자/${file}` });
    const index = [
      // 임상독성학 모의고사는 총론·각론을 한 파일로 묶은 실제 파일이다
      { kind: '모의고사', subject: '응급_중환자', exams: [
        quiz('1013_임상독성학_모의고사.html'),
        quiz('1013_소아기본소생술PBLS_모의고사.html'),
      ] },
      { kind: '퀴즈', subject: '응급_중환자', exams: [
        quiz('261013_윤성현_임상독성학총론_퀴즈.html'),
        quiz('261013_윤성현_임상독성학각론_퀴즈.html'),
        quiz('261013_차민수_소아기본소생술PBLS이물질기도폐쇄_퀴즈.html'),
      ] },
      { kind: '족보', subject: '응급_중환자', exams: [quiz('06_임상독성학총론.md')] },
    ];
    const lectures = [
      { name: '소아기본소생술(PBLS), 이물질 기도폐쇄' },
      { name: '임상독성학총론' },
      { name: '임상독성학각론' },
    ];
    const got = assignExams(index, lectures, '261013');
    const names = (i) => (got.get(i) || []).map(({ ex }) => ex.file);

    check('총론 줄에 퀴즈는 하나', names(1).filter((f) => f.includes('퀴즈')).length === 1,
      names(1).join(', '));
    check('총론 줄의 퀴즈는 총론 것', names(1).some((f) => f.includes('총론_퀴즈')));
    check('각론 줄의 퀴즈는 각론 것',
      names(2).filter((f) => f.includes('퀴즈')).join() === '261013_윤성현_임상독성학각론_퀴즈.html',
      names(2).join(', '));
    check('PBLS 줄은 제 퀴즈만',
      names(0).filter((f) => f.includes('퀴즈')).join()
        === '261013_차민수_소아기본소생술PBLS이물질기도폐쇄_퀴즈.html', names(0).join(', '));
    check('모의고사가 퀴즈보다 앞', names(1)[0].includes('모의고사'), names(1).join(', '));
    check('족보는 날짜로 붙지 않는다', ![...got.values()].flat().some(({ g }) => g.kind === '족보'));
    // 두 시간을 묶은 모의고사는 양쪽에 남는다 — 퀴즈처럼 한 줄로 몰면 한 줄이 빈다
    check('총론·각론 둘 다 모의고사가 있다',
      names(1).some((f) => f.includes('임상독성학_모의고사'))
      && names(2).some((f) => f.includes('임상독성학_모의고사')));
    check('퀴즈는 겹치지 않는다',
      [...got.values()].flat().filter(({ ex }) => ex.file.includes('퀴즈')).length === 3);
    check('다른 날 시험은 안 붙는다', assignExams(index, lectures, '261014').size === 0);
  }

  // 파일 안 제목이 딴 강의를 가리키면 안 쓴다 — vault 퀴즈 8개의 <h1>이 실제로 그랬다
  const tf = src.match(/const TITLE_FIT[\s\S]*?\n}\n/);
  check('app.js에 examTitle이 있다', !!tf);
  if (tf) {
    // eslint-disable-next-line no-eval
    const examTitle = eval(`(() => { ${tf[0]} return examTitle; })()`);
    const pbls = '소아기본소생술 PBLS 및 이물질 기도폐쇄 (차민수)';
    check('머리말이 딴 강의면 다음 후보로',
      examTitle({ titles: [pbls, '임상독성학 각론 퀴즈 — 윤성현 교수', '임상독성학각론'],
        lectureName: '임상독성학각론' }, '임상독성학각론') === '임상독성학 각론 퀴즈 — 윤성현 교수');
    check('전부 딴소리면 파일 이름',
      examTitle({ titles: [pbls], lectureName: '임상독성학각론' }, '임상독성학각론') === '임상독성학각론');
    check('닮은 머리말은 그대로 쓴다',
      examTitle({ titles: ['기본소생술(BLS) 모의고사'], lectureName: '기본소생술BLS' }, '기본소생술BLS')
        === '기본소생술(BLS) 모의고사');
    // 기준 둘이 서로 다른 걸 흘린다 — 하나만 보면 멀쩡한 제목이 버려진다
    check('강의명에 과목이 붙어 있어도 제목을 지킨다',
      examTitle({ titles: ['골관절염 퀴즈 — 채동식 교수 (2026-09-14)'], lectureName: '근골격계 골관절염' },
        '골관절염') === '골관절염 퀴즈 — 채동식 교수 (2026-09-14)');
    check('강의명이 없으면 파일 이름이 기준',
      examTitle({ titles: ['중이염 모의고사'] }, '두경부피부_중이염') === '중이염 모의고사');
    check('후보가 없으면 파일 이름', examTitle({ titles: [] }, '임상독성학각론') === '임상독성학각론');
    check('족보처럼 title 하나만 와도 된다',
      examTitle({ title: '중이염 모의고사' }, '중이염') === '중이염 모의고사');

    // 실제 vault 파일로 끝까지 — 128개 전부 제 머리말이 살아남아야 한다
    const roots = [`${VAULT}/05_퀴즈`, `${VAULT}/06_모의고사`];
    let seen = 0;
    let dropped = 0;
    for (const root of roots) {
      let subs = [];
      try { subs = readdirSync(root); } catch { continue; }     // vault 없는 환경
      for (const sub of subs) {
        let files = [];
        try { files = readdirSync(`${root}/${sub}`); } catch { continue; }
        for (const raw of files) {
          if (!raw.endsWith('.html')) continue;
          const file = raw.normalize('NFC');
          let parsed;
          try { parsed = parseExamHtml(readFileSync(`${root}/${sub}/${raw}`, 'utf8')); } catch { continue; }
          seen++;
          const t = examTitle(parsed, prettyExamName(file));
          if (t !== (parsed.titles[0] || prettyExamName(file))) {
            dropped++;
            check(`제 머리말이 버려졌다: ${file}`, false, t);
          }
          // 베껴온 PBLS 머리말이 되살아나면 바로 잡는다
          if (/소아기본소생술/.test(t)) {
            check(`PBLS 머리말이 남의 파일에: ${file}`, /소아기본소생술/.test(parsed.lectureName || file));
          }
        }
      }
    }
    if (seen) check(`vault 시험 ${seen}개 모두 제 제목을 쓴다`, dropped === 0, `${dropped}개 버려짐`);

    // 머리말을 다시 베껴 넣으면 걸러내는지 — 고친 파일이 또 틀어졌을 때의 안전망
    const 각론 = `${VAULT}/05_퀴즈/응급_중환자/261013_윤성현_임상독성학각론_퀴즈.html`;
    let html = null;
    try { html = readFileSync(각론, 'utf8'); } catch { /* vault 없는 환경 */ }
    if (html) {
      const t = examTitle(parseExamHtml(html), prettyExamName('261013_윤성현_임상독성학각론_퀴즈.html'));
      check(`각론 퀴즈 머리줄 — ${t}`, t.includes('각론') && !t.includes('소아기본소생술'));
      const broken = html.replace(/<h1>[^<]*<\/h1>/, `<h1>${pbls}</h1>`);
      const t2 = examTitle(parseExamHtml(broken), prettyExamName('261013_윤성현_임상독성학각론_퀴즈.html'));
      check(`머리말을 다시 베껴 넣어도 걸러낸다 — ${t2}`, !t2.includes('소아기본소생술'));
    }
  }
}

// ---------- 새로 올라온 노트도 열린다 (2026-10-15) ----------
// "오늘치 실강노트 안들어가지는데" — 오늘 탭은 화면을 그릴 때 받아둔 노트 목록을
// 칩마다 물려준다. 그 목록이 **맥에서 실강노트를 올리기 전**에 캐시됐으면,
// 목록을 쥐여줬다는 이유로 재조회를 건너뛰어 영영 안 열렸다.
{
  const src = readFileSync(`${PWA}/js/app.js`, 'utf8');
  const fn = src.match(/async function openNoteByName[\s\S]*?\n}\n/);
  check('app.js에 openNoteByName이 있다', !!fn);
  if (fn) {
    const body = fn[0];
    check('못 찾으면 목록을 새로 받아 다시 본다', /noteList\(true\)/.test(body));
    check('**목록을 쥐여줘도 재조회를 건너뛰지 않는다**',
      !/if \(!hit && !given/.test(body),
      (body.match(/if \(!hit[^)]*\)/) || [''])[0]);
    check('재조회 조건은 "못 찾았고 아직 강제 조회 전"뿐',
      /if \(!hit && !force\)/.test(body));
    check('새로 받은 목록을 오늘 탭 것과 바꿔둔다(다음 칩도 열리게)',
      /given\.push\(\.\.\.groups\)/.test(body));
  }
  // 오늘 탭이 실제로 목록을 물려주는지 — 이게 사라지면 위 보호장치가 의미를 잃는다
  check('오늘 탭의 실강노트 칩이 openNoteByName을 쓴다',
    /chip\('📗 실강노트', \(\) => openNoteByName\(l\.wiki/.test(src));
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
