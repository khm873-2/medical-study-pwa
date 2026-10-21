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
// 모의고사는 계속 늘어난다 — 숫자를 박아두면 새 파일이 생길 때마다 빨개진다.
// 중요한 건 "있는 것을 다 읽었나"이고, 그건 아래 '시험이 전부 열린다'가 본다.
check('모의고사를 모두 파싱한다', parsed >= 50, `${parsed}개`);
console.log(`  파싱: 시험 ${parsed}개 · 문항 ${qTotal}개 · 이미지 ${imgCount}장`);

// --- 문제 그림이 **실제로 있는 파일**을 가리키는가 (2026-10-19 신고) ---
// "퀴즈 풀 때 왜 이미지 못불러옴?" — 옆 노트에선 같은 그림이 멀쩡히 보이는데 문항에서만
// 안 떴다. 퀴즈 HTML 45건이 폴더 없이 **이름만** 적어뒀고(`"img": "응급중환자….png"`),
// 그러면 저장소 꼭대기에서 찾다 못 찾는다. 경로를 만드는 것만 보면 안 된다 —
// **그 자리에 파일이 있는지**까지 봐야 이런 게 걸린다.
{
  const have = new Set();
  try {
    for (const f of readdirSync(`${VAULT}/attachments`)) have.add(f.normalize('NFC'));
  } catch { /* 첨부 폴더가 없으면 아래에서 걸린다 */ }
  check('vault에 그림 보관함이 있다', have.size > 0, `${have.size}개`);
  let seen = 0;
  const missing = [];
  for (const root of ['06_모의고사', '05_퀴즈']) {
    let dirs;
    try { dirs = readdirSync(`${VAULT}/${root}`); } catch { continue; }
    for (const d of dirs) {
      let files;
      try { files = readdirSync(`${VAULT}/${root}/${d}`).filter((f) => f.endsWith('.html')); }
      catch { continue; }
      for (const f of files) {
        let qs;
        try { qs = parseExamHtml(readFileSync(`${VAULT}/${root}/${d}/${f}`, 'utf8')).questions; }
        catch { continue; }
        for (const q of qs) {
          for (const p of imagePaths(q)) {
            seen++;
            if (!p.startsWith('attachments/')) { missing.push(`${f} #${q.num}: 경로가 이상 — ${p}`); continue; }
            if (!have.has(p.slice('attachments/'.length))) missing.push(`${f} #${q.num}: 없음 — ${p}`);
          }
        }
      }
    }
  }
  check('**문제 그림이 전부 실제 파일을 가리킨다**', missing.length === 0,
    `${missing.length}/${seen}장 어긋남 — ${missing.slice(0, 3).join(' / ')}`);
  console.log(`  문제 그림 ${seen}장 — vault에서 전부 찾음${missing.length ? ` (못 찾음 ${missing.length})` : ''}`);
}

