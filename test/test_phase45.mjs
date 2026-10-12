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
// FSRS로 바꿨다(2026-10-10) — 상자 대신 S(안정성)·D(난이도)를 카드마다 들고 간다
const S1 = srs.c1.S;
R.gradeCard(srs, 'c1', true, { now: srs.c1.due });
ok('연속으로 맞히면 안정성이 커진다', srs.c1.S > S1, `${S1.toFixed(1)} → ${srs.c1.S.toFixed(1)}`);
const dueAt2 = srs.c1.due;
const D1 = srs.c1.D;
R.gradeCard(srs, 'c1', false, { now: srs.c1.due });
ok('틀리면 안정성이 줄어든다', srs.c1.S < 2, `S=${srs.c1.S.toFixed(2)}`);
ok('틀리면 난이도가 올라간다', srs.c1.D > D1, `${D1.toFixed(1)} → ${srs.c1.D.toFixed(1)}`);
ok('틀리면 내일 다시 본다',
  Math.round((srs.c1.due - srs.c1.last) / 86400000) === 1, `${Math.round((srs.c1.due - srs.c1.last) / 86400000)}일`);
ok('틀린 횟수가 쌓인다', srs.c1.lapses >= 1);

// 쉬운 카드와 어려운 카드의 간격이 갈린다 — Leitner가 못 하던 것
const fs3 = {};
let t3 = Date.now();
for (let i = 0; i < 4; i++) { R.gradeCard(fs3, 'easy', true, { now: t3 }); t3 = fs3.easy.due; }
let t4 = Date.now();
for (let i = 0; i < 4; i++) { R.gradeCard(fs3, 'hard', i >= 3, { now: t4 }); t4 = fs3.hard.due; }
const gap = (id) => Math.round((fs3[id].due - fs3[id].last) / 86400000);
ok('쉬운 카드는 간격이 길어진다', gap('easy') > gap('hard'), `쉬움 ${gap('easy')}일 vs 어려움 ${gap('hard')}일`);
ok('어려운 카드는 난이도가 높다', fs3.hard.D > fs3.easy.D, `${fs3.hard.D.toFixed(1)} vs ${fs3.easy.D.toFixed(1)}`);

// 시험 일정 연동 — 간격이 시험을 넘지 않는다.
// 간격이 길게 자란 카드(여러 번 맞혀 S가 큰 상태)라야 당기는 효과가 보인다.
const grow = (srsObj, opts) => {
  let t = Date.now();
  for (let i = 0; i < 6; i++) { R.gradeCard(srsObj, 'x', true, { now: t, ...opts }); t = srsObj.x.due; }
};
const fs6 = {};
grow(fs6, {});                                    // 시험 없음
const plainGap = Math.round((fs6.x.due - fs6.x.last) / 86400000);
// 같은 상태에서 "시험이 모레"일 때만 달라지는지 본다(지금 시점 고정)
const fs5 = { x: { ...fs6.x } };
const nowT = Date.now();
const examAt = nowT + 2 * 86400000;
R.gradeCard(fs5, 'x', true, { now: nowT, examAt });
const examGap = Math.round((fs5.x.due - nowT) / 86400000);
R.gradeCard(fs6, 'x', true, { now: nowT });
const plainGap2 = Math.round((fs6.x.due - nowT) / 86400000);
ok('복습이 시험 전으로 당겨진다', examGap < plainGap2, `시험있음 ${examGap}일 vs 없음 ${plainGap2}일`);
ok('시험 전에 한 번은 더 본다', fs5.x.due <= examAt, `${examGap}일 뒤 (시험 2일 뒤)`);

// 기억률 예측
ok('방금 본 카드는 기억률이 높다', R.retrievability(fs6.x) > 0.9);
ok('오래 안 본 카드는 기억률이 떨어진다',
  R.retrievability(fs6.x, Date.now() + 400 * 86400000) < 0.5);

