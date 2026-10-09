// 실제 DOM·CSS로 검증하는 테스트.
//
// 왜 필요한가: 기존 테스트는 DOM을 손수 만든 스텁 위에서 돌아서 "CSS 규칙이 서로를
// 덮어써서 기능이 죽는" 종류의 버그를 전혀 못 잡았다. 실제로 크기 조절과 펜 버튼
// 클릭이 두 번씩 "고쳤다"고 하고도 안 됐던 게 이 때문이다(2026-10-09).
//
// jsdom은 레이아웃(실제 px)을 계산하지 않지만, **CSS 규칙 매칭과 우선순위**는 계산한다.
// 그래서 "이 요소가 display:none이 되는가", "이 핸들러가 붙는가"는 정확히 검증된다.
//
// 실행: node test/test_dom.mjs   (jsdom 필요: npm i jsdom --cache /tmp/npmcache)

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
let JSDOM;
try {
  const req = createRequire('/tmp/jsdomtest/package.json');
  ({ JSDOM } = req('jsdom'));
} catch {
  console.log('⏭  jsdom이 없어 건너뜁니다 (npm i jsdom --cache /tmp/npmcache)');
  process.exit(0);
}

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

const html = readFileSync(`${PWA}/index.html`, 'utf8');
const css = readFileSync(`${PWA}/css/app.css`, 'utf8');

// 스크립트는 실행하지 않고(모듈 로딩이 복잡하다) DOM+CSS만 세운다.
const dom = new JSDOM(
  html.replace(/<script[\s\S]*?<\/script>/g, '') +
  `<style>${css}</style>`,
  { pretendToBeVisual: true, url: 'https://example.com/' }
);
const { window } = dom;
const { document } = window;
const style = (el) => window.getComputedStyle(el);

// ⚠️ jsdom은 @media를 평가하지 않는다(확인함). 그래서 미디어쿼리 안의 규칙은
// getComputedStyle 대신 **CSS 텍스트를 직접 파싱**해서 검증한다.
// 미디어쿼리 밖 규칙·DOM 구조·클래스는 그대로 jsdom으로 본다.

