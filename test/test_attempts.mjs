// 문항 이력 → "다시 볼 문항" 선별·순서, 그리고 시간표 파싱을 실제 vault 파일로 검증.
//
// 왜 이걸 테스트하나: 어떤 문항을 다시 꺼내는지가 공부 효과를 그대로 가른다. 찍어서
// 맞춘 문항을 놓치거나, 방금 틀린 것만 되풀이하면(정답 번호 암기) 기능이 있어도 무용하다.
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
const VAULT = '/Users/hyunminkang/Documents/Medical_vault';
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

const A = await import(pathToFileURL(`${PWA}/js/attempts.js`).href);

// reader.js는 브라우저 모듈을 import하므로 스텁으로 치환한 복사본을 쓴다.
global.document = { createElement: () => ({ className: '', textContent: '' }), addEventListener() {}, removeEventListener() {} };
const src = readFileSync(`${PWA}/js/reader.js`, 'utf8')
  .replace("import { listDir, getText, getBlobUrl } from './github.js';",
    'const listDir=async()=>[],getText=async()=>"",getBlobUrl=async()=>"";')
  .replace("import { kvGet, kvSet } from './db.js';",
    'const _kv={};const kvGet=async(k)=>_kv[k],kvSet=async(k,v)=>{_kv[k]=v;};');
const shim = `${PWA}/js/__t_att.mjs`;
writeFileSync(shim, src);
let R;
try { R = await import(pathToFileURL(shim).href); } finally { rmSync(shim, { force: true }); }

const NOW = Date.parse('2026-10-13T20:00:00');
const ago = (ms) => NOW - ms;
const mk = (id, over = {}) => ({
  id, exam: over.exam || 'E1', num: Number(id.split('#')[1] || 1),
  subject: over.subject || '응급_중환자', kind: '모의고사', title: 'T',
  n: 1, wrongN: 0, unsureN: 0,
  last: { at: ago(A.DAY * 2), picked: 0, correct: true, unsure: false },
  ...over,
});

// ---------- 무엇이 "약한 문항"인가 ----------
{
  const solid = mk('E1#1');
  const wrong = mk('E1#2', { wrongN: 1, last: { at: ago(A.DAY * 2), picked: 0, correct: false, unsure: false } });
  const lucky = mk('E1#3', { unsureN: 1, last: { at: ago(A.DAY * 2), picked: 1, correct: true, unsure: true } });

  ok('확신 있는 정답은 큐에서 내려간다', !A.isWeak(solid) && A.isSolid(solid));
  ok('오답은 약한 문항', A.isWeak(wrong));
  ok('찍어서 맞춘 것도 약한 문항', A.isWeak(lucky), '이게 빠지면 확신도 기능이 무의미하다');
  ok('찍어서 맞춘 것은 solid가 아니다', !A.isSolid(lucky));
  ok('한 번도 안 푼 문항은 약하지도 않다', !A.isWeak({ id: 'x' }) && !A.isWeak(null));
}

// ---------- 순서 ----------
{
  const freshWrong = mk('E1#1', { wrongN: 1, last: { at: ago(1000), picked: 0, correct: false, unsure: false } });
  const agedWrong = mk('E1#2', { wrongN: 1, last: { at: ago(A.DAY * 3), picked: 0, correct: false, unsure: false } });
  const agedLucky = mk('E1#3', { unsureN: 1, last: { at: ago(A.DAY * 3), picked: 0, correct: true, unsure: true } });

  ok('하루 지난 오답이 방금 틀린 것보다 먼저',
    A.weakScore(agedWrong, NOW) > A.weakScore(freshWrong, NOW),
    '틀린 직후 다시 풀면 정답 번호를 외우는 것에 가깝다');
  ok('오답이 찍어서 맞춘 것보다 먼저',
    A.weakScore(agedWrong, NOW) > A.weakScore(agedLucky, NOW));

  const leech = mk('E1#4', { wrongN: 4, last: { at: ago(A.DAY * 3), picked: 0, correct: false, unsure: false } });
  ok('반복해서 틀리는 문항이 앞으로 당겨진다',
    A.weakScore(leech, NOW) > A.weakScore(agedWrong, NOW));

  const q = A.weakQueue([freshWrong, agedLucky, agedWrong, leech], { now: NOW });
  ok('큐 순서: leech → 묵은 오답 → 방금 오답 → 찍은 것',
    q.map((x) => x.id).join(',') === 'E1#4,E1#2,E1#1,E1#3', q.map((x) => x.id).join(','));
  ok('solid는 큐에 없다', !A.weakQueue([mk('E1#9')], { now: NOW }).length);
}

