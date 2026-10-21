// 문항 ↔ 노트 섹션 매칭 회귀 테스트.
//
// 왜 따로 있나: test_phase3은 "예외 없이 1등이 나오는가"만 봤지 **그게 맞는 섹션인가**는
// 거의 안 봤다. 그래서 알레르기비염 문항에 "미각성 비염"을 띄우는 걸 못 잡았다(2026-10-09).
// 여기 정답지는 문항과 노트 섹션을 사람이 직접 읽고 단 것이다.
import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
const V = '/Users/hyunminkang/Documents/Medical_vault';

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

const src = readFileSync(`${PWA}/js/wiki.js`, 'utf8')
  // github.js를 가짜 파일시스템으로 바꾼다 — globalThis.__FS/__TXT로 조종한다
  .replace(/import \{[^}]*\} from '\.\/github\.js';/,
    'const listDir=async(p)=>((globalThis.__FS||{})[p]||[]),getText=async(p)=>((globalThis.__TXT||{})[p]||"");')
  .replace(/import \{[^}]*\} from '\.\/parser\.js';/, 'const linkedNoteFromMd=()=>null;');
const shim = `${PWA}/js/__tm.mjs`;
writeFileSync(shim, src);
let W;
try { W = await import(pathToFileURL(shim).href); } finally { rmSync(shim, { force: true }); }

const load = (exam, note) => {
  const h = readFileSync(`${V}/06_모의고사/${exam}.html`, 'utf8');
  const qs = JSON.parse(h.match(/const QUESTIONS = (\[[\s\S]*?\]);\s*\nconst LECTURE_NAME/)[1]);
  const secs = W.contentSections(W.splitSections(readFileSync(`${V}/98_예습노트_보관/${note}.md`, 'utf8')));
  return { qs, secs };
};

// ── 정답지 — 사람이 문항과 섹션을 읽고 달았다. 값은 "허용되는 섹션 제목 접두사"들이다.
const GOLD = [
  {
    exam: '두경부_피부/0929_두경부피부_알레르기비염부비동염비부비동종양_모의고사',
    note: '두경부_피부/0929_두경부피부_알레르기비염부비동염비부비동종양',
    want: {
      1: ['2.'],            // 알레르기비염 진단 — 노트에 진단 섹션은 없고 2번이 가장 가깝다
      2: ['2.', '3.'],      // 항히스타민제로 안 잡히는 증상=코막힘 → 비강스테로이드
      3: ['2.'],
      4: ['2.'],
      5: ['2.'],
      6: ['4.'],            // 교차개념 만성부비동염
    },
  },
  {
    exam: '응급_중환자/1012_환경의학_모의고사',
    note: '응급_중환자/1012_응급중환자_환경의학',
    want: {
      5: ['5.'],            // 마라톤 중 체온 40.7℃ 의식혼미 = heat stroke
      6: ['5.'],
      8: ['5.'],
      10: ['4.'],           // 동계훈련 발가락 = 동상
      15: ['1.'],           // 화상전문센터 이송기준
      18: ['1.', '2.'],     // 고압전기 감전 — 이송기준(전기손상) 또는 HBOT
    },
  },
  {
    exam: '응급_중환자/1015_전문심장소생술ACLS_모의고사',
    note: '응급_중환자/1015_응급중환자_전문심장소생술ACLS',
    want: { 1: ['1.'], 2: ['1.'], 4: ['1.'], 6: ['1.'], 7: ['1.'], 8: ['1.'] },
  },
];

let hit = 0, total = 0;
for (const g of GOLD) {
  let d;
  try { d = load(g.exam, g.note); } catch (e) { ok(`${g.exam} 로드`, false, e.message); continue; }
  for (const [num, want] of Object.entries(g.want)) {
    const q = d.qs.find((x) => String(x.num) === num);
    if (!q) { ok(`${g.exam} Q${num} 존재`, false); continue; }
    const top = W.rankSections(q, d.secs)[0];
    const good = want.some((w) => top.heading.startsWith(w));
    total++; if (good) hit++;
    ok(`${g.exam.split('/')[1].slice(0, 22)} Q${num} → ${want.join('/')}`,
      good, good ? '' : `실제: ${top.heading.slice(0, 26)}`);
  }
}
console.log(`  정답지 매칭: ${hit}/${total}`);

