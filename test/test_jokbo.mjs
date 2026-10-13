// 족보(학교 기출) 파서 — 실제 vault의 가공본 21챕터로 검증.
//
// 왜 실제 파일로 도는가: 족보는 사람이 PDF를 보고 손으로 옮긴 마크다운이라
// "형식이 일정하다"는 전제가 언제든 깨진다. 만들어낸 샘플로 통과해봐야
// 실제 파일에서 문항이 통째로 사라지면 알 길이 없다.

import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
const V = '/Users/hyunminkang/Documents/Medical_vault';
const DIR = `${V}/00_Raw_Text/기출문제_학교/응급_중환자`;
const REL = '00_Raw_Text/기출문제_학교/응급_중환자';

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

const src = readFileSync(`${PWA}/js/jokbo.js`, 'utf8')
  .replace("import { listDir, getText } from './github.js';", 'const listDir=async()=>[],getText=async()=>"";');
const shim = `${PWA}/js/__t_jokbo.mjs`;
writeFileSync(shim, src);
let J;
try { J = await import(pathToFileURL(shim).href); } finally { rmSync(shim, { force: true }); }

// ── 조각 함수 ──
ok('선지 줄 — "1. 본문"', JSON.stringify(J.optionLine('1. 선지가')) === '[1,"선지가"]');
ok('선지 줄 — "2) 본문"', JSON.stringify(J.optionLine('2) 선지나')) === '[2,"선지나"]');
ok('선지 줄 — "③ 본문"', JSON.stringify(J.optionLine('③ 선지다')) === '[3,"선지다"]');
ok('선지 아닌 줄', J.optionLine('그냥 평범한 문장이다.') === null);
ok('7번 이상은 선지가 아니다', J.optionLine('9. 뭔가') === null);

ok('정답 "3"', J.answerIndex('3') === 2);
ok('정답 "3번"', J.answerIndex('3번') === 2);
ok('정답 "③"', J.answerIndex('③') === 2);
ok('정답 "5 (VF)"', J.answerIndex('5 (VF)') === 4);
ok('정답이 글이면 -1', J.answerIndex('숫자가 아닌 서술형 정답') === -1);
ok('정답이 비면 -1', J.answerIndex('') === -1);

// ★ 복수정답 — 족보에 제일 흔한 함정. 하나만 보면 나머지를 고른 사람이 억울하게 틀린다.
ok('"2, 4" → 둘 다 정답', String(J.answerIndices('2, 4')) === '1,3');
ok('"1,3,5" (공백 없이)', String(J.answerIndices('1,3,5')) === '0,2,4');
ok('"3 · 5"', String(J.answerIndices('3 · 5')) === '2,4');
ok('"②④"', String(J.answerIndices('②④')) === '1,3');
ok('뒤에 말이 붙어도 번호까지만', String(J.answerIndices('2, 4 (최초 항목 참조 — 위 6번과 동일)')) === '1,3');
ok('"3번??(확실한 듯?)" 은 3번 하나', String(J.answerIndices('3번??(확실한 듯?)')) === '2');
ok('"5 (VF)" 는 5번 하나', String(J.answerIndices('5 (VF)')) === '4');
ok('서술형은 빈 배열', J.answerIndices('급성 전격성 심근염').length === 0);

{
  // ⚠️ 이 저장소는 공개다 — 예시 지문은 의학 내용이 아니라 **형식만** 흉내 낸 가짜를 쓴다.
  //    진짜 문항으로 도는 검사는 아래 "실제 vault 전수"가 맡는다(내용은 안 남긴다).
  const { stem, opts } = J.splitStemOptions(
    '지문 한 줄.\n1. 선지가\n2. 선지나\n3. 선지다\n4. 선지라\n5. 선지마');
  ok('지문과 선지를 가른다', stem === '지문 한 줄.' && opts.length === 5,
    `${opts.length}개 / ${stem.slice(0, 20)}`);
}
{
  // 본문 중간의 열거("1. 먼저")를 선지로 오인하면 안 된다 — 1로 시작해도 2,3,4가 안 이어진다
  const { opts } = J.splitStemOptions('순서는 1. 먼저 이것을 하고 그다음 저것을 한다.\n답을 고르시오.');
  ok('본문 속 열거는 선지가 아니다', opts.length === 0, `${opts.length}개`);
}
{
  const { opts } = J.splitStemOptions('지문\n1. 가\n2. 나\n3. 다');
  ok('선지가 3개뿐이면 안 받는다(오인 방지)', opts.length === 0, `${opts.length}개`);
}

