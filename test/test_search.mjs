// 찾기 — 범위(이 문서/이 폴더/전체)와 grep(정규식).
//
// 왜 따로 보는가: 한글은 NFC/NFD가 섞여 들어와 "분명히 있는데 안 찾아진다"가 반복됐다.
// 그리고 정규식을 켜면 사용자가 아무 글자나 넣을 수 있어서, **깨진 식으로 앱이 죽지 않는지**가
// 중요하다(2026-10-13 요청으로 들어온 기능).

import { readFileSync, writeFileSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

// 가짜 캐시로 갈아끼운다 — 실제 GitHub·IndexedDB 없이 검색만 본다
const FILES = {
  '02_Wiki/응급_중환자/1021_ECMO.md': 'VA-ECMO는 afterload가 증가한다. harlequin syndrome 주의.',
  '02_Wiki/응급_중환자/1012_환경의학.md': '열사병은 중심체온 40도 이상에서 진단한다.',
  '02_Wiki/두경부_피부/0901_비출혈.md': 'Kiesselbach 신경총에서 전방 비출혈이 흔하다.',
};
const src = readFileSync(`${PWA}/js/search.js`, 'utf8')
  .replace("import { listDir, getText } from './github.js';", 'const listDir=async()=>[],getText=async()=>"";')
  .replace("import { cacheGet, cacheSet, kvGet, kvSet } from './db.js';",
    'const cacheGet=async(p)=>(globalThis.__F[p]?{data:globalThis.__F[p]}:null),cacheSet=async()=>{},'
    + 'kvGet=async(k)=>(k==="cached_paths"?Object.keys(globalThis.__F):null),kvSet=async()=>{};')
  .replace("import { parseExamHtml, prettyExamName } from './parser.js';",
    'const parseExamHtml=()=>({questions:[]}),prettyExamName=(x)=>x;')
  .replace("import { resolveNotePath } from './wiki.js';", 'const resolveNotePath=async()=>null;');
globalThis.__F = FILES;
const shim = `${PWA}/js/__t_search.mjs`;
writeFileSync(shim, src);
let S;
try { S = await import(pathToFileURL(shim).href); } finally { rmSync(shim, { force: true }); }

// ── 맞는지 보는 함수 ──
{
  const m = S.matcher('ECMO');
  ok('글자를 찾는다', !!m('VA-ECMO는'), 'ECMO');
  ok('대소문자를 안 가린다(기본)', !!S.matcher('ecmo')('VA-ECMO는'));
  ok('대소문자를 가리게 하면 안 맞는다', !S.matcher('ecmo', { caseSensitive: true })('VA-ECMO는'));
}
{
  // ★ 한글 자소 분리(NFD) — 맥에서 만든 파일명·본문이 이렇게 들어온다
  const nfd = '열사병'.normalize('NFD');
  ok('자소가 갈라진 글도 찾는다(NFD)', !!S.matcher('열사병')(nfd), 'NFD 본문');
  ok('자소가 갈라진 말로도 찾는다', !!S.matcher(nfd)('열사병이 의심된다'), 'NFD 검색어');
}
{
  const m = S.matcher('a.terload', { regex: true });
  ok('정규식(grep)으로 찾는다', !!m('afterload가 증가'), 'a.terload');
  ok('정규식에서 글자 그대로는 안 맞을 수 있다', !S.matcher('^증가', { regex: true })('afterload가 증가'));
  ok('**깨진 정규식은 null** — 앱이 죽지 않는다', S.matcher('([', { regex: true }) === null);
}
{
  const m = S.matcher('가');
  const all = S.findAll('가나가다가', m);
  ok('한 글에서 여러 군데를 찾는다', all.length === 3, `${all.length}군데`);
  ok('자리를 정확히 집는다', JSON.stringify(all.map((x) => x.at)) === '[0,2,4]');
  ok('안 맞으면 빈 배열', S.findAll('나다라', m).length === 0);
  // 빈 문자열에 맞는 식이 무한루프를 돌면 앱이 멎는다
  ok('빈 것에 맞는 정규식도 멎지 않는다',
    S.findAll('가나다', S.matcher('x*', { regex: true })).length <= 200);
}

// ── 범위 ──
{
  const all = await S.search('ECMO');
  ok('전체에서 찾는다', all.length === 1 && all[0].path.includes('1021'), `${all.length}건`);
  const inDir = await S.search('비출혈', 40, { dir: '02_Wiki/두경부_피부' });
  ok('폴더를 한정해 찾는다', inDir.length === 1, `${inDir.length}건`);
  const outDir = await S.search('ECMO', 40, { dir: '02_Wiki/두경부_피부' });
  ok('**폴더 밖은 안 찾는다**', outDir.length === 0, `${outDir.length}건`);
  const re = await S.search('harlequin|열사병', 40, { regex: true });
  ok('정규식으로 여러 노트를 한 번에', re.length === 2, `${re.length}건`);
  ok('한 글자는 안 찾는다(오타로 전부 긁지 않게)', (await S.search('E')).length === 0);
}
{
  const hit = (await S.search('afterload'))[0];
  ok('찾은 자리 앞뒤를 같이 보여준다', hit.snippet.match === 'afterload' && hit.snippet.before.length > 0,
    JSON.stringify(hit.snippet).slice(0, 60));
}

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