/** @media (min-width: 900px) 블록들을 모은 텍스트 */
function wideCss() {
  const out = [];
  const re = /@media[^{]*\(min-width:\s*900px\)[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let i = re.lastIndex, depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out.join('\n');
}
const WIDE = wideCss();
ok('900px 미디어쿼리 블록이 존재', WIDE.length > 100, `${WIDE.length}자`);

/** 넓은 화면 CSS에서 특정 셀렉터의 선언을 찾는다(뒤에 나오는 것이 이긴다). */
function wideDecl(selector, prop) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let last = null, m;
  while ((m = re.exec(WIDE))) {
    const pm = m[1].match(new RegExp(prop + '\\s*:\\s*([^;]+)'));
    if (pm) last = pm[1].trim();
  }
  return last;
}

// ── 1. 크기 조절 손잡이 ──────────────────────────────────────────
const quizScreen = document.getElementById('quizScreen');
const colR = document.getElementById('colResizer');
const paneR = document.getElementById('paneResizer');
ok('colResizer 존재', !!colR);
ok('paneResizer 존재', !!paneR);

quizScreen.classList.remove('hidden');     // 화면 켜기

// (a) 넓은 화면에서 리사이저가 보이는가
ok('col-resizer가 넓은 화면에서 display:block',
  wideDecl('.col-resizer', 'display') === 'block', String(wideDecl('.col-resizer', 'display')));
ok('col-resizer에 cursor: col-resize',
  wideDecl('.col-resizer', 'cursor') === 'col-resize', String(wideDecl('.col-resizer', 'cursor')));
ok('col-resizer에 touch-action: none (펜/터치로 끌 수 있게)',
  wideDecl('.col-resizer', 'touch-action') === 'none', String(wideDecl('.col-resizer', 'touch-action')));

// ★ 패널이 닫혀 있어도 리사이저가 display:none 되면 안 된다 — 실제로 이 규칙 때문에
//   "크기 조절이 안 된다"는 버그가 있었다
const hiddenRule = /#quizScreen:not\(\.with-side\)[^{]*\.col-resizer[^{]*\{([^}]*)\}/.exec(WIDE);
ok('패널 닫힘 상태에서 col-resizer를 display:none 하지 않음',
  !hiddenRule || !/display:\s*none/.test(hiddenRule[1]),
  hiddenRule ? hiddenRule[1].trim() : '(규칙 없음)');

// (b) 사이드 폭이 --side-w로 결정되는가
const sideCol = document.querySelector('#quizScreen .side-col');
const basis = wideDecl('#quizScreen .side-col', 'flex');
ok('사이드 폭이 --side-w 변수를 씀', !!basis && basis.includes('--side-w'), String(basis));
// 같은 속성을 덮어쓰는 다른 규칙이 없어야 한다
const sideFlexRules = (WIDE.match(/\.side-col\s*\{[^}]*flex:/g) || []).length;
ok('사이드 flex를 덮어쓰는 규칙이 하나뿐', sideFlexRules === 1, `${sideFlexRules}개`);

// (c) 두 패널이 열렸을 때 pane-resizer
ok('pane-resizer가 넓은 화면에서 display:block',
  /\.pane-resizer:not\(\.hidden\)\s*\{[^}]*display:\s*block/.test(WIDE));
ok('pane-resizer에 cursor: row-resize',
  /\.pane-resizer:not\(\.hidden\)\s*\{[^}]*cursor:\s*row-resize/.test(WIDE));
ok('AI 패널 높이가 --ai-h를 씀', /--ai-h/.test(WIDE));

// ── 2. 네비가 항상 맨 아래 ──────────────────────────────────────
const nav = document.querySelector('#quizScreen .quiz-nav');
ok('네비가 main-col 안에 있음', !!nav.closest('.main-col'));
ok('네비에 margin-top:auto (항상 바닥)',
  wideDecl('#quizScreen .main-col > .quiz-nav', 'margin-top') === 'auto',
  String(wideDecl('#quizScreen .main-col > .quiz-nav', 'margin-top')));
ok('main-col이 세로 플렉스',
  wideDecl('#quizScreen .split > .main-col', 'flex-direction') === 'column',
  String(wideDecl('#quizScreen .split > .main-col', 'flex-direction')));
ok('main-col에 min-height (내용 짧아도 네비가 바닥)',
  /calc|vh/.test(String(wideDecl('#quizScreen .split > .main-col', 'min-height'))),
  String(wideDecl('#quizScreen .split > .main-col', 'min-height')));

// ── 3. 선택 팝업이 펜 입력을 받을 수 있는 구조인가 ──────────────
const pop = document.getElementById('selPop');
ok('selPop에 pen-passthrough 클래스', pop.classList.contains('pen-passthrough'));
const askBtn = document.getElementById('selAsk');
ok('selAsk 버튼 존재', !!askBtn);
ok('selAsk가 .sel-btn', askBtn.classList.contains('sel-btn'));
// pen.js의 isUiTarget이 이 버튼을 UI로 인식해야 한다
const penSrc = readFileSync(`${PWA}/js/pen.js`, 'utf8');
const uiSelMatch = penSrc.match(/return !!el\.closest\(\s*([\s\S]*?)\);/);
ok('isUiTarget 셀렉터 추출', !!uiSelMatch);
if (uiSelMatch) {
  const sel = uiSelMatch[1].replace(/['"\s+]/g, '').replace(/\n/g, '');
  pop.classList.remove('hidden');
  ok('팝업이 isUiTarget 셀렉터에 걸림', askBtn.closest(sel) !== null, sel.slice(0, 60));
}
// touchstart 핸들러가 UI에서 preventDefault를 건너뛰는가(소스 검사)
ok('touchstart 핸들러에 UI 예외 있음',
  /_onTouch[\s\S]{0,400}?isUiTarget\(e\.target\)[\s\S]{0,120}?return;/.test(penSrc));

// ── 4. 캔버스가 UI를 가리지 않는가 ───────────────────────────────
const canvas = document.createElement('canvas');
canvas.className = 'penlayer';
document.getElementById('qcard').appendChild(canvas);
ok('캔버스가 pointer-events:none', style(canvas).pointerEvents === 'none', style(canvas).pointerEvents);
ok('캔버스에 touch-action:none (펜 스크롤 가로채기 방지)',
  style(canvas).touchAction === 'none', style(canvas).touchAction);
// 패널이 열린 상태 클래스도 세팅해둔다(이후 검사용)
quizScreen.classList.add('with-side');
document.getElementById('wikiPanel').classList.remove('hidden');
document.getElementById('aiPanel').classList.remove('hidden');
ok('팝업이 캔버스보다 위(z-index)',
  Number(style(pop).zIndex) > Number(style(canvas).zIndex),
  `${style(pop).zIndex} vs ${style(canvas).zIndex}`);

// ── 5. 구버전 규칙이 남아 충돌하지 않는가 ────────────────────────
ok('구버전 .with-wiki 규칙 없음', !/\.with-wiki[\s.{]/.test(css), (css.match(/\.with-wiki[^\n]*/)||[''])[0]);
const penLayerRules = (css.match(/^\.penlayer\s*\{/gm) || []).length;
ok('.penlayer 규칙이 하나뿐', penLayerRules === 1, `${penLayerRules}개`);

// ── 6. 아이콘 — iOS 홈화면 아이콘이 안 바뀌던 문제(2026-10-09) ──
// iOS는 설치 시점에 아이콘을 복사해 박아두고, Safari는 아이콘 URL을 자체 DB에 캐시한다.
// URL에 ?v= 가 없으면 파일을 바꿔도 예전 아이콘이 계속 나온다.
{
  const { readFileSync: rf, existsSync: ex } = await import('fs');
  const touch = [...html.matchAll(/<link[^>]+rel="apple-touch-icon"[^>]*>/g)].map((m) => m[0]);
  ok('apple-touch-icon 선언이 있다', touch.length >= 1, `${touch.length}개`);
  ok('apple-touch-icon에 캐시버스터(?v=)', touch.every((t) => /\?v=\d+/.test(t)),
    touch.map((t) => (t.match(/href="([^"]+)"/) || [])[1]).join(' '));
  ok('apple-touch-icon에 sizes 명시', touch.every((t) => /sizes="\d+x\d+"/.test(t)));

  const mf = JSON.parse(rf(`${PWA}/manifest.json`, 'utf8'));
  ok('manifest 아이콘에도 같은 캐시버스터', mf.icons.every((i) => /\?v=\d+/.test(i.src)),
    mf.icons.map((i) => i.src).join(' '));

  // index.html과 manifest의 버전이 어긋나면 한쪽만 갱신돼 헷갈린다
  const vs = new Set([
    ...touch.map((t) => (t.match(/\?v=(\d+)/) || [])[1]),
    ...mf.icons.map((i) => (i.src.match(/\?v=(\d+)/) || [])[1]),
  ]);
  ok('index.html과 manifest의 아이콘 버전이 같다', vs.size === 1, [...vs].join('/'));

  // ?v= 를 뗀 실제 파일이 존재해야 한다
  const missing = mf.icons.map((i) => i.src.split('?')[0]).filter((f) => !ex(`${PWA}/${f}`));
  ok('manifest가 가리키는 아이콘 파일이 전부 존재', missing.length === 0, missing.join(' '));
  ok('maskable 아이콘이 있다', mf.icons.some((i) => i.purpose === 'maskable'));

  ok('앱 이름이 달모', mf.short_name === '달모', mf.short_name);
  const t = html.match(/<meta name="apple-mobile-web-app-title" content="([^"]+)"/);
  ok('홈화면 표시 이름이 달모', t && t[1] === '달모', t ? t[1] : 'null');
}

console.log(`\n통과 ${pass}건`);
if (fail.length) {
  console.log(`실패 ${fail.length}건:`);
  fail.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✅ 전부 통과');