// ── 알고리즘이 무너지지 않는지(속성 검사)
const d = load(GOLD[0].exam, GOLD[0].note);
const r = W.rankSections(d.qs[0], d.secs);
ok('점수 내림차순', r.every((s, i) => i === 0 || r[i - 1].score >= s.score));
ok('1등 점수는 1로 정규화', r[0].score === 1, String(r[0].score));
ok('모든 섹션에 fit이 있다', r.every((s) => typeof s.fit === 'number'));
ok('fit은 0~1', r.every((s) => s.fit >= 0 && s.fit <= 1));
ok('섹션을 빠뜨리지 않는다', r.length === d.secs.length, `${r.length}/${d.secs.length}`);
ok('fitLabel 경계', W.fitLabel(0.5) === '잘 맞음' && W.fitLabel(0.3) === '추정' && W.fitLabel(0.1) === '약한 추정');

// 한국어 띄어쓰기·조사에 흔들리지 않아야 한다(이번 버그의 근본 원인)
const secsAB = [{ heading: '2. 알레르기비염 치료 원칙', text: '비강 스테로이드가 안전하다.' },
                { heading: '6. 미각성 비염(Gustatory Rhinitis)', text: '국소 항콜린제가 1차 치료다.' }];
const qSpaced = { q: '알레르기 비염으로 진단받은 환자의 치료 원칙은?', opts: [], explain: '' };
ok('띄어쓰기가 달라도 맞는 섹션을 고른다',
  W.rankSections(qSpaced, secsAB)[0].heading.startsWith('2.'),
  W.rankSections(qSpaced, secsAB)[0].heading);
const qJosa = { q: '알레르기비염이 의심된다. 알레르기비염의 치료는?', opts: [], explain: '' };
ok('조사가 붙어도 맞는 섹션을 고른다', W.rankSections(qJosa, secsAB)[0].heading.startsWith('2.'));

// 짧은 섹션이 무조건 이기면 안 된다(코사인으로 바꿨을 때 생겼던 역진)
const secsLen = [{ heading: '1. 긴 섹션', text: ('심정지 알고리즘 제세동 에피네프린 '.repeat(40)) },
                 { heading: '2. 짧은 섹션', text: '감기약' }];
ok('짧다고 이기지 않는다',
  W.rankSections({ q: '심정지에서 제세동 후 에피네프린 투여 시점은?', opts: [], explain: '' }, secsLen)[0]
    .heading.startsWith('1.'));

// "(선지: …)" 오답 목록이 매칭을 끌고 가면 안 된다
const secsOpt = [{ heading: '1. 미각성 비염', text: '콜린성 반사.\n(선지: 국소스테로이드/항히스타민제/항울혈제)' },
                 { heading: '2. 국소 스테로이드제 약리', text: '비강 스테로이드의 작용과 안전성.' }];
ok('족보 오답 선지가 매칭을 끌고 가지 않는다',
  W.rankSections({ q: '비강 스테로이드의 안전성은?', opts: [], explain: '' }, secsOpt)[0].heading.startsWith('2.'));