// 시간표에서 시험일 읽기
const tt = ['| 날짜 | 요일 | 교시 | 주제 |', '|---|---|---|---|',
  '| 2026-10-14 | 수 | 1 | 중환자실의 구조와 운영 & 중증도 분류 및 평가 |',
  '| 2026-10-23 | 금 | 2~3 | 종합 시험(90분) |'].join('\n');
const exams = R.parseExamDates(tt);
ok('시험만 골라낸다(강의 제목 제외)', exams.length === 1 && /종합 시험/.test(exams[0].name),
  exams.map((e) => e.name).join(','));
ok('다음 시험을 찾는다', R.nextExam(exams, Date.parse('2026-10-20')).date === '2026-10-23');
ok('지난 시험은 안 고른다', R.nextExam(exams, Date.parse('2026-11-01')) === null);

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

// ── 시간표: 실강노트·족보 칸까지 읽는가 (2026-10-12) ──
// 수업을 듣고 /lecture-integrate로 위키를 만들어도 "오늘" 탭에 예습노트만 떴다.
// 시간표에는 `실강(02_Wiki)`·`가공족보` 칸이 이미 채워져 있는데 안 읽고 있었다.
{
  const md = [
    '| 날짜 | 교시 | 강의명 | 담당 | 가공족보 | 예습노트 | 실강(02_Wiki) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 2026-10-12 | 2~3 | 기본소생술(BLS) | 곽세정 | 02_기본소생술_BLS.md | ✅ [[1012_응급중환자_기본소생술BLS]] | ✅ [[응급중환자_기본소생술BLS]] (왕족 확정) |',
    '| 2026-10-12 | 8~9 | 환경의학 | 송명제 | 10_환경의학.md | ✅ [[1012_응급중환자_환경의학]] | — |',
  ].join('\n');
  const rows = R.parseSchedule(md);
  ok('강의 2개를 읽는다', rows.length === 2, String(rows.length));
  ok('예습노트 칸', rows[0].note === '1012_응급중환자_기본소생술BLS', rows[0].note);
  ok('실강(02_Wiki) 칸', rows[0].wiki === '응급중환자_기본소생술BLS', rows[0].wiki);
  ok('가공족보 칸은 위키링크가 아니라 파일명', rows[0].jokbo === '02_기본소생술_BLS.md', rows[0].jokbo);
  ok('실강이 아직 없으면 빈 값(— 를 노트로 오인하지 않는다)', rows[1].wiki === '', `"${rows[1].wiki}"`);
  ok('족보만 있는 강의도 읽는다', rows[1].jokbo === '10_환경의학.md', rows[1].jokbo);
}