// --- 모든 시험이 **실제로 열리는가** (2026-10-21 신고) ---
// "CRRT 퀴즈 안 들어가짐" — 그 파일은 `function wr(h){...}` 도우미를 만들어
// `wikiRefs: wr(H1)` 로 쓴다. 배열만 떼어 평가하니 "wr is not defined"로 통째로
// 실패했고, 앱에는 "문항 데이터를 찾지 못했습니다"로 떠서 퀴즈가 안 열렸다.
// ⚠️ 50개만 세던 옛 검사로는 못 잡는다 — **있는 시험을 전부** 열어본다.
{
  let opened = 0;
  const broken = [];
  for (const root of ['05_퀴즈', '06_모의고사']) {
    let dirs;
    try { dirs = readdirSync(`${VAULT}/${root}`); } catch { continue; }
    for (const d of dirs) {
      let files;
      try { files = readdirSync(`${VAULT}/${root}/${d}`); } catch { continue; }
      for (const f of files.filter((x) => x.endsWith('.html'))) {
        try {
          const r = parseExamHtml(readFileSync(`${VAULT}/${root}/${d}/${f}`, 'utf8'));
          if (r.questions.length) opened++;
          else broken.push(`${f}: 문항 0개`);
        } catch (e) { broken.push(`${f}: ${String(e.message).slice(0, 40)}`); }
      }
    }
  }
  check('**vault의 시험이 전부 열린다**', broken.length === 0,
    `${broken.length}개 못 열림 — ${broken.slice(0, 3).join(' / ')}`);
  console.log(`  시험 ${opened}개 — 전부 열림${broken.length ? ` (못 열림 ${broken.length})` : ''}`);

  // 도우미를 쓰는 꼴을 손으로 만들어서도 확인한다(vault가 바뀌어도 이 길은 지킨다)
  const withHelper = [
    '<script>',
    'const NOTE = "응급중환자_테스트";',
    'const H1 = "1. 첫 장";',
    'function wr(h){return [{note:NOTE, heading:h}];}',
    'const QUESTIONS = [',
    ' {num:1,type:"mc",q:"물음?",opts:["가","나"],ans:1,explain:"해설",wikiRefs:wr(H1)}',
    '];',
    '</script>',
  ].join('\n');
  let got = null;
  try { got = parseExamHtml(withHelper).questions; } catch { /* 아래에서 걸린다 */ }
  check('**도우미(wr·H1)를 쓰는 파일도 읽는다**', !!got && got.length === 1,
    got ? `${got.length}문항` : '못 읽음');
  check('도우미가 만든 wikiRefs도 살아 있다',
    !!got && got[0].wikiRefs && got[0].wikiRefs[0].heading === '1. 첫 장',
    got && got[0].wikiRefs ? JSON.stringify(got[0].wikiRefs[0]) : '없음');
}

// --- 모든 퀴즈·모의고사가 **연계노트를 찾을 수 있는가** (2026-10-20 신고) ---
// "PALS는 왜 퀴즈 푸는데 연계노트가 지정돼 있지 않다고 나옴?"
// 짝 md의 `연계노트: "[[...]]"`가 빠져 있으면 옆칸이 통째로 쓸모없어진다.
// vault를 세어 보니 퀴즈 4개가 그 꼴이었다 — 적어줄 때 빠뜨린 것이다.
// ⚠️ 앞머리만 보면 안 된다. 적힌 **그 노트가 실제로 있는지**까지 봐야 한다.
{
  const notes = new Set();
  for (const root of ['02_Wiki', '98_예습노트_보관']) {
    let subs;
    try { subs = readdirSync(`${VAULT}/${root}`); } catch { continue; }
    for (const d of subs) {
      let files;
      try { files = readdirSync(`${VAULT}/${root}/${d}`); } catch { continue; }
      for (const f of files) if (f.endsWith('.md')) notes.add(f.slice(0, -3).normalize('NFC'));
    }
  }
  check('vault에서 노트 이름을 읽었다', notes.size > 50, `${notes.size}개`);

  const bad = [];
  let seen = 0;
  for (const root of ['05_퀴즈', '06_모의고사']) {
    let dirs;
    try { dirs = readdirSync(`${VAULT}/${root}`); } catch { continue; }
    for (const d of dirs) {
      let files;
      try { files = readdirSync(`${VAULT}/${root}/${d}`); } catch { continue; }
      for (const f of files) {
        // 실제 시험만 본다 — 목록·기록 파일(_로 시작)은 시험이 아니다
        if (!f.endsWith('.md') || f.startsWith('_')) continue;
        if (!files.includes(f.replace(/\.md$/, '.html'))) continue;   // 풀이용 html이 있어야 시험
        seen++;
        const md = readFileSync(`${VAULT}/${root}/${d}/${f}`, 'utf8');
        const name = linkedNoteFromMd(md);
        if (!name) { bad.push(`${f}: 연계노트가 안 적혀 있음`); continue; }
        if (!notes.has(name.normalize('NFC'))) bad.push(`${f}: 가리키는 노트가 없음 — ${name}`);
      }
    }
  }
  check('**퀴즈·모의고사가 전부 연계노트를 가리킨다**', bad.length === 0,
    `${bad.length}/${seen}개 어긋남 — ${bad.slice(0, 3).join(' / ')}`);
  console.log(`  시험 ${seen}개 — 연계노트 전부 확인${bad.length ? ` (어긋남 ${bad.length})` : ''}`);
}