// ---------- 과목으로 좁히기 ----------
{
  const list = [
    mk('A#1', { subject: '응급_중환자', last: { at: ago(A.DAY), correct: false, picked: 0, unsure: false } }),
    mk('B#1', { subject: '근골격계', exam: 'E2', last: { at: ago(A.DAY), correct: false, picked: 0, unsure: false } }),
    mk('A#2', { subject: '응급_중환자', last: { at: ago(A.DAY), correct: true, picked: 0, unsure: true } }),
    mk('A#3', { subject: '응급_중환자' }),
  ];
  ok('과목으로 좁힌다', A.weakQueue(list, { subject: '응급_중환자', now: NOW }).length === 2);
  ok('시험으로 좁힌다', A.weakQueue(list, { exam: 'E2', now: NOW }).length === 1);
  ok('limit이 듣는다', A.weakQueue(list, { limit: 1, now: NOW }).length === 1);

  const by = A.weakBySubject(list, NOW);
  const em = by.find((g) => g.subject === '응급_중환자');
  ok('과목 요약 — 약함 2 · 틀림 1 · 찍음 1', em.weak === 2 && em.wrong === 1 && em.unsure === 1,
    JSON.stringify(em));
  ok('과목 요약 — solid도 센다', em.solid === 1 && em.total === 3, JSON.stringify(em));
  ok('약한 문항 많은 과목이 위로', by[0].subject === '응급_중환자');

  const p = A.examProgress(list, 'E1');
  ok('시험 진도 — 본 3개 중 solid 1 · 약함 2', p.seen === 3 && p.solid === 1 && p.weak === 2,
    JSON.stringify(p));
}

// ---------- 시간표 파싱 (실제 vault 파일) ----------
{
  const dir = `${VAULT}/00_Raw_Text/시간표`;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  ok('시간표 파일이 있다', files.length >= 3, `${files.length}개`);

  const all = [];
  for (const f of files) {
    const got = R.parseSchedule(readFileSync(`${dir}/${f}`, 'utf8'));
    ok(`${f} 파싱됨`, got.length > 0, `${got.length}개`);
    ok(`${f} 날짜가 전부 YYYY-MM-DD`,
      got.every((g) => /^20\d{2}-\d{2}-\d{2}$/.test(g.date)),
      JSON.stringify(got.filter((g) => !/^20\d{2}-\d{2}-\d{2}$/.test(g.date)).slice(0, 2)));
    ok(`${f} 강의명이 비지 않는다`, got.every((g) => g.name && g.name.length > 1));
    all.push(...got.map((g) => ({ ...g, src: f })));
  }

  // 두경부 시간표는 `09-28(월)`처럼 연도가 없다 — 파일 안의 다른 날짜에서 연도를 빌려야 한다
  const dgb = all.filter((g) => g.src.includes('두경부'));
  ok('연도 없는 표도 2026년으로 채운다',
    dgb.length > 0 && dgb.every((g) => g.date.startsWith('2026-')),
    JSON.stringify(dgb.slice(0, 2)));

  // 응급중환자 10-13은 PBLS·응급의학개요·임상독성학 총론/각론 네 칸
  const d1013 = all.filter((g) => g.date === '2026-10-13');
  ok('10-13에 강의 4개', d1013.length === 4, `${d1013.length}개: ${d1013.map((x) => x.name).join(' / ')}`);
  ok('10-13 예습노트 링크가 붙는다',
    d1013.filter((g) => g.note).length === 4, JSON.stringify(d1013.map((g) => g.note)));
  ok('예습노트 링크가 실제 파일명 꼴',
    d1013.every((g) => /^\d{4}_응급중환자_/.test(g.note)), JSON.stringify(d1013.map((g) => g.note)));
  ok('교시·담당이 들어온다',
    d1013.every((g) => g.period) && d1013.every((g) => /응급의학과/.test(g.teacher)));

  // 시험·피드백·휴강·자습은 공부 대상이 아니라 강의로 세지 않는다
  ok('자기주도학습은 강의가 아니다', !all.some((g) => /자기주도학습/.test(g.name)));
  ok('종합시험·형성평가는 강의가 아니다',
    !all.some((g) => /시험|형성평가/.test(g.name)), JSON.stringify(all.filter((g) => /시험|형성평가/.test(g.name)).map((g) => g.name)));
  ok('피드백·휴강도 강의가 아니다',
    !all.some((g) => /피드백|휴강/.test(g.name)), JSON.stringify(all.filter((g) => /피드백|휴강/.test(g.name)).map((g) => g.name)));
  // 다만 이름에 '평가'가 들어간 **진짜 강의**는 남아야 한다 — 과잉 필터 방지
  ok('"중증도 분류 및 평가"는 강의로 남는다',
    all.some((g) => /중증도 분류 및 평가/.test(g.name)),
    '평가 한 단어로 거르면 실제 강의가 사라진다');

  // 파일명 앞 MMDD로 모의고사를 잇는다 — 오늘 탭이 이 규칙에 의존한다
  const examFiles = readdirSync(`${VAULT}/06_모의고사/응급_중환자`).filter((f) => f.endsWith('.html'));
  const keys = new Set(examFiles.map((f) => (f.match(/^(\d{4})_/) || [])[1]).filter(Boolean));
  const lectureDays = new Set(all.filter((g) => g.src.includes('응급'))
    .map((g) => g.date.slice(5, 7) + g.date.slice(8, 10)));
  const orphan = [...keys].filter((k) => !lectureDays.has(k));
  ok('모의고사 파일의 MMDD가 전부 강의일과 맞는다', orphan.length === 0, `고아: ${orphan.join(',')}`);

  // ---------- lecturesFor ----------
  const em = all.filter((g) => g.src.includes('응급'));
  const t = R.lecturesFor(em, Date.parse('2026-10-13T10:00:00'));
  ok('오늘 수업이 있으면 today', t.when === 'today' && t.date === '2026-10-13' && t.lectures.length === 4);

  const sat = R.lecturesFor(em, Date.parse('2026-10-11T10:00:00'));
  ok('강의 시작 전이면 다음 수업으로', sat.when === 'future' && sat.date === '2026-10-12',
    `${sat.when} ${sat.date}`);

  // 10-22는 시험(형성평가)과 강의(응급의료체계 정책과 법률)가 같이 있는 날이다 —
  // 시험 칸은 걸러지고 강의만 남아 10-22가 마지막 수업일이 된다.
  const after = R.lecturesFor(em, Date.parse('2026-10-25T10:00:00'));
  ok('강의가 끝난 뒤면 직전 수업으로', after.when === 'past' && after.date === '2026-10-22',
    `${after.when} ${after.date}`);
  ok('10-22에 남는 것은 강의 한 개',
    after.lectures.length === 1 && /정책과 법률/.test(after.lectures[0].name),
    JSON.stringify(after.lectures.map((l) => l.name)));

  ok('빈 시간표에서도 안 터진다', R.lecturesFor([], NOW).when === 'none');
  ok('null에서도 안 터진다', R.lecturesFor(null, NOW).lectures.length === 0);

  // dayKey는 UTC가 아니라 로컬 기준이어야 한다(한국에서 하루 밀리는 버그)
  ok('dayKey는 로컬 날짜', R.dayKey(Date.parse('2026-10-13T01:00:00')) === '2026-10-13',
    R.dayKey(Date.parse('2026-10-13T01:00:00')));
}

