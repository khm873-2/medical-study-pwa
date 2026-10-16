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
const BUDGET = 54;          // 2026-10-15 기준. 줄이는 건 환영, 늘리는 건 금지.
// 86 → 61: `카드 관리` 블록 76줄이 통째로 두 번 들어가 있던 걸 지웠다(앞 복사본은
// 캐스케이드로 아예 안 쓰이고 있었다 — 고쳐도 아무 일도 안 일어나는 죽은 코드였다).

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

// 배경만 덮어쓰고 글씨색을 안 바꾸면 **글자가 배경에 묻힌다**.
// 2026-10-15에 실제로 그랬다 — `#syncBar.stuck`의 배경을 뒤쪽 블록에서 #b45309로
// 덮었는데 글씨는 var(--warn) = 같은 #b45309라서, 글자 없는 주황 막대가 떴다.
{
  const blocks = [...css.matchAll(/#syncBar\.stuck\s*\{([^}]*)\}/g)].map((m) => m[1]);
  ok('#syncBar.stuck 이 한 군데서만 정의된다', blocks.length === 1, `${blocks.length}곳`);
  const body = blocks.join(' ');
  const bg = (body.match(/background:\s*([^;]+)/) || [])[1];
  const fg = (body.match(/(?:^|[^-])color:\s*([^;]+)/) || [])[1];
  ok('막힌 띠에 배경과 글씨색이 함께 있다', !!bg && !!fg, `배경 ${bg} / 글씨 ${fg}`);
  ok('막힌 띠의 글씨가 배경과 다른 색이다',
    !!bg && !!fg && bg.trim() !== fg.trim(), `둘 다 ${bg}`);
  const btn = (css.match(/#syncBar\.stuck button\s*\{([^}]*)\}/) || [])[1] || '';
  ok('막힌 띠의 단추도 읽힌다', /color:\s*#fff|color:\s*white/.test(btn), btn.trim().slice(0, 60));
}

// 색을 바꿀 때 **글자가 안 읽히게 되는 일**을 막는다 (2026-10-16).
// "좀 더 어두워도 될것같음" 요청으로 어두움 모드를 다시 잡으면서, 재어 보니
// 흰 글씨를 얹는 파란 단추가 전부터 2.9:1(기준 4.5)이었다 — 눈으로는 못 잡는다.
{
  const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const Y = (h) => { const m = h.replace('#', '').match(/../g).map((v) => parseInt(v, 16));
    return 0.2126 * lin(m[0]) + 0.7152 * lin(m[1]) + 0.0722 * lin(m[2]); };
  const ratio = (a, b) => { const x = Y(a), y = Y(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const Lstar = (h) => { const y = Y(h); return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y; };
  const tok = (block, name) => {
    const m = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    return m ? m[1] : null;
  };
  const dark = (css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  const light = (css.match(/^:root\s*\{([\s\S]*?)\n\}/m) || [])[1] || '';
  for (const [label, b] of [['어두움', dark], ['밝음', light]]) {
    const T = (n) => tok(b, n);
    ok(`${label}: 색 토큰이 다 있다`,
      ['bg', 'card', 'page', 'text', 'sub', 'accent', 'accent-fill', 'border'].every(T),
      ['bg', 'card', 'page', 'text', 'sub', 'accent', 'accent-fill', 'border'].filter((n) => !T(n)).join(','));
    if (!T('card')) continue;
    ok(`${label}: 본문 글자가 또렷하다 (7:1)`, ratio(T('text'), T('card')) >= 7,
      `${ratio(T('text'), T('card')).toFixed(2)}:1`);
    ok(`${label}: 보조 글자도 읽힌다 (4.5:1)`, ratio(T('sub'), T('card')) >= 4.5,
      `${ratio(T('sub'), T('card')).toFixed(2)}:1`);
    ok(`${label}: 강조색이 읽힌다 (4.5:1)`, ratio(T('accent'), T('card')) >= 4.5,
      `${ratio(T('accent'), T('card')).toFixed(2)}:1`);
    ok(`${label}: **파란 단추의 흰 글씨가 읽힌다** (4.5:1)`, ratio('#ffffff', T('accent-fill')) >= 4.5,
      `${ratio('#ffffff', T('accent-fill')).toFixed(2)}:1`);
    // 바탕과 읽는 면이 **눈에 구분되어야** 한다 — 대비비는 어두운 쪽에서 무뎌서 L*로 본다.
    // 밝은 모드는 그림자가 윤곽을 맡아주므로 적게 벌어져도 되지만, 어두운 모드는
    // 그림자가 안 보여서 밝기 차이가 유일한 단서다 — 거기서 모자라 "쨍하지 않다"가 됐다.
    const needStep = label === '어두움' ? 6 : 2;
    ok(`${label}: 읽는 면이 바탕 위에 떠 보인다 (ΔL* ${needStep} 이상)`,
      Math.abs(Lstar(T('card')) - Lstar(T('bg'))) >= needStep,
      `ΔL* ${Math.abs(Lstar(T('card')) - Lstar(T('bg'))).toFixed(1)}`);
    ok(`${label}: 테두리가 보인다 (ΔL* 4 이상)`,
      Math.abs(Lstar(T('border')) - Lstar(T('card'))) >= 4,
      `ΔL* ${Math.abs(Lstar(T('border')) - Lstar(T('card'))).toFixed(1)}`);

    // 글을 길게 읽는 면 — 어두움 모드에서는 카드보다 깊게 가서 글자가 더 또렷하다.
    // 바탕과 가까워지므로 **가장자리는 테두리가 맡아야** 한다.
    ok(`${label}: 읽는 면의 글자가 또렷하다 (7:1)`, ratio(T('text'), T('page')) >= 7,
      `${ratio(T('text'), T('page')).toFixed(2)}:1`);
    ok(`${label}: 읽는 면이 카드보다 어둡지 밝지는 않다`,
      Lstar(T('page')) <= Lstar(T('card')) + 0.5,
      `읽는 면 L* ${Lstar(T('page')).toFixed(1)} · 카드 L* ${Lstar(T('card')).toFixed(1)}`);
    // 어두움 모드는 읽는 면이 바탕과 가까워 테두리가 **유일한** 가장자리 단서다.
    // 밝은 모드는 바탕(#f4f5f9)과 흰 면의 차이가 이미 있어서 테두리는 거들기만 한다.
    const needEdge = label === '어두움' ? 8 : 5;
    ok(`${label}: 읽는 면의 가장자리가 보인다 (ΔL* ${needEdge} 이상)`,
      Math.abs(Lstar(T('border')) - Lstar(T('page'))) >= needEdge,
      `ΔL* ${Math.abs(Lstar(T('border')) - Lstar(T('page'))).toFixed(1)}`);
  }
}

// 본문을 그리는 면은 **하이라이트 색을 스스로 정해야** 한다 (2026-10-16).
// 안 정하면 브라우저 기본 <mark>이 나오는데, 크롬은 글자색까지 알아서 맞춰주지만
// 사파리는 **물려받은 색 그대로** 쓴다 — 어두움 모드에서 흰 글씨에 샛노란 바탕이 되어
// 글자가 안 보였다. 크롬으로 재는 대비 점검으로는 못 잡으니 여기서 규칙으로 막는다.
{
  const SURFACES = ['.wiki-body', '.peek-body', '.card-context', '.cf-q', '.cf-row-q', '.deck-q'];
  const missing = [];
  const noColor = [];
  for (const sel of SURFACES) {
    // `<면> mark { … }` 가 어딘가에 있어야 하고, 배경과 글자색을 **둘 다** 정해야 한다
    const re = new RegExp(`${sel.replace('.', '\\.')}\\s+mark\\b[^{]*\\{([^}]*)\\}`, 'g');
    const bodies = [...css.matchAll(re)].map((m) => m[1]);
    if (!bodies.length) { missing.push(sel); continue; }
    const all = bodies.join(' ');
    if (!/background/.test(all) || !/(^|[^-])color:/.test(all)) noColor.push(sel);
  }
  ok('본문을 그리는 면마다 하이라이트 규칙이 있다', !missing.length, missing.join(', '));
  ok('하이라이트는 바탕과 글자색을 **둘 다** 정한다', !noColor.length, noColor.join(', '));

  // 어두움 모드에서도 같이 덮어야 한다 — 한쪽만 바꾸면 흰 글씨가 그대로 남는다
  const darkMarks = [...css.matchAll(/mark\b[^{]*\{[^}]*\}/g)]
    .filter((m) => /#6b4408|#ffe9ad/.test(m[0])).length;
  ok('어두움 모드 하이라이트 규칙이 있다', darkMarks >= 2, `${darkMarks}곳`);
}

console.log(`test_css.mjs  ${fail.length ? '❌' : '✅'} ${pass}개 통과${fail.length ? `, ${fail.length}개 실패` : ''}`);
fail.forEach((f) => console.log('   ✗ ' + f));
process.exit(fail.length ? 1 : 0);
