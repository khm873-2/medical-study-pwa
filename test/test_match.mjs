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
  .replace("import { listDir, getText } from './github.js';", 'const listDir=async()=>[],getText=async()=>"";')
  .replace("import { linkedNoteFromMd } from './parser.js';", 'const linkedNoteFromMd=()=>null;');
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

// ── wikiRefs(수동 지정) 경로 — 2026-10-09 도입. 자동 매칭보다 **항상** 우선해야 한다.
{
  const labeled = [
    ['응급_중환자/1015_전문심장소생술ACLS_모의고사', 13],
    ['응급_중환자/1012_환경의학_모의고사', 18],
    ['두경부_피부/0929_두경부피부_알레르기비염부비동염비부비동종양_모의고사', 6],
  ];
  for (const [exam, n] of labeled) {
    const h = readFileSync(`${V}/06_모의고사/${exam}.html`, 'utf8');
    const qs = JSON.parse(h.match(/const QUESTIONS = (\[[\s\S]*?\]);\s*\nconst LECTURE_NAME/)[1]);
    const withRefs = qs.filter((q) => Array.isArray(q.wikiRefs) && q.wikiRefs.length);
    ok(`${exam.split('/')[1].slice(0, 24)}: 전 문항에 wikiRefs`,
      withRefs.length === qs.length && qs.length === n, `${withRefs.length}/${qs.length}`);

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

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