// --- 흐름도(mermaid): 앱과 vault 스크립트가 **같은 이름**을 부르는가 (2026-10-19) ---
// 맥에서 그린 그림을 앱이 찾으려면 이름 짓는 셈이 두 군데에서 똑같아야 한다.
// 한쪽만 고치면 그림을 영영 못 찾는데, 화면에는 코드가 그대로 보일 뿐이라 알아채기 어렵다.
{
  const { mermaidName, renderMarkdown } = await import(`${PWA}/js/markdown.js`);
  const SRC = 'flowchart TD\n  A[출생] --> B{만삭인가?}\n  B -->|예| C[일반 처치]';
  check('흐름도 이름이 attachments 밑 .mermaid로 간다',
    mermaidName(SRC).startsWith('.mermaid/m') && mermaidName(SRC).endsWith('.png'),
    mermaidName(SRC));
  check('같은 글이면 같은 이름', mermaidName(SRC) === mermaidName(SRC + ''));
  check('글이 달라지면 이름도 달라진다(고치면 다시 그려지게)',
    mermaidName(SRC) !== mermaidName(SRC + '\n  C --> D[관찰]'));
  check('앞뒤 빈 줄은 무시한다', mermaidName(SRC) === mermaidName(`\n${SRC}\n\n`));

  // vault 쪽 스크립트의 같은 함수를 **그대로 떼어다** 돌려 본다
  let vaultName = null;
  try {
    const src = readFileSync(`${VAULT}/.claude/scripts/render-mermaid.mjs`, 'utf8');
    const m = src.match(/export function mermaidName\(src\) \{[\s\S]*?\n\}/);
    if (m) vaultName = new Function(`${m[0].replace('export ', '')}; return mermaidName;`)();
  } catch { /* 아래에서 걸린다 */ }
  check('vault에 흐름도 그리는 스크립트가 있다', !!vaultName);
  if (vaultName) {
    check('**앱과 vault가 같은 이름을 부른다**', vaultName(SRC) === mermaidName(SRC),
      `vault ${vaultName(SRC)} / 앱 ${mermaidName(SRC)}`);
    check('긴 글에서도 같다',
      vaultName(SRC.repeat(20)) === mermaidName(SRC.repeat(20)));
  }

  // 흐름도가 **한눈에 들어오는 크기인가**를 재는 셈(2026-10-20)
  {
    let shapeOf = null, MAXD = 7, MAXN = 10;
    try {
      const src = readFileSync(`${VAULT}/.claude/scripts/render-mermaid.mjs`, 'utf8');
      const m = src.match(/export function shapeOf\(src\) \{[\s\S]*?\n\}/);
      if (m) shapeOf = new Function(`${m[0].replace('export ', '')}; return shapeOf;`)();
      const d = src.match(/MAX_DEPTH = (\d+)/); if (d) MAXD = Number(d[1]);
      const n = src.match(/MAX_NODES = (\d+)/); if (n) MAXN = Number(n[1]);
    } catch { /* 아래에서 걸린다 */ }
    check('흐름도 크기를 재는 셈이 있다', !!shapeOf);
    if (shapeOf) {
      // 마디 한도는 느슨하다 — 분기 트리는 원래 마디가 많고 **옆으로** 퍼진다.
      // 세로 길이를 정하는 건 깊이다(2026-10-20에 18장 재어 고친 기준).
      check('깊이 한도가 7단계', MAXD === 7, `${MAXD}단계`);
      check('마디 한도는 느슨하게(옆으로 퍼지는 건 괜찮다)', MAXN >= 14, `${MAXN}개`);
      const chain = 'flowchart TD\n' + 'ABCDEFGHIJKLM'.split('').slice(0, 12)
        .map((c, i, a) => (i < a.length - 1 ? `  ${c} --> ${a[i + 1]}` : '')).filter(Boolean).join('\n');
      const deep = shapeOf(chain);
      check('**긴 사슬의 깊이를 잰다**', deep.depth === 12 && deep.nodes === 12,
        `마디 ${deep.nodes} 깊이 ${deep.depth}`);
      check('깊은 것을 깊다고 본다', deep.depth > MAXD, `깊이 ${deep.depth} > ${MAXD}`);
      // 다 그린 그림 높이가 진짜 잣대다 — 그 한도도 있는지 본다
      {
        const src = readFileSync(`${VAULT}/.claude/scripts/render-mermaid.mjs`, 'utf8');
        check('**그린 뒤 높이도 잰다**(진짜 잣대)',
          /MAX_PX\s*=\s*\d{4}/.test(src) && /pngTall/.test(src),
          (src.match(/MAX_PX = \d+/) || ['없음'])[0]);
      }
      const wide = shapeOf('flowchart TD\n  A --> B\n  A --> C\n  A --> D\n  B --> E\n  C --> E\n  D --> E');
      check('**넓게 편 것은 깊이가 얕다**(마디가 같아도)', wide.depth === 3 && wide.nodes === 5,
        `마디 ${wide.nodes} 깊이 ${wide.depth}`);
      check('넓은 것은 한도 안', wide.depth <= MAXD && wide.nodes <= MAXN);
      check('가지 글(-->|예|)이 깊이를 안 늘린다',
        shapeOf('flowchart TD\n  A -->|"예"| B\n  B -->|"아니오"| C').depth === 3);
      check('점선(-.->)은 곁다리라 깊이로 안 센다',
        shapeOf('flowchart TD\n  A --> B\n  B -.-> Z').depth === 2);
      check('classDef·class 줄은 마디로 안 센다',
        shapeOf('flowchart TD\n  A --> B\n  classDef x fill:#fff\n  class A,B x').nodes === 2);
      check('되돌아오는 고리가 있어도 안 멈춘다',
        shapeOf('flowchart TD\n  A --> B\n  B --> C\n  C --> A').depth >= 3);
    }
  }

  // 글을 그릴 때 코드 덩어리가 아니라 **그림 자리**가 나와야 한다
  const html = renderMarkdown('# 제목\n\n```mermaid\n' + SRC + '\n```\n\n뒷글\n');
  check('**흐름도가 그림으로 들어간다**(코드 덩어리로 안 쏟아진다)',
    /<img[^>]+data-mmd="1"/.test(html), html.slice(0, 160));
  check('그림이 없을 때 쓸 코드도 같이 남는다', /class="mmd-src"/.test(html));
  check('**왜 코드가 보이는지 적어준다**(안 그러면 버그로 보인다)',
    /mmd-why/.test(html) && /render-mermaid/.test(html));
  check('뒷글이 흐름도에 안 먹힌다', /뒷글/.test(html));
  check('mermaid가 아닌 코드는 그냥 코드로',
    /<pre><code>/.test(renderMarkdown('```js\nlet a = 1;\n```\n')));
  check('울타리 안의 #는 제목이 아니다',
    !/<h\d/.test(renderMarkdown('```\n# 샾으로 시작하는 줄\n```\n')));
}

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
  .replace(/import \{[^}]*\} from '\.\/github\.js';/, 'const getBlobUrl = async () => "blob:fake";')
  // quiz.js가 db.js에서 가져오는 이름이 늘어났는데(recordAttempt·markUnsure) 가짜가
  // 세 개뿐이라 모자랐다 — 지금 import에 적힌 이름을 **그대로 읽어** 다 만들어준다.
  .replace(/import \{([^}]*)\} from '\.\/db\.js';/, (_m, names) => names.split(',')
    .map((n) => n.trim()).filter(Boolean)
    .map((n) => `const ${n}=async()=>(${n === 'loadSession' ? 'null' : 'undefined'});`).join(''));
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
          // ⚠️ "머리말을 그대로 쓰는가"를 묻지 않는다 — 머리말이 베껴온 것이면
          //    **버리는 게 맞다**. vault에 그런 파일이 계속 생기므로(새로 만들 때 앞
          //    파일을 복사한다) 그걸 실패로 세면 안전장치가 일할 때마다 빨간불이 된다.
          //    물을 것은 "나온 제목이 그 강의와 맞느냐"다.
          // examTitle과 **같은 기준 둘**로 본다(강의명·파일 이름). 하나만 보면,
          // 강의명에 과목이 붙은 파일("근골격계 골관절염")에서 멀쩡한 제목이 걸린다.
          const anchors = [(parsed.lectureName || '').trim(), prettyExamName(file)].filter(Boolean);
          if (!anchors.some((a) => nameSimilarity(t, a) >= 0.3)) {
            dropped++;
            check(`제목이 그 강의와 안 맞는다: ${file}`, false, `${t} ↔ ${anchors.join(' / ')}`);
          }
          // 베껴온 PBLS 머리말이 되살아나면 바로 잡는다
          if (/소아기본소생술/.test(t)) {
            check(`PBLS 머리말이 남의 파일에: ${file}`, /소아기본소생술/.test(parsed.lectureName || file));
          }
        }
      }
    }
    if (seen) check(`vault 시험 ${seen}개 모두 제 강의 이름을 보여준다`, dropped === 0, `${dropped}개 어긋남`);

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

