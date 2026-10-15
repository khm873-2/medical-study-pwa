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
  .replace(/import \{[^}]*\} from '\.\/github\.js';/, 'const listDir=async()=>[],getText=async()=>"",listTree=async()=>[];')
  // ⚠️ import 줄을 **글자 그대로** 집으면, 거기에 이름 하나만 더해도 갈아끼우기가 조용히
  //    빗나가 진짜 db.js가 딸려 들어온다(2026-10-16: cacheGetMany를 더했다가 겪었다).
  //    줄 모양으로 집어서 무엇이 늘든 받아낸다.
  .replace(/import \{[^}]*\} from '\.\/db\.js';/,
    'const cacheGet=async(p)=>(globalThis.__F[p]?{data:globalThis.__F[p]}:null),cacheSet=async()=>{},'
    + 'cacheGetMany=async(ps)=>new Map((ps||[]).filter((p)=>globalThis.__F[p])'
    + '.map((p)=>[p,globalThis.__F[p]])),'
    + 'kvGet=async(k)=>(k==="cached_paths"?Object.keys(globalThis.__F):null),kvSet=async()=>{};')
  .replace(/import \{[^}]*\} from '\.\/parser\.js';/,
    'const parseExamHtml=()=>({questions:[]}),prettyExamName=(x)=>x;')
  .replace(/import \{[^}]*\} from '\.\/wiki\.js';/, 'const resolveNotePath=async()=>null;');
globalThis.__F = FILES;
// 갈아끼우기가 하나라도 빗나가면 진짜 모듈이 딸려 들어온다 — 그러면 이 검사는
// 더 이상 "검색만" 보는 게 아니다. 남은 상대경로 import가 있는지 먼저 확인한다.
const leftover = (src.match(/import[^;]*from '\.\/[^']+';/g) || []);
if (leftover.length) {
  console.log(`test_search.mjs  ❌ 갈아끼우지 못한 import가 남았습니다:\n   ${leftover.join('\n   ')}`);
  process.exit(1);
}
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

// ★ 한 노트에서 **전부** 찾는다. 하나만 찾던 탓에 "다 안 나온다"가 됐다(2026-10-14).
{
  globalThis.__F['02_Wiki/응급_중환자/반복.md'] =
    '화상센터 이송 기준이다. 화상센터는 특수부위를 받는다. 화상센터 전원 대상.';
  const many = await S.search('화상센터');
  ok('한 노트에 여러 번 나오면 여러 건으로', many.length === 3, `${many.length}건`);
  ok('몇 번째인지 제목에 적는다', /\(1\/3\)/.test(many[0].title), many[0].title);
  ok('자리가 서로 다르다', new Set(many.map((h) => h.at)).size === 3,
    many.map((h) => h.at).join(','));
  ok('건마다 그 자리를 짚는다', many.every((h) => h.snippet.match === '화상센터'),
    many.map((h) => h.snippet.match).join(' / '));
  delete globalThis.__F['02_Wiki/응급_중환자/반복.md'];
}

// ★★ 자소가 갈라진 글자(NFD)가 섞여 있어도 **칠하는 자리가 안 어긋난다**.
//    "화상센터"를 찾았는데 "센터 이송"이 노랗게 칠해지던 버그(2026-10-14 신고).
{
  const nfd = (t) => t.normalize('NFD');
  globalThis.__F['02_Wiki/응급_중환자/자소.md'] =
    nfd('앞에 오는 긴 글입니다. 화상센터 이송 기준을 본다.');
  const [h] = await S.search('화상센터');
  ok('자소가 갈라져 있어도 찾는다', !!h, h ? 'ok' : '못 찾음');
  ok('**칠하는 자리가 정확하다**', h && h.snippet.match.normalize('NFC') === '화상센터',
    h ? JSON.stringify(h.snippet.match) : '');
  ok('앞부분도 밀리지 않는다',
    h && /기준을 본다/.test(h.snippet.after.normalize('NFC')) === false
      ? true
      : !!(h && h.snippet.before.normalize('NFC').endsWith('글입니다. ')),
    h ? JSON.stringify(h.snippet.before.normalize('NFC').slice(-12)) : '');
  delete globalThis.__F['02_Wiki/응급_중환자/자소.md'];
}

// 한 노트가 결과를 다 먹지 않는다
{
  globalThis.__F['02_Wiki/응급_중환자/많이.md'] = '열사병 '.repeat(40);
  const many = await S.search('열사병', 40);
  ok('한 노트는 최대 8건까지만', many.filter((h) => /많이/.test(h.path)).length <= 8,
    `${many.filter((h) => /많이/.test(h.path)).length}건`);
  delete globalThis.__F['02_Wiki/응급_중환자/많이.md'];
}

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
