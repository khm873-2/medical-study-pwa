// Phase 4·5 테스트 — 읽기 모드(섹션 분리·카드 추출·SRS)와 검색 스니펫을 실제 노트로 검증.
import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
const VAULT = '/Users/hyunminkang/Documents/Medical_vault';
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

global.document = { createElement: () => ({ className: '', textContent: '' }), addEventListener() {}, removeEventListener() {} };
// Node 24는 navigator가 읽기 전용이라 덮어쓰지 않는다(reader.js는 'wakeLock' in navigator만 본다).

// reader.js는 브라우저 모듈을 import하므로 스텁으로 치환한 복사본을 쓴다.
const src = readFileSync(`${PWA}/js/reader.js`, 'utf8')
  .replace("import { listDir, getText, getBlobUrl } from './github.js';",
    'const listDir=async()=>[],getText=async()=>"",getBlobUrl=async()=>"";')
  .replace("import { kvGet, kvSet } from './db.js';",
    'const _kv={};const kvGet=async(k)=>_kv[k],kvSet=async(k,v)=>{_kv[k]=v;};');
const shim = `${PWA}/js/__t_reader.mjs`;
writeFileSync(shim, src);
let R;
try { R = await import(pathToFileURL(shim).href); } finally { rmSync(shim, { force: true }); }

// ── 카드 추출 ──
// 하이라이트가 실제로 들어있는 노트를 하나 찾아 쓴다(노트마다 사용 여부가 다르다).
function findNoteWithHighlights() {
  for (const root of ['98_예습노트_보관', '02_Wiki']) {
    for (const sub of readdirSync(`${VAULT}/${root}`)) {
      const dir = `${VAULT}/${root}/${sub}`;
      let fs2; try { fs2 = readdirSync(dir); } catch { continue; }
      for (const f of fs2.filter((x) => x.endsWith('.md'))) {
        const t = readFileSync(`${dir}/${f}`, 'utf8');
        if ((t.match(/==[^=]{2,}==/g) || []).length >= 5) return { path: `${dir}/${f}`, text: t };
      }
    }
  }
  return null;
}
const picked = findNoteWithHighlights();
ok('하이라이트 있는 노트 존재', !!picked);
const noteMd = picked.text;
// loadNote는 네트워크를 타므로 splitSections 결과를 직접 조립
const { splitSections } = await import(pathToFileURL(`${PWA}/js/wiki.js`).href).catch(async () => {
  const ws = readFileSync(`${PWA}/js/wiki.js`, 'utf8')
    .replace("import { listDir, getText } from './github.js';", 'const listDir=async()=>[],getText=async()=>"";')
    .replace("import { linkedNoteFromMd } from './parser.js';", 'const linkedNoteFromMd=()=>null;');
  const s2 = `${PWA}/js/__t_wiki2.mjs`;
  writeFileSync(s2, ws);
  try { return await import(pathToFileURL(s2).href); } finally { rmSync(s2, { force: true }); }
});

const note = { path: 'p.md', title: 'ACLS', sections: splitSections(noteMd) };
const cards = R.extractCards(note);
ok('카드 추출됨', cards.length > 0, `${cards.length}장`);
ok('카드에 정답', cards.every((c) => c.answer && c.answer.length >= 4));
ok('카드에 문맥', cards.every((c) => typeof c.context === 'string'));
ok('정답 자리가 ____로 가려짐', cards.every((c) => c.context.includes('____')),
  cards.find((c) => !c.context.includes('____'))?.context?.slice(0, 50));
ok('문맥에 정답이 그대로 안 보임', cards.every((c) => !c.context.includes(c.answer)),
  cards.find((c) => c.context.includes(c.answer))?.answer?.slice(0, 40));
ok('카드 id 유일', new Set(cards.map((c) => c.id)).size === cards.length);
ok('⭐ 표시 보존', cards.some((c) => c.starred));

// 여러 하이라이트가 한 줄에 있을 때 각각 카드가 되는지
const multi = { path: 'm.md', title: 'T', sections: [{ heading: 'S', text: 'A는 ==아데노신== 이고 B는 ==아미오다론== 다' }] };
const mc = R.extractCards(multi);
ok('한 줄 다중 하이라이트 → 카드 2장', mc.length === 2, `${mc.length}`);
ok('다중: 각 카드가 자기 답만 가림',
  mc[0].context.includes('____') && mc[0].context.includes('아미오다론') && !mc[0].context.includes('아데노신'),
  mc[0].context);