// ---------- 정답이 한 칸 밀리지 않는가 (2026-10-16 신고) ----------
// "퀴즈가 답이 하나씩 밀려있음." 실제로 그랬다. `ans`는 **0부터 세는 자리 번호**인데
// 다섯 파일이 1부터 세어 적어뒀다. 선지 해설에서 "정답."으로 시작하는 칸이 진짜 답이므로
// 그걸 기준으로 vault 전체를 대조한다 — 앞으로 같은 파일이 또 들어와도 여기서 걸린다.
{
  const MARK = /^\s*[✅⭕○◎▶]?\s*정답\s*([.\-—:·,)]|$)/;
  let checked = 0;
  let wrong = 0;
  let ox = 0;
  let oxWrong = 0;
  let dropped = 0;
  let total = 0;
  for (const root of ['05_퀴즈', '06_모의고사']) {
    let subs = [];
    try { subs = readdirSync(`${VAULT}/${root}`); } catch { continue; }
    for (const sub of subs) {
      let files = [];
      try { files = readdirSync(`${VAULT}/${root}/${sub}`); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.html')) continue;
        let p;
        try { p = parseExamHtml(readFileSync(`${VAULT}/${root}/${sub}/${f}`, 'utf8')); } catch { continue; }
        dropped += p.dropped || 0;
        total += p.questions.length;
        for (const q of p.questions) {
          // ① 자리를 벗어난 답은 있을 수 없다
          if (!(q.ans >= 0 && q.ans < q.opts.length)) {
            wrong++;
            check(`답이 선지 밖: ${f.normalize('NFC')} #${q.num}`, false, `ans=${q.ans}/${q.opts.length}`);
            continue;
          }
          // ② 선지 해설이 정답을 가리키면 그것과 맞아야 한다
          const opt = q.opt || [];
          if (opt.length !== q.opts.length) continue;
          const idx = opt.findIndex((t) => MARK.test(String(t)));
          if (idx < 0) continue;
          checked++;
          if (q.type === 'ox') ox++;
          if (q.ans !== idx) {
            wrong++;
            if (q.type === 'ox') oxWrong++;
            if (wrong <= 3) {
              check(`답이 한 칸 밀렸다: ${f.normalize('NFC')} #${q.num}`, false,
                `ans=${q.ans} 표시=${idx}`);
            }
          }
        }
      }
    }
  }
  if (checked) {
    check(`vault 문항 ${checked}개의 답이 해설과 맞는다 (OX ${ox}개 포함)`, wrong === 0,
      `${wrong}개 어긋남${oxWrong ? ` (OX ${oxWrong})` : ''}`);
  }
  // ③ 읽다가 조용히 버리는 문항이 없어야 한다 — OX를 못 알아봐서 216개를 버리고 있었다
  check(`버려지는 문항이 없다 (전체 ${total}문항)`, dropped === 0, `${dropped}개 버림`);
}