// ── 덱(폴더) 트리 · 보관 (2026-10-12) ──
// 카드 5,000장을 한 바구니에 두면 "두경부는 끝났는데 왜 아직 나오나"가 된다.
// 출처 폴더를 그대로 덱으로 쓰고, 끝난 과목은 보관함으로 접는다.
{
  const mk = (path, i) => ({ id: `qa:${path}#${i}`, kind: 'qa', notePath: path, noteTitle: 't',
    contextHtml: 'q', answers: ['a'] });
  const cards = [
    ...Array.from({ length: 3 }, (_, i) => mk('98_예습노트_보관/응급_중환자/1015_응급중환자_ACLS.md', i)),
    ...Array.from({ length: 2 }, (_, i) => mk('98_예습노트_보관/응급_중환자/1021_응급중환자_ECMO.md', i)),
    ...Array.from({ length: 4 }, (_, i) => mk('02_Wiki/두경부_피부/두경부피부_중이염.md', i)),
    ...Array.from({ length: 2 }, (_, i) => mk('02_Wiki/두경부_피부/QA/두경부피부_중이염_QA.md', i)),
    { id: 'box:1', contextHtml: 'q', answers: ['a'] },        // notePath 없는 카드
  ];

  // 번호로 집으면 개수를 하나만 바꿔도 조용히 다른 카드를 보게 된다 — 경로로 집는다
  const pick = (frag) => cards.find((c) => String(c.notePath || '').includes(frag));
  const d = R.deckOf(pick('1015_응급중환자_ACLS'));
  ok('덱 좌표 — 과목', d.subject === '응급_중환자', d.subject);
  ok('덱 좌표 — 노트', d.note === '1015_응급중환자_ACLS', d.note);
  const qa = R.deckOf(pick('/QA/'));
  ok('QA 하위폴더는 꼬리표로 단다', qa.subject === '두경부_피부' && qa.group === 'QA',
    `${qa.subject}/${qa.group}`);
  ok('출처 없는 카드는 기타로',
    R.deckOf(cards.find((c) => !c.notePath)).subject === R.OTHER_DECK);

  const tree = R.deckTree(cards, {});
  const byName = Object.fromEntries(tree.map((t) => [t.subject, t]));
  ok('과목 트리를 만든다', tree.length === 3, tree.map((t) => t.subject).join(','));
  ok('같은 과목은 루트가 달라도 한 칸으로 합친다',
    byName['두경부_피부'].n === 6, String(byName['두경부_피부'] && byName['두경부_피부'].n));
  ok('과목 아래에 노트가 달린다', byName['응급_중환자'].notes.length === 2);
  ok('노트는 배운 순서대로(날짜 오름차순)',
    byName['응급_중환자'].notes[0].name.startsWith('1015'), byName['응급_중환자'].notes[0].name);
  ok('새 카드는 전부 오늘 볼 것', byName['응급_중환자'].due === 5, String(byName['응급_중환자'].due));

  // ── 보관 ──
  // 3(ACLS) + 2(ECMO) + 4(중이염) + 2(중이염 QA) + 1(출처 없음) = 12장
  ok('준비한 카드 수', cards.length === 12, `${cards.length}장`);
  const archived = new Set([R.subKey('두경부_피부')]);
  const live = R.liveCards(cards, archived);
  ok('보관한 과목은 빠진다(QA본까지 같이)', live.length === 6, `${live.length}장`);
  ok('보관해도 카드 자체는 남는다', cards.length === 12);
  ok('보관 판정',
    R.isArchivedCard(archived, pick('두경부피부_중이염')) && !R.isArchivedCard(archived, pick('ACLS')));
  ok('오늘 볼 것에서도 빠진다', R.dueToday(live, {}).length === 6, `${R.dueToday(live, {}).length}장`);

  // 노트 하나만 보관할 수도 있다 — ACLS 3장만 빠진다
  const one = new Set([R.noteKey(pick('1015_응급중환자_ACLS'))]);
  ok('노트 단위 보관', R.liveCards(cards, one).length === 9, `${R.liveCards(cards, one).length}장`);

  const t2 = R.deckTree(cards, {}, { archived });
  ok('트리가 보관 상태를 표시한다',
    t2.find((t) => t.subject === '두경부_피부').archived === true);
  ok('보관된 과목은 아래로 내려간다', t2[t2.length - 1].subject === '두경부_피부', t2.map((x) => x.subject).join(','));
  ok('보관된 과목의 노트도 보관으로 표시된다',
    t2.find((t) => t.subject === '두경부_피부').notes.every((n) => n.archived));

  // ── 덱으로 거르기 ──
  ok('과목으로 거른다', R.cardsInDeck(cards, R.subKey('응급_중환자')).length === 5);
  ok('노트로 거른다', R.cardsInDeck(cards, R.noteKey(pick('1015_응급중환자_ACLS'))).length === 3);
  ok('키가 없으면 전부', R.cardsInDeck(cards, null).length === 12);
}