// ---------- 다음 시험 ----------
{
  const dir = `${VAULT}/00_Raw_Text/시간표`;
  const exams = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    exams.push(...R.parseExamDates(readFileSync(`${dir}/${f}`, 'utf8')).map((e) => ({ ...e, src: f })));
  }
  const next = R.nextExam(exams, Date.parse('2026-10-10T10:00:00'));
  ok('10/10 기준 다음 시험은 응급중환자 것', next && next.src.includes('응급'), JSON.stringify(next));
  ok('종합시험 10-23이 잡혀 있다', exams.some((e) => e.date === '2026-10-23'),
    JSON.stringify(exams.map((e) => e.date)));
}

// ---------- 노트에 손으로 쓴 Q&A → 카드 ----------
{
  // 포맷 변형을 손으로 짚는다
  const md = [
    '## 1. 천식의 진단',
    '',
    '### PFT 먼저',
    '**Q. 천식을 정의하는 3요소는?**',
    '🔴 **①기도의 만성 염증 ②기도과민성 ③가역적 기도폐쇄**. COPD도 ①②는 있다.',
    '',
    '**Q. 답이 여러 줄인 경우?**',
    '- 첫 줄',
    '- 둘째 줄',
    '',
    '**Q. 답이 없는 질문?**',
    '',
    '## 2. 다음 장',
    '**Q. 제목이 바뀌면 사슬도 바뀌나?**',
    '⭐ 바뀐다.',
    '',
  ].join('\n');
  const cs = R.qaCards(md, { path: '01_임종평_전범위/03_호흡기/02_천식.md', title: '02_천식' });

  ok('답 없는 질문은 카드가 안 된다', cs.length === 3, `${cs.length}장: ${cs.map((c) => c.question).join(' | ')}`);
  ok('질문에서 Q. 과 ** 를 뗀다', cs[0].question === '천식을 정의하는 3요소는?', cs[0].question);
  ok('답에서 마크다운·마커를 뗀다',
    cs[0].answers[0].startsWith('①기도의 만성 염증'), cs[0].answers[0].slice(0, 40));
  ok('🔴은 기출 근거로 기록된다', cs[0].examBacked === true && cs[0].starred === false);
  ok('⭐은 중요 표시로 기록된다', cs[2].starred === true && cs[2].examBacked === false);
  ok('제목 사슬이 붙는다', cs[0].heading === '1. 천식의 진단 › PFT 먼저', cs[0].heading);
  ok('제목이 바뀌면 사슬도 갈린다', cs[2].heading === '2. 다음 장', cs[2].heading);
  ok('여러 줄 답을 줄바꿈째로 담는다', cs[1].answers[0] === '- 첫 줄\n- 둘째 줄', JSON.stringify(cs[1].answers[0]));
  ok('카드 종류가 qa', cs.every((c) => c.kind === 'qa'));
  ok('카드 화면이 쓰는 필드가 다 있다',
    cs.every((c) => c.id && c.topic && c.contextHtml && c.answers.length === 1));
  ok('countQa가 카드 수와 맞는다', R.countQa(md) === cs.length, `${R.countQa(md)} vs ${cs.length}`);

  // 내용 안에 =나 *가 하나 섞인 경우 — 실제 노트에서 56장이 이 때문에 깨졌다
  const tricky = '**Q. 감마글로불린 패턴은?**\n==IgG↑=자가면역간염, IgM↑=PBC==. 끝.\n';
  const t = R.qaCards(tricky, {})[0];
  ok('==안에 = 가 있어도 기호를 벗긴다', !/==/.test(t.answers[0]), t.answers[0]);
  ok('내용은 보존된다', /IgG↑=자가면역간염/.test(t.answers[0]), t.answers[0]);

  const unbal = '**Q. 짝이 안 맞는 경우?**\n선행/악행금지가 우선한다== — 설명.\n';
  ok('짝 안 맞는 기호도 떼어낸다', !/==/.test(R.qaCards(unbal, {})[0].answers[0]));

  // HTML 주입 — 질문이 그대로 innerHTML로 들어가므로
  const xss = '**Q. <img src=x onerror=alert(1)>는?**\n답.\n';
  const x = R.qaCards(xss, {})[0];
  ok('질문을 HTML로 넣기 전에 이스케이프한다',
    x.contextHtml.includes('&lt;img') && !x.contextHtml.includes('<img'), x.contextHtml);

  // 너무 긴 답은 자른다
  const long = `**Q. 긴 답?**\n${'가'.repeat(1200)}\n`;
  const L = R.qaCards(long, {})[0];
  ok('너무 긴 답은 자르고 표시한다',
    L.truncated === true && L.answers[0].length <= R.QA_MAX + 2, `${L.answers[0].length}자`);

  // ---------- 실제 vault ----------
  const roots = ['01_임종평_전범위', '02_Wiki'];
  const all = [];
  let files = 0;
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${f.name}`;
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.md') && !f.name.startsWith('_')) {
        const got = R.qaCards(readFileSync(p, 'utf8'), { path: p.replace(`${VAULT}/`, ''), title: f.name });
        if (got.length) { files++; all.push(...got); }
      }
    }
  };
  roots.forEach((r) => walk(`${VAULT}/${r}`));

  ok('실제 노트에서 4,000장 넘게 나온다', all.length > 4000, `${all.length}장 / 파일 ${files}개`);
  ok('id가 겹치지 않는다', new Set(all.map((c) => c.id)).size === all.length,
    `${all.length - new Set(all.map((c) => c.id)).size}건 중복`);
  ok('마크다운 기호가 남은 카드가 없다',
    !all.some((c) => /\*\*|==|\[\[/.test(c.question) || /\*\*|==|\[\[/.test(c.answers[0])),
    JSON.stringify(all.filter((c) => /\*\*|==/.test(c.answers[0])).slice(0, 1).map((c) => c.question)));
  ok('질문이 비어 있는 카드가 없다', all.every((c) => c.question.length >= 3));
  ok('답이 비어 있는 카드가 없다', all.every((c) => c.answers[0].length >= 2));
  ok('모든 카드에 제목 사슬이 있다', all.every((c) => c.heading),
    `${all.filter((c) => !c.heading).length}장 없음`);
  const red = all.filter((c) => c.examBacked).length;
  ok('기출 근거(🔴) 카드가 절반 넘는다', red > all.length * 0.4, `${red}/${all.length}`);
  ok('잘린 카드는 드물다', all.filter((c) => c.truncated).length < all.length * 0.02,
    `${all.filter((c) => c.truncated).length}장`);
}

console.log(`test_attempts.mjs  ${fail.length ? '❌' : '✅'} ${pass}개 통과${fail.length ? `, ${fail.length}개 실패` : ''}`);
fail.forEach((f) => console.log('   ✗ ' + f));
process.exit(fail.length ? 1 : 0);