// ---------- 답 번호를 1부터 적은 파일을 바로잡는가 ----------
{
  const { fixOneBased } = await import(`${PWA}/js/parser.js`);
  const q = (ans, right) => ({
    type: 'mc', ans, opts: ['가', '나', '다', '라', '마'],
    opt: ['가 설명', '나 설명', '다 설명', '라 설명', '마 설명']
      .map((t, i) => (i === right ? '정답. 이것이다.' : t)),
  });
  // 파일 전체가 한 칸씩 밀렸으면 내린다
  const shifted = [q(2, 1), q(3, 2), q(1, 0), q(5, 4)];
  check('한 칸 밀린 파일을 바로잡는다', fixOneBased(shifted) === true);
  check('바로잡으면 해설과 맞는다', shifted.every((x, i) => x.ans === [1, 2, 0, 4][i]),
    shifted.map((x) => x.ans).join(','));
  // 멀쩡한 파일은 건드리지 않는다
  const fine = [q(1, 1), q(2, 2), q(0, 0), q(4, 4)];
  check('멀쩡한 파일은 안 건드린다', fixOneBased(fine) === false
    && fine.map((x) => x.ans).join(',') === '1,2,0,4', fine.map((x) => x.ans).join(','));
  // **한 문항만 어긋난 것은 옮기지 않는다** — 해설 표시가 잘못 붙은 파일이 따로 있다
  const oneOff = [q(0, 0), q(1, 1), q(2, 2), q(3, 3), q(2, 1)];
  check('한 문항만 어긋나면 안 옮긴다(해설이 잘못 붙은 경우)',
    fixOneBased(oneOff) === false, oneOff.map((x) => x.ans).join(','));
  // OX는 손대지 않는다 — 0=O, 1=X 라서 내리면 뜻이 뒤집힌다
  const withOx = [q(2, 1), q(3, 2), q(1, 0), { type: 'ox', ans: 1, opts: ['O', 'X'] }];
  fixOneBased(withOx);
  check('OX 답은 안 내린다', withOx[3].ans === 1, String(withOx[3].ans));
}

