// Phase 3 모듈 테스트 — 실제 vault 노트/문항으로 마크다운 렌더러·섹션 매칭·프롬프트를 검증.
import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
const VAULT = '/Users/hyunminkang/Documents/Medical_vault';

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

// ── markdown.js (DOM 불필요한 부분만) ──
global.document = { createElement: () => ({ className: '', textContent: '' }) };
const { renderMarkdown, escapeHtml } = await import(`${PWA}/js/markdown.js`);

ok('escapeHtml', escapeHtml('<b>&"') === '&lt;b&gt;&amp;&quot;');
ok('하이라이트', renderMarkdown('==중요==').includes('<mark>중요</mark>'));
ok('굵게', renderMarkdown('**굵게**').includes('<strong>굵게</strong>'));
ok('코드', renderMarkdown('`x`').includes('<code>x</code>'));
ok('헤딩', /<h\d>제목<\/h\d>/.test(renderMarkdown('## 제목')));
ok('수평선', renderMarkdown('---').includes('<hr>'));
ok('목록', renderMarkdown('- 하나\n- 둘').includes('<li>하나</li>'));
ok('번호목록', renderMarkdown('1. 하나\n2. 둘').includes('<ol>'));

const cal = renderMarkdown('> [!success]- 정답\n> 내용입니다');
ok('콜아웃 → details', cal.includes('<details') && cal.includes('cal-success'), cal.slice(0, 60));
ok('콜아웃 기본 접힘(-)', !/<details[^>]*\sopen/.test(cal));
ok('콜아웃 본문 렌더', cal.includes('내용입니다'));
const calOpen = renderMarkdown('> [!info]+ 열림\n> 본문');
ok('콜아웃 펼침(+)', /<details[^>]*\sopen/.test(calOpen));

const tbl = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
ok('표 렌더', tbl.includes('<table>') && tbl.includes('<th>A</th>') && tbl.includes('<td>1</td>'));
ok('표 가로스크롤 래퍼', tbl.includes('tablewrap'));

const emb = renderMarkdown('![[사진.png]]');
ok('이미지 임베드 → data-embed', emb.includes('data-embed="사진.png"'), emb);
const wl = renderMarkdown('[[노트이름]]');
ok('위키링크', wl.includes('data-note="노트이름"'));
const wl2 = renderMarkdown('[[노트|표시이름]]');
ok('위키링크 별칭', wl2.includes('>표시이름<') && wl2.includes('data-note="노트"'));

// XSS 방어 — 노트는 내 것이지만 렌더가 깨지면 안 된다
const xss = renderMarkdown('<script>alert(1)</script>');
ok('HTML 이스케이프', !xss.includes('<script>'), xss);

// ── wiki.js (네트워크 부분 제외한 순수 함수) ──
const wikiSrc = readFileSync(`${PWA}/js/wiki.js`, 'utf8')
  .replace("import { listDir, getText } from './github.js';", 'const listDir=async()=>[],getText=async()=>"";')
  .replace("import { linkedNoteFromMd } from './parser.js';", 'const linkedNoteFromMd=()=>null;');
const shim = `${PWA}/js/__t_wiki.mjs`;
writeFileSync(shim, wikiSrc);
let W;
try { W = await import(pathToFileURL(shim).href); } finally { rmSync(shim, { force: true }); }

const noteMd = readFileSync(
  `${VAULT}/98_예습노트_보관/응급_중환자/1015_응급중환자_전문심장소생술ACLS.md`, 'utf8');
const secs = W.splitSections(noteMd);
ok('섹션 분리', secs.length >= 7, `${secs.length}개`);
ok('섹션에 헤딩', secs.every((s) => s.heading && s.heading.length), '');
ok('### 는 섹션으로 안 쪼갬', !secs.some((s) => s.heading.startsWith('#')));
const content = W.contentSections(secs);
ok('목차/치트시트 제외', content.length < secs.length && !content.some((s) => /^(0\.|목차|🎯)/.test(s.heading)),
  content.map((s) => s.heading.slice(0, 12)).join(','));