// 짧은 핵심어도 카드가 되는지(실측상 "반점" 같은 2글자 하이라이트가 존재)
const short = R.extractCards({ path: 's.md', title: 'T', sections: [{ heading: 'S', text: '피부에 ==반점== 이 있다' }] });
ok('2글자 하이라이트도 카드', short.length === 1 && short[0].answer === '반점', JSON.stringify(short[0]?.answer));
// 하이라이트가 아닌 오탈자는 거르는지
const junk = R.extractCards({ path: 'j.md', title: 'T', sections: [{ heading: 'S', text: '어쩌고 ==, == 저쩌고' }] });
ok('구두점만 있는 건 카드 아님', junk.length === 0, `${junk.length}`);

// 전체 노트에서 터지지 않는지
let total = 0, crashed = 0, notes = 0;
for (const root of ['98_예습노트_보관', '02_Wiki']) {
  for (const sub of readdirSync(`${VAULT}/${root}`)) {
    const dir = `${VAULT}/${root}/${sub}`;
    let fs2; try { fs2 = readdirSync(dir); } catch { continue; }
    for (const f of fs2.filter((x) => x.endsWith('.md'))) {
      notes++;
      try {
        const n = { path: f, title: f, sections: splitSections(readFileSync(`${dir}/${f}`, 'utf8')) };
        total += R.extractCards(n).length;
      } catch { crashed++; }
    }
  }
}
ok('전 노트 카드 추출 무오류', crashed === 0, `${crashed}건 실패`);
console.log(`  노트 ${notes}개에서 카드 ${total}장 추출`);

// ── SRS ──
const srs = {};
R.gradeCard(srs, 'c1', true);
ok('맞히면 box 증가', srs.c1.box === 1);
ok('다음 복습일 설정', srs.c1.due > Date.now());
R.gradeCard(srs, 'c1', true);
ok('연속으로 맞히면 간격 늘어남', srs.c1.box === 2);
const dueAt2 = srs.c1.due;
R.gradeCard(srs, 'c1', false);
ok('틀리면 box 0으로', srs.c1.box === 0);
ok('틀리면 간격 짧아짐', srs.c1.due < dueAt2);

const sample = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const srs2 = { a: { box: 4, due: Date.now() + 1e9 }, b: { box: 1, due: 0 } };
const due = R.dueCards(sample, srs2);
ok('due: 미래 카드 제외', !due.find((c) => c.id === 'a'));
ok('due: 지난 카드 포함', !!due.find((c) => c.id === 'b'));
ok('due: 새 카드 포함', !!due.find((c) => c.id === 'c'));
const st = R.srsStats(sample, srs2);
ok('통계', st.total === 3 && st.new === 1 && st.mature === 1 && st.learning === 1,
  JSON.stringify(st));

// ── search.js 스니펫 ──
const ss = readFileSync(`${PWA}/js/search.js`, 'utf8')
  .replace("import { listDir, getText } from './github.js';", 'const listDir=async()=>[],getText=async()=>"";')
  .replace("import { cacheGet, cacheSet, kvGet, kvSet } from './db.js';",
    'const _c={},_k={};const cacheGet=async(p)=>_c[p],cacheSet=async(p,d)=>{_c[p]={data:d};},kvGet=async(k)=>_k[k],kvSet=async(k,v)=>{_k[k]=v;};')
  .replace("import { parseExamHtml, prettyExamName } from './parser.js';",
    `import { parseExamHtml, prettyExamName } from ${JSON.stringify(PWA + '/js/parser.js')};`);
const s3 = `${PWA}/js/__t_search.mjs`;
writeFileSync(s3, ss);
let S;
try { S = await import(pathToFileURL(s3).href); } finally { rmSync(s3, { force: true }); }
ok('search 모듈 로드', typeof S.search === 'function' && typeof S.cacheSubject === 'function');
const empty = await S.search('a');
ok('1글자는 검색 안 함', empty.length === 0);

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
