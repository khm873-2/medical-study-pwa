// CSS 중복 정의 감시 — 늘어나는 것만 막는 톱니(ratchet).
//
// 왜 있나: css/app.css는 고칠 때마다 새 블록을 **아래에 덧붙여** 왔다. 그래서
// 같은 선택자가 위아래에 두 번 있고, 아래 것이 캐스케이드로 이긴다.
// 위에 있는 블록을 고치면 **아무 일도 일어나지 않는다** — 2026-10-09에 리사이저가
// 두 번 연속 안 고쳐진 원인이 바로 이것(.side-col 의 display:flex !important)이었다.
//
// 지금 있는 86회는 지우다가 모양이 바뀔 위험이 있어 그대로 둔다(옛 블록에만 있는
// 속성은 여전히 적용되므로 통째로 삭제하면 회귀한다). 대신 **더 늘지 않게** 잠근다.
// 숫자를 올리고 싶으면, 올리는 이유를 여기 적어야 한다.

import { readFileSync } from 'fs';

const CSS = '/Users/hyunminkang/Documents/medical-study-pwa/css/app.css';
const BUDGET = 86;          // 2026-10-10 기준. 줄이는 건 환영, 늘리는 건 금지.

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

const css = readFileSync(CSS, 'utf8');

// @media 안쪽은 의도된 재정의라 세지 않는다
const media = [];
for (const m of css.matchAll(/@media[^{]*\{/g)) {
  let i = m.index + m[0].length, d = 1;
  while (i < css.length && d) { if (css[i] === '{') d++; else if (css[i] === '}') d--; i++; }
  media.push([m.index, i]);
}
const inMedia = (p) => media.some(([a, b]) => a <= p && p < b);

const seen = new Map();
for (const m of css.matchAll(/(^|\n)\s*([.#][A-Za-z][\w\-.,:#\s>]*?)\s*\{/g)) {
  const pos = m.index + m[1].length;
  if (inMedia(pos)) continue;
  const sel = m[2].split(/\s+/).join(' ');
  const line = css.slice(0, pos).split('\n').length;
  if (!seen.has(sel)) seen.set(sel, []);
  seen.get(sel).push(line);
}

const dups = [...seen.entries()].filter(([, v]) => v.length > 1);
const extra = dups.reduce((a, [, v]) => a + v.length - 1, 0);

ok(`중복 정의가 ${BUDGET}회를 넘지 않는다`, extra <= BUDGET,
  `지금 ${extra}회 (한도 ${BUDGET}). 새 규칙을 아래에 덧붙이지 말고 기존 블록을 고치세요.\n`
  + dups.sort((a, b) => b[1].length - a[1].length).slice(0, 6)
    .map(([s, v]) => `      ${s} → 줄 ${v.join(', ')}`).join('\n'));

if (extra < BUDGET) {
  console.log(`   ℹ️ 중복이 ${BUDGET} → ${extra}회로 줄었습니다. test_css.mjs의 BUDGET을 ${extra}로 내려주세요.`);
}

// 이번에 새로 넣은 선택자들은 중복이 없어야 한다
const NEW = ['.today-h', '.today-sec', '.today-exam', '.today-d', '.today-lec',
  '.today-lec-head', '.today-period', '.today-chips', '.chip', '.unsure-btn', '.unsure-btn.on'];
for (const sel of NEW) {
  const v = seen.get(sel) || [];
  ok(`${sel} 는 한 번만 정의된다`, v.length === 1, `${v.length}번 (줄 ${v.join(', ')})`);
}

// !important 는 캐스케이드를 통째로 무력화해서 위 블록을 고칠 수 없게 만든다
const bangs = [...css.matchAll(/!important/g)].length;
ok('!important 가 10개를 넘지 않는다', bangs <= 10,
  `${bangs}개 — 2026-10-09에 .side-col{display:flex!important} 때문에 뒤 규칙이 전부 죽었다`);

// 색을 @media·[data-theme] 안에서만 정의하면 기본 테마에서 색이 빈다
const rootBlock = (css.match(/:root\s*\{([\s\S]*?)\}/) || [])[1] || '';
for (const tok of ['--bg', '--text', '--card', '--border', '--accent', '--sub', '--warn', '--correct']) {
  ok(`${tok} 가 기본 :root 에 있다`, rootBlock.includes(tok));
}

console.log(`test_css.mjs  ${fail.length ? '❌' : '✅'} ${pass}개 통과${fail.length ? `, ${fail.length}개 실패` : ''}`);
fail.forEach((f) => console.log('   ✗ ' + f));
process.exit(fail.length ? 1 : 0);