// ── 실제 vault 전수 ──
if (!existsSync(DIR)) {
  console.log('⏭  vault 족보 폴더가 없어 전수 검증은 건너뜁니다');
} else {
  const files = readdirSync(DIR).filter((f) => /^\d{2}_.+\.md$/.test(f) && !f.startsWith('00_')).sort();
  ok('챕터 파일을 찾는다(20개 이상)', files.length >= 20, `${files.length}개`);

  let total = 0, mc = 0, open = 0, imgs = 0;
  const problems = [];
  for (const f of files) {
    const { title, questions } = J.parseJokbo(readFileSync(`${DIR}/${f}`, 'utf8'), `${REL}/${f}`);
    if (!title) problems.push(`${f}: 제목 없음`);
    if (!questions.length) problems.push(`${f}: 문항 0개`);
    total += questions.length;
    for (const q of questions) {
      if (q.type === 'mc') {
        mc++;
        if (q.opts.length < 4) problems.push(`${f} #${q.num}: 선지 ${q.opts.length}개`);
        if (!(q.ans >= 0 && q.ans < q.opts.length)) problems.push(`${f} #${q.num}: 정답 범위 밖(${q.ans})`);
      } else open++;
      if (!q.q || q.q.length < 4) problems.push(`${f} #${q.num}: 지문 없음`);
      if (!q.source) problems.push(`${f} #${q.num}: 출처 없음`);
      for (const p of q.imgs) {
        imgs++;
        if (!p.startsWith(REL + '/images/')) problems.push(`${f} #${q.num}: 이미지 경로가 vault 기준이 아니다 — ${p}`);
        if (!existsSync(`${V}/${p}`)) problems.push(`${f} #${q.num}: 이미지 파일 없음 — ${p}`);
      }
    }
  }
  ok('21챕터가 전부 파싱된다', problems.length === 0, problems.slice(0, 5).join(' / '));
  ok('문항이 600개 넘게 나온다', total >= 600, `${total}개`);
  ok('채점 가능한 객관식이 400개 넘는다', mc >= 400, `${mc}개`);
  ok('서술형 복원도 버리지 않는다', open >= 100, `${open}개`);
  ok('이미지가 100장 넘게 붙는다', imgs >= 100, `${imgs}장`);
  console.log(`  실측: ${total}문항 (객관식 ${mc} · 읽기 ${open}) · 이미지 ${imgs}장`);

  // ★ 가장 위험한 것: 지문·선지에 정답이 섞여 들어가는 것.
  //   족보 원문은 블록 끝이 "답:" "해설:"이라 잘못 자르면 답이 그대로 보인다.
  const LEAK = /(^|\n)\s*(답\s*[:(（]|정답\s*[:(（]|해설\s*[:：]|답은\s|정답은\s)/;
  const leaks = [];
  for (const f of files) {
    for (const q of J.parseJokbo(readFileSync(`${DIR}/${f}`, 'utf8'), `${REL}/${f}`).questions) {
      if (q.type !== 'mc') continue;                      // 읽기 문항은 답이 보여도 된다
      if (LEAK.test(`${q.q}\n${q.opts.join('\n')}`)) leaks.push(`${f} #${q.num}`);
    }
  }
  ok('객관식 지문·선지에 정답이 새지 않는다', leaks.length === 0, leaks.slice(0, 4).join(' / '));

  // 해설에는 원문·검증·교정이 모두 담겨야 한다(가공본의 핵심 가치)
  const ecmo = `${DIR}/16_체외막산소장치_ECMO.md`;
  if (existsSync(ecmo)) {
    const { questions } = J.parseJokbo(readFileSync(ecmo, 'utf8'), `${REL}/16_체외막산소장치_ECMO.md`);
    const withVerify = questions.filter((q) => /검증 —/.test(q.explain)).length;
    ok('해설에 검증 결과가 붙는다', withVerify >= questions.length - 2, `${withVerify}/${questions.length}`);
    const openOne = questions.find((q) => q.type === 'open');
    ok('읽기 문항은 정답을 해설에 담는다', openOne && /정답\(족보\)/.test(openOne.explain));
    ok('출처에 연도와 교수가 들어간다', /족보 \d{4} · /.test(questions[0].source), questions[0].source);
  }
}

// ── 원문이 통째로 사라지는 곳이 없는가(2026-10-13 전수 대조) ──
if (existsSync(DIR)) {
  const files = readdirSync(DIR).filter((f) => /^\d{2}_.+\.md$/.test(f) && !f.startsWith('00_')).sort();
  const norm = (x) => String(x).normalize('NFC').replace(/[\s*`>#_\-–—·…"'“”‘’()[\]{}]/g, '');
  let blocks = 0, qs = 0, multi = 0, introChars = 0;
  const lost = [];
  for (const f of files) {
    const md = readFileSync(`${DIR}/${f}`, 'utf8').replace(/\r\n/g, '\n');
    const { questions, intro } = J.parseJokbo(md, `${REL}/${f}`);
    blocks += md.split(/\n(?=##\s*\[)/).length - 1;
    qs += questions.length;
    multi += questions.filter((q) => q.ansAll).length;
    introChars += (intro || '').length;
    const all = questions.map((q) => norm(`${q.q}\n${q.opts.join('\n')}\n${q.explain}`)).join('\n');
    for (const b of md.split(/\n(?=##\s*\[)/).slice(1)) {
      for (const m of b.matchAll(/^\*\*(.+?)\*\*\s*[:：]?\s*([\s\S]*?)(?=\n\*\*|\n---|\n##|$)/gm)) {
        const name = m[1].split('(')[0].trim();
        if (name === '첨부 이미지') continue;        // 그림은 q.imgs로 따로 간다(위에서 전수 확인)
        const val = norm(m[2]);
        if (val.length < 8) continue;
        if (!all.includes(val.slice(0, 40))) lost.push(`${f} · ${name}: ${m[2].trim().slice(0, 30)}`);
      }
    }
  }
  ok('블록 하나가 문항 하나가 된다(빠짐없이)', blocks === qs, `${blocks}블록 → ${qs}문항`);
  ok('**원문 어느 필드도 사라지지 않는다**', lost.length === 0, lost.slice(0, 3).join(' / '));
  ok('복수정답 문항을 살려낸다(100개 이상)', multi >= 100, `${multi}개`);
  ok('챕터 출제 경향이 앱으로 간다(2만 자 이상)', introChars >= 18000, `${introChars}자`);
  console.log(`  실측: 복수정답 ${multi}문항 · 챕터 머리말 ${introChars}자`);
}

// 과목마다 가공본이 조금씩 다르다 — 모르는 필드도 버리지 않는다
{
  const { questions } = J.parseJokbo(
    '# 제목\n\n## [2022 · 김] 1번\n\n**문제**\n지문\n1. 가\n2. 나\n3. 다\n4. 라\n\n'
    + '**정답 (족보)**: 2\n\n**2022 스캔 원본 대조 결과**: 스캔본과 글자까지 같다\n', 'x/01_a.md');
  ok('처음 보는 필드도 해설에 남는다',
    /2022 스캔 원본 대조 결과 — 스캔본과 글자까지 같다/.test(questions[0].explain),
    questions[0].explain.slice(0, 50));
  ok('정답 번호만 있으면 해설에 또 적지 않는다', !/정답\(족보\)/.test(questions[0].explain));
}

// ── 챕터 ↔ 강의 노트 짝짓기 ──
{
  const ws = readFileSync(`${PWA}/js/wiki.js`, 'utf8')
    .replace("import { listDir, getText } from './github.js';",
      'const listDir=async(p)=>((globalThis.__FS||{})[p]||[]),getText=async()=>"";')
    .replace("import { linkedNoteFromMd } from './parser.js';", 'const linkedNoteFromMd=()=>null;');
  const wshim = `${PWA}/js/__t_jw.mjs`;
  writeFileSync(wshim, ws);
  let W;
  try { W = await import(pathToFileURL(wshim).href); } finally { rmSync(wshim, { force: true }); }

  ok('이름이 같으면 1', W.nameSimilarity('16_체외막산소장치_ECMO', '1021_응급중환자_ECMO') === 1);
  ok('조사가 달라도 붙는다',
    W.nameSimilarity('13_중환자실환자의통증진정및섬망관리', '1016_응급중환자_중환자실통증진정섬망관리') >= 0.5);
  ok('남남은 안 붙는다', W.nameSimilarity('21_의료인문학', '1012_응급중환자_환경의학') < 0.5);
  ok('족보 경로를 알아본다',
    W.isJokboPath('00_Raw_Text/기출문제_학교/응급_중환자/16_x.md') && !W.isJokboPath('06_모의고사/a/b.html'));

  // 가짜 파일시스템으로 실제 짝짓기
  const dir = (n, p) => ({ type: 'dir', name: n, path: p });
  const file = (n, p) => ({ type: 'file', name: n, path: p });
  globalThis.__FS = {
    '98_예습노트_보관': [dir('응급_중환자', '98_예습노트_보관/응급_중환자')],
    '98_예습노트_보관/응급_중환자': [
      file('1021_응급중환자_ECMO.md', '98_예습노트_보관/응급_중환자/1021_응급중환자_ECMO.md'),
      file('1012_응급중환자_환경의학.md', '98_예습노트_보관/응급_중환자/1012_응급중환자_환경의학.md'),
    ],
    '02_Wiki': [], '01_임종평_전범위': [],
  };
  ok('족보 챕터가 예습노트로 이어진다',
    (await W.noteForJokbo('00_Raw_Text/기출문제_학교/응급_중환자/16_체외막산소장치_ECMO.md'))
      === '1021_응급중환자_ECMO');
  ok('맞는 노트가 없으면 null(엉뚱한 걸 띄우지 않는다)',
    (await W.noteForJokbo('00_Raw_Text/기출문제_학교/응급_중환자/21_의료인문학.md')) === null);
  delete globalThis.__FS;
}

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