// 매칭 정확도 — 사람이 확인한 기대값과 대조
const html = readFileSync(`${VAULT}/06_모의고사/응급_중환자/1015_전문심장소생술ACLS_모의고사.html`, 'utf8');
const qs = JSON.parse(html.match(/const QUESTIONS = (\[[\s\S]*?\]);\s*\nconst LECTURE_NAME/)[1]);
const expect = { 1: '1.', 2: '1.', 4: '1.', 6: '1.', 7: '1.', 8: '1.' }; // 심정지 계열
let hit = 0, tested = 0;
for (const q of qs) {
  const want = expect[q.num];
  if (!want) continue;
  tested++;
  const top = W.rankSections(q, content)[0];
  if (top.heading.startsWith(want)) hit++;
}
ok('섹션 자동매칭 정확도', hit === tested, `${hit}/${tested}`);
ok('매칭이 점수 내림차순', (() => {
  const r = W.rankSections(qs[0], content);
  return r.every((s, i) => i === 0 || r[i - 1].score >= s.score);
})());

// 모든 응급_중환자 시험에서 매칭이 터지지 않는지(예외 없이 1등이 나오는지)
let crashed = 0, noteMissing = 0, totalQ = 0;
for (const f of readdirSync(`${VAULT}/06_모의고사/응급_중환자`).filter((x) => x.endsWith('.html'))) {
  const h = readFileSync(`${VAULT}/06_모의고사/응급_중환자/${f}`, 'utf8');
  const m = h.match(/const QUESTIONS = (\[[\s\S]*?\]);\s*\nconst LECTURE_NAME/);
  if (!m) continue;
  const mdPath = `${VAULT}/06_모의고사/응급_중환자/${f.replace(/\.html$/, '.md')}`;
  if (!existsSync(mdPath)) continue;
  const link = readFileSync(mdPath, 'utf8').match(/연계노트:\s*"?\[\[([^\]]+)\]\]"?/);
  if (!link) { noteMissing++; continue; }
  let np = null;
  for (const base of ['98_예습노트_보관', '02_Wiki']) {
    for (const sub of readdirSync(`${VAULT}/${base}`)) {
      const cand = `${VAULT}/${base}/${sub}/${link[1]}.md`;
      if (existsSync(cand)) { np = cand; break; }
    }
    if (np) break;
  }
  if (!np) { noteMissing++; continue; }
  const cs = W.contentSections(W.splitSections(readFileSync(np, 'utf8')));
  for (const q of JSON.parse(m[1])) {
    totalQ++;
    try {
      const r = W.rankSections(q, cs);
      if (!r.length || typeof r[0].score !== 'number') crashed++;
    } catch { crashed++; }
  }
}
ok('전 문항 매칭 무오류', crashed === 0, `${crashed}건 실패 / ${totalQ}문항`);
console.log(`  매칭 검사: ${totalQ}문항, 연계노트 없음 ${noteMissing}개 시험`);

// ── ask.js ──
const { buildPrompt, buildQaMarkdown, appList } = await import(`${PWA}/js/ask.js`);
const p = buildPrompt({ term: 'Torsade de Pointes', question: qs[0], subject: '응급_중환자', lecture: 'ACLS' });
ok('프롬프트에 용어', p.includes('Torsade de Pointes'));
ok('프롬프트에 형식 지시', p.includes('개조식'));
ok('프롬프트에 문제 지문', p.includes(qs[0].q.slice(0, 20)));
ok('앱 목록', appList().length >= 2);

const qa = buildQaMarkdown({
  subject: '응급_중환자', lecture: 'ACLS', examPath: '06_모의고사/x.html',
  items: [{ term: 'TdP', qnum: 3, qtext: '문제지문', answer: '답변내용' }],
});
ok('QA 경로가 AI대화로그', qa.path.startsWith('00_Raw_Text/AI대화로그/'), qa.path);
ok('QA frontmatter', qa.content.startsWith('---\n'));
ok('QA에 답변 포함', qa.content.includes('답변내용'));
ok('QA 파일명에 날짜', /_\d{2}-\d{2}-\d{2}_/.test(qa.path), qa.path);

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