// ── 제목이 조금 바뀌어도 그 대목을 찾는다 (2026-10-16) ──
// 노트는 계속 자라서 제목이 바뀐다. `13. 🔥 오늘 퀴즈 11문항 …`이 수업 뒤
// `… 27문항 …`이 됐는데, 글자가 같아야만 찾던 탓에 참조가 **조용히 떨어져**
// 노트 전체 자동매칭으로 넘어갔다 — 화면엔 엉뚱한 대목이 뜨고 왜인지 알 길이 없었다.
{
  const secs = [
    { heading: '12. 소생 후 치료 [슬라이드 p.40]', text: 'a' },
    { heading: '13. 🔥 오늘 퀴즈 27문항 · 증례 5건 [퀴즈 노트 56p · 슬라이드 p.43–46 · 전사문]', text: 'b' },
    { heading: '14. 마무리', text: 'c' },
  ];
  const got = (w) => { const r = W.findHeading(secs, w); return r ? r.heading : null; };
  ok('글자가 같으면 그대로', got('14. 마무리') === '14. 마무리');
  ok('**숫자가 바뀌어도 같은 대목을 찾는다**',
    got('13. 🔥 오늘 퀴즈 11문항 · 증례 4건 [슬라이드 p.43–46 · 전사문]') === secs[1].heading,
    got('13. 🔥 오늘 퀴즈 11문항 · 증례 4건 [슬라이드 p.43–46 · 전사문]'));
  ok('앞 번호가 같으면 그걸 믿는다', got('13. 아주 다르게 바뀐 제목') === secs[1].heading);
  ok('번호가 없어도 많이 닮으면 찾는다', got('소생 후 치료 [슬라이드 p.40]') === secs[0].heading);
  ok('남남은 안 찾는다(엉뚱한 대목을 들이밀지 않는다)', got('완전히 관계없는 다른 이야기') === null,
    got('완전히 관계없는 다른 이야기'));
  ok('빈 제목도 안 터진다', W.findHeading(secs, '') === null && W.findHeading([], '가') === null);
}

// ── wikiRefs(수동 지정) 경로 — 2026-10-09 도입. 자동 매칭보다 **항상** 우선해야 한다.
{
  // ⚠️ 문항 수를 숫자로 박아두면 **시험이 자라는 순간 거짓 경보**가 된다
  //    (ACLS가 13→19문항이 되면서 하루 종일 빨간불이었다 — 2026-10-16).
  //    여기서 볼 것은 "몇 개냐"가 아니라 **빠진 문항이 없느냐**다. 최소 개수만 못박는다.
  const labeled = [
    ['응급_중환자/1015_전문심장소생술ACLS_모의고사', 13],
    ['응급_중환자/1012_환경의학_모의고사', 18],
    ['두경부_피부/0929_두경부피부_알레르기비염부비동염비부비동종양_모의고사', 6],
  ];
  for (const [exam, least] of labeled) {
    const h = readFileSync(`${V}/06_모의고사/${exam}.html`, 'utf8');
    const qs = JSON.parse(h.match(/const QUESTIONS = (\[[\s\S]*?\]);\s*\nconst LECTURE_NAME/)[1]);
    const withRefs = qs.filter((q) => Array.isArray(q.wikiRefs) && q.wikiRefs.length);
    ok(`${exam.split('/')[1].slice(0, 24)}: 전 문항에 wikiRefs`,
      withRefs.length === qs.length && qs.length >= least, `${withRefs.length}/${qs.length}`);

    // 지정한 heading이 노트에 실제로 있어야 한다 — 오타 하나면 앱이 조용히 자동매칭으로 떨어진다
    let bad = 0;
    for (const q of qs) {
      for (const r of q.wikiRefs || []) {
        let found = null;
        for (const root of ['98_예습노트_보관', '02_Wiki', '01_임종평_전범위']) {
          for (const sub of readdirSync(`${V}/${root}`)) {
            const c = `${V}/${root}/${sub}/${r.note}.md`;
            if (existsSync(c)) { found = c; break; }
          }
          if (found) break;
        }
        if (!found) { bad++; continue; }
        const heads = W.splitSections(readFileSync(found, 'utf8')).map((x) => x.heading);
        if (!heads.includes(r.heading.trim())) bad++;
      }
    }
    ok(`${exam.split('/')[1].slice(0, 24)}: heading이 노트에 실존`, bad === 0, `${bad}건 불일치`);
  }
}

