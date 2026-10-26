// 안정적 원본 문항 ID(qid) 배관 검증 — 즉석 랜덤 모의고사에서 같은 원본 문항이 다른
// 파일·다른 번호로 다시 뽑혀도 한 이력으로 이어지는지 확인한다(2026-10-26).
//
// 왜 따로 파일을 두나: parser.js는 DOM 의존이 없어 Node에서 바로 돌릴 수 있고,
// db.js의 attemptId는 indexedDB를 함수 안에서만 쓰므로(모듈 최상단에선 안 건드림)
// import만으로는 안 터진다 — 새 통합 하네스를 만드는 것보다 가볍다.
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

const { parseExamHtml } = await import(pathToFileURL(`${PWA}/js/parser.js`).href);
const { attemptId } = await import(pathToFileURL(`${PWA}/js/db.js`).href);

// ---------- parser.js가 id를 통과시키는가 ----------
{
  const withId = `<script>const QUESTIONS = [
    {num:1, type:'mc', q:'문제1', opts:['가','나','다'], ans:0, id:'알렌:foo.txt:5'}
  ];</script>`;
  const { questions } = parseExamHtml(withId);
  ok('id가 있으면 그대로 통과한다', questions[0].id === '알렌:foo.txt:5', questions[0].id);

  const withoutId = `<script>const QUESTIONS = [
    {num:1, type:'mc', q:'문제1', opts:['가','나','다'], ans:0}
  ];</script>`;
  const { questions: q2 } = parseExamHtml(withoutId);
  ok('id가 없으면 필드 자체가 없다(기존 파일과 완전히 같은 모양)', !('id' in q2[0]));
}

// ---------- db.js의 attemptId가 qid를 우선한다 ----------
{
  ok('qid 없으면 exam#num', attemptId('a.html', 3) === 'a.html#3');
  ok('qid 있으면 qid: 접두', attemptId('a.html', 3, '알렌:foo.txt:5') === 'qid:알렌:foo.txt:5');
  ok('같은 qid면 exam·num이 달라도 같은 키 — 다른 파일로 다시 뽑혀도 이력이 이어진다',
    attemptId('a.html', 3, '알렌:foo.txt:5') === attemptId('b.html', 9, '알렌:foo.txt:5'));
  ok('qid가 다르면 다른 키', attemptId('a.html', 3, 'x') !== attemptId('a.html', 3, 'y'));
}

console.log(`통과 ${pass}건`);
if (fail.length) { console.log('❌ 실패:\n- ' + fail.join('\n- ')); process.exit(1); }
console.log('✅ 전부 통과');