// ---------- OX 답이 어떤 꼴로 적혀 있든 읽는가 ----------
{
  // OX를 못 알아보면 "읽을 수 있는 문항이 없다"며 **던진다** — 검사가 거기서 죽지 않고
  // 무엇이 사라졌는지 말하게 한다
  const one = (raw) => {
    const html = `<script>const QUESTIONS = ${JSON.stringify([raw])};</script>`;
    try { return parseExamHtml(html).questions[0] || null; } catch { return null; }
  };
  const cases = [
    ['참·거짓 true', { type: 'ox', q: '문장이다.', ans: true }, 0],
    ['참·거짓 false', { type: 'ox', q: '문장이다.', ans: false }, 1],
    ['번호 0', { type: 'ox', q: '문장이다.', correct: 0 }, 0],
    ['번호 1', { type: 'ox', q: '문장이다.', correct: 1 }, 1],
    ['글자 "O"', { type: 'ox', q: '문장이다.', ans: 'O' }, 0],
    ['글자 "X"', { type: 'ox', q: '문장이다.', ans: 'X' }, 1],
    ['글자 "거짓"', { type: 'ox', q: '문장이다.', ans: '거짓' }, 1],
  ];
  for (const [label, raw, want] of cases) {
    const got = one(raw);
    check(`OX ${label} → ${want === 0 ? 'O' : 'X'}`, got && got.ans === want && got.type === 'ox',
      got ? `ans=${got.ans} type=${got.type}` : '문항이 사라졌다');
  }
  // 선지가 따로 없어도 OX는 O·X 두 칸으로 선다 — 전에는 선지가 없다며 버렸다
  const ox = one({ type: 'ox', q: '문장이다.', correct: 1 });
  check('OX 문항이 버려지지 않는다', !!ox && ox.opts.join('') === 'OX',
    ox ? ox.opts.join('') : '사라짐');
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