// ── 노트 이름 찾기(findNoteInGroups) — "오늘" 탭 ↻ 자동 복구의 바탕 (2026-10-12) ──
// 실제 증상: vault에 새 노트를 올리고 ↻ 를 눌러도 "노트를 찾지 못했습니다"가 떴다.
// (quit+재실행은 되는데 ↻ 로는 안 됨 — note_index 캐시가 ↻ 의 대상이 아니었다.)
// app.js의 openNoteByName은 이 함수로 먼저 찾고, 없으면 noteList(true)로 한 번 더 본다.
{
  const groups = [
    { root: '02_Wiki', subject: '응급_중환자', notes: [
      { name: '응급중환자_기본소생술BLS', path: '02_Wiki/응급_중환자/응급중환자_기본소생술BLS.md' },
    ] },
  ];
  ok('이름으로 노트를 찾는다',
    R.findNoteInGroups(groups, '응급중환자_기본소생술BLS').path
      === '02_Wiki/응급_중환자/응급중환자_기본소생술BLS.md');
  ok('NFD로 와도 찾는다(한글 정규화)',
    !!R.findNoteInGroups(groups, '응급중환자_기본소생술BLS'.normalize('NFD')));
  ok('없으면 null — 호출 쪽이 이걸로 "한 번 더 볼지" 판단한다',
    R.findNoteInGroups(groups, '방금생긴노트') === null);
  ok('빈 목록도 터지지 않는다', R.findNoteInGroups([], '아무거나') === null);
  ok('groups가 없어도 터지지 않는다', R.findNoteInGroups(undefined, '아무거나') === null);
}

// ── MarginNote 슬라이드 링크 (2026-10-12) ──
// 위키에 이미 깔린 `[슬라이드 p.12]` 1,400여 개를 눌러서 MarginNote의 그 쪽으로 간다.
// 스킴은 MarginNote 4 앱 바이너리에 문서화된 것을 그대로 쓴다:
//   marginnote4app://page/{md5}/p12 · /p10-15 · /p4,7 · md5가 '0'이면 "지금 열린 문서"
{
  const { renderMarkdown, setSlideDoc } = await import(`${PWA}/js/markdown.js`);

  // ⚠️ 지금은 **꺼져 있다**(markdown.js의 SLIDE_LINKS=false). `page/...` 포맷이
  //    MarginNote 앱 바이너리에 적혀 있긴 한데 MCP(AI 도구)용 ID 표기였고, URL
  //    스킴으로는 앱만 열리고 그 페이지로 가지 않는다(맥·아이패드 둘 다 확인).
  //    "열리긴 하는데 안 간다"가 제일 헷갈리는 모양이라 링크를 아예 안 만든다.
  setSlideDoc(null);
  const plain = renderMarkdown('가슴압박 깊이는 5~6cm다. [슬라이드 p.12]');
  ok('지금은 링크를 만들지 않는다(안 가는 링크를 두지 않는다)',
    !/<a class="slide-link"/.test(plain), plain.slice(0, 80));
  ok('표기 글자는 그대로 남는다(어느 슬라이드인지는 계속 보인다)', /슬라이드 p\.12/.test(plain));

  // 쪽 번호 해석은 살아 있다 — 맞는 라우트를 찾으면 상수만 켜면 된다
  const src = readFileSync(`${PWA}/js/markdown.js`, 'utf8');
  ok('링크를 켜고 끄는 스위치가 한 군데다', /const SLIDE_LINKS = false/.test(src));
  ok('왜 껐는지 코드에 남아 있다', /MCP\(AI 도구\) 서버가 쓰는 ID 표기/.test(src));
  ok('단일 쪽·범위·여러 쪽 해석이 남아 있다',
    /p\$\{range\[1\]\}-\$\{range\[2\]\}/.test(src) && /p\$\{list\.join\(','\)\}/.test(src));

  // frontmatter에서 PDF 이름 뽑기 — 공백이 들어간 이름이 흔하다
  ok('frontmatter의 PDF 이름을 읽는다',
    R.sourcePdf('---\nsource:\n  - "260914_Gen. P. Tumors_정환용.pdf (원본 69p)"\n---\n# 제목')
      === '260914_Gen. P. Tumors_정환용.pdf');
  ok('PDF가 없으면 null', R.sourcePdf('---\ntags: [a]\n---\n본문') === null);
  ok('frontmatter가 없어도 안 터진다', R.sourcePdf('그냥 본문') === null);

  // iCloud가 만드는 "… 2.pdf" 중복까지 찾아낸다(실측 56개 중 22개가 이 꼴)
  const docs = {
    '260914_Gen. P. Tumors_정환용.pdf': 'aaa111',
    '260911_근골격계_임상미생물_260911_강의용_김자영 2.pdf': 'bbb222',
  };
  ok('이름이 똑같으면 찾는다', R.findMnDoc(docs, '260914_Gen. P. Tumors_정환용.pdf') === 'aaa111');
  ok('iCloud "… 2.pdf" 중복도 찾는다',
    R.findMnDoc(docs, '260911_근골격계_임상미생물_260911_강의용_김자영.pdf') === 'bbb222');
  ok('없으면 null(엉뚱한 문서를 열지 않는다)', R.findMnDoc(docs, '전혀다른강의.pdf') === null);
  ok('맵이 비어도 안 터진다', R.findMnDoc({}, 'x.pdf') === null && R.findMnDoc(null, 'x.pdf') === null);
}