// Cheat Sheet를 가리키는 wikiRefs도 살아남아야 한다 —
// contentSections가 "0. Exam Cheat Sheet"를 매칭 후보에서 빼기 때문에 그냥 두면 사라진다.
// (환경의학 노트에는 익수·저체온 대단원이 없어서 그 문항들이 Cheat Sheet를 가리킨다.)
{
  const h = readFileSync(`${V}/06_모의고사/응급_중환자/1012_환경의학_모의고사.html`, 'utf8');
  const qs = JSON.parse(h.match(/const QUESTIONS = (\[[\s\S]*?\]);\s*\nconst LECTURE_NAME/)[1]);
  const cheat = qs.filter((q) => (q.wikiRefs || []).some((r) => /Cheat Sheet/.test(r.heading)));
  ok('익수·저체온 문항은 Cheat Sheet를 가리킨다', cheat.length === 7, `${cheat.length}개`);   // Q1~4,9,12,13

  const all = W.splitSections(readFileSync(
    `${V}/98_예습노트_보관/응급_중환자/1012_응급중환자_환경의학.md`, 'utf8'));
  const body = W.contentSections(all);
  ok('Cheat Sheet는 자동 매칭 후보에서 빠진다',
    !body.some((s) => /Cheat Sheet/.test(s.heading)));
  // wikiFor와 같은 방식으로 목록을 만들어 본다
  const ref = cheat[0].wikiRefs[0];
  const picked = all.filter((s) => s.heading.trim() === ref.heading.trim());
  ok('그래도 wikiRefs로 지정하면 찾아진다', picked.length === 1, ref.heading);
  const extra = all.filter((s) => !body.some((b) => b.heading === s.heading));
  ok('참고 섹션(목차·Cheat Sheet·Advanced)이 목록 끝에 남는다', extra.length >= 2, `${extra.length}개`);
}

// ── 노트 탐색 범위 (2026-10-12) ──
// /lecture-integrate는 위키를 만들 때마다 Q&A 보조본을 `02_Wiki/{과목}/QA/`에 같이 만든다.
// 2단만 훑으면 그 폴더가 통째로 안 보여서 앞으로 만드는 위키의 절반이 앱에 안 올라온다.
{
  const dir = (n, p) => ({ type: 'dir', name: n, path: p });
  const file = (n, p) => ({ type: 'file', name: n, path: p });
  globalThis.__FS = {
    '98_예습노트_보관': [dir('응급_중환자', '98_예습노트_보관/응급_중환자')],
    '98_예습노트_보관/응급_중환자': [file('1021_응급중환자_ECMO.md', '98_예습노트_보관/응급_중환자/1021_응급중환자_ECMO.md')],
    '02_Wiki': [dir('두경부_피부', '02_Wiki/두경부_피부')],
    '02_Wiki/두경부_피부': [
      file('두경부피부_중이염.md', '02_Wiki/두경부_피부/두경부피부_중이염.md'),
      dir('QA', '02_Wiki/두경부_피부/QA'),
    ],
    '02_Wiki/두경부_피부/QA': [file('두경부피부_중이염_QA.md', '02_Wiki/두경부_피부/QA/두경부피부_중이염_QA.md')],
    '01_임종평_전범위': [dir('05_순환기', '01_임종평_전범위/05_순환기')],
    '01_임종평_전범위/05_순환기': [file('심근염.md', '01_임종평_전범위/05_순환기/심근염.md')],
  };
  const wiki = await W.listNoteFiles('02_Wiki');
  ok('산문 노트를 찾는다', wiki.some((f) => f.name === '두경부피부_중이염' && !f.group));
  ok('QA 하위 폴더까지 찾는다',
    wiki.some((f) => f.name === '두경부피부_중이염_QA' && f.group === 'QA'),
    JSON.stringify(wiki.map((f) => `${f.group || '-'}/${f.name}`)));

  ok('연계노트가 QA본도 가리킬 수 있다',
    (await W.resolveNotePath('두경부피부_중이염_QA')) === '02_Wiki/두경부_피부/QA/두경부피부_중이염_QA.md');
  // build_mock_exam_html.py는 01_임종평_전범위까지 뒤져서 wikiRefs를 검증한다.
  // 앱이 안 보면 빌드는 통과하는데 화면에선 조용히 자동매칭으로 떨어진다.
  ok('01_임종평_전범위도 탐색 범위에 있다(빌드 검증과 같은 범위)',
    (await W.resolveNotePath('심근염')) === '01_임종평_전범위/05_순환기/심근염.md');
  ok('없는 노트는 null', (await W.resolveNotePath('없는노트')) === null);
  // 자소 분리형(NFD)으로 적힌 연계노트도 같은 노트로 본다 — 눈에는 똑같은데 문자열은 다르다
  ok('NFD로 적힌 이름도 찾는다',
    (await W.resolveNotePath('두경부피부_중이염'.normalize('NFD'))) === '02_Wiki/두경부_피부/두경부피부_중이염.md');
  delete globalThis.__FS;
}

// ── 옆칸 목차는 **문서 차례 그대로** (2026-10-20 신고) ──
// "아니 이렇게 순서가 없다니까?" — 관련도 순으로 섞어 줘서 목차가
// "2 · 12 · 🗺️ · 6 · 7 · 10 · 3 · 4 · 5 · 8"처럼 나왔다. 목차인데 차례가 없으면
// 지금 어디쯤인지 가늠이 안 된다. 맞추는 셈은 **어디를 먼저 펼지**에만 쓴다.
{
  const secs = ['1. 들머리', '2. 심전도 감시', '3. 혈압 비침습', '4. 동맥 파형', '5. 용적 평가']
    .map((h) => ({ heading: h, text: `${h}에 대한 내용. 심전도 유도 V5 좌심실 측벽 허혈.` }));
  const q = { q: '5유도 심전도에서 추가로 보는 유도는?', opts: ['V5 좌심실 측벽'], explain: 'V5' };

  // rankSections 자체는 여전히 **맞는 것부터** 준다(여러 곳이 [0]을 쓴다)
  const ranked = W.rankSections(q, secs);
  ok('맞추는 셈은 그대로 — 가장 맞는 토막이 맨 앞',
    ranked[0].heading.startsWith('2.'), ranked[0].heading);
  ok('관련도 순은 문서 차례와 다르다(그래서 목차로 쓰면 안 된다)',
    ranked.map((x) => x.heading).join() !== secs.map((x) => x.heading).join());

  // wikiFor가 돌려주는 목록은 **문서 차례**여야 한다 — 그 자리에서 셈만 떼어 확인
  const scoreOf = new Map(ranked.map((r) => [r.heading, r]));
  const inOrder = secs.map((x) => ({ ...x, score: (scoreOf.get(x.heading) || {}).score || 0 }));
  const best = inOrder.findIndex((x) => x.heading === ranked[0].heading);
  ok('**목차는 문서 차례 그대로**',
    inOrder.map((x) => x.heading).join() === secs.map((x) => x.heading).join());
  ok('처음 펴는 곳은 가장 맞는 토막을 가리킨다', inOrder[best].heading.startsWith('2.'), String(best));
  ok('차례를 바꿔도 점수는 따라간다', inOrder[best].score >= Math.max(...inOrder.map((x) => x.score)));

  // 실제 wiki.js가 그렇게 짜여 있는지 — 글로도 확인한다(돌려보기 어려운 자리라)
  const src = readFileSync(`${PWA}/js/wiki.js`, 'utf8');
  ok('wikiFor가 문서 차례로 돌려준다', /sections: \[\.\.\.inOrder, \.\.\.extra\]/.test(src));
  ok('어디를 먼저 펼지는 bestIdx로 알린다', /bestIdx/.test(src));
}