// ── 실제 vault로: 슬라이드 표기가 정말 링크가 되는가 ──
{
  const { renderMarkdown, setSlideDoc } = await import(`${PWA}/js/markdown.js`);
  const mapPath = `${VAULT}/.medstudy/marginnote_docs.json`;
  let docs = null;
  if (existsSync(mapPath)) docs = JSON.parse(readFileSync(mapPath, 'utf8')).docs;
  ok('vault에 MarginNote 문서 맵이 있다(맥에서 export 실행됨)', !!docs && Object.keys(docs).length > 0,
    docs ? `${Object.keys(docs).length}건` : '없음 — export_marginnote_map.py를 돌릴 것');

  if (docs) {
    const notes = [];
    for (const root of ['02_Wiki', '98_예습노트_보관']) {
      const base = `${VAULT}/${root}`;
      if (!existsSync(base)) continue;
      for (const sub of readdirSync(base)) {
        const dir = `${base}/${sub}`;
        let files;
        try { files = readdirSync(dir); } catch { continue; }
        for (const f of files) if (f.endsWith('.md')) notes.push(`${dir}/${f}`);
      }
    }
    let withSlides = 0, linked = 0, marks = 0;
    for (const p of notes) {
      const md = readFileSync(p, 'utf8');
      if (!md.includes('[슬라이드 p.')) continue;
      withSlides++;
      marks += (md.match(/\[슬라이드\s*p\./g) || []).length;
      if (R.findMnDoc(docs, R.sourcePdf(md))) linked++;
    }
    ok('슬라이드 표기가 있는 노트가 여럿이다', withSlides >= 20, `${withSlides}개`);
    ok('표기가 1,000개 넘게 쌓여 있다(새로 넣을 필요 없다)', marks >= 1000, `${marks}개`);
    ok('절반 이상이 MarginNote 문서로 이어진다', linked >= withSlides / 2,
      `${linked}/${withSlides}개`);
    console.log(`  슬라이드 표기 ${marks}개 · 노트 ${withSlides}개 중 ${linked}개가 MarginNote로 연결`);

    // 실제 노트 줄이 그대로 읽히는지(링크가 꺼져 있어도 글은 멀쩡해야 한다)
    const sample = notes.find((p) => readFileSync(p, 'utf8').includes('[슬라이드 p.'));
    const md = readFileSync(sample, 'utf8');
    setSlideDoc(R.findMnDoc(docs, R.sourcePdf(md)));
    const line = md.split('\n').find((l) => /\[슬라이드\s*p\.\s*\d/.test(l));
    const html = renderMarkdown(line);
    ok('실제 노트 줄에 슬라이드 표기가 그대로 보인다', /슬라이드\s*p\.\s*\d/.test(html),
      html.slice(0, 70));
    ok('안 가는 링크를 만들지 않는다', !/marginnote4app/.test(html));
    setSlideDoc(null);
  }
}

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