// ── 족보는 **정리된 위키**에 붙는다 (2026-10-21 지적) ──
// "족보는 지금 예습노트랑 연결되어 있는 거임?" — 그랬다. 예습노트(98_)를 먼저
// 훑어서, 위키에 같은 강의가 있어도 날것이 떴다(39개 중 36개). 차례만 바꾸면 된다.
{
  const src = readFileSync(`${PWA}/js/wiki.js`, 'utf8');
  const fn = (src.match(/export async function noteForJokbo[\s\S]*?\n\}/) || [''])[0];
  ok('족보 짝짓기는 위키를 먼저 본다',
    /ROOTS = \['02_Wiki'/.test(fn), fn ? '차례 확인' : '함수를 못 찾음');
  ok('위키에 짝이 없으면 예습노트로 간다(없는 것보다 낫다)',
    /98_예습노트_보관/.test(fn));

  // 이름 맞추기 자체는 그대로인지 — 같은 강의면 둘 다 1.00이라 차례가 결정한다
  const ch = '01_정형외과학서론_골절개론및치료원칙';
  const wikiName = '근골격계_골절개론및치료원칙';
  const yeName = '0910_근골격계_골절개론및치료원칙';
  ok('위키·예습노트가 같은 점수다(그래서 차례가 가른다)',
    Math.abs(W.nameSimilarity(ch, wikiName) - W.nameSimilarity(ch, yeName)) < 0.01,
    `${W.nameSimilarity(ch, wikiName).toFixed(2)} vs ${W.nameSimilarity(ch, yeName).toFixed(2)}`);
  ok('그 점수가 문턱을 넘는다', W.nameSimilarity(ch, wikiName) >= 0.5,
    W.nameSimilarity(ch, wikiName).toFixed(2));
}

// ── 점수를 세 루트 한 그릇에 담지 말고 **루트 단위**로 본다 (2026-10-21 재지적) ──
// "강의 다 끝났는데 이게 무슨말임" — 재서 보니 실제로는 22개 중 19개가 이미 위키로
// 잘 가고 있었는데, 한 그릇에 담아 최고점만 뽑는 예전 방식이 08_소아기본소생술_PALS_
// 신생아소생술처럼 **한 족보 챕터가 위키에서 세 노트(PBLS·PALS·NRP)로 나뉜** 경우를
// 못 잡았다 — 위키 쪽 최선(PALS, 0.58)이 문턱은 넘는데, 예습노트 쪽 우연한 글자
// 겹침(0.67)에 밀려 예습노트로 떨어졌다. 루트 단위로 보면 위키가 문턱만 넘으면
// 거기서 끝나야 한다.
{
  const dir = (n, p) => ({ type: 'dir', name: n, path: p });
  const file = (n, p) => ({ type: 'file', name: n, path: p });
  globalThis.__FS = {
    '02_Wiki': [dir('응급_중환자', '02_Wiki/응급_중환자')],
    '02_Wiki/응급_중환자': [
      file('응급중환자_소아기본소생술PBLS및이물질기도폐쇄.md', '02_Wiki/응급_중환자/응급중환자_소아기본소생술PBLS및이물질기도폐쇄.md'),
      file('응급중환자_소아전문소생술PALS.md', '02_Wiki/응급_중환자/응급중환자_소아전문소생술PALS.md'),
      file('응급중환자_신생아소생술NRP.md', '02_Wiki/응급_중환자/응급중환자_신생아소생술NRP.md'),
    ],
    '98_예습노트_보관': [dir('응급_중환자', '98_예습노트_보관/응급_중환자')],
    '98_예습노트_보관/응급_중환자': [
      file('1013_응급중환자_소아기본소생술PBLS.md', '98_예습노트_보관/응급_중환자/1013_응급중환자_소아기본소생술PBLS.md'),
    ],
    '01_임종평_전범위': [],
  };
  const got = await W.noteForJokbo('00_Raw_Text/기출문제_학교/응급_중환자/08_소아기본소생술_PALS_신생아소생술.md');
  ok('위키 쪽이 문턱만 넘으면 예습노트 점수가 더 높아도 위키를 쓴다',
    got === '응급중환자_소아전문소생술PALS', String(got));
  delete globalThis.__FS;
}

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');

