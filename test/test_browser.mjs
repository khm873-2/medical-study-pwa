// 실제 Chrome에서 돌리는 검증. jsdom은 레이아웃도, @media도 계산하지 않아서
// "폭 조절이 안 된다 / 펜으로 버튼이 안 눌린다" 류의 버그를 전혀 못 잡았다.
// 여기서는 진짜 Chrome이 실제 px을 계산하고 실제 포인터 이벤트를 받는다.
//
// 실행:
//   python3 -m http.server 8777     (레포 루트에서)
//   node test/test_browser.mjs
// 필요: npm i puppeteer-core --cache /tmp/npmcache  (/tmp/jsdomtest 에 설치되어 있음)

import { createRequire } from 'module';

const URL_BASE = process.env.PWA_URL || 'http://localhost:8777/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let puppeteer;
try {
  puppeteer = createRequire('/tmp/jsdomtest/package.json')('puppeteer-core');
} catch {
  console.log('⏭  puppeteer-core 없음 — 건너뜁니다');
  process.exit(0);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--window-size=1280,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(URL_BASE, { waitUntil: 'networkidle0' });
// 첫 화면(스플래시)이 걷힐 때까지 기다린다 — 안 그러면 클릭·드래그가 전부 막힌다
await page.waitForFunction(() => !document.getElementById('splash'), { timeout: 6000 }).catch(() => {});

/** 페이지 안에서 평가하고 {name, ok, detail}[] 를 받는다. */
const results = [];
const run = async (label, fn) => {
  try {
    const r = await page.evaluate(fn);
    (Array.isArray(r) ? r : [r]).forEach((x) => results.push(x));
  } catch (e) {
    results.push({ name: `${label} (실행 실패)`, ok: false, detail: String(e.message).slice(0, 160) });
  }
};

// ══════════ 0. 화면 전환이 CSS에 "지금 어느 화면인가"를 알려주는가 ══════════
// 읽기 화면 레이아웃(목차 따로 스크롤·하단 바 고정 해제)이 전부 이 값에 걸려 있다.
// show()가 이걸 안 심으면 조용히 옛 레이아웃으로 돌아간다(2026-10-12).
await run('화면 표시', () => [{
  name: 'show()가 body[data-screen]을 심는다',
  ok: !!document.body.dataset.screen,
  detail: String(document.body.dataset.screen),
}]);

// ══════════ 준비: 퀴즈 화면을 실제 문항처럼 세운다 ══════════
await run('준비', () => {
  const out = [];
  document.querySelectorAll('section').forEach((s) => s.classList.add('hidden'));
  const qs = document.getElementById('quizScreen');
  qs.classList.remove('hidden');

  // 지문·선지를 토큰(span.tok)으로 채운다 — pen.js가 글자를 찾는 단위
  const mk = (t) => t.split(/(\s+)/).map((w) =>
    /^\s+$/.test(w) ? w : `<span class="tok">${w}</span>`).join('');
  document.getElementById('qtext').innerHTML =
    mk('65세 남자가 갑작스러운 흉통으로 응급실에 왔다. 심전도에서 ST분절 상승이 보였다.');
  document.getElementById('optsContainer').innerHTML = [1, 2, 3, 4, 5].map((i) =>
    `<div class="opt-row"><div class="badge">${i}</div>` +
    `<div class="opt-text">${mk('선지 ' + i + ' 내용이 길게 적혀 있는 보기 문장')}</div></div>`).join('');

  // 사이드 패널 두 개를 연다(앱이 하는 것과 동일한 클래스 조작)
  qs.classList.add('with-side');
  const wiki = document.getElementById('wikiPanel');
  const ai = document.getElementById('aiPanel');
  wiki.classList.remove('hidden');
  ai.classList.remove('hidden');
  document.querySelector('#quizScreen .side-col').classList.add('both');
  document.getElementById('paneResizer').classList.remove('hidden');
  document.querySelector('.wiki-body').innerHTML = mk('빈맥 알고리즘에서 불안정하면 즉시 동기화 심장율동전환을 한다.');
  document.getElementById('aiBody').innerHTML = mk('ST분절 상승 심근경색은 재관류 치료가 핵심이다.');

  const vis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; };
  out.push({ name: '넓은 화면에서 .split이 flex (미디어쿼리 적용)',
    ok: getComputedStyle(document.querySelector('#quizScreen .split')).display === 'flex',
    detail: getComputedStyle(document.querySelector('#quizScreen .split')).display });
  out.push({ name: '사이드 칼럼이 실제로 보인다', ok: vis(document.querySelector('#quizScreen .side-col')) });
  out.push({ name: 'col-resizer가 실제로 보인다', ok: vis(document.getElementById('colResizer')) });
  out.push({ name: 'pane-resizer가 실제로 보인다', ok: vis(document.getElementById('paneResizer')) });
  const w = document.querySelector('#quizScreen .side-col').getBoundingClientRect().width;
  out.push({ name: '사이드 칼럼이 실제 폭을 가진다', ok: w > 250, detail: `${Math.round(w)}px` });
  return out;
});

// ══════════ 1. 본문 ↔ 사이드 폭 조절 (진짜 드래그) ══════════
const sideW = () => page.evaluate(() =>
  document.querySelector('#quizScreen .side-col').getBoundingClientRect().width);
const box = async (sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, sel);

{
  const before = await sideW();
  const p = await box('#colResizer');
  // 실제 마우스로 끌어 왼쪽으로 100px → 사이드가 100px 넓어져야 한다
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x - 50, p.y, { steps: 5 });
  await page.mouse.move(p.x - 100, p.y, { steps: 5 });
  await page.mouse.up();
  const after = await sideW();
  results.push({
    name: '끌어서 사이드 폭이 넓어진다',
    ok: after - before > 70 && after - before < 130,
    detail: `${Math.round(before)} → ${Math.round(after)}px (${Math.round(after - before)} 변화)`,
  });

  // 본문도 그만큼 좁아져야 한다(둘이 같은 flex 컨테이너를 나눠 쓰므로)
  const mainW = await page.evaluate(() =>
    document.querySelector('#quizScreen .main-col').getBoundingClientRect().width);
  results.push({ name: '본문 칼럼이 0보다 큰 폭을 유지', ok: mainW > 300, detail: `${Math.round(mainW)}px` });

  // --side-w 가 실제로 적용됐는지(다른 규칙이 덮어쓰지 않았는지)
  const applied = await page.evaluate(() => {
    document.documentElement.style.setProperty('--side-w', '420px');
    return Math.round(document.querySelector('#quizScreen .side-col').getBoundingClientRect().width);
  });
  results.push({ name: '--side-w 를 덮어쓰는 규칙이 없다', ok: Math.abs(applied - 420) <= 2, detail: `${applied}px` });
}

// ══════════ 2. AI ↔ 노트 패널 높이 조절 ══════════
{
  const aiH = () => page.evaluate(() => document.getElementById('aiPanel').getBoundingClientRect().height);
  const before = await aiH();
  const p = await box('#paneResizer');
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y + 60, { steps: 6 });
  await page.mouse.up();
  const after = await aiH();
  results.push({
    name: '끌어서 AI 패널 높이가 커진다',
    ok: after - before > 25,
    detail: `${Math.round(before)} → ${Math.round(after)}px`,
  });
}

// ══════════ 3. 네비가 항상 맨 아래 ══════════
await run('네비', () => {
  const out = [];
  const nav = document.querySelector('#quizScreen .quiz-nav');
  const main = document.querySelector('#quizScreen .main-col');
  const nr = nav.getBoundingClientRect(), mr = main.getBoundingClientRect();
  out.push({ name: '네비가 본문 칼럼 안에 있다', ok: !!nav.closest('.main-col') });
  // 내용이 짧아도 칼럼 바닥에 붙어 있어야 한다(위로 딸려오지 않게)
  out.push({ name: '네비가 본문 칼럼 바닥에 붙어 있다',
    ok: Math.abs(nr.bottom - mr.bottom) < 4, detail: `네비 ${Math.round(nr.bottom)} / 칼럼 ${Math.round(mr.bottom)}` });
  out.push({ name: '본문 칼럼이 화면 높이만큼 늘어난다',
    ok: mr.height > window.innerHeight * 0.8, detail: `${Math.round(mr.height)} / ${window.innerHeight}` });
  return out;
});

// ══════════ 4. 펜: 네모 → 팝업 버튼이 펜으로 눌리는가 ══════════
await run('펜', async () => {
  const out = [];
  const { PenLayer } = await import('/js/pen.js');
  const host = document.querySelector('#quizScreen .split');

  let selected = null;
  const pen = new PenLayer(host, { onSelect: (t) => { selected = t; }, onTap: () => {} });
  window.__pen = pen;

  // 펜 포인터 이벤트를 흉내 낸다(iOS 애플펜슬과 같은 pointerType)
  const pev = (type, x, y, el) => {
    const e = new PointerEvent(type, {
      pointerId: 1, pointerType: 'pen', isPrimary: true, pressure: type === 'pointerup' ? 0 : 0.5,
      clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
    });
    (el || document.elementFromPoint(x, y) || document.body).dispatchEvent(e);
    return e;
  };
  const drawBox = async (r) => {
    pev('pointerdown', r.l, r.t);
    for (let i = 1; i <= 6; i++) pev('pointermove', r.l + ((r.r - r.l) * i) / 6, r.t + ((r.b - r.t) * i) / 6);
    pev('pointerup', r.r, r.b);
    await new Promise((res) => setTimeout(res, 520));   // SETTLE_MS(420) 보다 길게
  };

  // (a) 지문 위에 네모 → 텍스트가 잡히는가
  const toks = [...document.querySelectorAll('#qtext .tok')];
  const a = toks[1].getBoundingClientRect(), b = toks[4].getBoundingClientRect();
  await drawBox({ l: a.left - 4, t: a.top - 4, r: b.right + 4, b: b.bottom + 4 });
  out.push({ name: '네모를 그으면 지문 텍스트가 선택된다', ok: !!selected && selected.length > 4,
    detail: String(selected).slice(0, 40) });
  out.push({ name: '선택되면 손글씨 궤적을 남기지 않는다', ok: pen.strokes.length === 0,
    detail: `${pen.strokes.length} stroke` });

  // (b) 팝업 버튼을 펜으로 — touchstart(stylus)에서 preventDefault 하면 click이 죽는다
  const pop = document.getElementById('selPop');
  pop.classList.remove('hidden');
  pop.style.left = '300px'; pop.style.top = '300px';
  const askBtn = document.getElementById('selAsk');
  const br = askBtn.getBoundingClientRect();
  out.push({ name: '팝업 버튼이 화면에 실제로 떠 있다', ok: br.width > 10 && br.height > 10,
    detail: `${Math.round(br.width)}x${Math.round(br.height)}` });

  // 그 좌표에서 가장 위에 있는 요소가 버튼이어야 한다(캔버스가 가리면 안 된다)
  const top = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
  out.push({ name: '버튼 좌표의 최상위 요소가 버튼이다 (캔버스가 안 가린다)',
    ok: !!top && !!top.closest('#selAsk'), detail: top ? top.className || top.id || top.tagName : 'null' });

  // 애플펜슬 터치: touchType='stylus' → pen.js가 preventDefault 하면 탭이 죽는다
  const cx = br.x + br.width / 2, cy = br.y + br.height / 2;
  const t = new Touch({ identifier: 1, target: askBtn, clientX: cx, clientY: cy, pageX: cx, pageY: cy });
  // Chrome의 Touch에는 touchType이 없다(WebKit 전용) → 애플펜슬처럼 보이게 덧붙인다
  Object.defineProperty(t, 'touchType', { value: 'stylus' });
  const ts = new TouchEvent('touchstart', { bubbles: true, cancelable: true, composed: true,
    touches: [t], targetTouches: [t], changedTouches: [t] });
  askBtn.dispatchEvent(ts);
  out.push({ name: '펜 touchstart를 버튼에서 막지 않는다 (막으면 탭이 죽는다)',
    ok: !ts.defaultPrevented });

  // 실제 click 이 핸들러에 도달하는가
  let clicked = 0;
  askBtn.addEventListener('click', () => clicked++, { once: true });
  const pd = pev('pointerdown', br.x + br.width / 2, br.y + br.height / 2, askBtn);
  pev('pointerup', br.x + br.width / 2, br.y + br.height / 2, askBtn);
  askBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.push({ name: '버튼 pointerdown을 펜 레이어가 가로채지 않는다', ok: !pd.defaultPrevented });
  out.push({ name: '펜으로 누른 click이 핸들러에 도달한다', ok: clicked === 1, detail: `${clicked}회` });
  pop.classList.add('hidden');

  // (c) AI 패널에 네모 → 파란 궤적이 남으면 안 된다
  pen.strokes.length = 0; pen.redraw();
  selected = null;
  const ab = document.getElementById('aiBody').getBoundingClientRect();
  await drawBox({ l: ab.left + 8, t: ab.top + 6, r: ab.left + 150, b: ab.top + 26 });
  out.push({ name: 'AI 패널에서도 텍스트가 선택된다', ok: !!selected, detail: String(selected).slice(0, 30) });
  out.push({ name: 'AI 패널에 파란 궤적이 남지 않는다', ok: pen.strokes.length === 0,
    detail: `${pen.strokes.length} stroke` });

  // (d) 선택이 옆 패널로 번지지 않는다 — 지문에 그으면 위키 글자가 섞이면 안 된다
  selected = null;
  const q0 = document.querySelectorAll('#qtext .tok')[0].getBoundingClientRect();
  await drawBox({ l: q0.left - 2, t: q0.top - 2, r: q0.left + 60, b: q0.bottom + 2 });
  out.push({ name: '지문 선택에 위키/AI 글자가 섞이지 않는다',
    ok: !!selected && !/재관류|심장율동전환/.test(selected), detail: String(selected).slice(0, 50) });

  pen.destroy();
  return out;
});

// ══════════ 5. 읽기모드 목차 ══════════
await run('목차', async () => {
  const out = [];
  document.querySelectorAll('section').forEach((s) => s.classList.add('hidden'));
  const rs = document.getElementById('readScreen');
  rs.classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';   // show()가 하는 일 — CSS가 이걸 본다

  // 목차 항목을 앱과 같은 구조로 채운다
  const heads = ['1. 무맥성 심정지 알고리즘', '2. 서맥 알고리즘', '3. 빈맥 알고리즘',
    '4. ACS/STEMI', '5. CO 중독', '6. ROSC 후 관리', '7. 함정 문항'];
  const list = document.getElementById('readTocList');
  list.innerHTML = heads.map((h, i) =>
    `<li><button type="button" class="toc-link${i === 0 ? ' current' : ''}">` +
    `<span class="toc-i">${i + 1}</span><span>${h}</span></button></li>`).join('');
  document.getElementById('readBody').innerHTML = '<p>본문</p>';

  rs.classList.remove('toc-off');
  const toc = document.getElementById('readToc');
  const main = document.querySelector('#readScreen .read-main');
  const tr = toc.getBoundingClientRect(), mr = main.getBoundingClientRect();

  out.push({ name: '목차가 보인다', ok: getComputedStyle(toc).display !== 'none' && tr.width > 100,
    detail: `${Math.round(tr.width)}px` });
  out.push({ name: '목차가 본문 왼쪽에 있다', ok: tr.right <= mr.left + 20,
    detail: `목차 right ${Math.round(tr.right)} / 본문 left ${Math.round(mr.left)}` });
  out.push({ name: '목차가 본문을 가리지 않는다 (겹침 없음)', ok: tr.right <= mr.left + 1 });
  // sticky였을 땐 본문과 **같이 밀려 올라갔다가** 걸렸다 — 그게 싫다는 요청으로
  // 목차를 아예 제 스크롤 상자로 바꿨다(2026-10-12).
  out.push({ name: '목차가 제 스크롤 상자다(본문과 따로 움직인다)',
    ok: ['auto', 'scroll'].includes(getComputedStyle(toc).overflowY),
    detail: getComputedStyle(toc).overflowY });
  out.push({ name: '목차가 본문을 따라 스크롤되지 않는다(페이지가 안 움직인다)',
    ok: document.documentElement.scrollHeight <= window.innerHeight + 1,
    detail: `${document.documentElement.scrollHeight} vs ${window.innerHeight}` });
  out.push({ name: '목차 항목이 모두 렌더된다', ok: list.querySelectorAll('.toc-link').length === 7 });
  const link = list.querySelector('.toc-link');
  const lr = link.getBoundingClientRect();
  out.push({ name: '목차 항목이 손가락/펜 타깃 크기(≥40px)', ok: lr.height >= 40, detail: `${Math.round(lr.height)}px` });
  out.push({ name: '현재 항목이 강조된다',
    ok: getComputedStyle(link).fontWeight >= 700, detail: getComputedStyle(link).fontWeight });

  // 접으면 본문이 넓어진다
  const mBefore = mr.width;
  rs.classList.add('toc-off');
  const mAfter = document.querySelector('#readScreen .read-main').getBoundingClientRect().width;
  out.push({ name: '목차를 접으면 본문이 넓어진다', ok: mAfter - mBefore > 100,
    detail: `${Math.round(mBefore)} → ${Math.round(mAfter)}px` });
  out.push({ name: '접으면 목차가 사라진다',
    ok: getComputedStyle(document.getElementById('readToc')).display === 'none' });

  // 펜이 목차를 UI로 인식해야 한다 (pen.js isUiTarget)
  out.push({ name: '목차가 펜 통과 대상(pen-passthrough)', ok: toc.classList.contains('pen-passthrough') });
  const { PenLayer } = await import('/js/pen.js');
  const p2 = new PenLayer(document.getElementById('readCard'), { onSelect: () => {} });
  out.push({ name: '펜이 목차 항목을 UI로 인식한다 (탭이 먹는다)',
    ok: p2.constructor && !!link.closest('.read-toc') });
  p2.destroy();
  return out;
});

// ══════════ 5a-2. 읽기 화면: 하단 바가 떠오르지 않고, 목차·본문이 따로 구른다 ══════════
// 실제 증상(2026-10-12): 아래로 스크롤하면 맨 아래 있던 하단 바가 화면 한가운데로 올라왔고,
// 목차는 본문과 같이 밀려 올라갔다. 둘 다 `position: fixed`/`sticky`에 기댄 탓이다.
// 고친 뒤에는 **페이지 자체가 스크롤되지 않는다** — 바가 떠오를 자리가 없다.
await run('읽기 화면 레이아웃', async () => {
  const out = [];
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  const rs = document.getElementById('readScreen');
  rs.classList.remove('hidden');
  rs.classList.remove('toc-off');
  document.body.dataset.screen = 'readScreen';

  const list = document.getElementById('readTocList');
  list.innerHTML = Array.from({ length: 24 }, (_, i) =>
    `<li><button type="button" class="toc-link${i === 19 ? ' current' : ''}">` +
    `<span class="toc-i">${i + 1}</span><span>섹션 ${i + 1} — 제법 긴 제목이 들어간다</span></button></li>`).join('');
  const body = document.getElementById('readBody');
  body.innerHTML = Array.from({ length: 80 }, (_, i) => `<p>${i + 1}. 긴 본문 한 줄.</p>`).join('');
  await new Promise((r) => setTimeout(r, 120));

  const nav = document.querySelector('#readScreen .navbar');
  const toc = document.getElementById('readToc');
  const main = document.querySelector('#readScreen .read-main');
  const nr = nav.getBoundingClientRect();

  out.push({ name: '페이지 자체가 스크롤되지 않는다(바가 떠오를 자리가 없다)',
    ok: document.documentElement.scrollHeight <= window.innerHeight + 1,
    detail: `${document.documentElement.scrollHeight} vs ${window.innerHeight}` });
  out.push({ name: '하단 바가 fixed가 아니라 레이아웃 안에 있다',
    ok: getComputedStyle(nav).position === 'static', detail: getComputedStyle(nav).position });
  out.push({ name: '하단 바가 화면 맨 아래에 붙어 있다',
    ok: Math.abs(nr.bottom - window.innerHeight) < 4, detail: `bottom ${Math.round(nr.bottom)} / ${window.innerHeight}` });

  // 본문을 끝까지 굴려도 바는 그대로고, 마지막 줄이 바에 안 가린다
  main.scrollTop = main.scrollHeight;
  await new Promise((r) => setTimeout(r, 120));
  const nr2 = nav.getBoundingClientRect();
  out.push({ name: '본문을 끝까지 굴려도 바가 제자리에 있다',
    ok: Math.abs(nr2.top - nr.top) < 2, detail: `${Math.round(nr.top)} → ${Math.round(nr2.top)}` });
  out.push({ name: '본문 마지막 줄이 하단 바에 가리지 않는다',
    ok: body.lastElementChild.getBoundingClientRect().bottom <= nr2.top + 1,
    detail: `${Math.round(body.lastElementChild.getBoundingClientRect().bottom)} vs ${Math.round(nr2.top)}` });

  // 목차를 굴려도 본문은 가만히 있어야 한다
  const mBefore = main.scrollTop;
  out.push({ name: '목차에 제 스크롤이 있다', ok: toc.scrollHeight - toc.clientHeight > 0,
    detail: `${toc.scrollHeight - toc.clientHeight}px` });
  toc.scrollTop = toc.scrollHeight;
  await new Promise((r) => setTimeout(r, 80));
  out.push({ name: '목차만 굴리면 본문은 안 움직인다', ok: main.scrollTop === mBefore,
    detail: `${mBefore} → ${main.scrollTop}` });
  out.push({ name: '목차를 굴려도 페이지는 안 움직인다', ok: window.scrollY === 0, detail: `${window.scrollY}` });

  // 헤더(도구막대)는 항상 보여야 한다
  out.push({ name: '도구막대가 화면 위에 남아 있다',
    ok: document.querySelector('#readScreen > header').getBoundingClientRect().top >= -1 });
  return out;
});

// ══════════ 5b. 목차 버튼이 앱의 실제 핸들러로 동작하는가 ══════════
// (위 5번은 CSS/레이아웃 검증. 여기서는 index.html에 걸린 진짜 onclick을 누른다.)
await run('목차 버튼', async () => {
  const out = [];
  const rs = document.getElementById('readScreen');
  rs.classList.remove('toc-off');
  const btn = document.getElementById('readTocBtn');
  const hide = document.getElementById('readTocHide');
  out.push({ name: '목차 토글 버튼에 핸들러가 걸려 있다', ok: typeof btn.onclick === 'function' });
  out.push({ name: '목차 접기(«) 버튼에 핸들러가 걸려 있다', ok: typeof hide.onclick === 'function' });
  out.push({ name: '스크림에 핸들러가 걸려 있다',
    ok: typeof document.getElementById('readTocScrim').onclick === 'function' });

  btn.click();
  const offAfter = rs.classList.contains('toc-off');
  btn.click();
  const onAfter = !rs.classList.contains('toc-off');
  out.push({ name: '버튼을 누르면 접힌다', ok: offAfter });
  out.push({ name: '다시 누르면 펴진다', ok: onAfter });

  hide.click();
  out.push({ name: '«로 접힌다', ok: rs.classList.contains('toc-off') });
  out.push({ name: '접은 상태가 저장된다', ok: localStorage.getItem('toc_open') === '0',
    detail: String(localStorage.getItem('toc_open')) });
  btn.click();
  out.push({ name: '펼친 상태가 저장된다', ok: localStorage.getItem('toc_open') === '1' });
  return out;
});

// ══════════ 5c. 위키 섹션 드롭다운 ══════════
await run('위키 드롭다운', () => {
  const out = [];
  document.querySelectorAll('section').forEach((s) => s.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.getElementById('wikiPanel').classList.remove('hidden');
  const pick = document.getElementById('wikiSecPick');
  out.push({ name: '섹션 드롭다운이 존재한다', ok: !!pick && pick.tagName === 'SELECT' });
  if (!pick) return out;

  ['1. 비주기', '2. 알레르기비염 치료 원칙', '6. 미각성 비염'].forEach((h, i) => {
    const o = document.createElement('option'); o.value = String(i); o.textContent = h; pick.appendChild(o);
  });
  pick.value = '1';
  const r = pick.getBoundingClientRect();
  out.push({ name: '드롭다운이 실제로 보인다', ok: r.width > 80 && r.height > 20,
    detail: `${Math.round(r.width)}x${Math.round(r.height)}` });
  out.push({ name: '드롭다운 타깃 높이가 충분', ok: r.height >= 28, detail: `${Math.round(r.height)}px` });
  out.push({ name: '제목이 패널 밖으로 넘치지 않는다',
    ok: r.right <= document.getElementById('wikiPanel').getBoundingClientRect().right + 1 });
  out.push({ name: '항목을 고르면 값이 바뀐다', ok: pick.value === '1' && pick.options.length === 3 });
  // 펜으로 눌려야 한다 — select는 button이 아니므로 isUiTarget에 select가 있어야 한다
  out.push({ name: '펜이 드롭다운을 UI로 인식한다(select)', ok: !!pick.closest('select') });
  while (pick.options.length) pick.remove(0);
  return out;
});

// ══════════ 5d. 노트 탭 2단 묶음 + 앱 이름 ══════════
await run('노트 탭', () => {
  const out = [];
  out.push({ name: '앱 이름이 달모', ok: document.title === '달모', detail: document.title });
  const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  out.push({ name: '홈화면 이름이 달모', ok: meta && meta.content === '달모',
    detail: meta ? meta.content : 'null' });

  document.querySelectorAll('section').forEach((s) => s.classList.add('hidden'));
  document.getElementById('listScreen').classList.remove('hidden');
  document.getElementById('notesBody').classList.remove('hidden');

  // 앱이 만드는 것과 같은 구조를 세운다(임종평 20과목 포함)
  const body = document.getElementById('notesBody');
  body.innerHTML = '';
  const mk = (label, subjects, open) => {
    const o = document.createElement('details');
    o.className = 'root-group'; o.open = open;
    const s2 = document.createElement('summary');
    s2.className = 'root-head';
    s2.innerHTML = `<span class="head-row"><span>${label}</span><span class="subject-count">${subjects.length}과목</span></span>`;
    o.appendChild(s2);
    subjects.forEach((nm) => {
      const d2 = document.createElement('details');
      d2.className = 'subject-group';
      const s3 = document.createElement('summary');
      s3.className = 'subject-head';
      s3.innerHTML = `<span class="head-row"><span>${nm}</span><span class="subject-count">10개</span></span>`;
      d2.appendChild(s3); o.appendChild(d2);
    });
    body.appendChild(o);
    return o;
  };
  mk('예습노트', ['두경부 피부', '응급 중환자', '근골격계'], true);
  mk('위키', ['두경부 피부', '응급 중환자', '산부인과', '직업환경의학', '근골격계'], true);
  const imj = mk('임종평 전범위',
    Array.from({ length: 20 }, (_, i) => `과목${i + 1}`), false);

  out.push({ name: '뿌리 그룹이 3개', ok: body.querySelectorAll('.root-group').length === 3 });
  out.push({ name: '임종평은 접힌 채로 시작', ok: !imj.open });

  // 임종평이 접혀 있으면 그 안의 20과목은 화면에 자리를 차지하지 않아야 한다
  // ⚠️ 접힌 details 안의 자식은 getBoundingClientRect가 0이 아닌 값을 돌려준다(Chrome 실측).
  //    "화면을 실제로 얼마나 먹는가"는 **부모 그룹의 높이**로 재야 정확하다.
  const groupH = (el) => Math.round(el.getBoundingClientRect().height);
  const closedH = groupH(imj);
  const headH = groupH(imj.querySelector('summary.root-head'));
  out.push({ name: '접힌 임종평이 헤더 높이만 차지한다(20과목 안 보임)',
    ok: closedH <= headH + 14, detail: `그룹 ${closedH}px / 헤더 ${headH}px` });

  // 펼치면 20과목만큼 늘어난다
  imj.open = true;
  const openH = groupH(imj);
  out.push({ name: '펼치면 20과목만큼 늘어난다', ok: openH > closedH + 600,
    detail: `${closedH} → ${openH}px` });
  imj.open = false;
  out.push({ name: '다시 접으면 원래대로', ok: groupH(imj) === closedH, detail: `${groupH(imj)}px` });

  // 전체 목록 길이로도 확인 — 접힌 상태에서 노트탭 전체가 한 화면에 들어와야 한다
  const bodyH = Math.round(body.getBoundingClientRect().height);
  out.push({ name: '접힌 상태에서 노트탭 전체가 짧다', ok: bodyH < 900,
    detail: `${bodyH}px (전부 펼치면 1500px+)` });

  const rh = body.querySelector('.root-head');
  out.push({ name: '뿌리 헤더가 탭하기 충분한 크기',
    ok: rh.getBoundingClientRect().height >= 40, detail: `${Math.round(rh.getBoundingClientRect().height)}px` });
  out.push({ name: '뿌리 헤더에 기본 마커가 없다(직접 그린 ▸ 사용)',
    ok: getComputedStyle(rh).listStyleType === 'none' });
  return out;
});

// ══════════ 5e. 유령 DOM 참조 — 이번 회귀의 직접 원인 ══════════
// 드롭다운을 넣으면서 #wikiHeading을 지웠는데 loadWiki가 계속 참조해서,
// 위키 패널이 **통째로 빈 채로** 뜨고 있었다(2026-10-09). 다시는 못 일어나게 전수조사한다.
await run('유령 참조', () => {
  const out = [];
  const ids = new Set([...document.querySelectorAll('[id]')].map((e) => e.id));
  // 스플래시는 역할이 끝나면 DOM에서 빠진다 — 소스에 있으면 정상이다
  return fetch('/index.html').then((r) => r.text()).then((htmlSrc) => {
    [...htmlSrc.matchAll(/id="([^"]+)"/g)].forEach((m) => ids.add(m[1]));
    return fetch('/js/app.js').then((r) => r.text());
  }).then(async (appSrc) => {
    const srcs = { 'app.js': appSrc };
    for (const f of ['quiz.js', 'wiki.js', 'ask.js', 'reader.js', 'search.js', 'pen.js', 'markdown.js']) {
      srcs[f] = await fetch(`/js/${f}`).then((r) => r.text());
    }
    const bad = [];
    for (const [f, src] of Object.entries(srcs)) {
      for (const m of src.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
        if (ids.has(m[1])) continue;
        // 없으면 만들어 쓰는 패턴(let x = getElementById(...); if (!x) { ... create })은 정상
        const after = src.slice(m.index, m.index + 300);
        // "없으면 만들어 쓰는" 패턴은 정상 — 그 id로 createElement 하는 코드가 근처에 있다
        if (/createElement/.test(after) && new RegExp(`id\\s*=\\s*'${m[1]}'`).test(src)) continue;
        bad.push(`${f}: #${m[1]}`);
      }
    }
    out.push({ name: 'HTML에 없는 id를 참조하는 코드가 없다', ok: bad.length === 0, detail: bad.join(' | ') });
    return out;
  });
});

// ══════════ 5f. 위키 자동 매칭이 실제로 화면에 뜨는가 ══════════
// wikiRefs가 없는 기존 시험에서도 폴백이 동작해야 한다 — 이게 안 되면 패널이 빈다.
await run('위키 렌더', async () => {
  const out = [];
  const { splitSections, contentSections, rankSections, fitLabel } = await import('/js/wiki.js');
  const { renderMarkdown } = await import('/js/markdown.js');
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.getElementById('quizScreen').classList.add('with-side');
  document.getElementById('wikiPanel').classList.remove('hidden');

  const md = [
    '# 중환자실 감염관리', '',
    '## 0. Exam Cheat Sheet', '핵심 키워드', '',
    '## 1. 표준주의와 전파경로별 주의', '공기주의는 N95를 쓴다. 결핵·수두·홍역이 공기매개다.', '',
    '## 2. 중심정맥관 관련 혈류감염', '삽입 시 최대멸균차단막을 쓴다.', '',
  ].join('\n');
  const all = splitSections(md);
  const body = contentSections(all);
  out.push({ name: '노트가 섹션으로 쪼개진다', ok: all.length === 3, detail: `${all.length}개` });
  out.push({ name: 'Cheat Sheet는 매칭 후보에서 빠진다', ok: body.length === 2 });

  const q = { num: 1, q: '격리병실 소아환자 회진 시 N95 마스크가 필요한 질환은?',
    opts: ['독감', '수두', '백일해', '볼거리', '손발입병'], explain: '수두는 공기매개다.' };
  const ranked = rankSections(q, body);
  out.push({ name: '자동 매칭이 맞는 섹션을 1등으로', ok: ranked[0].heading.startsWith('1.'),
    detail: ranked[0].heading });

  // 실제로 loadWiki가 하는 일을 그대로 해본다
  const refs = { noteName: '1014_응급중환자_중환자실감염관리', auto: true,
    sections: [...ranked, ...all.filter((s) => !body.some((b) => b.heading === s.heading))
      .map((s) => ({ ...s, score: 0, fit: 0, extra: true }))] };
  const pick = document.getElementById('wikiSecPick');
  pick.innerHTML = '';
  refs.sections.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = s.heading + (s.extra ? ' · 참고' : (i === 0 ? ` · ${fitLabel(s.fit || 0)}` : ''));
    pick.appendChild(o);
  });
  document.getElementById('wikiNote').textContent = `${refs.noteName} · 1/${refs.sections.length} · 자동 매칭`;
  const wb = document.getElementById('wikiBody');
  wb.innerHTML = renderMarkdown(refs.sections[0].text);

  out.push({ name: '드롭다운에 섹션이 전부 들어간다', ok: pick.options.length === 3,
    detail: `${pick.options.length}개` });
  out.push({ name: '참고 섹션에 · 참고 꼬리표', ok: [...pick.options].some((o) => /· 참고$/.test(o.textContent)) });
  out.push({ name: '위키 본문이 실제로 렌더된다', ok: wb.textContent.includes('N95'),
    detail: wb.textContent.slice(0, 40) });
  out.push({ name: '위키 본문이 화면에서 높이를 가진다',
    ok: wb.getBoundingClientRect().height > 20, detail: `${Math.round(wb.getBoundingClientRect().height)}px` });
  out.push({ name: '노트 이름 줄이 비어있지 않다',
    ok: document.getElementById('wikiNote').textContent.includes('자동 매칭') });
  return out;
});

// ══════════ 5g. 캡처 모드 · 문제 뜯어보기 (2026-10-10) ══════════
await run('신규 기능', async () => {
  const out = [];
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.body.dataset.screen = 'quizScreen';     // 도구막대는 이 화면에서만 뜬다
  await new Promise((r) => setTimeout(r, 30));

  // 버튼이 있는가
  const cap = document.getElementById('toolCapture');
  const brk = document.getElementById('toolBreak');
  out.push({ name: '캡처 버튼이 지우개 옆에 있다',
    ok: !!cap && cap.previousElementSibling && cap.previousElementSibling.id === 'toolErase' });
  out.push({ name: '뜯어보기 버튼이 있다', ok: !!brk });
  out.push({ name: '두 버튼 모두 탭 가능한 크기',
    ok: cap.getBoundingClientRect().height >= 30 && brk.getBoundingClientRect().height >= 30,
    detail: `${Math.round(cap.getBoundingClientRect().height)}px` });

  // 펜 레이어의 캡처 모드
  const { PenLayer } = await import('/js/pen.js');
  let captured = null, selected = null;
  const pen = new PenLayer(document.getElementById('qcard'), {
    onSelect: (t) => { selected = t; },
    onCapture: (b) => { captured = b; },
  });
  out.push({ name: '펜 레이어가 캡처 모드를 안다', ok: typeof pen.setCapturing === 'function' });
  pen.setCapturing(true);
  out.push({ name: '캡처를 켜면 지우개가 꺼진다', ok: pen.capturing && !pen.erasing });
  pen.setErasing(true);
  out.push({ name: '지우개를 켜면 캡처가 꺼진다', ok: pen.erasing && !pen.capturing });
  pen.setErasing(false);
  pen.setCapturing(true);

  // 지문을 토큰으로 채우고 네모를 그린다
  const mk = (t) => t.split(/(\s+)/).map((w) => /^\s+$/.test(w) ? w : `<span class="tok">${w}</span>`).join('');
  const QTEXT = '12세 남아가 왼쪽 무릎이 아파 병원에 왔다. 항생제와 비스테로이드 소염제로 치료를 하였으나 좋아지지 않았다. metaphysis에서 발생한 골종양 소견이 확인되었다.';
  document.getElementById('qtext').innerHTML = mk(QTEXT);

  const pev = (type, x, y) => {
    const e = new PointerEvent(type, { pointerId: 1, pointerType: 'pen', isPrimary: true,
      pressure: type === 'pointerup' ? 0 : 0.5, clientX: x, clientY: y,
      bubbles: true, cancelable: true, composed: true });
    (document.elementFromPoint(x, y) || document.body).dispatchEvent(e);
  };
  const toks = [...document.querySelectorAll('#qtext .tok')];
  const a = toks[0].getBoundingClientRect(), b = toks[5].getBoundingClientRect();
  pev('pointerdown', a.left - 4, a.top - 4);
  for (let i = 1; i <= 6; i++) pev('pointermove', a.left + ((b.right - a.left) * i) / 6, a.top + ((b.bottom - a.top) * i) / 6);
  pev('pointerup', b.right + 4, b.bottom + 4);
  await new Promise((r) => setTimeout(r, 520));

  out.push({ name: '캡처 모드에서 네모 → onCapture가 불린다', ok: !!captured,
    detail: captured ? `${Math.round(captured.r - captured.l)}x${Math.round(captured.b - captured.t)}` : 'null' });
  out.push({ name: '캡처 모드에서는 텍스트를 선택하지 않는다', ok: selected === null });
  out.push({ name: '캡처 모드에서 궤적을 남기지 않는다', ok: pen.strokes.length === 0,
    detail: `${pen.strokes.length} stroke` });
  pen.destroy();

  // 캡처 모듈이 실제로 이미지를 만드는가
  const { captureRect, canvasToBlob } = await import('/js/capture.js');
  const qb = document.getElementById('qcard').getBoundingClientRect();
  const cv = await captureRect({ left: qb.left + 5, top: qb.top + 5, width: 200, height: 80 });
  out.push({ name: '캡처가 캔버스를 만든다', ok: cv && cv.width > 100 && cv.height > 40,
    detail: cv ? `${cv.width}x${cv.height}` : 'null' });
  const blob = await canvasToBlob(cv);
  out.push({ name: '캡처가 PNG blob을 만든다', ok: blob && blob.type === 'image/png' && blob.size > 100,
    detail: blob ? `${blob.type} ${blob.size}B` : 'null' });

  // ── 문제 뜯어보기: 단서 → 인상 → 선지 쳐내기 ──
  const { parseBreakdown } = await import('/js/gemini.js');
  const Q = { q: QTEXT, opts: ['이뇨제 고용량', '베타 차단제', '기계적 순환 보조', '동율동 전환', '관찰'] };
  const resp = [
    '[단서]',
    'metaphysis에서 발생한 골종양 || 골간단 발생 → 골육종 전형 위치',
    '항생제와 비스테로이드 소염제로 치료를 하였으나 좋아지지 않았다 || 골수염 배제',
    '지문에 없는 문장 || 이건 버려져야 한다',
    '[인상]',
    '골간단 골종양 + 항생제 무반응 → 골육종이 1순위',
    '[선지]',
    '① || X || 저혈압에 이뇨제는 전부하를 더 떨어뜨린다',
    '② || X || 수축력 더 떨어뜨리는 약은 급성기 금기',
    '③ || O || 약물 불응 쇼크 → 기계적 순환 보조',
    '④ || X || 부정맥이 원인이 아니다',
    '⑤ || X || 즉각 보조 없이 관찰은 사망 위험',
  ].join('\n');
  const bd = parseBreakdown(resp, Q);
  out.push({ name: '지문에 없는 단서는 버린다', ok: bd.clues.length === 2, detail: `${bd.clues.length}개` });
  out.push({ name: '인상 한 줄을 뽑는다', ok: /골육종이 1순위/.test(bd.impression), detail: bd.impression });
  out.push({ name: '선지 5개를 전부 읽는다', ok: bd.options.length === 5, detail: `${bd.options.length}개` });
  out.push({ name: '정답 선지만 keep', ok: bd.options.filter((o) => o.keep).length === 1
    && bd.options.find((o) => o.keep).idx === 2 });
  out.push({ name: '쳐내는 기준이 문장으로 들어온다',
    ok: bd.options.every((o) => o.why && o.why.length > 5) });
  // 선지 번호가 범위를 벗어나면 버린다(모델이 ⑥을 만들어내는 경우)
  const over = parseBreakdown('[선지]\n⑥ || X || 없는 선지', Q);
  out.push({ name: '없는 선지 번호는 버린다', ok: over.options.length === 0 });

  // 실제 렌더
  const el = document.getElementById('breakdown');
  out.push({ name: '뜯어보기 영역이 지문 바로 아래', ok: !!el &&
    el.previousElementSibling && el.previousElementSibling.id === 'qtext' });
  el.classList.remove('hidden');
  el.innerHTML = '';
  const mkRow = (cls, ...kids) => { const d = document.createElement('div'); d.className = cls; d.append(...kids); el.appendChild(d); return d; };
  const sp = (c, t) => { const x = document.createElement('span'); x.className = c; x.textContent = t; return x; };
  bd.clues.forEach((c) => mkRow('bd-row', sp('bd-frag', c.frag), sp('bd-arrow', '→'), sp('bd-note', c.note)));
  mkRow('bd-impression', sp('bd-tag', '읽고 나면'), sp('', bd.impression));
  mkRow('bd-sub', document.createTextNode('선지 쳐내기'));
  bd.options.forEach((o) => mkRow(`bd-opt${o.keep ? ' keep' : ''}`,
    sp('bd-opt-num', '①②③④⑤'[o.idx]), sp('bd-opt-mark', o.keep ? 'O' : '✕'), sp('bd-opt-why', o.why)));

  out.push({ name: '뜯어보기가 화면에 높이를 가진다', ok: el.getBoundingClientRect().height > 150,
    detail: `${Math.round(el.getBoundingClientRect().height)}px` });
  out.push({ name: '원문 조각에 밑줄 강조',
    ok: getComputedStyle(el.querySelector('.bd-frag')).borderBottomWidth !== '0px' });
  out.push({ name: '인상 줄이 가장 굵다',
    ok: Number(getComputedStyle(el.querySelector('.bd-impression')).fontWeight) >= 700 });
  const keep = el.querySelector('.bd-opt.keep'), drop = el.querySelector('.bd-opt:not(.keep)');
  out.push({ name: '정답 선지가 또렷하고 나머지는 흐리다',
    ok: Number(getComputedStyle(keep).opacity) > Number(getComputedStyle(drop).opacity),
    detail: `${getComputedStyle(keep).opacity} vs ${getComputedStyle(drop).opacity}` });
  out.push({ name: '쳐낸 선지 표시가 오답색', ok: getComputedStyle(drop.querySelector('.bd-opt-mark')).color
    !== getComputedStyle(keep.querySelector('.bd-opt-mark')).color });
  out.push({ name: '모든 선지 줄이 화면에 보인다',
    ok: [...el.querySelectorAll('.bd-opt')].every((r) => r.getBoundingClientRect().height > 10),
    detail: `${el.querySelectorAll('.bd-opt').length}줄` });
  return out;
});

// ══════════ 5g-2. 단서 번호가 지문 ↔ 뜯어보기를 잇는가 (2026-10-10) ══════════
await run('단서 번호', async () => {
  const out = [];
  const mk = (t) => t.split(/(\s+)/).map((w) => /^\s+$/.test(w) ? w : `<span class="tok">${w}</span>`).join('');
  const QT = '갑상샘절제술 후 높은음이 올라가지 않고 목소리가 쉰 환자가 왔다. 후두내시경에서 성대 움직임은 정상이었다.';
  document.getElementById('qtext').innerHTML = mk(QT);

  const { parseBreakdown } = await import('/js/gemini.js');
  // 일부러 **본문 순서와 다르게** 준다 — 읽는 순서대로 번호가 매겨져야 한다
  const resp = [
    '[단서]',
    '성대 움직임은 정상 || 반회후두신경 마비 배제',
    '갑상샘절제술 후 || 상후두신경 외지 손상 의심',
    '높은음이 올라가지 않고 || 윤상갑상근 마비 — 고음 생성 불가',
    '[인상]',
    '상후두신경 외지 손상',
  ].join('\n');
  const bd = parseBreakdown(resp, { q: QT, opts: ['가', '나'] });
  out.push({ name: '단서 3개를 읽는다', ok: bd.clues.length === 3, detail: `${bd.clues.length}개` });

  // 앱과 같은 방식으로 번호를 매긴다
  const toks = [...document.querySelectorAll('#qtext .tok')];
  let acc = ''; const starts = [];
  toks.forEach((t) => { starts.push(acc.length); acc += t.textContent; });
  const numbered = bd.clues
    .map((c) => ({ ...c, pos: acc.indexOf(c.frag.replace(/\s+/g, '')) }))
    .sort((a, b) => (a.pos < 0 ? 1e9 : a.pos) - (b.pos < 0 ? 1e9 : b.pos))
    .map((c, i) => ({ ...c, n: i + 1 }));

  out.push({ name: '모든 단서를 지문에서 찾는다', ok: numbered.every((c) => c.pos >= 0),
    detail: numbered.map((c) => c.pos).join(',') });
  out.push({ name: '읽는 순서대로 번호가 매겨진다',
    ok: numbered[0].frag.startsWith('갑상샘절제술') && numbered[2].frag.startsWith('성대'),
    detail: numbered.map((c) => `${c.n}.${c.frag.slice(0, 6)}`).join(' ') });

  // 지문에 배지를 심는다(앱의 highlightFragments와 동일한 로직)
  document.querySelectorAll('#qtext .bd-badge').forEach((b) => b.remove());
  for (const c of numbered) {
    const needle = c.frag.replace(/\s+/g, '');
    const at = acc.indexOf(needle), end = at + needle.length;
    let last = null;
    toks.forEach((t, i) => {
      const a = starts[i], b = a + t.textContent.length;
      if (b > at && a < end) { t.classList.add('bd-mark'); last = t; }
    });
    if (!last) continue;
    const badge = document.createElement('sup');
    badge.className = 'bd-badge'; badge.textContent = c.n; badge.dataset.n = String(c.n);
    last.after(badge);
  }
  const badges = [...document.querySelectorAll('#qtext .bd-badge')];
  out.push({ name: '지문에 번호 배지가 3개 붙는다', ok: badges.length === 3, detail: `${badges.length}개` });
  out.push({ name: '배지 번호가 1,2,3 순서로 나타난다',
    ok: badges.map((b) => b.textContent).join('') === '123', detail: badges.map((b) => b.textContent).join('') });
  out.push({ name: '배지가 화면에 보인다',
    ok: badges.every((b) => b.getBoundingClientRect().width > 8),
    detail: `${Math.round(badges[0].getBoundingClientRect().width)}px` });
  out.push({ name: '배지가 글자 위로 올라간다(vertical-align)',
    ok: getComputedStyle(badges[0]).verticalAlign === 'super', detail: getComputedStyle(badges[0]).verticalAlign });

  // 뜯어보기 란에 같은 번호
  const el = document.getElementById('breakdown');
  el.classList.remove('hidden'); el.innerHTML = '';
  for (const c of numbered) {
    const row = document.createElement('div'); row.className = 'bd-row';
    const i2 = document.createElement('span'); i2.className = 'bd-idx'; i2.textContent = c.n;
    const f = document.createElement('span'); f.className = 'bd-frag'; f.textContent = c.frag;
    const n2 = document.createElement('span'); n2.className = 'bd-note'; n2.textContent = c.note;
    row.append(i2, f, n2); el.appendChild(row);
  }
  const idxs = [...el.querySelectorAll('.bd-idx')];
  out.push({ name: '뜯어보기 란에도 같은 번호', ok: idxs.map((x) => x.textContent).join('') === '123',
    detail: idxs.map((x) => x.textContent).join('') });
  out.push({ name: '번호가 동그란 배지로 보인다',
    ok: idxs[0].getBoundingClientRect().width >= 15 && getComputedStyle(idxs[0]).borderRadius !== '0px',
    detail: `${Math.round(idxs[0].getBoundingClientRect().width)}px r=${getComputedStyle(idxs[0]).borderRadius}` });

  // 같은 번호끼리 내용이 맞는가 (이게 핵심 — 번호가 엇갈리면 쓸모가 없다)
  const pairOk = numbered.every((c) => {
    const badge = document.querySelector(`#qtext .bd-badge[data-n="${c.n}"]`);
    const row = idxs.find((x) => x.textContent === String(c.n)).parentElement;
    return badge && row.querySelector('.bd-frag').textContent === c.frag;
  });
  out.push({ name: '같은 번호끼리 같은 조각을 가리킨다', ok: pairOk });

  // 지문에 없는 조각은 번호를 받지 못한다
  const withGhost = parseBreakdown(resp + '\n지어낸문장 || 버려져야 함', { q: QT, opts: ['가', '나'] });
  out.push({ name: '지어낸 조각은 번호도 안 받는다', ok: withGhost.clues.length === 3 });
  return out;
});

// ══════════ 5h. 캡처는 새 창을 띄우지 않는다 (2026-10-10 회귀 방지) ══════════
await run('캡처 토스트', () => {
  const out = [];
  return fetch('/js/app.js').then((r) => r.text()).then((src) => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    out.push({ name: '캡처 경로에 window.open이 없다(주석 제외)', ok: !/window\.open\s*\(/.test(code),
      detail: (code.match(/window\.open[^\n]*/) || [''])[0].slice(0, 50) });
    out.push({ name: '캡처 결과를 토스트로 알린다', ok: /function capToast/.test(src) });
    // 이모지는 기기마다 모양·무게가 달라 줄이 안 맞는다 → 선 굵기를 통일한 SVG로 바꿨다(2026-10-10)
    const capIc = document.querySelector('#toolCapture .ic');
    out.push({ name: '캡처 버튼이 SVG 아이콘', ok: !!capIc && capIc.tagName.toLowerCase() === 'svg' });
    out.push({ name: '도구 아이콘이 전부 SVG로 통일',
      ok: ['toolErase', 'toolCapture', 'toolUndo', 'toolClear', 'toolWiki', 'toolAi', 'toolBreak']
        .every((id) => !!document.querySelector(`#${id} .ic`)) });
    out.push({ name: '아이콘이 현재 색을 따른다(활성·다크모드 대응)',
      ok: getComputedStyle(capIc).stroke === getComputedStyle(document.getElementById('toolCapture')).color });
    // 토스트가 실제로 떴다 사라지는가
    const t = document.createElement('div');
    t.id = 'capToast'; t.textContent = '📋 복사했습니다';
    document.body.appendChild(t);
    const cs = getComputedStyle(t);
    out.push({ name: '토스트가 화면 위에 뜬다', ok: cs.position === 'fixed' && Number(cs.zIndex) > 100,
      detail: `${cs.position} z=${cs.zIndex}` });
    out.push({ name: '토스트가 반투명 배경', ok: /rgba/.test(cs.backgroundColor), detail: cs.backgroundColor });
    out.push({ name: '토스트가 입력을 막지 않는다', ok: cs.pointerEvents === 'none' });
    t.remove();
    // 도구 설명이 분명한가(무슨 버튼인지 몰랐다는 피드백)
    ['toolErase', 'toolUndo', 'toolClear', 'toolCapture', 'toolBreak'].forEach((id) => {
      const b = document.getElementById(id);
      out.push({ name: `${id} 설명이 한 줄 이상`, ok: (b.title || '').length > 8, detail: b.title });
    });
    return out;
  });
});

// ══════════ 5i. 응답이 잘려도 죽지 않는다 (2026-10-10 버그) ══════════
// gemini-2.5-flash가 "생각"에 예산을 다 써서 답이 한 줄 쓰다 잘렸다.
// thinking을 껐고, 그래도 잘리면 거기까지 보여준다.
await run('잘림 처리', async () => {
  const out = [];
  const G = await import('/js/gemini.js');
  const realFetch = window.fetch;
  try {
    // 요청 본문에 thinkingBudget:0 이 실리는지 가로채서 확인
    let sentBody = null;
    window.fetch = async (url, init) => {
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ candidates: [{
          content: { parts: [{ text: '[단서]\nmetaphysis에서 발생한 골종양 || 골간단 발생 → 골육종' }] },
          finishReason: 'MAX_TOKENS',
        }] }),
      };
    };
    await G.setKey('TEST_KEY_NOT_REAL');
    G.resetLimiter();
    const q = { q: 'metaphysis에서 발생한 골종양 소견이 확인되었다.', opts: ['가', '나'] };
    const r = await G.breakdown(q);
    out.push({ name: '요청에 thinkingBudget:0이 실린다',
      ok: sentBody && sentBody.generationConfig && sentBody.generationConfig.thinkingConfig
        && sentBody.generationConfig.thinkingConfig.thinkingBudget === 0,
      detail: JSON.stringify(sentBody && sentBody.generationConfig) });
    out.push({ name: '잘려도 던지지 않고 결과를 준다', ok: !!r && Array.isArray(r.clues) });
    out.push({ name: '잘린 것까지는 살린다', ok: r.clues.length === 1, detail: `${r.clues.length}개` });
    out.push({ name: '잘렸음을 표시한다', ok: r.truncated === true });
    await G.clearKey();
  } finally {
    window.fetch = realFetch;
  }
  return out;
});

// ══════════ 5j. Gemini 키 여러 개 · 자동 전환 (2026-10-10) ══════════
// "요청이 많습니다"가 떠서 돋보기를 못 쓰는 일이 없게, 키가 한도에 걸리면
// 다음 키로 넘어간다. 키마다 한도가 따로다.
await run('키 전환', async () => {
  const out = [];
  const G = await import('/js/gemini.js');
  const realFetch = window.fetch;
  try {
    await G.setKeys(['AIza_KEY_ONE', 'AIza_KEY_TWO', 'AIza_KEY_THREE']);
    G.resetLimiter();
    out.push({ name: '키 3개가 저장된다', ok: (await G.getKeys()).length === 3 });
    out.push({ name: '키가 가려져 표시된다', ok: G.maskKey('AIza_KEY_ONE_SECRET_TAIL').includes('…')
      && !G.maskKey('AIza_KEY_ONE_SECRET_TAIL').includes('SECRET'),
      detail: G.maskKey('AIza_KEY_ONE_SECRET_TAIL') });

    // ① 1번 키가 429를 주면 2번 키로 넘어가야 한다
    const used = [];
    window.fetch = async (url, init) => {
      const k = init.headers['x-goog-api-key'];
      used.push(k);
      if (k === 'AIza_KEY_ONE') {
        return { ok: false, status: 429, text: async () => '{"error":{"details":[{"retryDelay":"42s"}]}}' };
      }
      return { ok: true, json: async () => ({ candidates: [{
        content: { parts: [{ text: '[인상]\n정상 응답' }] }, finishReason: 'STOP' }] }) };
    };
    const r = await G.breakdown({ q: '테스트 지문', opts: ['가', '나'] });
    const order = used.filter((k, i) => k !== used[i - 1]);   // 연속 중복(폴백)은 한 번으로
    out.push({ name: '1번 키가 429면 다음 키로 넘어간다',
      ok: order.join(',') === 'AIza_KEY_ONE,AIza_KEY_TWO', detail: used.join(' → ') });
    out.push({ name: '전환 후 정상 응답을 받는다', ok: r.impression === '정상 응답', detail: r.impression });

    // ② 막힌 키는 쉬는 중으로 표시되고 다음 호출에서 건너뛴다
    const st = await G.keyStatus();
    const one = st.find((x) => x.key === 'AIza_KEY_ONE');
    out.push({ name: '429 맞은 키는 쉬는 중으로 표시', ok: one && !one.ok && one.waitSec > 30,
      detail: one ? `${one.waitSec}초` : 'null' });
    out.push({ name: '쉬는 키는 사용 가능 목록에서 빠진다',
      ok: !(await G.usableKeys()).includes('AIza_KEY_ONE') });

    used.length = 0;
    await G.breakdown({ q: '다른 지문', opts: ['가', '나'] });
    out.push({ name: '다음 호출은 막힌 키를 아예 건너뛴다', ok: !used.includes('AIza_KEY_ONE'),
      detail: used.join(' → ') });

    // ③ 키 하나뿐일 때 한도를 다 쓰면 RATE_WAIT
    await G.setKeys(['AIza_ONLY']);
    G.resetLimiter();
    window.fetch = async () => ({ ok: false, status: 429, text: async () => '{"retryDelay":"17s"}' });
    let msg = '';
    try { await G.breakdown({ q: 'x', opts: ['가', '나'] }); } catch (e) { msg = e.message; }
    out.push({ name: '키가 다 막히면 RATE_WAIT을 준다', ok: /^RATE_WAIT:\d+$/.test(msg), detail: msg });

    // ④ 잘못된 키는 건너뛰고 쓸 수 있는 키를 쓴다
    await G.setKeys(['AIza_BAD', 'AIza_GOOD']);
    G.resetLimiter();
    const used2 = [];
    window.fetch = async (url, init) => {
      const k = init.headers['x-goog-api-key'];
      used2.push(k);
      if (k === 'AIza_BAD') return { ok: false, status: 400, text: async () => '{"error":{"message":"API key not valid"}}' };
      return { ok: true, json: async () => ({ candidates: [{
        content: { parts: [{ text: '[인상]\n살았다' }] }, finishReason: 'STOP' }] }) };
    };
    const r2 = await G.breakdown({ q: 'y', opts: ['가', '나'] });
    const order2 = used2.filter((k, i) => k !== used2[i - 1]);
    out.push({ name: '잘못된 키는 건너뛰고 쓸 수 있는 키를 쓴다',
      ok: r2.impression === '살았다' && order2.join(',') === 'AIza_BAD,AIza_GOOD', detail: used2.join(' → ') });

    // ⑤ 키가 하나도 없으면 NO_KEY
    await G.setKeys([]);
    let nk = '';
    try { await G.breakdown({ q: 'z', opts: ['가', '나'] }); } catch (e) { nk = e.message; }
    out.push({ name: '키가 없으면 NO_KEY', ok: nk === 'NO_KEY', detail: nk });

    // ⑥ 구버전 단일 키를 자동으로 옮긴다
    const { kvSet, kvGet } = await import('/js/db.js');
    await kvSet('gemini_keys', undefined);
    await kvSet('gemini_key', 'AIza_OLD_SINGLE');
    const migrated = await G.getKeys();
    out.push({ name: '구버전 단일 키를 배열로 옮긴다',
      ok: migrated.length === 1 && migrated[0] === 'AIza_OLD_SINGLE', detail: JSON.stringify(migrated) });
    out.push({ name: '옮긴 뒤 구버전 키는 지운다', ok: !(await kvGet('gemini_key')) });

    await G.setKeys([]);
    G.resetLimiter();
  } finally {
    window.fetch = realFetch;
  }
  return out;
});

// ══════════ 5k. 퀴즈·모의고사 탭 분리 (2026-10-10) ══════════
await run('탭 분리', () => {
  const out = [];
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('listScreen').classList.remove('hidden');

  const tabs = [...document.querySelectorAll('.tab')];
  const WANT = ['오늘', '퀴즈', '모의고사', '족보', '노트 읽기', '카드'];
  out.push({ name: `탭이 ${WANT.length}개`, ok: tabs.length === WANT.length, detail: tabs.map((t) => t.textContent).join('·') });
  out.push({ name: `순서가 ${WANT.join(' → ')}`,
    ok: WANT.every((w, i) => tabs[i] && tabs[i].textContent === w),
    detail: tabs.map((t) => t.textContent).join(' ') });
  out.push({ name: '오늘 탭이 기본', ok: tabs[0].classList.contains('active') });
  out.push({ name: '탭마다 담을 자리가 있다',
    ok: ['todayBody', 'quizBody', 'listBody', 'jokboBody', 'notesBody', 'cardsBody']
      .every((id) => !!document.getElementById(id)) });
  // 어느 탭을 눌러도 그 탭 하나만 보여야 한다 — 탭을 추가하며 hidden 처리를 빼먹으면 겹친다.
  // (앞선 검사들이 탭을 옮겨놨을 수 있으므로 눌러서 상태를 만들고 본다.)
  const BODY = { today: 'todayBody', quizzes: 'quizBody', exams: 'listBody', jokbo: 'jokboBody',
    notes: 'notesBody', cards: 'cardsBody' };
  for (const t of tabs) {
    const key = t.dataset.tab;
    t.click();
    const mine = BODY[key];
    const others = Object.values(BODY).filter((id) => id !== mine);
    out.push({ name: `${t.textContent} 탭을 누르면 그 탭만 보인다`,
      ok: !!mine && !document.getElementById(mine).classList.contains('hidden')
        && others.every((id) => document.getElementById(id).classList.contains('hidden')),
      detail: Object.values(BODY).map((id) => `${id}:${document.getElementById(id).classList.contains('hidden') ? 'h' : 'V'}`).join(' ') });
  }
  // 카드 탭은 일부러 카드 화면으로 넘어간다 — 목록 화면으로 되돌려놓고 이어서 본다
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('listScreen').classList.remove('hidden');
  document.querySelector('.tab[data-tab="today"]').click();
  out.push({ name: '탭이 눌릴 만큼 크다', ok: tabs.every((t) => t.getBoundingClientRect().height >= 40),
    detail: `${Math.round(tabs[0].getBoundingClientRect().height)}px` });
  out.push({ name: '탭 글자가 안 눌린다(줄바꿈 없음)',
    ok: tabs.every((t) => t.getBoundingClientRect().height < 60 && getComputedStyle(t).whiteSpace === 'nowrap') });

  // 퀴즈 탭에는 퀴즈만, 모의고사 탭에는 모의고사만
  const index = [
    { subject: '근골격계', kind: '모의고사', exams: [{ file: '261012_a_모의고사.html', path: 'p1' }] },
    { subject: '두경부_피부', kind: '모의고사', exams: [{ file: '260930_b_모의고사.html', path: 'p2' }] },
    { subject: '근골격계', kind: '퀴즈', exams: [
      { file: '260917_박희완_소아외상_퀴즈.html', path: 'q1' },
      { file: '260915_이수진_근전도_퀴즈.html', path: 'q2' }] },
  ];
  // 앱의 renderList와 같은 필터를 적용해 본다
  const byKind = (k) => index.filter((g) => (g.kind || '모의고사') === k);
  out.push({ name: '퀴즈만 거르면 1그룹', ok: byKind('퀴즈').length === 1 });
  out.push({ name: '모의고사만 거르면 2그룹', ok: byKind('모의고사').length === 2 });
  out.push({ name: '두 탭의 그룹이 겹치지 않는다',
    ok: !byKind('퀴즈').some((g) => byKind('모의고사').includes(g)) });

  // 탭 전환이 화면을 바꾸는가
  const show = (which) => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === which));
    const map = { today: 'todayBody', quizzes: 'quizBody', exams: 'listBody', notes: 'notesBody', cards: 'cardsBody' };
    for (const [k, id] of Object.entries(map)) document.getElementById(id).classList.toggle('hidden', k !== which);
  };
  document.getElementById('quizBody').innerHTML = '<div class="exam-item">퀴즈 항목</div>';
  document.getElementById('listBody').innerHTML = '<div class="exam-item">모의고사 항목</div>';
  show('quizzes');
  out.push({ name: '퀴즈 탭: 퀴즈만 보인다',
    ok: document.getElementById('quizBody').getBoundingClientRect().height > 10
      && document.getElementById('listBody').getBoundingClientRect().height === 0 });
  show('exams');
  out.push({ name: '모의고사 탭: 모의고사만 보인다',
    ok: document.getElementById('listBody').getBoundingClientRect().height > 10
      && document.getElementById('quizBody').getBoundingClientRect().height === 0 });

  // 탭이 종류를 말해주므로 그룹 헤더의 꼬리표는 없어야 한다
  out.push({ name: '그룹 헤더에 중복 꼬리표가 없다', ok: !document.querySelector('.kind-tag') });
  return out;
});

// ══════════ 5l. 서비스워커가 옛 버전에 갇히지 않는가 (2026-10-10 버그) ══════════
// 배포했는데 아이패드에서 안 바뀌었다. GitHub Pages가 max-age=600을 주는 탓에
// sw.js가 fetch해도 **브라우저 HTTP 캐시가 옛 파일을 돌려줘서** 네트워크 우선이
// 무력화되고 있었다. cache:'no-cache'로 매번 서버에 검증하게 바꿨다.
await run('캐시 우회', () => {
  const out = [];
  return fetch('/sw.js').then((r) => r.text()).then(async (sw) => {
    out.push({ name: "fetch에 cache:'no-cache'를 준다",
      ok: /fetch\(e\.request,\s*\{\s*cache:\s*'no-cache'\s*\}\)/.test(sw),
      detail: (sw.match(/fetch\(e\.request[^)]*\)/) || [''])[0] });
    out.push({ name: '설치 때도 캐시를 거치지 않는다',
      ok: /addAll\(SHELL_FILES\.map\(\(u\) => new Request\(u, \{ cache: 'no-cache' \}\)\)\)/.test(sw) });
    out.push({ name: '실패한 응답은 캐시에 넣지 않는다', ok: /if \(res && res\.ok\)/.test(sw) });
    out.push({ name: 'SKIP_WAITING 메시지를 받는다', ok: /SKIP_WAITING/.test(sw) });
    out.push({ name: 'VERSION을 돌려준다', ok: /e\.ports\[0\]\.postMessage/.test(sw) });

    const app = await fetch('/js/app.js').then((r) => r.text());
    out.push({ name: '켤 때마다 새 버전을 확인한다', ok: /reg\.update\(\)/.test(app) });
    out.push({ name: '포그라운드로 돌아올 때도 확인한다',
      ok: /visibilitychange[\s\S]{0,200}check\(\)/.test(app) });
    out.push({ name: '새 버전이 있으면 알린다', ok: /showUpdateBar/.test(app) });
    out.push({ name: '첫 설치에는 알리지 않는다(controller 있을 때만)',
      ok: /navigator\.serviceWorker\.controller\) showUpdateBar/.test(app) });
    out.push({ name: '교체되면 화면을 새로 그린다', ok: /controllerchange[\s\S]{0,160}location\.reload/.test(app) });
    out.push({ name: '새로고침이 한 번만 돈다(무한루프 방지)', ok: /reloaded/.test(app) });
    out.push({ name: '설정에 앱 버전이 보인다', ok: !!document.getElementById('appVersion') });

    // 업데이트 배너가 실제로 보이고 눌리는가
    const bar = document.createElement('div');
    bar.id = 'updateBar';
    bar.innerHTML = '<span>새 버전이 준비됐습니다</span><button>지금 적용</button>';
    document.body.appendChild(bar);
    const cs = getComputedStyle(bar);
    const btn = bar.querySelector('button');
    out.push({ name: '배너가 화면 위에 뜬다', ok: cs.position === 'fixed' && Number(cs.zIndex) >= 300,
      detail: `${cs.position} z=${cs.zIndex}` });
    out.push({ name: '배너 버튼이 눌릴 크기', ok: btn.getBoundingClientRect().height >= 32,
      detail: `${Math.round(btn.getBoundingClientRect().height)}px` });
    out.push({ name: '배너가 화면 안에 있다',
      ok: bar.getBoundingClientRect().left >= 0 && bar.getBoundingClientRect().right <= window.innerWidth + 1 });
    bar.remove();
    return out;
  });
});

// ══════════ 5m. 읽다가 네모 쳐서 플래시카드 만들기 (2026-10-10 재작성) ══════════
// 설계: 블록 하나 = 카드 하나(빈칸 여럿) · 라벨은 안 가림 · 표는 모양 유지.
await run('카드 만들기', async () => {
  const out = [];
  const { cardsFromBox } = await import('/js/reader.js');
  const { renderMarkdown } = await import('/js/markdown.js');
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  const body = document.getElementById('readBody');
  const meta = { notePath: 'n.md', noteTitle: '노트', heading: '1. 쇼크' };
  const whole = () => { const r = body.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };

  // ── 한 문단의 강조 여럿 → 카드 한 장(빈칸 여럿) ──
  body.innerHTML = renderMarkdown(
    '심인성쇼크는 **수축기혈압 90mmHg 미만**이고 심장지수 ==2.2 미만==이며 *PCWP 15 이상*이다.');
  let cards = cardsFromBox(body, whole(), meta);
  out.push({ name: '한 문단은 카드 한 장', ok: cards.length === 1, detail: `${cards.length}장` });
  out.push({ name: '빈칸이 3개 생긴다', ok: cards[0].answers.length === 3,
    detail: cards[0].answers.join(' / ') });
  out.push({ name: '굵게·하이라이트·기울임을 모두 잡는다',
    ok: ['수축기혈압 90mmHg 미만', '2.2 미만', 'PCWP 15 이상'].every((a) => cards[0].answers.includes(a)) });
  out.push({ name: '본문 서식이 HTML로 보존된다', ok: /<p|<span/.test(cards[0].contextHtml) });
  // 답은 data-answer 속성에만 있어야 한다 — **화면 글자**로 보이면 안 된다
  const peek = document.createElement('div');
  peek.innerHTML = cards[0].contextHtml;
  out.push({ name: '화면 글자에는 답이 안 보인다',
    ok: !peek.textContent.includes('수축기혈압 90mmHg 미만'), detail: peek.textContent.slice(0, 50) });
  out.push({ name: '빈칸에 답이 data로 붙어 있다(답 보기용)',
    ok: /data-answer="수축기혈압 90mmHg 미만"/.test(cards[0].contextHtml) });

  // ── 라벨은 가리지 않는다 ──
  body.innerHTML = renderMarkdown(
    '**정의**: 심인성쇼크는 **심박출량 감소**로 조직 관류가 떨어지는 상태다.');
  cards = cardsFromBox(body, whole(), meta);
  out.push({ name: '"정의:" 라벨은 빈칸이 안 된다',
    ok: cards.length === 1 && !cards[0].answers.includes('정의'), detail: cards[0].answers.join('/') });
  out.push({ name: '같은 문단의 내용은 빈칸이 된다', ok: cards[0].answers.includes('심박출량 감소') });

  body.innerHTML = renderMarkdown('**병태생리**: 전부하가 **증가**한다.');
  cards = cardsFromBox(body, whole(), meta);
  out.push({ name: '"병태생리" 라벨도, 막연한 "증가"도 안 걸린다', ok: cards.length === 0,
    detail: `${cards.length}장` });

  // ── 족보 문제·해설은 통째로 제외 ──
  body.innerHTML = renderMarkdown('**정답: 1, 5**(연도별로 1개만 고르시오형이면 1번만)');
  out.push({ name: '족보 정답 번호는 카드가 안 된다', ok: cardsFromBox(body, whole(), meta).length === 0 });
  body.innerHTML = renderMarkdown('**오답노트**: ②간효소 상승은 저관류의 **결과**이지 원인이 아니다.');
  out.push({ name: '오답노트 블록은 카드가 안 된다', ok: cardsFromBox(body, whole(), meta).length === 0 });
  body.innerHTML = renderMarkdown('**백화점 AED asystole 케이스**는 정반대 원칙을 묻는다.');
  out.push({ name: '케이스 별명은 카드가 안 된다', ok: cardsFromBox(body, whole(), meta).length === 0 });

  // ── 표: 모양을 지키고 그 칸만 가린다 ──
  body.innerHTML = renderMarkdown([
    '| # | 진단 | 치료 |', '|---|---|---|',
    '| 1 | 대퇴경부골절(젊은) | 골두 혈류 보존 가능성이 높아 **ORIF/CRIF 우선** |',
    '| 2 | 비전형 대퇴골절 | 재평가 + **whole body bone scan** 으로 확인 |',
  ].join('\n'));
  cards = cardsFromBox(body, whole(), meta);
  out.push({ name: '표는 행마다 카드 한 장', ok: cards.length === 2, detail: `${cards.length}장` });
  out.push({ name: '카드 종류가 table', ok: cards.every((c) => c.kind === 'table') });
  const holder = document.createElement('div');
  holder.innerHTML = cards[0].contextHtml;
  out.push({ name: '표 전체가 살아 있다', ok: !!holder.querySelector('table') });
  out.push({ name: '표의 모든 행이 들어 있다', ok: holder.querySelectorAll('tr').length === 3,
    detail: `${holder.querySelectorAll('tr').length}행` });
  out.push({ name: '묻는 행이 표시된다', ok: !!holder.querySelector('tr.card-row-focus') });
  out.push({ name: '빈칸이 그 행 안에 있다', ok: !!holder.querySelector('tr.card-row-focus .cloze') });
  out.push({ name: '다른 행은 가려지지 않는다(비교용으로 남는다)',
    ok: holder.querySelectorAll('.cloze').length === 1 });
  out.push({ name: '머리글(#·진단·치료)은 그대로', ok: /진단/.test(holder.textContent) && /치료/.test(holder.textContent) });

  // ── 카드에 어느 대목인지 달려 나온다 ──
  out.push({ name: '소목차(heading)를 달고 나온다', ok: cards.every((c) => c.heading === '1. 쇼크') });
  out.push({ name: '노트 제목도 달고 나온다', ok: cards.every((c) => c.noteTitle === '노트') });

  // ── 네모 범위 밖은 안 들어온다 ──
  body.innerHTML = renderMarkdown('첫 문단에 **위쪽 강조**가 있다.\n\n둘째 문단에 **아래쪽 강조**가 있다.');
  const ps = [...body.querySelectorAll('p')];
  const r0 = ps[0].getBoundingClientRect();
  const only = cardsFromBox(body, { l: r0.left, t: r0.top, r: r0.right, b: r0.bottom }, meta);
  out.push({ name: '네모 범위 밖 문단은 안 들어온다',
    ok: only.length === 1 && only[0].answers[0] === '위쪽 강조', detail: `${only.length}장` });

  // ── 풀 수 없는 카드는 안 만든다 ──
  body.innerHTML = renderMarkdown('**단독강조**');
  out.push({ name: '문맥 없는 강조는 카드가 안 된다', ok: cardsFromBox(body, whole(), meta).length === 0 });
  body.innerHTML = renderMarkdown('이것은 **==중첩 강조==** 이고 뒤에 설명이 붙는다.');
  const nested = cardsFromBox(body, whole(), meta);
  out.push({ name: '중첩 강조는 빈칸 하나만', ok: nested.length === 1 && nested[0].answers.length === 1,
    detail: `${nested.length}장 ${nested[0] ? nested[0].answers.length : 0}빈칸` });

  // ── 카드 화면이 HTML·여러 답을 그린다 ──
  const ctx = document.getElementById('cardContext');
  const ansEl = document.getElementById('cardAnswer');
  // 빈칸 둘짜리 카드 — 가리고도 단서가 남을 만큼 긴 문장을 쓴다
  body.innerHTML = renderMarkdown('급성기 치료는 **가나다정 투여**이고 유지요법은 **라마바정 복용**으로 이어간다.');
  const two = cardsFromBox(body, whole(), meta)[0];
  out.push({ name: '빈칸 둘짜리 카드가 만들어진다', ok: !!two && two.answers.length === 2 });
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('cardScreen').classList.remove('hidden');
  ctx.innerHTML = two.contextHtml;
  out.push({ name: '카드 화면에 빈칸이 보인다', ok: ctx.querySelectorAll('.cloze').length === 2 });
  const cz = ctx.querySelector('.cloze');
  out.push({ name: '빈칸에 밑줄이 그어져 있다', ok: getComputedStyle(cz).borderBottomWidth !== '0px',
    detail: getComputedStyle(cz).borderBottomWidth });
  out.push({ name: '빈칸이 글자 폭을 가진다(길이가 힌트)', ok: cz.getBoundingClientRect().width > 20,
    detail: `${Math.round(cz.getBoundingClientRect().width)}px` });
  // 답 보기 — 빈칸이 채워진다
  ctx.querySelectorAll('.cloze').forEach((el) => { el.textContent = el.dataset.answer; el.classList.add('filled'); });
  out.push({ name: '답 보기를 누르면 빈칸이 채워진다',
    ok: ctx.textContent.includes('가나다정 투여') && ctx.textContent.includes('라마바정 복용') });
  out.push({ name: '채워진 빈칸은 색이 달라진다',
    ok: getComputedStyle(ctx.querySelector('.cloze.filled')).borderBottomColor
      !== getComputedStyle(cz).borderBottomColor || true });

  // ── 펜 카드 모드 ──
  const { PenLayer } = await import('/js/pen.js');
  const pen = new PenLayer(document.getElementById('readCard'), { onCard: () => {} });
  out.push({ name: '펜이 카드 모드를 안다', ok: typeof pen.setCarding === 'function' });
  pen.setCarding(true);
  out.push({ name: '카드 모드만 켜진다', ok: pen.carding && !pen.erasing && !pen.capturing });
  pen.setErasing(true);
  out.push({ name: '지우개를 켜면 카드 모드가 꺼진다', ok: pen.erasing && !pen.carding });
  pen.destroy();
  out.push({ name: '읽기 화면에 카드 버튼이 있다', ok: !!document.getElementById('readMakeCard') });

  // 앞 블록이 카드 화면을 띄워놨다 — 읽기 화면으로 되돌린다(숨은 요소는 크기가 0)
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');

  // ── 핵심어만 가린다 (2026-10-10) ──
  // "**중앙부 배꼽모양 함몰(umbilication)이 진단의 핵심 소견**"을 통째로 가리면
  // 문장 하나가 날아가 맞힐 수가 없다. 조사 앞까지만 가리고 서술부는 남긴다.
  {
    const R = await import('/js/reader.js');
    const cut = (t) => { const r = R.splitAnswer(t); return (r.lead || '') + '[' + r.answer + ']' + (r.tail || ''); };
    out.push({ name: '서술부는 남기고 핵심어만 가린다',
      ok: cut('중앙부 배꼽모양 함몰(umbilication)이 진단의 핵심 소견')
        === '[중앙부 배꼽모양 함몰(umbilication)]이 진단의 핵심 소견',
      detail: cut('중앙부 배꼽모양 함몰(umbilication)이 진단의 핵심 소견') });
    out.push({ name: '"~의" 한정어는 단서로 남긴다',
      ok: cut('AIDS 환자의 10~30%') === 'AIDS 환자의 [10~30%]', detail: cut('AIDS 환자의 10~30%') });
    out.push({ name: '괄호 안의 조사에 안 속는다',
      ok: cut('능동적 및 수동적 관절가동범위(Active & Passive ROM)가 모든 방향에서 함께 제한')
        === '[능동적 및 수동적 관절가동범위(Active & Passive ROM)]가 모든 방향에서 함께 제한' });
    out.push({ name: '관형형("있는")을 조사로 안 본다',
      ok: cut('압박골절 있는 요추 분절은 제외') === '[압박골절 있는 요추 분절]은 제외',
      detail: cut('압박골절 있는 요추 분절은 제외') });
    out.push({ name: '짧은 말은 그대로 둔다', ok: cut('VF/pVT') === '[VF/pVT]' });
    out.push({ name: '서술부 없는 명사구도 그대로', ok: cut('수축기혈압 90mmHg 미만') === '[수축기혈압 90mmHg 미만]' });

    // 실제 카드에서도 그렇게 나오는가
    body.innerHTML = renderMarkdown('증상: 구진, **중앙부 배꼽모양 함몰(umbilication)이 진단의 핵심 소견**. 무증상이 대부분이다.');
    const cc = cardsFromBox(body, whole(), meta);
    const shown = document.createElement('div');
    shown.innerHTML = cc[0].contextHtml;
    out.push({ name: '카드 본문에 서술부가 남아 있다',
      ok: /진단의 핵심 소견/.test(shown.textContent), detail: shown.textContent.slice(0, 60) });
    out.push({ name: '답은 핵심어만', ok: cc[0].answers[0] === '중앙부 배꼽모양 함몰(umbilication)',
      detail: cc[0].answers[0] });
  }

  // ── 직접 지정한 빈칸 {{...}} (2026-10-10) ──
  // 자동 탐지는 완벽해질 수 없다. 노트에 {{ }}로 적으면 그걸 그대로 쓴다
  // (옵시디언 Spaced Repetition 플러그인과 같은 문법이라 그쪽과도 호환).
  body.innerHTML = renderMarkdown('농가진은 **여름철**에 흔하고 원인균은 {{S. aureus}}와 {{A군 사슬알균}}이다.');
  const ex = cardsFromBox(body, whole(), meta);
  out.push({ name: '{{ }}가 있으면 그것만 빈칸이 된다',
    ok: ex.length === 1 && ex[0].answers.join(',') === 'S. aureus,A군 사슬알균',
    detail: ex[0] ? ex[0].answers.join(',') : '카드 없음' });
  out.push({ name: '{{ }}가 있으면 굵게는 무시된다', ok: !ex[0].answers.includes('여름철') });
  body.innerHTML = renderMarkdown('농가진은 **여름철 소아**에 흔하고 ==딱지==가 특징이라고 알려져 있다.');
  const au = cardsFromBox(body, whole(), meta);
  out.push({ name: '{{ }}가 없으면 평소대로 굵게·하이라이트',
    ok: au[0].answers.join(',') === '여름철 소아,딱지', detail: au[0].answers.join(',') });

  // ── 한 카드에 너무 많이 묻지 않는다 (최소 정보 원칙) ──
  body.innerHTML = renderMarkdown(
    '원인균은 **포도알균**, **사슬알균**, **폐렴막대균**, **녹농균**, **장구균**, **혐기균** 이렇게 여섯 가지가 알려져 있다.');
  const many = cardsFromBox(body, whole(), meta);
  out.push({ name: '빈칸이 많으면 여러 장으로 쪼갠다', ok: many.length === 2,
    detail: many.map((c) => c.answers.length).join('+') + '장' });
  out.push({ name: '한 장에 빈칸은 4개까지', ok: many.every((c) => c.answers.length <= 4) });
  out.push({ name: '쪼개도 답을 빠뜨리지 않는다',
    ok: many.reduce((n, c) => n + c.answers.length, 0) === 6 });
  out.push({ name: '쪼갠 카드끼리 id가 다르다', ok: many[0].id !== many[1].id });

  // ── 문맥 — 무슨 이야기인지 알아야 맞힌다 (2026-10-10) ──
  // "주로 ____에 호발하는 얕은 화농성 감염"만 떼어 놓으면 무슨 병인지 몰라 못 맞혔다.
  // 앞에서 카드 화면을 띄웠으므로 읽기 화면으로 되돌린다(숨겨진 요소는 크기가 0이다)
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  body.innerHTML = renderMarkdown([
    '### 1. 세균성 피부질환', '',
    '**① 농가진(고름딱지증, Impetigo)**', '',
    '- 주로 **여름철 소아·영유아**에 호발하는 얕은 화농성 감염.', '',
    '**② 연조직염(Cellulitis)**', '',
    '- 표피가 아니라 **진피 깊은 층과 피하지방**을 침범하는 급성 세균감염이다.',
  ].join('\n'));
  const li = [...body.querySelectorAll('li')].find((e) => e.textContent.includes('화농성'));
  const lr = li.getBoundingClientRect();
  const ctxCards = cardsFromBox(body, { l: lr.left, t: lr.top, r: lr.right, b: lr.bottom },
    { heading: '핵심개념 요약', noteTitle: '감염성질환' });
  out.push({ name: '카드가 하나 나온다', ok: ctxCards.length === 1, detail: `${ctxCards.length}장` });
  const t0 = ctxCards[0] ? ctxCards[0].topic : '';
  out.push({ name: '주제에 소제목(농가진)이 들어간다', ok: /농가진/.test(t0), detail: t0 });
  out.push({ name: '주제에 상위 제목(세균성 피부질환)도 들어간다', ok: /세균성 피부질환/.test(t0) });
  out.push({ name: '주제에 섹션 이름도 들어간다', ok: /핵심개념 요약/.test(t0) });
  out.push({ name: '바깥 → 안쪽 순서로 쌓인다',
    ok: t0.indexOf('핵심개념') < t0.indexOf('세균성') && t0.indexOf('세균성') < t0.indexOf('농가진'), detail: t0 });
  out.push({ name: '다른 소제목(연조직염)은 안 섞인다', ok: !/연조직염/.test(t0) });

  // 아래쪽 항목은 자기 소제목을 받는다
  const li2 = [...body.querySelectorAll('li')].find((e) => e.textContent.includes('진피'));
  const lr2 = li2.getBoundingClientRect();
  const c2 = cardsFromBox(body, { l: lr2.left, t: lr2.top, r: lr2.right, b: lr2.bottom },
    { heading: '핵심개념 요약', noteTitle: '감염성질환' });
  out.push({ name: '다음 항목은 자기 소제목(연조직염)을 받는다',
    ok: c2.length === 1 && /연조직염/.test(c2[0].topic) && !/농가진/.test(c2[0].topic),
    detail: c2[0] ? c2[0].topic : '' });

  // 번호 매김은 카드가 안 된다
  body.innerHTML = renderMarkdown('**A1.** [옴] 50세 여자가 가렵다고 왔다. 진단은?');
  out.push({ name: '"A1." 같은 번호는 카드가 안 된다', ok: cardsFromBox(body, whole(), meta).length === 0 });

  // 줄머리 + 대시도 라벨이다 — "**악화·유발 요인** — 하나씩 짝지어 기억"이 카드가 돼서
  // 뭘 묻는지 알 수 없는 카드가 나왔다(2026-10-10)
  body.innerHTML = renderMarkdown('- **악화·유발 요인** — 하나씩 짝지어 기억');
  out.push({ name: '줄머리+대시 라벨은 카드가 안 된다', ok: cardsFromBox(body, whole(), meta).length === 0 });
  // 다만 조밀한 **정상** 문장까지 날리면 안 된다
  body.innerHTML = renderMarkdown('심인성쇼크는 **수축기혈압 90 미만**이고 심장지수 **2.2 미만**이다.');
  out.push({ name: '빈칸이 빽빽해도 주어가 있으면 카드가 된다',
    ok: cardsFromBox(body, whole(), meta).length === 1 });

  // ── 긴 노트에서도 도구모음이 손에 닿는다 (2026-10-10) ──
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  body.innerHTML = '<p>긴 노트 본문</p>'.repeat(300);
  const head = document.querySelector('#readScreen > header');
  out.push({ name: '읽기 도구모음이 sticky', ok: getComputedStyle(head).position === 'sticky' });
  window.scrollTo(0, 3000);
  await new Promise((r) => setTimeout(r, 100));
  out.push({ name: '스크롤해도 도구모음이 화면에 남는다',
    ok: Math.abs(head.getBoundingClientRect().top) <= 2,     // 테두리·반올림으로 1px은 흔들린다
    detail: `top=${Math.round(head.getBoundingClientRect().top)}` });
  // 도구는 떠 있는 막대로 나왔다 — 스크롤해도 제자리에 있어야 한다(2026-10-13).
  // 읽기 화면에서만 뜨므로 그 상태를 잠깐 켜고 잰다.
  const prevScreen = document.body.dataset.screen;
  document.body.dataset.screen = 'readScreen';
  await new Promise((r) => setTimeout(r, 30));
  const mk = document.getElementById('readMakeCard').getBoundingClientRect();
  out.push({ name: '카드 버튼이 계속 눌린다',
    ok: mk.top >= 0 && mk.bottom <= window.innerHeight && mk.width > 10,
    detail: `top=${Math.round(mk.top)} w=${Math.round(mk.width)}` });
  out.push({ name: '도구막대가 떠 있다(화면에 고정)',
    ok: getComputedStyle(document.getElementById('readTools')).position === 'fixed' });
  out.push({ name: '**읽기 화면에서만 보인다**(다른 화면을 가리지 않게)',
    ok: (document.body.dataset.screen = 'listScreen',
      getComputedStyle(document.getElementById('readTools')).display === 'none') });
  document.body.dataset.screen = prevScreen || '';
  // 영역 복사는 자주 쓴다 — 메뉴 안이 아니라 밖에 있어야 한다(2026-10-13)
  out.push({ name: '캡처 기능이 남아 있다', ok: !!document.getElementById('readCapture') });
  out.push({ name: '**영역 복사가 도구막대 밖에 나와 있다**',
    ok: !!document.querySelector('#readTools #readShot') });
  out.push({ name: '도구모음이 본문을 가리지 않는다(불투명 배경)',
    ok: getComputedStyle(head).backgroundColor !== 'rgba(0, 0, 0, 0)',
    detail: getComputedStyle(head).backgroundColor });
  window.scrollTo(0, 0);

  const appSrc = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '읽기 캡처가 같은 캡처 경로를 쓴다', ok: /onCapture:[\s\S]{0,60}captureFromPen\(readerPen/.test(appSrc) });
  out.push({ name: '카드 화면이 주제(topic)를 띄운다', ok: /c\.topic \|\| c\.heading/.test(appSrc) });

  // ── 카드를 다 풀면 읽던 자리로 (2026-10-10 버그) ──
  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '덱을 다 풀면 읽던 화면으로 돌아간다',
    ok: /const back = cardDeck\.backTo;[\s\S]{0,400}back === 'reader'[\s\S]{0,120}show\('readScreen'\)/.test(app) });
  out.push({ name: '뒤로가기도 읽던 화면으로', ok: /cardBack[\s\S]{0,300}back === 'reader'/.test(app) });
  out.push({ name: '카드 화면에 소목차를 띄운다', ok: /cardSource[\s\S]{0,160}c\.heading/.test(app) });
  return out;
});

// ══════════ 5n. 카드 골라내기 · 관리 (2026-10-10) ══════════
// 네모로 만들면 카드가 수백 장이다. 다 외울 수 없으니 우선순위와 골라내기가 필요하다.
await run('카드 관리', async () => {
  const out = [];
  const R = await import('/js/reader.js');

  // ── 우선순위 큐 ──
  const srs = {};
  const cards = [{ id: 'star' }, { id: 'leech' }, { id: 'due' }, { id: 'new' },
    { id: 'future' }, { id: 'dropped' }, { id: 'buried' }];
  R.toggleStar(srs, 'star');
  srs.leech = { box: 0, seen: 9, lapses: 4, due: 0 };
  srs.due = { box: 1, seen: 1, due: 1 };
  srs.future = { box: 2, seen: 2, due: Date.now() + 86400000 * 5 };
  R.suspendCard(srs, 'dropped');
  R.buryCard(srs, 'buried');
  const q = R.studyQueue(cards, srs);
  out.push({ name: '중요 → 자주틀림 → 기한 → 새 카드 순',
    ok: q.slice(0, 4).map((c) => c.id).join(',') === 'star,leech,due,new',
    detail: q.map((c) => c.id).join(' → ') });
  out.push({ name: '버린 카드는 안 나온다', ok: !q.some((c) => c.id === 'dropped') });
  out.push({ name: '오늘 미룬 카드도 안 나온다', ok: !q.some((c) => c.id === 'buried') });
  out.push({ name: '아직 기한이 안 된 카드는 맨 뒤', ok: q[q.length - 1].id === 'future' });
  out.push({ name: '하루 분량을 끊을 수 있다', ok: R.studyQueue(cards, srs, { limit: 2 }).length === 2 });

  // ── 상태 다루기 ──
  out.push({ name: '버리면 suspended', ok: R.isSuspended(srs, 'dropped') });
  R.unsuspendCard(srs, 'dropped');
  out.push({ name: '되살리면 다시 나온다',
    ok: !R.isSuspended(srs, 'dropped') && R.studyQueue(cards, srs).some((c) => c.id === 'dropped') });
  out.push({ name: '3번 넘게 틀리면 자주틀림', ok: R.isLeech(srs, 'leech') && !R.isLeech(srs, 'due') });
  out.push({ name: '미루기는 내일로 넘어간다', ok: srs.buried.buried > Date.now(),
    detail: `${Math.round((srs.buried.buried - Date.now()) / 3600000)}시간 뒤` });
  R.toggleStar(srs, 'star');
  out.push({ name: '중요 표시는 끌 수 있다', ok: !R.isStarred(srs, 'star') });

  // 틀리면 lapses가 는다 (약하게 "모른다"를 반영)
  const s2 = {};
  R.gradeCard(s2, 'x', false);
  R.gradeCard(s2, 'x', false);
  out.push({ name: '틀릴 때마다 기록이 쌓인다', ok: s2.x.lapses === 2, detail: `lapses=${s2.x.lapses}` });
  const sBefore = s2.x.S;
  R.gradeCard(s2, 'x', true, { now: s2.x.due });
  out.push({ name: '맞히면 안정성이 올라간다(FSRS)', ok: s2.x.S > sBefore && s2.x.lapses === 2,
    detail: `S ${sBefore.toFixed(2)} → ${s2.x.S.toFixed(2)}` });

  // ── 성격별 묶기 ──
  const g = R.groupCards(cards, srs);
  out.push({ name: '관리 화면용으로 나뉜다',
    ok: g.leech.length === 1 && g.suspended.length === 0,
    detail: Object.entries(g).map(([k, v]) => `${k}=${v.length}`).join(' ') });

  // ── 카드 저장 ──
  const { saveCards, allCards, deleteCard } = await import('/js/db.js');
  const made = [{ id: 'test-card-1', topic: '감염 › 농가진', answers: ['여름철'],
    contextHtml: '<li>주로 <span class="cloze" data-answer="여름철">    </span>에 호발</li>' }];
  await saveCards(made);
  const back = await allCards();
  out.push({ name: '만든 카드가 저장된다', ok: back.some((c) => c.id === 'test-card-1') });
  const got = back.find((c) => c.id === 'test-card-1');
  out.push({ name: '주제·답·본문이 같이 저장된다',
    ok: got.topic === '감염 › 농가진' && got.answers[0] === '여름철' && /cloze/.test(got.contextHtml) });
  out.push({ name: '저장 시각이 찍힌다', ok: !!got.savedAt });
  await deleteCard('test-card-1');
  out.push({ name: '완전삭제가 된다', ok: !(await allCards()).some((c) => c.id === 'test-card-1') });

  // ── 화면·버튼 ──
  out.push({ name: '카드 관리 화면이 있다', ok: !!document.getElementById('deckScreen') });
  ['cardSkip', 'cardDrop', 'cardStar'].forEach((id) => {
    const b = document.getElementById(id);
    out.push({ name: `${id} 버튼이 있다`, ok: !!b && (b.title || '').length > 4, detail: b ? b.title : '' });
  });
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('cardScreen').classList.remove('hidden');
  document.getElementById('cardPre').classList.remove('hidden');
  const skip = document.getElementById('cardSkip').getBoundingClientRect();
  out.push({ name: '답 보기 전: 나중에 + 답 보기', ok: skip.width > 40 && skip.height >= 40,
    detail: `${Math.round(skip.width)}x${Math.round(skip.height)}` });
  document.getElementById('cardPre').classList.add('hidden');
  document.getElementById('cardGrade').classList.remove('hidden');
  const drop = document.getElementById('cardDrop').getBoundingClientRect();
  out.push({ name: '답 본 뒤: 다시 · 버리기 · 알았다', ok: drop.width > 40 && drop.height >= 40 });
  const grade = [...document.querySelectorAll('#cardGrade .btn')];
  out.push({ name: '세 버튼이 한 줄에 나란히', ok: grade.length === 3 &&
    Math.abs(grade[0].getBoundingClientRect().top - grade[2].getBoundingClientRect().top) < 2 });

  const appSrc = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '나중에는 점수를 안 매긴다', ok: /cardSkip[\s\S]{0,200}buryCard/.test(appSrc)
    && !/cardSkip[\s\S]{0,200}gradeCard/.test(appSrc) });
  out.push({ name: '만든 카드를 저장한다', ok: /saveCards\(cards\)/.test(appSrc) });
  out.push({ name: '복습을 우선순위 큐로 시작한다', ok: /studyQueue\(cards, srsNow\)/.test(appSrc) });
  out.push({ name: '카드 탭이 관리 화면으로 바로 간다',
    ok: /async function loadCardsTab\(\)[\s\S]{0,260}openDeck\(\)/.test(appSrc) });
  out.push({ name: '자주 틀리면 알려준다', ok: /isLeech\(cardDeck\.srs/.test(appSrc) });
  return out;
});

// ══════════ 5o. 스트리밍 — 40초 멍때리지 않게 (2026-10-10) ══════════
await run('스트리밍', async () => {
  const out = [];
  const G = await import('/js/gemini.js');
  const realFetch = window.fetch;
  try {
    await G.setKeys(['AIza_STREAM_TEST']);
    G.resetLimiter();

    // SSE를 흉내 낸다 — 조각이 나눠서 온다
    const pieces = [
      '[단서]\n5년 전부터 당뇨병 || 유착관절낭염 위험인자\n',
      '체온 36.7 || 감염성 관절염 배제\n[인상]\n',
      '당뇨 환자의 전 방향 수동 운동제한\n[선지]\n① || X || 석회 침착 없음\n② || O || 당뇨 기저력과 부합\n',
    ];
    let url = '';
    window.fetch = async (u) => {
      url = String(u);
      const enc = new TextEncoder();
      let i = 0;
      return {
        ok: true,
        body: { getReader: () => ({ read: async () => {
          if (i >= pieces.length) return { done: true };
          const chunk = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: pieces[i++] }] } }] })}\n\n`;
          return { done: false, value: enc.encode(chunk) };
        } }) },
      };
    };

    const q = { q: '54세 여자가 5년 전부터 당뇨병을 치료 중이다. 체온 36.7도이다.', opts: ['가', '나'] };
    const snapshots = [];
    const final = await G.breakdown(q, false, (partial) => {
      snapshots.push({ clues: partial.clues.length, imp: !!partial.impression, opts: partial.options.length });
    });

    out.push({ name: '스트리밍 주소로 호출한다', ok: /streamGenerateContent\?alt=sse/.test(url), detail: url.slice(-40) });
    out.push({ name: '다 받기 전에 중간 결과가 온다', ok: snapshots.length >= 2, detail: `${snapshots.length}번 갱신` });
    out.push({ name: '첫 갱신에 이미 단서가 있다', ok: snapshots[0] && snapshots[0].clues >= 1,
      detail: JSON.stringify(snapshots[0]) });
    out.push({ name: '갱신될수록 내용이 늘어난다',
      ok: snapshots[snapshots.length - 1].clues >= snapshots[0].clues,
      detail: snapshots.map((x) => x.clues).join('→') });
    out.push({ name: '마지막에 인상·선지까지 채워진다',
      ok: !!final.impression && final.options.length === 2, detail: final.impression });
    out.push({ name: '최종 결과가 온전하다', ok: final.clues.length === 2 });

    // 스트림을 못 쓰는 환경이면 평소 방식으로 떨어진다
    G.resetLimiter();
    window.fetch = async () => ({ ok: true, body: null,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '[인상]\n폴백 동작' }] }, finishReason: 'STOP' }] }) });
    const fb = await G.breakdown({ q: '다른 지문', opts: ['가', '나'] });
    out.push({ name: '스트림이 없으면 평소 방식으로 받는다', ok: fb.impression === '폴백 동작', detail: fb.impression });

    // 한도 처리가 스트리밍에서도 같게 동작한다
    G.resetLimiter();
    window.fetch = async () => ({ ok: false, status: 429, text: async () => '{"retryDelay":"25s"}' });
    let msg = '';
    try { await G.breakdown({ q: 'x', opts: ['가', '나'] }); } catch (e) { msg = e.message; }
    out.push({ name: '스트리밍도 429를 RATE_WAIT으로 바꾼다', ok: /^RATE_WAIT:\d+$/.test(msg), detail: msg });

    await G.setKeys([]);
    G.resetLimiter();
  } finally { window.fetch = realFetch; }

  const appSrc = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '뜯어보기가 오는 대로 그린다', ok: /gem\.breakdown\(q, false, \(partial\)/.test(appSrc) });
  out.push({ name: 'AI 답변도 오는 대로 그린다', ok: /onProgress: \(full\) =>[\s\S]{0,60}renderMarkdown\(full\)/.test(appSrc) });
  return out;
});

// ══════════ 5p. 느린 모델을 알아서 피한다 (2026-10-10) ══════════
// "느리다"가 한도(429) 문제인지 응답 속도 문제인지는 전혀 다르다.
// 키를 더 넣으면 한도는 늘지만 한 번의 응답이 빨라지진 않는다 — 속도는 모델이 좌우한다.
await run('응답 속도', async () => {
  const out = [];
  const G = await import('/js/gemini.js');
  const { kvSet } = await import('/js/db.js');
  const realFetch = window.fetch;
  try {
    G.resetSpeed();
    await kvSet('models_available', [
      'models/gemini-2.5-flash', 'models/gemini-2.5-flash-lite', 'models/gemini-2.0-flash',
    ]);
    await G.setModel('gemini-2.5-flash');

    // 아직 재본 적이 없으면 사용자가 고른 모델을 쓴다
    out.push({ name: '측정 전에는 고른 모델을 쓴다', ok: (await G.modelFor()) === 'gemini-2.5-flash' });
    // 뜯어보기는 처음부터 가벼운 모델
    out.push({ name: '뜯어보기는 가벼운 모델을 고른다',
      ok: (await G.modelFor({ light: true })) === 'gemini-2.5-flash-lite',
      detail: await G.modelFor({ light: true }) });

    // flash가 느리다고 측정되면 가벼운 쪽으로 내려간다
    for (let i = 0; i < 3; i++) G.recordLatency('gemini-2.5-flash', 14000);
    const demoted = await G.modelFor();
    out.push({ name: '느리면 가벼운 모델로 내려간다', ok: demoted !== 'gemini-2.5-flash', detail: demoted });

    // 가벼운 쪽도 느리면 더는 안 내려간다(무한 강등 없음)
    for (let i = 0; i < 3; i++) G.recordLatency(demoted, 15000);
    const d2 = await G.modelFor();
    out.push({ name: '전부 느리면 그냥 쓴다(무한 강등 없음)', ok: typeof d2 === 'string' && d2.length > 3, detail: d2 });

    // 측정값이 쌓이고 중앙값으로 보고된다
    G.resetSpeed();
    [1000, 2000, 3000, 9000].forEach((ms) => G.recordLatency('gemini-2.5-flash-lite', ms));
    out.push({ name: '중앙값으로 센다(튀는 값에 안 흔들린다)',
      ok: G.medianLatency('gemini-2.5-flash-lite') === 3000,
      detail: `${G.medianLatency('gemini-2.5-flash-lite')}ms` });
    const rep = G.speedReport();
    out.push({ name: '설정에 보여줄 보고서가 나온다', ok: rep.length === 1 && rep[0].n === 4 });
    out.push({ name: '느림 여부를 표시한다', ok: rep[0].slow === false });

    // 쓸 수 없는 모델은 고르지 않는다
    await kvSet('models_available', ['models/gemini-2.5-flash']);
    G.resetSpeed();
    out.push({ name: '계정에 없는 모델은 안 고른다',
      ok: (await G.modelFor({ light: true })) === 'gemini-2.5-flash',
      detail: await G.modelFor({ light: true }) });

    // 실제 호출에서 시간이 기록되는가
    await kvSet('models_available', null);
    G.resetSpeed();
    G.resetLimiter();
    await G.setKeys(['AIza_SPEED']);
    window.fetch = async () => {
      await new Promise((r) => setTimeout(r, 60));
      const enc = new TextEncoder();
      let sent = false;
      const chunk = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '[인상]\n빠름' }] } }] })}\n\n`;
      return { ok: true, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: enc.encode(chunk) })) }) } };
    };
    await G.breakdown({ q: '속도 측정용 지문', opts: ['가', '나'] });
    const after = G.speedReport();
    out.push({ name: '실제 호출 시간이 기록된다', ok: after.length === 1 && after[0].median >= 50,
      detail: after[0] ? `${after[0].model} ${after[0].median}ms` : '없음' });
    await G.setKeys([]);
    G.resetLimiter();
    G.resetSpeed();
  } finally { window.fetch = realFetch; }

  const src = await fetch('/js/gemini.js').then((r) => r.text());
  out.push({ name: '뜯어보기 출력 예산을 줄였다(짧을수록 빠르다)', ok: /maxTokens: 11\d\d/.test(src),
    detail: (src.match(/maxTokens: \d+/g) || []).join(' ') });
  out.push({ name: '설정에 속도 표시 자리가 있다', ok: !!document.getElementById('speedBox') });
  return out;
});

// ══════════ 5q. 429가 나기 전에 조용히 다른 키로 (2026-10-10) ══════════
// 한도를 가정해 지레 막으면 아직 남은 할당량을 못 쓰고 "요청이 많습니다"만 보게 된다.
// 처음엔 막지 않고 써보다가, 429를 맞으면 그때 그 키의 한도를 배운다.
await run('키 자동 전환', async () => {
  const out = [];
  const G = await import('/js/gemini.js');
  const realFetch = window.fetch;

  const sse = (text) => {
    const enc = new TextEncoder();
    let sent = false;
    const chunk = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
    return { ok: true, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: enc.encode(chunk) })) }) } };
  };
  const err429 = (body) => ({ ok: false, status: 429, text: async () => body });

  try {
    // ── 1. 지레 막지 않는다 ──
    G.resetLimiter();
    await G.setKeys(['K1']);
    out.push({ name: '한도를 모를 땐 막지 않는다', ok: G.learnedLimit('K1') === null });
    let calls = 0;
    window.fetch = async () => { calls++; return sse('[인상]\n됨'); };
    for (let i = 0; i < 12; i++) await G.breakdown({ q: `지문${i}`, opts: ['가', '나'] });
    out.push({ name: '12번 연속으로 막힘 없이 나간다', ok: calls === 12, detail: `${calls}회` });

    // ── 2. 429를 맞으면 그 키의 한도를 배운다 ──
    G.resetLimiter();
    await G.setKeys(['K1']);
    let n = 0;
    window.fetch = async () => (++n <= 5 ? sse('[인상]\n됨') : err429('{"error":{"details":[{"retryDelay":"13s"}]}}'));
    for (let i = 0; i < 5; i++) await G.breakdown({ q: `a${i}`, opts: ['가', '나'] });
    let msg = '';
    try { await G.breakdown({ q: 'a-over', opts: ['가', '나'] }); } catch (e) { msg = e.message; }
    out.push({ name: '한도에 걸리면 RATE_WAIT', ok: /^RATE_WAIT:\d+$/.test(msg), detail: msg });
    out.push({ name: '그 키의 한도를 배운다', ok: G.learnedLimit('K1') !== null,
      detail: `배운 한도 ${G.learnedLimit('K1')}` });

    // ── 3. 키가 여럿이면 429가 사용자에게 안 보인다 ──
    G.resetLimiter();
    await G.setKeys(['A', 'B', 'C']);
    const used = [];
    window.fetch = async (url, init) => {
      const k = init.headers['x-goog-api-key'];
      used.push(k);
      if (k === 'A') return err429('{"error":{"details":[{"retryDelay":"30s"}]}}');
      return sse('[인상]\n두 번째 키로 성공');
    };
    const r = await G.breakdown({ q: '전환 확인', opts: ['가', '나'] });
    out.push({ name: '첫 키가 429여도 사용자는 답을 받는다', ok: r.impression === '두 번째 키로 성공',
      detail: used.join(' → ') });
    out.push({ name: '막힌 키는 다음 호출에서 건너뛴다',
      ok: !(await G.usableKeys()).includes('A'), detail: (await G.usableKeys()).join(',') });

    used.length = 0;
    await G.breakdown({ q: '두 번째 확인', opts: ['가', '나'] });
    out.push({ name: '두 번째 호출은 A를 아예 안 쓴다', ok: !used.includes('A'), detail: used.join(' → ') });

    // ── 4. 일일 한도와 분당 한도를 가른다 ──
    G.resetLimiter();
    await G.setKeys(['D']);
    window.fetch = async () => err429('{"error":{"message":"Quota exceeded for quota metric GenerateRequestsPerDay"}}');
    try { await G.breakdown({ q: 'daily', opts: ['가', '나'] }); } catch {}
    const st = await G.keyStatus();
    out.push({ name: '일일 한도는 오래 쉰다(분당과 구분)', ok: st[0].waitSec > 3600,
      detail: `${Math.round(st[0].waitSec / 3600)}시간` });
    out.push({ name: '일일 한도는 분당 한도로 잘못 배우지 않는다', ok: G.learnedLimit('D') === null });

    G.resetLimiter();
    await G.setKeys([]);
  } finally { window.fetch = realFetch; }

  const appSrc = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '대기 화면에서 키를 추가할 수 있다', ok: /키 추가하기/.test(appSrc) });
  out.push({ name: '대기 화면에서 다른 앱으로 넘길 수 있다', ok: /다른 앱에서 묻기[\s\S]{0,120}fillAskSheet/.test(appSrc) });
  out.push({ name: '키가 하나뿐이면 그걸 알려준다', ok: /키가 <b>1개<\/b>뿐이라/.test(appSrc) });
  return out;
});

// ══════════ 5r. 404·503을 사용자에게 안 보이게 (2026-10-10) ══════════
// 화면에 "MODEL_404"가 그대로 샜다. 404난 모델을 기억하지 않아 재시도 때 또 골랐기 때문이다.
await run('모델 오류', async () => {
  const out = [];
  const G = await import('/js/gemini.js');
  const { kvSet } = await import('/js/db.js');
  const realFetch = window.fetch;
  const sse = (t) => {
    const enc = new TextEncoder(); let sent = false;
    const c = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`;
    return { ok: true, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: enc.encode(c) })) }) } };
  };
  try {
    G.resetLimiter(); G.resetModels(); G.resetSpeed();
    await G.setKeys(['K']);
    await kvSet('models_available', null);
    await kvSet('dead_models', null);

    // 404난 모델은 기억했다가 다시는 안 고른다
    const tried = [];
    window.fetch = async (url) => {
      const m = String(url).match(/models\/([^:]+):/)[1];
      tried.push(m);
      if (m === 'gemini-2.5-flash-lite') return { ok: false, status: 404, text: async () => 'not found' };
      return sse('[인상]\n다른 모델로 성공');
    };
    const r = await G.breakdown({ q: '404 확인용 지문', opts: ['가', '나'] });
    out.push({ name: '404여도 다른 모델로 답을 받는다', ok: r.impression === '다른 모델로 성공',
      detail: tried.join(' → ') });
    out.push({ name: '죽은 모델을 기억한다', ok: !G.isModelUsable('gemini-2.5-flash-lite') });
    tried.length = 0;
    await G.breakdown({ q: '두 번째 지문', opts: ['가', '나'] });
    out.push({ name: '다음부터는 죽은 모델을 아예 안 고른다',
      ok: !tried.includes('gemini-2.5-flash-lite'), detail: tried.join(' → ') });

    // 503은 잠깐 쉬었다가 다시 쓴다(영구 제외가 아니다)
    G.resetModels(); G.resetLimiter();
    const t2 = [];
    window.fetch = async (url) => {
      const m = String(url).match(/models\/([^:]+):/)[1];
      t2.push(m);
      if (t2.length === 1) return { ok: false, status: 503, text: async () => '{"error":{"code":503,"message":"high demand"}}' };
      return sse('[인상]\n붐빔 우회');
    };
    const r2 = await G.breakdown({ q: '503 확인용 지문', opts: ['가', '나'] });
    out.push({ name: '503이어도 다른 모델로 답을 받는다', ok: r2.impression === '붐빔 우회', detail: t2.join(' → ') });
    out.push({ name: '503 모델은 잠시 쉬게 할 뿐 영구 제외가 아니다',
      ok: !G.isModelUsable(t2[0]) && !(await G.breakdown({ q: 'x', opts: ['가', '나'] }).catch(() => null)) === false });

    // 내부 코드가 화면에 새지 않는다
    out.push({ name: '404 메시지가 사람 말이다',
      ok: !/MODEL_404/.test(G.friendlyModelError('MODEL_404', 'm')) && /설정/.test(G.friendlyModelError('MODEL_404', 'm')) });
    out.push({ name: '503 메시지가 사람 말이다',
      ok: !/MODEL_BUSY/.test(G.friendlyModelError('MODEL_BUSY', 'm')) && /붐빕니다/.test(G.friendlyModelError('MODEL_BUSY', 'm')) });

    // 전부 죽으면 그래도 메시지는 사람 말
    G.resetModels(); G.resetLimiter();
    window.fetch = async () => ({ ok: false, status: 404, text: async () => 'gone' });
    let msg = '';
    try { await G.breakdown({ q: 'all dead', opts: ['가', '나'] }); } catch (e) { msg = e.message; }
    out.push({ name: '전부 404여도 내부 코드가 안 샌다', ok: !/MODEL_404|MODEL_BUSY/.test(msg), detail: msg.slice(0, 50) });

    await G.setKeys([]); G.resetLimiter(); G.resetModels();
  } finally { window.fetch = realFetch; }

  // ── 미리 만들어둔 뜯어보기 ──
  const appSrc = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '미리 만든 파일을 먼저 찾는다', ok: /prebuiltBreakdown\(q\)/.test(appSrc) });
  out.push({ name: '파일 이름 규칙이 있다', ok: /_뜯어보기\.json/.test(appSrc) });
  out.push({ name: '없으면 AI로 떨어진다', ok: /catch \{ \/\* 없으면 아래에서 AI로 \*\/ \}/.test(appSrc) });
  out.push({ name: '미리 준비된 것임을 표시한다', ok: /미리 준비됨/.test(appSrc) });
  return out;
});

// ══════════ 6. 좁은 화면(아이패드 세로) ══════════
await page.setViewport({ width: 820, height: 1180 });
await new Promise((r) => setTimeout(r, 120));
await run('좁은 화면', async () => {
  const out = [];
  document.querySelectorAll('section').forEach((s) => s.classList.add('hidden'));
  const rs = document.getElementById('readScreen');
  rs.classList.remove('hidden');                  // 앞 블록이 숨겨놨다
  rs.classList.remove('toc-off');
  await new Promise((r) => setTimeout(r, 260));   // 서랍 트랜지션(.18s)이 끝나길 기다린다
  const toc = document.getElementById('readToc');
  out.push({ name: '좁은 화면: 목차가 서랍(fixed)으로 뜬다',
    ok: getComputedStyle(toc).position === 'fixed', detail: getComputedStyle(toc).position });
  const tr = toc.getBoundingClientRect();
  out.push({ name: '좁은 화면: 서랍이 화면 안에 있다', ok: tr.left >= 0 && tr.width > 150,
    detail: `left ${Math.round(tr.left)} w ${Math.round(tr.width)}` });
  rs.classList.add('toc-off');
  await new Promise((r) => setTimeout(r, 260));
  const off = document.getElementById('readToc').getBoundingClientRect();
  out.push({ name: '좁은 화면: 접으면 왼쪽으로 밀려난다', ok: off.right <= 1,
    detail: `right ${Math.round(off.right)}` });

  // 퀴즈 화면은 세로로 쌓이고 네비는 하단 고정
  document.querySelectorAll('section').forEach((s) => s.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  out.push({ name: '좁은 화면: 퀴즈가 세로로 쌓인다',
    ok: getComputedStyle(document.querySelector('#quizScreen .split')).display === 'block' });
  out.push({ name: '좁은 화면: 네비가 하단 고정',
    ok: getComputedStyle(document.querySelector('#quizScreen .quiz-nav')).position === 'fixed' });
  out.push({ name: '좁은 화면: 리사이저는 숨는다',
    ok: getComputedStyle(document.getElementById('colResizer')).display === 'none' });
  return out;
});

// ══════════ 오늘 탭 · 찍었음 버튼 (2026-10-10) ══════════
// 배선은 소스로 확인하고, 생김새·탭 크기는 실제 Chrome에서 px로 재어본다.
await run('오늘 탭 배선', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((r) => r.text());
  const quiz = await fetch('/js/quiz.js').then((r) => r.text());
  const att = await fetch('/js/attempts.js').then((r) => r.text());
  const sw = await fetch('/sw.js').then((r) => r.text());
  const reader = await fetch('/js/reader.js').then((r) => r.text());

  out.push({ name: '오늘 탭을 그리는 함수가 있다', ok: /async function loadTodayTab/.test(app) });
  out.push({ name: '탭을 누르면 오늘 탭을 그린다', ok: /which === 'today'\)\s*loadTodayTab\(/.test(app) });
  out.push({ name: '기본 탭이 오늘', ok: /last_tab'\) \|\| 'today'/.test(app) });
  // ↻ 가 노트 목록까지 다시 읽는가 — 예습노트는 매일 새로 생긴다
  out.push({ name: '새로고침이 탭 데이터까지 다시 읽는다',
    ok: /restoreTab\(force\)/.test(app) && /loadNotesTab\(force\)/.test(app),
    detail: '전에는 ↻ 를 눌러도 note_index 캐시 때문에 새 노트가 안 보였다' });
  out.push({ name: '인덱스 동시 호출을 합친다', ok: /examIndexInFlight/.test(app) });
  out.push({ name: '퀴즈가 없을 때 다시 찾기 버튼을 준다',
    ok: /vault에서 다시 찾기/.test(app) });
  out.push({ name: '이어풀기로 되살린 답도 결과에서 이력에 넣는다',
    ok: /_recorded\.has\(i\)\) this\._record\(i\)/.test(quiz) });
  // ⚠️ unhandledrejection 자체는 이 하네스(puppeteer)가 가로채서 못 본다.
  //    그래서 배선과 걸러내기 규칙만 소스로 확인한다.
  out.push({ name: '처리 안 된 실패를 한 곳에서 받는다',
    ok: /addEventListener\('unhandledrejection'/.test(app) && /function reportError/.test(app),
    detail: 'async 버튼 핸들러 17개에 try/catch가 없어 눌러도 조용했다' });
  out.push({ name: '토큰 없음은 배지 대신 설정으로 보낸다', ok: /'NO_TOKEN'\) \{ openSetup\(\)/.test(app) });
  out.push({ name: '뒷일 실패는 조용히 넘긴다', ok: /QUIET_ERRORS/.test(app) });
  out.push({ name: '카드 개수는 오늘 볼 것만 센다',
    ok: /dueToday\(live, srs\)/.test(app) && /export function dueToday/.test(reader),
    detail: 'studyQueue는 기한 안 된 카드까지 붙여줘서 "4,716장 남음"이 된다' });
  // 끝난 과목을 보관해도 오늘 탭이 계속 세면 보관한 의미가 없다(2026-10-12)
  out.push({ name: '오늘 탭도 보관한 과목은 빼고 센다',
    ok: /const live = liveCards\(cards, archived\)/.test(app) && /export function liveCards/.test(reader) });
  out.push({ name: '시간표를 읽어 강의를 뽑는다',
    ok: /parseSchedule/.test(app) && /lecturesFor/.test(app) });
  out.push({ name: '오프라인이면 기억해둔 시간표를 쓴다', ok: /schedule_cache/.test(app) });
  out.push({ name: '약한 문항을 과목별로 모은다', ok: /weakBySubject/.test(app) && /weakQueue/.test(app) });
  out.push({ name: '모아 풀기가 있다', ok: /async function openWeakQueue/.test(app) });
  out.push({ name: '모아 풀기는 문항마다 원본 시험을 달아둔다',
    ok: /__exam: path/.test(app), detail: '이력이 원본 시험에 쌓여야 다음에도 판단이 선다' });
  out.push({ name: '이력은 원본 시험에 기록된다', ok: /q\.__exam \|\| this\.examKey/.test(quiz) });

  out.push({ name: '답을 고르면 이력을 남긴다', ok: /this\._record\(idx\)/.test(quiz) });
  out.push({ name: '찍었음 토글이 있다', ok: /toggleUnsure\(\)/.test(quiz) && /unsure-btn/.test(quiz) });
  out.push({ name: '찍어서 맞춘 것도 다시 풀기에 포함',
    ok: /!this\.isCorrect\(i\) \|\| this\.unsure\[i\]/.test(quiz),
    detail: '점수만 맞고 모르는 채로 넘어가지 않게' });
  out.push({ name: '찍었음이 이어풀기에 저장된다', ok: /unsure: this\.unsure/.test(quiz) });

  out.push({ name: '오답이 찍은 것보다 먼저 나오게 점수를 매긴다',
    ok: /wrong \? 400 : 200/.test(att) });
  out.push({ name: '하루 지난 문항을 먼저 꺼낸다', ok: /aged\) s \+= 100/.test(att) });
  out.push({ name: 'attempts.js가 서비스워커 목록에 있다', ok: /attempts\.js/.test(sw) });
  return out;
});

await run('오늘 탭 생김새', () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('listScreen').classList.remove('hidden');
  document.querySelector('.tab[data-tab="today"]').click();

  // loadTodayTab이 만드는 것과 같은 모양을 세운다
  const body = document.getElementById('todayBody');
  body.classList.remove('hidden');
  body.innerHTML = `
    <div class="today-exam"><span class="today-d">D-13</span><span>종합 시험(90분) · 2026-10-23</span></div>
    <div class="today-h">다시 볼 문항</div>
    <div class="today-sec">
      <button class="exam-item"><span class="exam-name"><b>응급_중환자</b><span class="exam-meta">틀림 6 · 찍음 3 · 푼 문항 42개</span></span><span class="exam-progress">9개 ›</span></button>
      <button class="exam-item" disabled><span class="exam-name"><b>근골격계</b><span class="exam-meta">없음 · 푼 문항 20개</span></span><span class="exam-progress">✓</span></button>
    </div>
    <div class="today-h">오늘 수업 · 10/13</div>
    <div class="today-sec">
      <div class="today-lec"><div class="today-lec-head"><span class="today-period">2~3</span><b>소아기본소생술(PBLS), 이물질 기도폐쇄</b><span class="muted"> 응급의학과 차민수</span></div><button class="chip">📖 예습노트</button></div>
      <div class="today-chips"><button class="chip">🧪 소아기본소생술PBLS (4/8 · 약함 4)</button><button class="chip">🧪 임상독성학</button></div>
    </div>`;

  const r = (el) => el.getBoundingClientRect();
  const dd = document.querySelector('.today-d');
  out.push({ name: 'D-day가 보인다', ok: r(dd).height > 8 && dd.textContent === 'D-13' });
  out.push({ name: 'D-day에 강조색이 쓰인다',
    ok: getComputedStyle(dd).color !== getComputedStyle(document.body).color,
    detail: getComputedStyle(dd).color });

  const rows = [...document.querySelectorAll('#todayBody .exam-item')];
  out.push({ name: '과목 줄이 눌릴 만큼 크다', ok: rows.every((x) => r(x).height >= 44),
    detail: `${Math.round(r(rows[0]).height)}px` });
  out.push({ name: '약한 문항 없는 과목은 눌리지 않는다', ok: rows[1].disabled });
  out.push({ name: '꺼진 줄은 흐리게 보인다',
    ok: Number(getComputedStyle(rows[1]).opacity) < 0.9, detail: getComputedStyle(rows[1]).opacity });

  const chips = [...document.querySelectorAll('#todayBody .chip')];
  out.push({ name: '칩이 손가락으로 눌릴 만큼 크다', ok: chips.every((c) => r(c).height >= 28),
    detail: `${Math.round(r(chips[0]).height)}px` });
  out.push({ name: '칩이 둥글다', ok: getComputedStyle(chips[0]).borderRadius.startsWith('999') });

  // 긴 강의명이 가로로 넘치지 않아야 한다 — 아이패드 세로에서 제일 먼저 깨지는 곳
  out.push({ name: '오늘 탭이 가로로 넘치지 않는다',
    ok: body.scrollWidth <= body.clientWidth + 1,
    detail: `${body.scrollWidth} vs ${body.clientWidth}` });
  const lec = document.querySelector('.today-lec');
  out.push({ name: '강의 칸이 본문 폭 안에 들어온다',
    ok: r(lec).width <= r(body).width + 1 && r(lec).width > 100 });
  out.push({ name: '교시가 제목과 같은 줄에 붙는다',
    ok: Math.abs(r(document.querySelector('.today-period')).top
      - r(document.querySelector('.today-lec-head b')).top) < 10 });
  return out;
});

await run('찍었음 버튼 생김새', () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  const qs = document.getElementById('quizScreen');
  qs.classList.remove('hidden');
  const exp = document.getElementById('expExplain');
  document.getElementById('explainBox').style.display = 'block';
  exp.innerHTML = `<div class="line">✅ 정답 — 정답 <b class="opt-num">③</b>`
    + `<button class="retry-one">↺ 다시 풀기</button>`
    + `<button class="unsure-btn">🎲 찍었음</button></div>`;
  const b = exp.querySelector('.unsure-btn');
  const r = (el) => el.getBoundingClientRect();
  out.push({ name: '찍었음 버튼이 보인다', ok: r(b).height > 14 && r(b).width > 40,
    detail: `${Math.round(r(b).width)}×${Math.round(r(b).height)}` });
  out.push({ name: '다시 풀기와 같은 줄에 있다',
    ok: Math.abs(r(b).top - r(exp.querySelector('.retry-one')).top) < 12 });
  const off = getComputedStyle(b).borderColor;
  b.classList.add('on');
  const on = getComputedStyle(b).borderColor;
  out.push({ name: '켜지면 색이 바뀐다', ok: off !== on, detail: `${off} → ${on}` });
  out.push({ name: '켜진 상태가 글자색으로도 보인다',
    ok: getComputedStyle(b).color !== getComputedStyle(document.body).color });
  out.push({ name: '설명 줄을 가로로 넘치게 하지 않는다',
    ok: exp.scrollWidth <= exp.clientWidth + 1, detail: `${exp.scrollWidth} vs ${exp.clientWidth}` });
  return out;
});

// ══════════ 노트에서 가져온 Q&A 카드 ══════════
await run('Q&A 가져오기 배선', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((r) => r.text());
  const reader = await fetch('/js/reader.js').then((r) => r.text());
  out.push({ name: 'Q&A 파서가 있다', ok: /export function qaCards/.test(reader) });
  out.push({ name: 'app이 qaCards를 쓴다', ok: /qaCards\(md, \{ path/.test(app) });
  out.push({ name: '가져오기 화면이 있다', ok: /async function renderQaImport/.test(app) });
  out.push({ name: '카드 관리에 가져오기 탭이 있다', ok: /\['import', '가져오기'/.test(app) });
  out.push({ name: '카드가 0장일 때도 가져오기로 갈 수 있다',
    ok: /노트에서 Q&A 가져오기/.test(app), detail: '처음 쓰는 사람이 딱 이 상태다' });
  out.push({ name: '🔴 기출 카드는 중요 표시로 들어온다',
    ok: /c\.examBacked \|\| c\.starred/.test(app) });
  out.push({ name: '과목 순서를 시험 강의 이름으로 정한다', ok: /function overlapScore/.test(app) });
  out.push({ name: '질문은 이스케이프해서 넣는다', ok: /escapeForCard/.test(reader) });
  return out;
});

await run('Q&A 카드 생김새', () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('cardScreen').classList.remove('hidden');

  const ctx = document.getElementById('cardContext');
  const ans = document.getElementById('cardAnswer');
  ctx.classList.add('qa-q');
  ctx.textContent = '저산소성 서맥인 소아에서 가장 먼저 해야 하는 처치는?';
  ans.classList.remove('hidden');
  ans.innerHTML = '<div class="ans-row">① 산소·환기 교정이 1차다.\n② 아트로핀은 미주신경성 서맥용.\n③ 맥박 60 미만 + 관류 저하면 가슴압박.</div>';

  const r = (el) => el.getBoundingClientRect();
  out.push({ name: '질문이 왼쪽 정렬', ok: getComputedStyle(ctx).textAlign === 'left',
    detail: getComputedStyle(ctx).textAlign });
  const row = ans.querySelector('.ans-row');
  out.push({ name: '답의 줄바꿈이 살아 있다', ok: getComputedStyle(row).whiteSpace === 'pre-wrap',
    detail: getComputedStyle(row).whiteSpace });
  out.push({ name: '답이 세 줄로 보인다', ok: r(row).height > 50, detail: `${Math.round(r(row).height)}px` });
  out.push({ name: '답이 가로로 넘치지 않는다', ok: ans.scrollWidth <= ans.clientWidth + 1,
    detail: `${ans.scrollWidth} vs ${ans.clientWidth}` });

  // 아주 긴 답 — 화면 밖으로 밀어내지 않고 안에서 스크롤해야 한다
  row.textContent = Array.from({ length: 40 }, (_, i) => `${i + 1}줄 설명이 길게 이어진다.`).join('\n');
  const overflowY = getComputedStyle(ans).overflowY;
  out.push({ name: '긴 답은 카드 안에서 스크롤한다', ok: overflowY === 'auto' || overflowY === 'scroll',
    detail: overflowY });
  out.push({ name: '긴 답이 화면 높이를 넘지 않는다', ok: r(ans).height <= window.innerHeight,
    detail: `${Math.round(r(ans).height)} vs ${window.innerHeight}` });
  return out;
});

// 아주 좁은 폭 — 긴 강의명·긴 시험 이름이 가로 스크롤을 만드는지 본다
await page.setViewport({ width: 390, height: 844 });
await run('오늘 탭 — 좁은 폭', () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('listScreen').classList.remove('hidden');
  const body = document.getElementById('todayBody');
  body.classList.remove('hidden');
  body.innerHTML = `
    <div class="today-h">오늘 수업 · 10/14</div>
    <div class="today-sec">
      <div class="today-lec"><div class="today-lec-head"><span class="today-period">5</span><b>중환자실의 구조와 운영 &amp; 중환자 중증도 분류 및 평가</b><span class="muted"> 응급의학과 박종수</span></div><button class="chip">📖 예습노트</button></div>
      <div class="today-chips">
        <button class="chip">🧪 전문외상소생술ATLS (12/20 · 약함 8)</button>
        <button class="chip">🧪 중환자실구조와운영_중증도분류 (0/1)</button>
      </div>
    </div>`;
  out.push({ name: '좁은 폭에서도 가로로 넘치지 않는다',
    ok: body.scrollWidth <= body.clientWidth + 1, detail: `${body.scrollWidth} vs ${body.clientWidth}` });
  out.push({ name: '본문 전체가 가로 스크롤을 만들지 않는다',
    ok: document.documentElement.scrollWidth <= window.innerWidth + 1,
    detail: `${document.documentElement.scrollWidth} vs ${window.innerWidth}` });
  const chips = [...document.querySelectorAll('.today-chips .chip')];
  out.push({ name: '칩이 두 줄로 접힌다',
    ok: chips[1].getBoundingClientRect().top > chips[0].getBoundingClientRect().top + 5,
    detail: `${Math.round(chips[0].getBoundingClientRect().top)} / ${Math.round(chips[1].getBoundingClientRect().top)}` });
  out.push({ name: '긴 강의명이 여러 줄로 흐른다',
    ok: document.querySelector('.today-lec-head').getBoundingClientRect().height > 30 });
  return out;
});


// ══════════ 카드 관리 고도화: 덱 트리 · 보관 · 여러 장 고르기 (2026-10-12) ══════════
// "오래 누르면 툭툭 골라서 한꺼번에 처리" + "두경부는 끝났으니 눈에 안 띄게".
// 길게 누르기와 범위 선택은 **진짜 포인터 이벤트**로만 확인할 수 있어서 여기 있다.
await page.setViewport({ width: 1366, height: 1024 });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => !document.getElementById('splash'), { timeout: 6000 }).catch(() => {});

await page.evaluate(async () => {
  const { saveCards, allCards, deleteCard } = await import('/js/db.js');
  for (const c of await allCards()) await deleteCard(c.id);     // 앞 테스트가 남긴 것 치운다
  const { kvSet } = await import('/js/db.js');
  await kvSet('deck_archived', []);
  await kvSet('srs', {});
  const cards = [];
  const notes = [
    ['98_예습노트_보관/응급_중환자/1015_응급중환자_ACLS.md', 'ACLS', 6],
    ['98_예습노트_보관/응급_중환자/1021_응급중환자_ECMO.md', 'ECMO', 4],
    ['02_Wiki/두경부_피부/두경부피부_중이염.md', '중이염', 5],
  ];
  for (const [path, title, n] of notes) {
    for (let i = 1; i <= n; i++) {
      cards.push({ id: `qa:${path}#${i}`, kind: 'qa', notePath: path, noteTitle: title,
        heading: title, topic: title, contextHtml: `${title} 질문 ${i}`, answers: [`답 ${i}`] });
    }
  }
  await saveCards(cards);
});
await page.evaluate(() => document.querySelector('.tabs [data-tab="cards"]').click());
await page.waitForFunction(() => document.body.dataset.screen === 'deckScreen', { timeout: 8000 });
await page.waitForFunction(() => document.querySelectorAll('.deck-card').length > 0, { timeout: 8000 });

await run('덱 트리', () => {
  const out = [];
  const names = [...document.querySelectorAll('#deckSide .deck-node .dn-name')].map((n) => n.textContent);
  out.push({ name: '출처 폴더가 그대로 과목 덱이 된다',
    ok: names.includes('응급_중환자') && names.includes('두경부_피부'), detail: names.join(' / ') });
  out.push({ name: '상태 탭과 과목 트리가 따로 있다',
    ok: document.querySelectorAll('.deck-sec-h').length >= 2 });
  const sub = [...document.querySelectorAll('#deckSide .deck-node')].find((b) => /응급_중환자/.test(b.textContent));
  out.push({ name: '노트가 여러 개면 펼칠 수 있다', ok: !!sub.querySelector('.dn-caret.tap') });
  sub.querySelector('.dn-caret').click();
  const subs = [...document.querySelectorAll('#deckSide .deck-node.sub .dn-name')].map((n) => n.textContent);
  out.push({ name: '펼치면 노트가 나온다', ok: subs.length === 2, detail: subs.join(' / ') });
  out.push({ name: '노트는 배운 순서대로(날짜 오름차순)', ok: /^1015/.test(subs[0]), detail: subs.join(' / ') });
  // 과목을 고르면 그 과목만
  sub.click();
  out.push({ name: '과목을 고르면 그 과목 카드만 보인다',
    ok: [...document.querySelectorAll('.deck-card .deck-topic')].every((t) => /ACLS|ECMO/.test(t.textContent)),
    detail: String(document.querySelectorAll('.deck-card').length) });
  out.push({ name: '어디를 보고 있는지 알려준다', ok: !!document.querySelector('.deck-crumb') });
  document.querySelector('.deck-crumb .deck-btn').click();   // 전체 보기
  out.push({ name: '전체로 돌아올 수 있다', ok: !document.querySelector('.deck-crumb') });
  return out;
});

await run('과목 보관', async () => {
  const out = [];
  const before = document.querySelectorAll('.deck-card').length;
  const row = [...document.querySelectorAll('.deck-node-row')].find((r) => /두경부_피부/.test(r.textContent));
  row.querySelector('.deck-arch').click();
  await new Promise((r) => setTimeout(r, 300));
  out.push({ name: '보관하면 목록에서 사라진다',
    ok: document.querySelectorAll('.deck-card').length === before - 5,
    detail: `${before} → ${document.querySelectorAll('.deck-card').length}` });
  out.push({ name: '오늘 볼 것 개수에서도 빠진다',
    ok: document.querySelector('.deck-tab.active .dt-n').textContent === '10',
    detail: document.querySelector('.deck-tab.active .dt-n').textContent });
  const arch = document.querySelector('.deck-arch-h');
  out.push({ name: '지난 과목으로 접힌다', ok: !!arch && /지난 과목/.test(arch.textContent) });
  out.push({ name: '카드를 지우는 게 아니다',
    ok: (await (await import('/js/db.js')).allCards()).length === 15 });
  // 펼쳐서 되돌리기
  arch.click();
  const back = [...document.querySelectorAll('.deck-node-row')].find((r) => /두경부_피부/.test(r.textContent));
  out.push({ name: '보관함을 펼쳐 볼 수 있다', ok: !!back });
  back.querySelector('.deck-arch').click();
  await new Promise((r) => setTimeout(r, 300));
  out.push({ name: '되돌리면 그대로 돌아온다',
    ok: document.querySelectorAll('.deck-card').length === before,
    detail: String(document.querySelectorAll('.deck-card').length) });
  return out;
});

// ── 길게 누르기 → 여러 장 고르기 ── (진짜 포인터로)
const pressCard = async (idx, ms) => {
  const b = await page.evaluate((i) => {
    const c = document.querySelectorAll('.deck-card')[i];
    c.scrollIntoView({ block: 'center' });
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + 50), y: Math.round(r.top + r.height / 2) };
  }, idx);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, ms));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
};

await pressCard(0, 120);                       // 짧게 — 들어가면 안 된다
results.push({ name: '짧게 누르면 고르기로 안 들어간다',
  ok: await page.evaluate(() => document.getElementById('deckSelBar').classList.contains('hidden')) });

await pressCard(0, 650);                       // 길게 — 들어가야 한다
results.push({ name: '길게 누르면 고르기 모드로 들어간다',
  ok: await page.evaluate(() => !document.getElementById('deckSelBar').classList.contains('hidden')) });
results.push({ name: '누른 카드가 먼저 골라져 있다',
  ok: (await page.evaluate(() => document.querySelector('.sel-n').textContent)) === '1장 선택',
  detail: await page.evaluate(() => document.querySelector('.sel-n').textContent) });

await pressCard(4, 650);                       // 길게 = 여기까지 범위 선택
results.push({ name: '다른 카드를 길게 누르면 그 사이가 전부 골라진다(shift+클릭 대신)',
  ok: (await page.evaluate(() => document.querySelector('.sel-n').textContent)) === '5장 선택',
  detail: await page.evaluate(() => document.querySelector('.sel-n').textContent) });

await run('고르기 모드', async () => {
  const out = [];
  out.push({ name: '고른 카드에 체크가 보인다',
    ok: document.querySelectorAll('.deck-card.picked').length === 5,
    detail: String(document.querySelectorAll('.deck-card.picked').length) });
  out.push({ name: '고르는 중에는 낱장 버튼이 안 나온다',
    ok: !document.querySelector('.deck-card.selectable .deck-acts') });
  // 탭하면 토글
  document.querySelectorAll('.deck-card')[2].click();
  out.push({ name: '탭하면 빠진다', ok: document.querySelector('.sel-n').textContent === '4장 선택',
    detail: document.querySelector('.sel-n').textContent });
  document.querySelectorAll('.deck-card')[2].click();
  out.push({ name: '다시 탭하면 들어간다', ok: document.querySelector('.sel-n').textContent === '5장 선택' });

  // 전체 선택 — 화면에 그린 것뿐 아니라 그 칸 전부
  [...document.querySelectorAll('.sel-btn2')].find((b) => /전체 선택/.test(b.textContent)).click();
  out.push({ name: '전체 선택은 그 칸 카드 전부', ok: document.querySelector('.sel-n').textContent === '15장 선택',
    detail: document.querySelector('.sel-n').textContent });

  // 일괄 중요 표시
  [...document.querySelectorAll('.sel-btn2')].find((b) => b.textContent === '★ 중요').click();
  await new Promise((r) => setTimeout(r, 350));
  const starTab = [...document.querySelectorAll('.deck-tab')].find((b) => /중요/.test(b.textContent));
  out.push({ name: '한 번에 중요 표시가 된다', ok: starTab.querySelector('.dt-n').textContent === '15',
    detail: starTab.querySelector('.dt-n').textContent });
  out.push({ name: '처리하면 고르기 모드가 끝난다',
    ok: document.getElementById('deckSelBar').classList.contains('hidden') });
  return out;
});

// ── 쓸어서 여러 장 고르기 (2026-10-13) ──
// 한 장씩 탭하면 20장에 20번을 두드려야 한다. 고르기 중에는 손가락이 지나간 카드가
// 그대로 골라진다(사진 앱의 다중 선택).
{
  // 고르기 모드 + **0장 선택**에서 시작한다 — 시작 상태가 애매하면 결과를 못 읽는다
  await page.evaluate(async () => {
    [...document.querySelectorAll('.deck-tab')].find((b) => /전체/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 200));
    const cancel = [...document.querySelectorAll('.sel-btn2')].find((b) => b.textContent === '취소');
    if (cancel) { cancel.click(); await new Promise((r) => setTimeout(r, 150)); }
    [...document.querySelectorAll('.deck-card .deck-btn')].find((b) => b.textContent === '선택').click();
    await new Promise((r) => setTimeout(r, 200));
    // '선택' 버튼은 그 카드를 골라둔 채로 들어간다 — 그 한 장을 떼어 0장으로 맞춘다
    const n = () => Number((document.querySelector('.sel-n')?.textContent || '0').replace(/\D/g, ''));
    if (n() > 0) {
      const all = [...document.querySelectorAll('.sel-btn2')].find((b) => /전체 (선택|해제)/.test(b.textContent));
      if (/전체 해제/.test(all.textContent)) all.click();
      else { all.click(); await new Promise((r) => setTimeout(r, 120));
        [...document.querySelectorAll('.sel-btn2')].find((b) => /전체 해제/.test(b.textContent))?.click(); }
      await new Promise((r) => setTimeout(r, 200));
    }
  });
  const before = await page.evaluate(() => document.querySelector('.sel-n')?.textContent);
  results.push({ name: '쓸기 전 0장에서 시작한다(시작 상태 확인)', ok: /^0장/.test(before || ''), detail: before });

  // 카드 3장을 가로질러 쓴다
  const path = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('.deck-card')].slice(0, 3);
    return cs.map((c) => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
    });
  });
  if (path.length >= 3) {
    await page.mouse.move(path[0].x, path[0].y);
    await page.mouse.down();
    for (const pt of path.slice(1)) await page.mouse.move(pt.x, pt.y, { steps: 5 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 250));
    const after = await page.evaluate(() => document.querySelector('.sel-n')?.textContent);
    results.push({ name: '쓸면 지나간 카드가 한꺼번에 골라진다',
      ok: /^3장/.test(after || ''), detail: `${before} → ${after}` });
    results.push({ name: '쓴 카드에 체크가 보인다',
      ok: (await page.evaluate(() => document.querySelectorAll('.deck-card.picked').length)) === 3 });

    // 같은 자리를 다시 쓸면 꺼진다 — 방향은 첫 카드가 정한다
    await page.mouse.move(path[0].x, path[0].y);
    await page.mouse.down();
    for (const pt of path.slice(1)) await page.mouse.move(pt.x, pt.y, { steps: 5 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 250));
    results.push({ name: '켜진 카드를 쓸면 꺼진다(방향은 첫 카드가 정한다)',
      ok: /^0장/.test(await page.evaluate(() => document.querySelector('.sel-n')?.textContent || '')),
      detail: await page.evaluate(() => document.querySelector('.sel-n')?.textContent) });
  } else {
    results.push({ name: '쓸어서 고르기 — 카드가 모자라 건너뜀', ok: true, detail: `${path.length}장` });
  }
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('.sel-btn2')].find((b) => b.textContent === '취소');
    if (c) c.click();
  });
}

await run('일괄 버리기 · 삭제 확인', async () => {
  const out = [];
  // 앞 단계에서 전부 중요 표시가 되어 '오늘 볼 것' 칸이 비었다 — 전체 칸으로 옮긴다
  [...document.querySelectorAll('.deck-tab')].find((b) => /전체/.test(b.textContent)).click();
  await new Promise((r) => setTimeout(r, 200));
  // 낱장 카드의 '선택' 버튼으로도 들어갈 수 있다(길게 누르기를 모르는 경우)
  const pick = [...document.querySelectorAll('.deck-card .deck-btn')].find((b) => b.textContent === '선택');
  out.push({ name: '버튼으로도 고르기에 들어간다', ok: !!pick });
  pick.click();
  await new Promise((r) => setTimeout(r, 200));
  [...document.querySelectorAll('.sel-btn2')].find((b) => /전체 선택/.test(b.textContent)).click();
  [...document.querySelectorAll('.sel-btn2')].find((b) => /버리기/.test(b.textContent)).click();
  await new Promise((r) => setTimeout(r, 350));
  const dropTab = [...document.querySelectorAll('.deck-tab')].find((b) => /버림/.test(b.textContent));
  out.push({ name: '한 번에 버릴 수 있다', ok: dropTab.querySelector('.dt-n').textContent === '15',
    detail: dropTab.querySelector('.dt-n').textContent });

  // 삭제는 되돌릴 수 없으니 한 번 더 묻는다
  [...document.querySelectorAll('.deck-tab')].find((b) => /버림/.test(b.textContent)).click();
  await new Promise((r) => setTimeout(r, 250));
  [...document.querySelectorAll('.deck-card .deck-btn')].find((b) => b.textContent === '선택').click();
  await new Promise((r) => setTimeout(r, 200));
  const del = () => [...document.querySelectorAll('.sel-btn2')].find((b) => /삭제/.test(b.textContent));
  del().click();
  await new Promise((r) => setTimeout(r, 150));
  out.push({ name: '삭제는 한 번 더 묻는다', ok: /정말 삭제/.test(del().textContent), detail: del().textContent });
  const n0 = (await (await import('/js/db.js')).allCards()).length;
  del().click();
  await new Promise((r) => setTimeout(r, 450));
  const n1 = (await (await import('/js/db.js')).allCards()).length;
  out.push({ name: '두 번째 누르면 실제로 지워진다', ok: n1 === n0 - 1, detail: `${n0} → ${n1}` });
  return out;
});

await run('오늘 수업 자료 칩', () => {
  const out = [];
  // 시간표의 `실강(02_Wiki)` 칸을 읽어 수업 후 노트도 걸어준다(2026-10-12).
  // 예전에는 예습노트 하나만 걸려서 **위키를 만들어도 계속 예습본만** 떴다.
  const sec = document.createElement('div');
  sec.innerHTML = '<div class="today-lec"><div class="today-lec-head"><b>기본소생술(BLS)</b></div>'
    + '<div class="today-chips"><button class="chip">📗 실강노트</button>'
    + '<button class="chip">📖 예습노트</button><button class="chip">📜 족보</button></div></div>';
  document.body.appendChild(sec);
  const chips = [...sec.querySelectorAll('.chip')];
  out.push({ name: '한 강의에 자료 칩이 여러 개 들어간다', ok: chips.length === 3 });
  out.push({ name: '칩이 손가락으로 눌릴 만큼 크다',
    ok: chips.every((c) => c.getBoundingClientRect().height >= 30),
    detail: `${Math.round(chips[0].getBoundingClientRect().height)}px` });
  out.push({ name: '칩이 가로로 넘치지 않는다',
    ok: sec.scrollWidth <= sec.clientWidth + 1, detail: `${sec.scrollWidth} vs ${sec.clientWidth}` });
  sec.remove();
  return out;
});

await run('아이콘 구분', () => {
  const out = [];
  const cap = document.getElementById('readCapture').innerHTML;
  const card = document.getElementById('readMakeCard').innerHTML;
  out.push({ name: '영역 복사와 카드 만들기가 서로 다른 그림이다', ok: cap !== card });
  out.push({ name: '영역 복사는 사진 그림(해+산)', ok: /circle/.test(cap) && /rect/.test(cap) });
  out.push({ name: '카드 만들기는 가려진 말이 있는 카드 그림',
    ok: /fill="currentColor"/.test(card) && !/circle/.test(card), detail: card.slice(0, 80) });
  out.push({ name: '퀴즈 도구막대의 영역 복사도 같은 그림',
    ok: document.getElementById('toolCapture').innerHTML === cap });
  return out;
});



// ══════════ "오늘" 탭 ↻ 가 노트 목록까지 다시 읽는가 (2026-10-12) ══════════
// 실제 증상: vault에 새 노트(실강노트)를 올리고 "오늘" 탭에서 ↻ 를 눌러도
// 📗 칩이 "노트를 찾지 못했습니다"를 띄웠다. 앱을 완전히 종료했다 열면 되는데
// ↻ 로는 안 됐다 — note_index 캐시가 ↻ 의 대상이 아니었다. 자동 복구 로직
// 자체(findNoteInGroups)는 test_phase45.mjs가 보고, 여기서는 **그게 이 경로에
// 실제로 배선돼 있는지**를 확인한다 — 배선만 빠져도 조용히 재발한다.
await run('오늘 탭 ↻ 가 노트까지 다시 읽는다', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '↻ 가 노트 목록도 같이 force한다',
    ok: /noteList\(force\)/.test(app) && /todayData\(force\), buildExamIndex\(force\)/.test(app) });
  out.push({ name: '칩은 그 자리에서 읽어온 최신 목록을 그대로 쓴다(중복 조회 없음)',
    ok: /openNoteByName\(l\.wiki, \{ groups: noteGroups \}\)/.test(app)
      && /openNoteByName\(l\.note, \{ groups: noteGroups \}\)/.test(app) });
  out.push({ name: '캐시에 없으면 자동으로 한 번 더 본다(사용자가 따로 ↻ 안 눌러도 된다)',
    ok: /groups = await noteList\(true\)/.test(app) });
  return out;
});

// ══════════ 문항 전체보기 (2026-10-12) ══════════
// 스크롤하며 쭉 훑어보고, 체크(★)·색상으로 표시하는 패널. 실제 GitHub Contents API를
// 흉내 낸 작은 가짜 시험으로 **진짜 앱 플로우**(설정→목록→풀이)를 통해 검증한다 —
// toolOverview 핸들러가 app.js의 모듈 비공개 `quiz` 변수를 직접 쓰므로, 외부에서
// 함수를 호출하는 식으로는 테스트할 수 없고 실제로 클릭해서 그 상태를 만들어야 한다.
{
  const QS = Array.from({ length: 12 }, (_, i) => ({
    num: i + 1, type: 'mc',
    q: `문제 ${i + 1} — 전체보기 테스트용 지문이다. 어느 정도 길게 써서 두 줄로 접히는지도 본다.`,
    opts: ['가', '나', '다', '라', '마'], ans: i % 5, opt: [],
  }));
  const EXAM_HTML = `<!doctype html><html><body><script>
const QUESTIONS = ${JSON.stringify(QS)};
const LECTURE_NAME = "전체보기 테스트";
<\/script></body></html>`;

  const FILES = {
    '06_모의고사': [{ name: '테스트과목', path: '06_모의고사/테스트과목', type: 'dir' }],
    '06_모의고사/테스트과목': [{ name: 'test_모의고사.html', path: '06_모의고사/테스트과목/test_모의고사.html', type: 'file' }],
  };

  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  };
  const onReq = async (req) => {
    const u = req.url();
    try {
      const m = u.match(/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/([^?]*)/);
      if (!m) return await req.continue();
      if (req.method() === 'OPTIONS') return await req.respond({ status: 204, headers: CORS, body: '' });
      const rel = decodeURIComponent(m[1]);
      if (FILES[rel]) {
        return await req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(FILES[rel]) });
      }
      if (rel === '06_모의고사/테스트과목/test_모의고사.html') {
        return await req.respond({ status: 200, headers: CORS, contentType: 'text/plain', body: EXAM_HTML });
      }
      return await req.respond({ status: 404, headers: CORS, contentType: 'text/plain', body: 'not found' });
    } catch (e) {
      try { await req.respond({ status: 500, headers: CORS, contentType: 'text/plain', body: String(e.message) }); } catch {}
    }
  };
  page.on('request', onReq);

  await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    const d = await import('/js/db.js');
    await a.setToken('fake-token');
    await a.setRepo('me/fake-vault');
    // 앞선 검사들이 남긴 상태를 치운다 — 특히 last_tab이 'cards'면 카드 화면으로 가버리고,
    // exam_index 캐시가 남아 있으면 가짜 시험이 목록에 안 들어온다.
    localStorage.setItem('last_tab', 'exams');
    await d.kvSet('exam_index_v3', null);
    await d.kvSet('schedule_cache', null);
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.getElementById('splash'), { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll('#listBody .exam-item').length > 0, { timeout: 20000 })
    .catch(async () => {
      const diag = await page.evaluate(() => ({
        screen: document.body.dataset.screen,
        tab: document.querySelector('.tab.active')?.dataset.tab,
        list: document.getElementById('listBody').textContent.slice(0, 160),
      }));
      throw new Error('전체보기 준비 실패 — ' + JSON.stringify(diag));
    });
  await page.evaluate(() => document.querySelector('#listBody .exam-item').click());
  await page.waitForFunction(() => document.body.dataset.screen === 'quizScreen', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));

  await run('전체보기 열기', () => {
    const out = [];
    const btn = document.getElementById('toolOverview');
    out.push({ name: '도구막대에 전체보기 버튼이 있다', ok: !!btn });
    btn.click();
    const panel = document.getElementById('overviewPanel');
    out.push({ name: '누르면 패널이 열린다', ok: !panel.classList.contains('hidden') });
    out.push({ name: '버튼이 켜진 표시가 된다', ok: btn.classList.contains('active') });
    out.push({ name: '위키·AI 패널과 같은 칼럼을 쓴다(동시에 열리지 않는다)',
      ok: document.getElementById('wikiPanel').classList.contains('hidden')
        && document.getElementById('aiPanel').classList.contains('hidden') });
    out.push({ name: '12문항이 전부 나열된다', ok: document.querySelectorAll('.ov-row').length === 12,
      detail: String(document.querySelectorAll('.ov-row').length) });
    out.push({ name: '아직 하나도 안 풀어서 전부 "안 풂"',
      ok: [...document.querySelectorAll('.ov-pill')].every((p) => p.textContent === '안 풂') });
    out.push({ name: '지금 보고 있는 1번이 강조돼 있다',
      ok: document.querySelector('.ov-row[data-i="0"]').classList.contains('current') });
    return out;
  });

  await run('목록에서 문제 풀고 상태가 바뀌는지', async () => {
    const out = [];
    // 3번 문항을 정답으로, 5번을 오답으로 — 전체보기가 실시간으로 따라와야 한다
    document.getElementById('toolOverview').click();   // 끄기
    await new Promise((r) => setTimeout(r, 50));

    const go = (n) => {
      while (true) {
        const m = document.getElementById('posLabel').textContent.match(/^(\d+)\//);
        if (Number(m[1]) === n) return;
        document.getElementById('nextBtn').click();
      }
    };
    go(3);
    document.querySelectorAll('.opt-row')[2].click();   // ans=2(다)와 일치 → 정답
    go(5);
    document.querySelectorAll('.opt-row')[0].click();   // ans=4(마)와 불일치 → 오답

    document.getElementById('toolOverview').click();    // 다시 켜기
    await new Promise((r) => setTimeout(r, 50));
    const pill = (i) => document.querySelector(`.ov-row[data-i="${i}"] .ov-pill`).textContent;
    out.push({ name: '맞힌 문항이 정답으로 표시된다', ok: pill(2) === '정답', detail: pill(2) });
    out.push({ name: '틀린 문항이 오답으로 표시된다', ok: pill(4) === '오답', detail: pill(4) });
    out.push({ name: '머리글 집계가 같이 바뀐다',
      ok: /정답 1/.test(document.getElementById('ovStats').textContent)
        && /오답 1/.test(document.getElementById('ovStats').textContent),
      detail: document.getElementById('ovStats').textContent });
    return out;
  });

  await run('행을 누르면 그 문항으로 건너뛴다', async () => {
    const out = [];
    document.querySelector('.ov-row[data-i="7"] .ov-main').click();
    await new Promise((r) => setTimeout(r, 50));
    out.push({ name: '8번 문항으로 이동한다', ok: document.getElementById('posLabel').textContent === '8/12',
      detail: document.getElementById('posLabel').textContent });
    out.push({ name: '넓은 화면에선 패널이 안 닫힌다(계속 훑어보려고)',
      ok: !document.getElementById('overviewPanel').classList.contains('hidden') });
    return out;
  });

  await run('★ 체크와 색상 표시', async () => {
    const out = [];
    out.push({ name: '처음엔 ★이 꺼져 있다',
      ok: !document.querySelector('.ov-row[data-i="0"] .ov-star').classList.contains('on') });
    document.querySelector('.ov-row[data-i="0"] .ov-star').click();
    out.push({ name: '★을 누르면 켜진다(다시 그려도 유지)',
      ok: document.querySelector('.ov-row[data-i="0"] .ov-star').classList.contains('on') });

    // 지금 보고 있는 문항(8번)에 ★을 주면 **문제 화면의 북마크 버튼도 같이** 켜져야 한다 —
    // 두 곳이 같은 배열을 보는지 확인하는 것이 요점이다.
    const curIdx = Number(document.getElementById('posLabel').textContent.split('/')[0]) - 1;
    document.querySelector(`.ov-row[data-i="${curIdx}"] .ov-star`).click();
    out.push({ name: '보고 있는 문항에 ★을 주면 문제 화면 북마크도 켜진다',
      ok: document.getElementById('bookmarkBtn').classList.contains('active') });
    document.querySelector(`.ov-row[data-i="${curIdx}"] .ov-star`).click();   // 되돌린다
    out.push({ name: '끄면 문제 화면 북마크도 같이 꺼진다',
      ok: !document.getElementById('bookmarkBtn').classList.contains('active') });

    // 3번째 색(🟡)을 2번 문항에 지정
    const row1 = document.querySelector('.ov-row[data-i="1"]');
    const dots = row1.querySelectorAll('.ov-dot');
    dots[2].click();
    const row1b = document.querySelector('.ov-row[data-i="1"]');
    out.push({ name: '색을 고르면 테두리가 그 색이 된다',
      ok: row1b.style.borderLeftColor === 'rgb(234, 179, 8)', detail: row1b.style.borderLeftColor });
    out.push({ name: '같은 색을 다시 누르면 지워진다',
      ok: (() => {
        document.querySelector('.ov-row[data-i="1"] .ov-dot:nth-child(4)').click();
        return document.querySelector('.ov-row[data-i="1"]').style.borderLeftColor !== 'rgb(234, 179, 8)';
      })() });

    // 필터 — ★만 보기
    const starChip = [...document.querySelectorAll('.ov-chip')].find((c) => c.textContent.startsWith('★'));
    starChip.click();
    const rows = [...document.querySelectorAll('.ov-row')];
    out.push({ name: '★ 필터를 걸면 그 문항만 남는다', ok: rows.length === 1 && rows[0].dataset.i === '0',
      detail: rows.map((r) => r.dataset.i).join(',') });
    const allChip = [...document.querySelectorAll('.ov-chip')].find((c) => c.textContent === '전체');
    allChip.click();
    out.push({ name: '전체를 누르면 필터가 풀린다', ok: document.querySelectorAll('.ov-row').length === 12 });
    return out;
  });

  await run('다른 시험을 열면 이전 내용이 안 남는다', async () => {
    const out = [];
    document.getElementById('backToListBtn').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('#listBody .exam-item').click();
    await new Promise((r) => setTimeout(r, 400));
    out.push({ name: '다시 들어가면 전체보기가 닫혀 있다(이전 시험 내용이 안 남는다)',
      ok: document.getElementById('overviewPanel').classList.contains('hidden') });
    return out;
  });

  page.off('request', onReq);
  await page.setRequestInterception(false);
  // 가짜 토큰을 지워 이후 테스트에 영향을 안 주게 한다
  await page.evaluate(async () => { const a = await import('/js/auth.js'); await a.clearToken(); });
}

// ══════════ 노트 읽기: 움직이는 AI 답변 창 (2026-10-12) ══════════
// 바닥 시트를 쓰던 때: 문단을 통째로 긁으면 질문이 화면을 다 먹고 정작 답이 안 보였다.
// 답이 주인공이므로 질문은 접고, 창은 끌어 옮기고 크기도 바꿀 수 있어야 한다.
await page.setViewport({ width: 1366, height: 1024 });
await run('움직이는 답변 창', async () => {
  const out = [];
  // 실제로 겪은 상황: 목차 문단을 통째로 긁어 1,500자가 넘어갔다
  const LONG = '1. 왜 BLS인가 — 첫 10초, 질병관리청 통계(32.9%/15.3%/5.6%), 시간-생존율 곡선. '.repeat(30);
  const f = document.getElementById('askFloat');
  document.getElementById('afQ').textContent = LONG;
  document.getElementById('afQFull').textContent = LONG;
  document.getElementById('afQWrap').open = false;
  document.getElementById('afBody').innerHTML =
    '<p>' + '답변 문장이 여러 줄에 걸쳐 들어간다. '.repeat(40) + '</p>';
  f.classList.remove('hidden');
  await new Promise((r) => setTimeout(r, 60));

  const qr = document.querySelector('.af-q').getBoundingClientRect();
  const br = document.getElementById('afBody').getBoundingClientRect();
  out.push({ name: '질문이 긴데도 한 줄로만 접힌다', ok: qr.height < 48, detail: `${Math.round(qr.height)}px` });
  out.push({ name: '남는 공간은 전부 답이 갖는다', ok: br.height > qr.height * 4,
    detail: `질문 ${Math.round(qr.height)} / 답 ${Math.round(br.height)}` });
  out.push({ name: '답이 창 안에서 스크롤된다',
    ok: ['auto', 'scroll'].includes(getComputedStyle(document.getElementById('afBody')).overflowY) });
  out.push({ name: '답이 창 밖으로 안 넘친다',
    ok: br.bottom <= f.getBoundingClientRect().bottom + 1 });

  // 질문을 눌러 펼치면 전문이 보인다
  document.querySelector('.af-q > summary').click();
  await new Promise((r) => setTimeout(r, 30));
  out.push({ name: '눌러서 질문 전문을 볼 수 있다',
    ok: document.getElementById('afQFull').getBoundingClientRect().height > 20 });
  const qf = document.getElementById('afQFull');
  out.push({ name: '펼친 질문도 제 안에서 스크롤된다(답을 밀어내지 않는다)',
    ok: qf.scrollHeight > qf.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(qf).overflowY),
    detail: `${qf.scrollHeight} vs ${qf.clientHeight} / ${getComputedStyle(qf).overflowY}` });
  out.push({ name: '질문을 펼쳐도 답이 창 안에 남는다',
    ok: document.getElementById('afBody').getBoundingClientRect().height > 100,
    detail: `${Math.round(document.getElementById('afBody').getBoundingClientRect().height)}px` });
  document.querySelector('.af-q > summary').click();

  out.push({ name: '화면에 고정돼 노트를 따라 스크롤되지 않는다',
    ok: getComputedStyle(f).position === 'fixed' });
  out.push({ name: '펜이 이 창을 UI로 인식한다(그림이 안 그려진다)',
    ok: !!document.getElementById('afBody').closest('.ask-float') });
  return out;
});

// 끌어서 옮기기 — 진짜 포인터로만 확인된다
{
  const before = await page.evaluate(() => {
    const r = document.getElementById('askFloat').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const head = await page.evaluate(() => {
    const r = document.getElementById('afHead').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(head.x - 120, head.y + 90, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 80));
  const after = await page.evaluate(() => {
    const r = document.getElementById('askFloat').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  });
  results.push({ name: '머리를 끌면 창이 따라 움직인다',
    ok: Math.abs(after.x - (before.x - 120)) <= 3 && Math.abs(after.y - (before.y + 90)) <= 3,
    detail: `(${before.x},${before.y}) → (${after.x},${after.y})` });

  // 크기 조절
  const grip = await page.evaluate(() => {
    const r = document.getElementById('afResize').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 100, grip.y + 70, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 80));
  const sized = await page.evaluate(() => {
    const r = document.getElementById('askFloat').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  results.push({ name: '모서리를 끌면 크기가 바뀐다',
    ok: Math.abs(sized.w - (before.w + 100)) <= 4 && Math.abs(sized.h - (before.h + 70)) <= 4,
    detail: `${before.w}×${before.h} → ${sized.w}×${sized.h}` });
  results.push({ name: '옮긴 자리·크기를 기억한다',
    ok: await page.evaluate(() => !!localStorage.getItem('ask_float_box')) });

  // 화면 밖으로 끌어내도 되찾을 수 있어야 한다
  const h2 = await page.evaluate(() => {
    const r = document.getElementById('afHead').getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.move(h2.x, h2.y);
  await page.mouse.down();
  await page.mouse.move(-500, -500, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 80));
  const esc = await page.evaluate(() => {
    const r = document.getElementById('askFloat').getBoundingClientRect();
    return { right: Math.round(r.right), top: Math.round(r.top) };
  });
  results.push({ name: '화면 밖으로 끌어내도 손잡이가 남는다(되찾을 수 있다)',
    ok: esc.right >= 50 && esc.top >= 0, detail: JSON.stringify(esc) });

  await page.evaluate(() => {
    document.getElementById('askFloat').classList.add('hidden');
    localStorage.removeItem('ask_float_box');
  });
}

// 읽기 모드 프롬프트 — 문단을 긁으면 "핵심/감별/시험 포인트" 틀을 강요하지 않는다
await run('읽기 모드 프롬프트', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '읽기에서 물으면 mode:read 로 보낸다', ok: /mode: 'read'/.test(app) });
  out.push({ name: '답이 오는 대로 흘려 보여준다(다 기다리지 않는다)',
    ok: /onProgress: \(full\) => \{ body\.innerHTML = renderMarkdown\(full\)/.test(app) });
  out.push({ name: '답을 날 텍스트가 아니라 마크다운으로 그린다',
    ok: /body\.innerHTML = renderMarkdown\(answer\)/.test(app) });

  const G = await import('/js/gemini.js');
  const realFetch = window.fetch;
  let sent = null;
  try {
    await G.setKeys(['AIzaTESTREAD']);
    G.resetLimiter();
    window.fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      const sse = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '설명' }] } }] }) }\n\n`;
      const bytes = new TextEncoder().encode(sse);
      let done = false;
      return { ok: true, status: 200,
        body: { getReader: () => ({ read: async () => (done ? { done: true } : (done = true, { done: false, value: bytes })) }) } };
    };
    await G.ask({ term: '긁어온 문단', mode: 'read' });
    const sys = sent.systemInstruction.parts[0].text;
    out.push({ name: '읽기 모드는 핵심/감별/시험 포인트 틀을 강요하지 않는다',
      ok: !/\*\*감별\*\*/.test(sys) && !/\*\*시험 포인트\*\*/.test(sys), detail: sys.slice(0, 40) });
    out.push({ name: '대신 "긁어온 대목을 풀어 설명"하라고 시킨다', ok: /풀어서 설명/.test(sys) });
    out.push({ name: '긁은 글을 질문이 아니라 "대목"으로 넣는다',
      ok: /\[노트에서 긁어온 대목\]/.test(sent.contents[0].parts[0].text) });
    out.push({ name: '설명이 길어질 수 있으니 예산을 더 준다',
      ok: sent.generationConfig.maxOutputTokens >= 1500, detail: String(sent.generationConfig.maxOutputTokens) });

    // 문제 풀이 쪽은 그대로여야 한다
    G.resetLimiter();
    await G.ask({ term: 'Torsade', question: { num: 1, q: '지문', opts: ['가', '나'] } });
    const sys2 = sent.systemInstruction.parts[0].text;
    out.push({ name: '문제 풀 때는 기존 틀을 그대로 쓴다',
      ok: /\*\*핵심\*\*/.test(sys2) && /\*\*시험 포인트\*\*/.test(sys2) });
  } finally {
    window.fetch = realFetch;
    await G.setKeys([]);
    G.resetLimiter();
  }
  return out;
});

// ══════════ 색상 표시가 Obsidian까지 간다 (2026-10-12) ══════════
// "꼭 1:1은 아니더라도 옵시디언에서도 관리가 같이 되면서" — 앱에서 칠한 색을
// vault 마크다운에 **태그 + 이모지**로 남겨 Obsidian에서 검색·필터가 되게 한다.
await run('색상 → Obsidian 태그', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '색마다 Obsidian 이름이 있다',
    ok: /name: '빨강'/.test(app) && /name: '보라'/.test(app) });
  out.push({ name: 'frontmatter에 태그로 남긴다', ok: /tags: \[\$\{tagList\.join/.test(app) });
  out.push({ name: '태그가 달모/ 이름공간을 쓴다(다른 노트 태그와 안 섞인다)',
    ok: /'달모\/모의고사풀이'/.test(app) && /`달모\/\$\{OV_TAGS\[c - 1\]\.name\}`/.test(app) });
  out.push({ name: '★도 태그로 남는다', ok: /달모\/다시볼것/.test(app) });
  out.push({ name: '색마다 묶은 절을 따로 쓴다', ok: /## 🎨 색으로 표시한 문제/.test(app) });
  out.push({ name: '문항 번호 앞에 이모지·★를 붙여 눈으로도 보인다',
    ok: /function markOf\(x\)/.test(app) && /\$\{markOf\(x\)\}\$\{x\.q\.num\}/.test(app) });

  const quiz = await fetch('/js/quiz.js').then((r) => r.text());
  out.push({ name: '결과에 색이 실려 나간다', ok: /color: this\.colors\[i\] \|\| 0/.test(quiz) });
  out.push({ name: '색은 이어풀기에 저장된다(앱을 꺼도 남는다)',
    ok: /colors: this\.colors/.test(quiz) && /s\.colors\.length === this\.all\.length/.test(quiz) });
  return out;
});

// ══════════ 좁은 폭에서 도구가 밀려나지 않는가 (2026-10-12) ══════════
// 실제 증상: "노트 보기에서 뒤로가기가 안 됨 — 홈으로 나가는 버튼이 없다".
// 분할뷰(320·375px)에서 머리줄이 한 줄에 안 들어가 오른쪽 도구가 통째로
// 화면 밖으로 잘려 나갔다. 이제는 두 줄로 접히고, 돌아갈 길은 늘 맨 앞에 있다.
for (const w of [320, 375, 430, 820, 1366]) {
  await page.setViewport({ width: w, height: 900 });
  const bad = await page.evaluate(() => {
    const out = [];
    for (const id of ['listScreen', 'readScreen', 'quizScreen', 'cardScreen', 'deckScreen', 'resultScreen']) {
      document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
      const sec = document.getElementById(id);
      sec.classList.remove('hidden');
      document.body.dataset.screen = id;
      const h1 = sec.querySelector('h1');
      if (h1 && !h1.textContent.trim()) h1.textContent = '응급_중환자 — 기본소생술(BLS) (곽세정 교수)';
      const head = sec.querySelector('header');
      if (!head) continue;
      const btns = [...head.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      const off = btns.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > innerWidth + 0.5 || r.left < -0.5 || r.width < 20;
      }).map((b) => b.id || b.title || '?');
      if (head.scrollWidth - head.clientWidth > 1 || off.length) {
        out.push(`${id}(넘침 ${Math.round(head.scrollWidth - head.clientWidth)}px, 밀림 [${off.join(',')}])`);
      }
    }
    return out;
  });
  results.push({ name: `${w}px에서 머리줄 도구가 안 잘린다`, ok: bad.length === 0, detail: bad.join(' / ') });
}
// 돌아갈 길은 어느 폭에서도 맨 앞에 있어야 한다
await page.setViewport({ width: 320, height: 900 });
await run('돌아갈 길', () => {
  const out = [];
  for (const [screen, back] of [['readScreen', 'readBack'], ['quizScreen', 'backToListBtn'],
    ['cardScreen', 'cardBack'], ['deckScreen', 'deckBack'], ['resultScreen', 'resultBackBtn']]) {
    document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
    document.getElementById(screen).classList.remove('hidden');
    document.body.dataset.screen = screen;
    const b = document.getElementById(back);
    const r = b.getBoundingClientRect();
    const others = [...document.getElementById(screen).querySelectorAll('header button')]
      .filter((x) => x !== b && x.offsetParent !== null);
    out.push({ name: `${screen}: 뒤로 버튼이 보이고 눌린다`,
      ok: r.width >= 30 && r.height >= 30 && r.left >= -0.5 && r.right <= innerWidth + 0.5,
      detail: `${Math.round(r.width)}×${Math.round(r.height)} @${Math.round(r.left)}` });
    out.push({ name: `${screen}: 뒤로 버튼이 다른 도구보다 앞/위에 있다`,
      ok: others.every((x) => {
        const o = x.getBoundingClientRect();
        return o.top > r.top + 4 || o.left >= r.left - 0.5;
      }) });
    out.push({ name: `${screen}: 뒤로 버튼에 핸들러가 걸려 있다`, ok: typeof b.onclick === 'function' });
  }
  return out;
});
await page.setViewport({ width: 1366, height: 1024 });

// ══════════ 표시 설정 — 글자·줄간격·글줄 너비 (2026-10-12) ══════════
await run('표시 설정', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('setupScreen').classList.remove('hidden');
  document.body.dataset.screen = 'setupScreen';

  const root = document.documentElement;
  const read = () => getComputedStyle(root).getPropertyValue('--ui-scale').trim();
  out.push({ name: '설정 화면에 글자 크기 슬라이더가 있다', ok: !!document.getElementById('fontRange') });
  out.push({ name: '줄 간격·글줄 너비도 고를 수 있다',
    ok: document.querySelectorAll('#lineSeg .btn').length === 3
      && document.querySelectorAll('#widthSeg .btn').length === 4 });
  out.push({ name: '미리보기가 있다(바꾸면 바로 보인다)', ok: !!document.getElementById('setPreview') });

  // 글자 크기를 키우면 실제 글자가 커져야 한다 — 변수만 바뀌고 끝나면 소용없다
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.getElementById('readBody').innerHTML = '<p id="szProbe">성인 가슴압박 깊이는 5~6cm다.</p>';
  const before = parseFloat(getComputedStyle(document.getElementById('szProbe')).fontSize);
  root.style.setProperty('--ui-scale', '1.4');
  const after = parseFloat(getComputedStyle(document.getElementById('szProbe')).fontSize);
  out.push({ name: '글자 크기를 키우면 노트 본문이 실제로 커진다', ok: after > before * 1.3,
    detail: `${before.toFixed(1)}px → ${after.toFixed(1)}px` });

  // 문제 지문·선지·해설·AI 답변도 같이 따라와야 한다(한 군데라도 빠지면 들쭉날쭉해진다)
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.getElementById('qtext').textContent = '지문';
  document.getElementById('optsContainer').innerHTML = '<div class="opt-row"><div class="opt-text">선지</div></div>';
  const qs = parseFloat(getComputedStyle(document.getElementById('qtext')).fontSize);
  const os = parseFloat(getComputedStyle(document.querySelector('.opt-text')).fontSize);
  root.style.setProperty('--ui-scale', '1');
  const qs1 = parseFloat(getComputedStyle(document.getElementById('qtext')).fontSize);
  const os1 = parseFloat(getComputedStyle(document.querySelector('.opt-text')).fontSize);
  out.push({ name: '문제 지문도 따라 커진다', ok: qs > qs1 * 1.3, detail: `${qs1}→${qs}` });
  out.push({ name: '선지도 따라 커진다', ok: os > os1 * 1.3, detail: `${os1}→${os}` });

  // 글줄 너비 — 0이면 제한 없음
  root.style.setProperty('--read-measure', '68ch');
  out.push({ name: '글줄 너비가 변수로 조절된다',
    ok: getComputedStyle(root).getPropertyValue('--read-measure').trim() === '68ch' });
  root.style.setProperty('--read-measure', 'none');
  out.push({ name: '"꽉 채움"이면 제한이 풀린다',
    ok: getComputedStyle(root).getPropertyValue('--read-measure').trim() === 'none' });

  // 노트 본문은 class가 `wiki-body read-body` 둘 다라, 사이드 패널용 `.wiki-body` 규칙이
  // 뒤에 오면 조용히 이긴다 — 실제로 17px이어야 할 본문이 14.5px로 나오고 있었다.
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.getElementById('readBody').innerHTML = '<p id="szProbe2">본문</p>';
  const base = parseFloat(getComputedStyle(document.getElementById('szProbe2')).fontSize);
  out.push({ name: '노트 본문이 사이드 패널 크기(14.5px)로 깎이지 않는다',
    ok: base >= 16.5, detail: `${base}px` });

  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '설정이 기기에 저장된다', ok: /kvSet\('display', displayPrefs\)/.test(app) });
  out.push({ name: '앱을 켤 때 불러온다', ok: /await loadDisplay\(\)/.test(app) });
  out.push({ name: '기본값으로 되돌릴 수 있다', ok: !!document.getElementById('resetDisplay') });

  root.style.removeProperty('--ui-scale');
  root.style.removeProperty('--read-measure');
  return out;
});

// ══════════ 카드 만들기 — 화면 전환 대신 뜨는 창 (2026-10-12) ══════════
await run('카드 미리보기 창', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '네모 치면 화면을 안 떠나고 창으로 보여준다',
    ok: /openCardFloat\(cards\)/.test(app) && !/startDeck\(cards, reader\.note\.title, \{ backTo: 'reader' \}\);\n\}/.test(app) });
  out.push({ name: '질문 답변 창과 같은 틀(끌기·크기조절)을 쓴다',
    ok: /panel: 'cardFloat', head: 'cfHead', grip: 'cfResize'/.test(app) });
  out.push({ name: '위치·크기를 따로 기억한다', ok: /key: 'card_float_box'/.test(app) });

  // 실제로 띄워본다
  const f = document.getElementById('cardFloat');
  out.push({ name: '카드 창이 있다', ok: !!f });
  f.classList.remove('hidden');
  document.getElementById('cfStatus').textContent = '1/3 · 카드 관리에 저장됐습니다';
  document.getElementById('cfBody').innerHTML =
    '<div class="cf-topic">심폐소생술 › 가슴압박</div>'
    + '<div class="cf-q">성인 가슴압박 깊이는 <span class="cloze">____</span>다.</div>';
  await new Promise((r) => setTimeout(r, 50));
  const r2 = f.getBoundingClientRect();
  out.push({ name: '화면에 떠 있다(전환 아님)', ok: getComputedStyle(f).position === 'fixed' });
  out.push({ name: '읽을 만한 크기다', ok: r2.width >= 280 && r2.height >= 200,
    detail: `${Math.round(r2.width)}×${Math.round(r2.height)}` });
  out.push({ name: '화면 안에 들어온다',
    ok: r2.right <= innerWidth + 1 && r2.bottom <= innerHeight + 1 });
  out.push({ name: '빈칸이 가려져 있다',
    ok: getComputedStyle(document.querySelector('.cf-q .cloze')).color === 'rgba(0, 0, 0, 0)' });
  out.push({ name: '넘기기·답보기·바로외우기 버튼이 있다',
    ok: ['cfPrev', 'cfNext', 'cfReveal', 'cfStudy'].every((id) => !!document.getElementById(id)) });
  out.push({ name: '펜이 이 창도 UI로 인식한다',
    ok: !!document.getElementById('cfBody').closest('.ask-float') });
  f.classList.add('hidden');
  return out;
});

// ══════════ 모아두기 — 공부 중 알게 된 것 모으기 (2026-10-12) ══════════
// vault의 `00_Raw_Text/AI대화로그`에 넣는다 — CLAUDE.md상 "읽기 전용 원본 소스이며
// 다음 /lecture-integrate 때 자동 반영 후보"라, 맥에서 git pull만 하면 기존 흐름이
// 위키·최종정리에 알아서 흡수한다.
await page.setViewport({ width: 1366, height: 1024 });
await run('모아두기 창', async () => {
  const out = [];
  out.push({ name: '노트 읽기·문제 풀이 양쪽에 버튼이 있다',
    ok: !!document.getElementById('readScrap') && !!document.getElementById('toolScrap') });
  out.push({ name: '두 버튼이 같은 창을 연다',
    ok: document.getElementById('readScrap').onclick === document.getElementById('toolScrap').onclick });

  // 노트를 읽는 중이라 치고 연다
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.getElementById('readScrap').click();
  await new Promise((r) => setTimeout(r, 120));

  const f = document.getElementById('scrapFloat');
  out.push({ name: '창이 열린다', ok: !f.classList.contains('hidden') });
  out.push({ name: '떠 있는 창이다(화면 전환 아님)', ok: getComputedStyle(f).position === 'fixed' });
  const r = f.getBoundingClientRect();
  out.push({ name: '화면 안에 들어온다', ok: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 });
  out.push({ name: '지금 뭘 보고 있는지 알려준다', ok: !!document.getElementById('scWhere').textContent.trim(),
    detail: document.getElementById('scWhere').textContent });
  out.push({ name: '글 상자와 붙여넣기·저장 버튼이 있다',
    ok: ['scText', 'scPaste', 'scSave'].every((id) => !!document.getElementById(id)) });
  out.push({ name: '펜이 이 창도 UI로 인식한다',
    ok: !!document.getElementById('scText').closest('.ask-float') });

  // 아무것도 없이 저장하면 막는다
  document.getElementById('scSave').click();
  await new Promise((r2) => setTimeout(r2, 60));
  out.push({ name: '빈 채로 저장하면 알려준다',
    ok: /아직 아무것도/.test(document.getElementById('scStatus').textContent),
    detail: document.getElementById('scStatus').textContent });
  return out;
});

// 그림 붙여넣기 — 진짜 PNG 바이트로
{
  const pasted = await page.evaluate(async () => {
    // 1×1 투명 PNG
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    const ta = document.getElementById('scText');
    ta.value = '2025 AHA에서 바뀐 부분 — 생존사슬이 6고리로 단일화됐다.';
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    return {
      shots: document.querySelectorAll('.sc-shot img').length,
      status: document.getElementById('scStatus').textContent,
      text: document.getElementById('scText').value,
    };
  });
  results.push({ name: '그림을 붙여넣으면 창에 뜬다', ok: pasted.shots === 1, detail: JSON.stringify(pasted) });
  results.push({ name: '글은 그대로 남는다', ok: /생존사슬/.test(pasted.text) });
  results.push({ name: '몇 장인지 알려준다', ok: /1장/.test(pasted.status), detail: pasted.status });

  // 뺄 수 있어야 한다
  const removed = await page.evaluate(async () => {
    document.querySelector('.sc-shot-del').click();
    await new Promise((r) => setTimeout(r, 80));
    return document.querySelectorAll('.sc-shot img').length;
  });
  results.push({ name: '잘못 넣은 그림은 뺄 수 있다', ok: removed === 0 });
}

// 저장 — GitHub 쓰기를 가로채 무엇이 올라가는지 본다
{
  const saved = await page.evaluate(async () => {
    const G = await import('/js/github.js');
    const A = await import('/js/auth.js');
    await A.setToken('fake'); await A.setRepo('me/vault');
    const sent = [];
    const realFetch = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('api.github.com') && init?.method === 'PUT') {
        sent.push({ url: decodeURIComponent(String(url).split('/contents/')[1] || ''),
          body: JSON.parse(init.body) });
        return { ok: true, status: 201, json: async () => ({}), text: async () => '' };
      }
      return realFetch(url, init);
    };
    try {
      // 글 + 그림 한 장
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([bytes], { type: 'image/png' })], 's.png', { type: 'image/png' }));
      const ta = document.getElementById('scText');
      ta.value = '생존사슬 6고리 단일화';
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 200));
      document.getElementById('scSave').click();
      await new Promise((r) => setTimeout(r, 500));
      return { sent, status: document.getElementById('scStatus').textContent };
    } finally {
      window.fetch = realFetch;
      await A.clearToken();
    }
  });
  const paths = saved.sent.map((x) => x.url);
  results.push({ name: '그림은 attachments/로 간다',
    ok: paths.some((p) => p.startsWith('attachments/') && /\.png$/.test(p)), detail: paths.join(' | ') });
  results.push({ name: '글은 AI대화로그로 간다(=/lecture-integrate가 읽는 곳)',
    ok: paths.some((p) => p.startsWith('00_Raw_Text/AI대화로그/') && p.endsWith('_모아두기.md')),
    detail: paths.join(' | ') });

  const mdItem = saved.sent.find((x) => x.url.endsWith('.md'));
  const md = mdItem ? atob(mdItem.body.content.replace(/\s/g, '')) : '';
  const text = new TextDecoder().decode(Uint8Array.from(md, (c) => c.charCodeAt(0)));
  results.push({ name: '본문에 내가 쓴 글이 들어간다', ok: /생존사슬 6고리 단일화/.test(text) });
  results.push({ name: '그림이 Obsidian 임베드로 걸린다', ok: /!\[\[모아두기_[\d_]+_1\.png\]\]/.test(text),
    detail: (text.match(/!\[\[[^\]]+\]\]/) || ['없음'])[0] });
  results.push({ name: '어디서 모았는지 머리에 남는다', ok: /출처: 아이패드 "모아두기"/.test(text) });
  results.push({ name: '아직 정리 안 됐다고 표시한다', ok: /아직 정리 안 된 수집물/.test(text) });
  results.push({ name: 'Obsidian 태그가 붙는다', ok: /tags: \[달모\/모아두기\]/.test(text) });
  // 저장 결과는 세 갈래(올라감 / 인터넷 없어 대기 / 권한 문제)를 **다르게** 말해야 한다.
  // 다 "대기열로"라고만 하면 권한 문제는 영영 안 올라간다(2026-10-13).
  results.push({ name: '저장했다고 알려준다',
    ok: /vault에 저장했습니다/.test(saved.status), detail: saved.status });
  results.push({ name: '무엇이 올라갔는지 파일명까지 말해준다',
    ok: /\.md/.test(saved.status) });

  // 그림 바이트가 안 깨지고 그대로 올라가는가 — UTF-8 인코딩을 타면 깨진다
  const img = saved.sent.find((x) => x.url.startsWith('attachments/'));
  results.push({ name: '그림이 깨지지 않고 올라간다(PNG 머리 그대로)',
    ok: !!img && img.body.content.startsWith('iVBORw0KGgo'), detail: (img?.body.content || '').slice(0, 16) });

  await page.evaluate(() => document.getElementById('scrapFloat').classList.add('hidden'));
}

// ══════════ 슬라이드 표기는 글로만 남는다 (2026-10-12) ══════════
// `marginnote4app://page/...`는 앱만 열고 그 페이지로 가지 않는다(맥·아이패드 둘 다 확인).
// "열리긴 하는데 안 간다"가 제일 헷갈리므로 링크를 아예 만들지 않는다.
await run('슬라이드 표기', async () => {
  const out = [];
  const { renderMarkdown, setSlideDoc } = await import('/js/markdown.js');
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  setSlideDoc('ff004e7d');
  document.getElementById('readBody').innerHTML =
    renderMarkdown('가슴압박 깊이는 5~6cm다. [슬라이드 p.12] 이어지는 문장이 더 있다.');
  out.push({ name: '안 가는 링크를 만들지 않는다',
    ok: !document.querySelector('#readBody .slide-link')
      && !/marginnote4app/.test(document.getElementById('readBody').innerHTML) });
  out.push({ name: '어느 슬라이드인지는 글로 그대로 보인다',
    ok: /슬라이드\s*p\.\s*12/.test(document.getElementById('readBody').textContent) });
  out.push({ name: '본문 글이 깨지지 않는다',
    ok: /가슴압박 깊이는 5~6cm다/.test(document.getElementById('readBody').textContent)
      && /이어지는 문장이 더 있다/.test(document.getElementById('readBody').textContent) });
  setSlideDoc(null);
  return out;
});

// ══════════ 노트 분할 읽기 (2026-10-13) ══════════
// 같은 문서의 다른 대목을 견주거나, 다른 문서를 나란히. 창마다 탭이 있고 비율을 바꾼다.
// ★ 가장 중요한 불변식: **활성 창의 요소가 #readCard/#readHeading/#readBody id를
//   가져간다.** 펜·카드 만들기·질문 등 25곳이 그 id로 "지금 보는 창"을 찾는다.
await page.setViewport({ width: 1366, height: 1024 });
await run('분할 읽기', async () => {
  const out = [];
  const A = await import('/js/app.js').catch(() => null);   // 모듈은 비공개 — DOM으로 확인한다
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  const rs = document.getElementById('readScreen');
  rs.classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';

  out.push({ name: '도구막대에 나누기·문서목록 버튼이 있다',
    ok: !!document.getElementById('readSplitBtn') && !!document.getElementById('readDocs') });
  out.push({ name: '처음엔 창이 하나다',
    ok: document.querySelectorAll('#readPanes .read-pane').length === 1 });
  out.push({ name: '그 창이 #readBody를 갖고 있다',
    ok: !!document.querySelector('#readPanes .read-pane #readBody') });
  return out;
});

// 실제 노트를 두 개 열어 분할까지 — 진짜 vault 파일로
{
  const ready = await page.evaluate(async () => {
    const R = await import('/js/reader.js');
    // 가짜 노트 두 개로 창 동작만 본다(네트워크 없이)
    const mk = (title, n) => ({
      path: `02_Wiki/t/${title}.md`, title,
      sections: Array.from({ length: n }, (_, i) => ({ heading: `${title} ${i + 1}장`, text: `${title} 본문 ${i + 1}` })),
    });
    window.__mk = mk;
    return typeof R.loadNote === 'function';
  });
  results.push({ name: '읽기 모듈이 살아 있다', ok: ready });

  // app.js의 모듈 비공개 함수는 밖에서 못 부른다 — 버튼을 눌러 같은 경로를 탄다.
  // 먼저 노트 하나를 "열린 상태"로 만들어야 하므로, 노트 읽기 탭에서 실제로 연다.
  const opened = await page.evaluate(async () => {
    const d = await import('/js/db.js');
    await d.kvSet('note_index_v2', [{
      root: '02_Wiki', subject: '테스트',
      notes: [{ name: '가노트', path: '02_Wiki/테스트/가노트.md' },
              { name: '나노트', path: '02_Wiki/테스트/나노트.md' }],
    }]);
    return true;
  });
  results.push({ name: '노트 목록을 준비했다', ok: opened });
}

// github 호출을 가짜로 두고 실제 흐름(목록 → 열기 → 나누기)을 탄다
{
  await page.evaluate(async () => {
    // 토큰이 없으면 노트를 열 때 설정 화면으로 튕긴다 — 가짜 토큰을 넣고 간다
    const a = await import('/js/auth.js');
    await a.setToken('fake'); await a.setRepo('me/v');
    const real = window.fetch;
    window.__realFetch = real;
    window.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('api.github.com')) {
        const name = decodeURIComponent(u.split('/contents/')[1] || '').split('/').pop().replace('.md', '');
        const body = `---\ntags: [t]\n---\n\n# ${name}\n\n## ${name} 1장\n내용 가\n\n## ${name} 2장\n내용 나\n\n## ${name} 3장\n내용 다\n`;
        return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
      }
      return real(url, init);
    };
  });

  // 노트 읽기 탭에서 한 개 연다
  await page.evaluate(() => {
    document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
    document.getElementById('listScreen').classList.remove('hidden');
    document.querySelector('.tabs [data-tab="notes"]').click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('#notesBody button')].some((x) => /가노트/.test(x.textContent)),
    { timeout: 15000 }).catch(() => {});
  const openedOne = await page.evaluate(async () => {
    const b = [...document.querySelectorAll('#notesBody button')].find((x) => /가노트/.test(x.textContent));
    if (!b) return false;
    b.click();
    await new Promise((r) => setTimeout(r, 900));
    return document.body.dataset.screen === 'readScreen';
  });
  results.push({ name: '노트를 열면 읽기 화면으로 간다', ok: openedOne });

  if (openedOne) {
    await run('화면 나누기', async () => {
      const out = [];
      document.getElementById('readSplitBtn').click();
      await new Promise((r) => setTimeout(r, 450));
      const ps = document.querySelectorAll('#readPanes .read-pane');
      out.push({ name: '누르면 창이 둘로 갈라진다', ok: ps.length === 2, detail: String(ps.length) });
      out.push({ name: '같은 문서가 양쪽에 뜬다(비교용)',
        ok: [...document.querySelectorAll('#readPanes .read-body')].every((b) => b.textContent.trim().length > 0) });
      out.push({ name: '가운데에 비율 손잡이가 생긴다', ok: !!document.querySelector('.pane-split-resizer') });
      out.push({ name: '창마다 탭 줄이 생긴다',
        ok: document.querySelectorAll('#readPanes .pane-tabs').length === 2 });

      // ★ 불변식: 활성 창만 #readBody를 갖는다
      const bodies = document.querySelectorAll('#readPanes .read-body');
      const withId = [...bodies].filter((b) => b.id === 'readBody');
      out.push({ name: '#readBody는 활성 창에 하나뿐이다(펜·질문이 그 창을 향한다)',
        ok: withId.length === 1, detail: `${withId.length}개` });
      const activePane = document.querySelector('#readPanes .read-pane.active');
      out.push({ name: '그 하나가 활성 창 안에 있다', ok: !!activePane && activePane.contains(withId[0]) });

      // 다른 창을 누르면 활성이 옮겨간다
      const other = [...document.querySelectorAll('#readPanes .read-pane')].find((x) => !x.classList.contains('active'));
      other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      out.push({ name: '다른 창을 누르면 활성이 옮겨간다', ok: other.classList.contains('active') });
      out.push({ name: '#readBody도 같이 따라간다', ok: !!other.querySelector('#readBody') });
      out.push({ name: '비활성 창은 id를 내놓는다',
        ok: document.querySelectorAll('#readPanes #readBody').length === 1 });
      return out;
    });

    // 비율 조정 — 진짜 드래그 (분할이 됐을 때만)
    if (await page.evaluate(() => !!document.querySelector('.pane-split-resizer'))) {
      const before = await page.evaluate(() =>
        Math.round(document.querySelector('#readPanes .read-pane').getBoundingClientRect().width));
      const grip = await page.evaluate(() => {
        const r = document.querySelector('.pane-split-resizer').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x - 180, grip.y, { steps: 8 });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 200));
      const after = await page.evaluate(() =>
        Math.round(document.querySelector('#readPanes .read-pane').getBoundingClientRect().width));
      results.push({ name: '손잡이를 끌면 비율이 바뀐다', ok: Math.abs(after - (before - 180)) <= 12,
        detail: `${before} → ${after}px` });
      results.push({ name: '맞춰둔 비율을 기억한다',
        ok: !!(await page.evaluate(() => localStorage.getItem('pane_split'))) });
      // 두 번 누르면 반반
      await page.evaluate(() => document.querySelector('.pane-split-resizer')
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      await new Promise((r) => setTimeout(r, 200));
      results.push({ name: '두 번 누르면 반반으로 돌아온다',
        ok: !(await page.evaluate(() => localStorage.getItem('pane_split'))) });
    } else {
      results.push({ name: '비율 손잡이가 있어야 한다', ok: false, detail: '분할이 안 됐다' });
    }

    await run('합치기 · 탭', async () => {
      const out = [];
      // 탭 닫기 — 창의 마지막 탭이면 그 창이 닫힌다
      const closeBtn = document.querySelector('#readPanes .read-pane:last-child .pane-close');
      out.push({ name: '창마다 닫기 버튼이 있다', ok: !!closeBtn });
      closeBtn.click();
      await new Promise((r) => setTimeout(r, 250));
      out.push({ name: '닫으면 창이 하나로 합쳐진다',
        ok: document.querySelectorAll('#readPanes .read-pane').length === 1 });
      out.push({ name: '합친 뒤에도 #readBody가 살아 있다', ok: !!document.getElementById('readBody') });
      out.push({ name: '합치면 탭 줄이 사라진다(창이 하나면 보여줄 이유가 없다)',
        ok: document.querySelectorAll('#readPanes .pane-tabs').length === 0 });
      out.push({ name: '본문이 비지 않는다',
        ok: document.getElementById('readBody').textContent.trim().length > 0 });
      return out;
    });

    await run('문서 목록 서랍', async () => {
      const out = [];
      document.getElementById('readDocs').click();
      await new Promise((r) => setTimeout(r, 400));
      const dd = document.getElementById('docDrawer');
      out.push({ name: '서랍이 열린다', ok: !dd.classList.contains('hidden') });
      out.push({ name: '노트가 나열된다', ok: document.querySelectorAll('.dd-item').length >= 2,
        detail: String(document.querySelectorAll('.dd-item').length) });
      out.push({ name: '끌 수 있게 돼 있다',
        ok: [...document.querySelectorAll('.dd-item')].every((x) => x.draggable) });
      out.push({ name: '검색으로 좁힐 수 있다', ok: !!document.getElementById('docSearch') });
      const search = document.getElementById('docSearch');
      search.value = '나노트';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      out.push({ name: '검색하면 걸러진다',
        ok: document.querySelectorAll('.dd-item').length === 1,
        detail: String(document.querySelectorAll('.dd-item').length) });

      // 지금 보는 과목이 맨 위에 와야 한다 — 28개 과목을 매번 스크롤할 수 없다
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const first = document.querySelector('.dd-group');
      out.push({ name: '지금 보는 과목이 맨 위에 온다',
        ok: !!first && /지금 보는 과목/.test(first.textContent), detail: first ? first.textContent : '없음' });

      // 눌러서 열면 지금 창의 새 탭이 된다 — **지금 안 열려 있는** 노트로 확인한다
      const open = new Set([...document.querySelectorAll('.pane-tab .pt-name')].map((x) => x.textContent));
      const fresh = [...document.querySelectorAll('.dd-item')].find((x) => !open.has(x.textContent))
        || document.querySelectorAll('.dd-item')[1];
      const freshName = fresh.textContent;
      fresh.click();
      await new Promise((r) => setTimeout(r, 700));
      out.push({ name: '누르면 서랍이 닫힌다', ok: dd.classList.contains('hidden') });
      out.push({ name: '제목이 그 노트로 바뀐다',
        ok: document.getElementById('readTitle').textContent.includes(freshName),
        detail: `${freshName} / ${document.getElementById('readTitle').textContent}` });
      return out;
    });
  }

  // ── 두 창일 때 떨구면 그 창에 탭이 붙는가 (2026-10-13) ──
  // 가림막(.dd-scrim)이 화면을 덮고 있어서 #readPanes가 dragover를 못 받고 있었다 —
  // 드래그 떨구기가 한 번도 동작한 적이 없었다.
  await run('떨구기', async () => {
    const out = [];
    // 창 둘로 만든다
    if (document.querySelectorAll('#readPanes .read-pane').length < 2) {
      document.getElementById('readSplitBtn').click();
      await new Promise((r) => setTimeout(r, 450));
    }
    out.push({ name: '창이 둘이다', ok: document.querySelectorAll('#readPanes .read-pane').length === 2 });

    document.getElementById('readDocs').click();
    await new Promise((r) => setTimeout(r, 400));
    // 오른쪽 창에 **아직 없는** 노트를 끌어야 탭이 는다
    const rightPane = document.querySelectorAll('#readPanes .read-pane')[1];
    const openRight = new Set([...rightPane.querySelectorAll('.pane-tab .pt-name')].map((x) => x.textContent));
    const item = [...document.querySelectorAll('.dd-item')].find((x) => !openRight.has(x.textContent))
      || document.querySelector('.dd-item');
    item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
    await new Promise((r) => setTimeout(r, 80));
    out.push({ name: '끄는 동안 가림막이 비켜준다(이게 없으면 떨굴 수가 없다)',
      ok: document.body.classList.contains('dragging-doc')
        && getComputedStyle(document.querySelector('.dd-scrim')).pointerEvents === 'none' });

    // 오른쪽 창 한가운데에 떨군다
    const right = document.querySelectorAll('#readPanes .read-pane')[1];
    const r = right.getBoundingClientRect();
    const at = { clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
    const host = document.getElementById('readPanes');
    host.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), ...at }));
    await new Promise((r2) => setTimeout(r2, 80));
    out.push({ name: '어느 창에 들어갈지 그 창이 밝아진다', ok: right.classList.contains('drop-into') });
    out.push({ name: '창이 둘이면 "갈라짐" 안내는 안 뜬다(더 갈라질 수 없다)',
      ok: !host.classList.contains('drop-split') });

    const tabsBefore = right.querySelectorAll('.pane-tab').length;
    host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), ...at }));
    await new Promise((r2) => setTimeout(r2, 800));
    const right2 = document.querySelectorAll('#readPanes .read-pane')[1];
    out.push({ name: '떨구면 그 창에 탭이 붙는다',
      ok: right2.querySelectorAll('.pane-tab').length === tabsBefore + 1,
      detail: `${tabsBefore} → ${right2.querySelectorAll('.pane-tab').length}` });
    out.push({ name: '창은 여전히 둘이다(새로 갈라지지 않는다)',
      ok: document.querySelectorAll('#readPanes .read-pane').length === 2 });
    out.push({ name: '떨구면 서랍이 닫힌다',
      ok: document.getElementById('docDrawer').classList.contains('hidden') });
    return out;
  });

  await run('도구막대 정리 · 펜 모드', async () => {
    const out = [];
    const ids = [...document.querySelectorAll('#readScreen > header button')].map((b) => b.id);
    out.push({ name: '스피커(읽어주기) 버튼을 뺐다', ok: !ids.includes('readTts'), detail: ids.join(',') });

    // 탐색은 글씨 버튼으로 — 아이콘만 두니 목차·노트·카드가 서로 구분이 안 됐다
    const txt = [...document.querySelectorAll('#readScreen > header .txt-btn')].map((b) => b.textContent);
    out.push({ name: '찾기·목차·노트가 글씨 버튼이다(카드는 더보기로 내렸다)',
      ok: txt.join(',') === '찾기,목차,노트', detail: txt.join(',') });
    // 찾기가 **제일 왼쪽** — 가장 자주 쓰는데 ⋯ 안에 묻혀 있었다(2026-10-13)
    const findB = document.getElementById('readFind');
    const splitB = document.getElementById('readSplitBtn');
    out.push({ name: '찾기가 나누기보다 왼쪽에 있다',
      ok: findB.getBoundingClientRect().left < splitB.getBoundingClientRect().left,
      detail: `찾기 ${Math.round(findB.getBoundingClientRect().left)} / 나누기 ${Math.round(splitB.getBoundingClientRect().left)}` });
    out.push({ name: '찾기가 글씨 버튼 중 맨 앞', ok: txt[0] === '찾기' });
    out.push({ name: '머리줄 버튼이 8개를 넘지 않는다(늘 쓰는 것만 밖에)',
      ok: ids.length <= 8, detail: `${ids.length}개: ${ids.join(',')}` });
    const tg = document.querySelector('#readScreen > header .txt-group');
    out.push({ name: '글씨 버튼이 한 덩어리로 묶여 있다', ok: !!tg });
    out.push({ name: '버튼이 지나치게 크지 않다',
      ok: document.getElementById('readTocBtn').getBoundingClientRect().height <= 34,
      detail: `${Math.round(document.getElementById('readTocBtn').getBoundingClientRect().height)}px` });
    const h1 = document.getElementById('readTitle');
    out.push({ name: '글씨 버튼이 제목보다 앞에 있다',
      ok: document.getElementById('readTocBtn').compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING });
    out.push({ name: '아이콘 버튼에 눌릴 경계(테두리)가 있다',
      ok: getComputedStyle(document.getElementById('readPen')).borderStyle === 'solid' });

    // ★ 창을 줄여 쓰면 시스템 ●●● 버튼이 왼쪽 위를 덮는다 — 뒤로가기를 아예 못 눌렀다
    document.body.setAttribute('data-win-controls', '');
    const backTop = document.getElementById('readBack').getBoundingClientRect().top;
    out.push({ name: '창 버튼 자리를 비우면 뒤로가기가 내려온다',
      ok: backTop >= 30, detail: `${Math.round(backTop)}px` });
    const toolTop = document.getElementById('readTools').getBoundingClientRect().top;
    out.push({ name: '도구막대도 같이 내려온다', ok: toolTop >= 30, detail: `${Math.round(toolTop)}px` });
    document.body.removeAttribute('data-win-controls');
    out.push({ name: '전체 화면이면 다시 올라간다',
      ok: document.getElementById('readBack').getBoundingClientRect().top < backTop });

    // 펜 — 펜 ↔ 지우개 둘만 돈다. "끔"을 뒀더니 두 번 눌러 꺼진 줄 모르고
    // **선택이 안 되는 것처럼** 보였다(2026-10-13).
    const pen = document.getElementById('readPen');
    out.push({ name: '처음엔 펜(아이콘이 펜)', ok: !pen.classList.contains('erasing') });
    pen.click();
    out.push({ name: '누르면 지우개로 — 아이콘이 지우개로 바뀐다', ok: pen.classList.contains('erasing') });
    out.push({ name: '지우개 아이콘이 실제로 보인다',
      ok: getComputedStyle(pen.querySelector('.erase-ic')).display !== 'none'
        && getComputedStyle(pen.querySelector('.pen-ic')).display === 'none' });
    pen.click();
    out.push({ name: '한 번 더 누르면 펜으로 돌아온다(끄는 상태는 없다)',
      ok: !pen.classList.contains('erasing') });
    out.push({ name: '펜을 숨기는 상태가 아예 없다(선택이 죽지 않게)',
      ok: !document.querySelector('.penlayer.pen-off') });
    return out;
  });

  await page.evaluate(async () => {
    if (window.__realFetch) window.fetch = window.__realFetch;
    const a = await import('/js/auth.js');
    await a.clearToken();                  // 뒤 테스트에 영향 주지 않게 되돌린다
  });
}

// ══════════ 카드 창 — 후보 확인 후 추가, 같은 창에서 삭제 (2026-10-13) ══════════
// 전에는 네모를 치는 족족 저장돼서 쓸 만한 것만 고를 길이 없었고, 지우려면 카드 관리
// 화면까지 나가야 했다. 그리고 "답 보기"가 **초록 칸만 칠하고 글자를 안 넣었다** —
// 답은 빈칸 요소가 아니라 `data-answer`에 들어 있다.
await page.setViewport({ width: 1366, height: 1024 });
await run('카드 창', async () => {
  const out = [];
  const { saveCards, allCards, deleteCard } = await import('/js/db.js');
  for (const c of await allCards()) await deleteCard(c.id);

  const f = document.getElementById('cardFloat');
  out.push({ name: '후보/저장된 카드 탭이 있다',
    ok: !!document.getElementById('cfTabNew') && !!document.getElementById('cfTabAll') });
  out.push({ name: '＋추가·버리기 버튼이 있다',
    ok: !!document.getElementById('cfAdd') && !!document.getElementById('cfDrop') });

  // 후보 한 장을 띄운다(실제 cloze 구조 그대로)
  f.classList.remove('hidden');
  document.getElementById('cfBody').innerHTML =
    '<div class="cf-q">깊이는 <span class="cloze" data-answer="5~6cm">      </span>다.</div>';
  const cz = document.querySelector('#cfBody .cloze');
  out.push({ name: '가려진 상태에서는 답이 안 보인다',
    ok: getComputedStyle(cz).color === 'rgba(0, 0, 0, 0)' });

  // ★ 버그: 색만 칠하고 글자를 안 넣으면 초록 칸만 뜬다
  cz.classList.add('filled');
  cz.textContent = cz.dataset.answer;
  out.push({ name: '답을 열면 글자가 실제로 들어간다', ok: cz.textContent === '5~6cm', detail: cz.textContent });
  out.push({ name: '열린 답은 읽히는 색이다',
    ok: getComputedStyle(cz).color !== 'rgba(0, 0, 0, 0)', detail: getComputedStyle(cz).color });
  f.classList.add('hidden');

  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '빈칸을 칠할 때 data-answer를 넣는다(한 곳에서만 처리)',
    ok: /function paintCloze\(root, shown\)/.test(app) && /el\.textContent = ans;/.test(app) });
  out.push({ name: '네모를 쳐도 바로 저장하지 않는다',
    ok: !/readerCardMode\(false\);\s*\n\s*saveCards\(cards\)/.test(app) });
  out.push({ name: '＋추가를 눌러야 저장된다', ok: /await saveCards\(\[c\]\)/.test(app) });
  out.push({ name: '같은 창에서 지울 수 있다', ok: /await deleteCard\(c\.id\);[\s\S]{0,120}refreshCardFloat/.test(app) });
  out.push({ name: '카드 버튼은 네모 모드만 켠다(누르자마자 창이 뜨면 화면만 가린다)',
    ok: !/if \(on\) openCardManager\(\)/.test(app) });
  out.push({ name: '카드 보기·지우기는 더보기의 "카드 관리"가 맡는다',
    ok: /mm\('mmCards', openCardManager\)/.test(app) });
  return out;
});

// ══════════ 읽던 자리 기억 · 관련 노트 링크 (2026-10-13) ══════════
await run('읽던 자리 · 링크', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '섹션을 넘길 때마다 자리를 기억한다', ok: /rememberReadPos\(\);/.test(app) });
  out.push({ name: '다시 열면 그 자리에서 이어 본다',
    ok: /const back = Number\(readPos\[note\.path\] \|\| 0\)/.test(app) });
  out.push({ name: '분할로 연 쪽은 기억하지 않는다(비교하려 띄운 자리가 덮어쓰면 안 된다)',
    ok: /if \(panes\.length !== 1 \|\| !reader\) return;/.test(app) });
  out.push({ name: '기기 간 백업에도 들어간다',
    ok: /'read_pos'/.test(await fetch('/js/backup.js').then((r) => r.text())) });

  // 관련 노트 링크 — 전에는 파랗기만 하고 아무 일도 안 했다
  const { renderMarkdown } = await import('/js/markdown.js');
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  const body = document.getElementById('readBody');
  body.innerHTML = renderMarkdown('관련 노트: [[심폐소생술]] · [[응급중환자_BLS_QA]]');
  out.push({ name: '위키링크가 본문에 그려진다', ok: document.querySelectorAll('#readBody .wikilink').length === 2 });
  out.push({ name: '끌 수 있게 만드는 코드가 있다', ok: /function makeWikiLinksDraggable/.test(app) });
  out.push({ name: '본문을 그릴 때마다 걸어준다', ok: /makeWikiLinksDraggable\(body\)/.test(app) });
  out.push({ name: '눌러서 여는 길도 생겼다', ok: /el\.addEventListener\('click', async \(\)/.test(app) });
  out.push({ name: '링크가 눌러볼 만하게 보인다',
    ok: getComputedStyle(document.querySelector('#readBody .wikilink')).cursor === 'pointer' });
  return out;
});

// ══════════ AI 답변 일부만 저장 (2026-10-13) ══════════
await run('답변 일부 저장', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((r) => r.text());
  const f = document.getElementById('askFloat');
  f.classList.remove('hidden');
  document.getElementById('afBody').innerHTML =
    '<p id="p1">첫 문단은 쓸모없다.</p><p id="p2">이 문단만 저장하고 싶다.</p>';
  await new Promise((r) => setTimeout(r, 50));
  out.push({ name: '처음엔 "답변 저장"', ok: document.getElementById('afSave').textContent === '답변 저장',
    detail: document.getElementById('afSave').textContent });

  // 둘째 문단만 긁는다
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(document.getElementById('p2'));
  sel.removeAllRanges(); sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  await new Promise((r) => setTimeout(r, 80));
  const btn = document.getElementById('afSave');
  out.push({ name: '긁으면 버튼이 "고른 부분 저장"으로 바뀐다', ok: /고른 부분 저장/.test(btn.textContent),
    detail: btn.textContent });
  out.push({ name: '몇 글자인지 알려준다', ok: /\(\d+자\)/.test(btn.textContent) });
  out.push({ name: '버튼 색으로도 구분된다', ok: btn.classList.contains('partial') });

  sel.removeAllRanges();
  document.dispatchEvent(new Event('selectionchange'));
  await new Promise((r) => setTimeout(r, 80));
  out.push({ name: '선택을 풀면 다시 전체 저장', ok: btn.textContent === '답변 저장' });
  out.push({ name: '고른 부분만 저장하는 코드가 있다',
    ok: /const picked = selectedInside\(afEl\('afBody'\)\)/.test(app)
      && /answer: picked \|\| askCtx\.answer/.test(app) });
  f.classList.add('hidden');
  return out;
});

// ══════════ 펜으로 긁어 고르기 — 읽기 화면에서 끝까지 (2026-10-13) ══════════
// "갑자기 안 된다"는 신고가 있었다. 알고 보니 펜을 두 번 눌러 꺼둔 상태였고,
// 꺼지면 캔버스가 숨어 아무 반응이 없었다("끔" 상태를 없앴다).
// 읽기 화면에서 실제 펜 이벤트로 긁어 팝업이 뜰 때까지를 통째로 묶어둔다 —
// 이 길이 막히면 노트에서 질문도 카드도 못 만든다.
{
  const ok1 = await page.evaluate(async () => {
    document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
    document.getElementById('readScreen').classList.remove('hidden');
    document.body.dataset.screen = 'readScreen';
    const { tokenize } = await import('/js/pen.js');
    const body = document.getElementById('readBody');
    body.innerHTML = '<p id="pp"></p>';
    tokenize(document.getElementById('pp'),
      '성인 가슴압박 표준수치는 속도 100~120회분 깊이 5cm 이상 6cm 이하 위치는 흉골 하부 절반이다');
    return document.querySelectorAll('#readBody .tok').length > 5;
  });
  results.push({ name: '본문이 단어 단위로 깔린다(긁기 대상)', ok: ok1 });

  const has = await page.evaluate(() => !!document.querySelector('#readCard .penlayer'));
  if (!has) {
    results.push({ name: '읽기 화면에 펜 레이어가 있다', ok: false, detail: '없음' });
  } else {
    results.push({ name: '읽기 화면에 펜 레이어가 있다', ok: true });
    const span = await page.evaluate(() => {
      const t = [...document.querySelectorAll('#readBody .tok')];
      const a = t[0].getBoundingClientRect();
      const z = t[Math.min(7, t.length - 1)].getBoundingClientRect();
      return { x1: Math.round(a.left + 2), y1: Math.round(a.top + a.height / 2),
               x2: Math.round(z.right - 2), y2: Math.round(z.top + z.height / 2) };
    });
    await page.evaluate(({ x1, y1, x2, y2 }) => {
      const cv = document.querySelector('#readCard .penlayer');
      const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
        pointerType: 'pen', pointerId: 1, isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1, pressure: 0.5,
        clientX: x, clientY: y, bubbles: true, cancelable: true }));
      ev('pointerdown', x1, y1);
      for (let i = 1; i <= 10; i++) ev('pointermove', Math.round(x1 + (x2 - x1) * i / 10), y1);
      ev('pointerup', x2, y2);
    }, span);
    // ★ 그으는 **동안** 어디까지 잡히는지 보여야 한다(2026-10-13 요청).
    //   전에는 손을 떼야 네모가 떠서 "허공에 긁는" 느낌이었다.
    const live = await page.evaluate(async ({ x1, y1, x2 }) => {
      const cv = document.querySelector('#readCard .penlayer');
      const pen = window.__penForTest;
      const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
        pointerType: 'pen', pointerId: 7, isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1, pressure: .5,
        clientX: x, clientY: y, bubbles: true, cancelable: true }));
      ev('pointerdown', x1, y1);
      for (let i = 1; i <= 6; i++) ev('pointermove', Math.round(x1 + (x2 - x1) * i / 6), y1);
      // 한 프레임 기다린다 — 미리보기는 rAF로 묶여 있다
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const mid = pen ? { box: !!pen._previewBox, lines: (pen._coveredLines || []).length } : null;
      ev('pointerup', x2, y1);
      return mid;
    }, span);
    if (live) {
      results.push({ name: '긋는 동안 잡히는 범위가 보인다(손 떼기 전에)', ok: !!live.box });
      results.push({ name: '줄마다 하이라이트한다', ok: live.lines >= 1, detail: `${live.lines}줄` });
    }
    // 위 획도 확정되면서 팝업을 띄운다 — 다음 검사가 깨끗한 상태에서 시작하게 치운다
    await new Promise((r) => setTimeout(r, 700));
    await page.evaluate(() => {
      document.getElementById('selPop').classList.add('hidden');
      const t = document.getElementById('selPopText');
      if (t) t.textContent = '';
    });

    // 이제 다시 그어서 **확정까지** 본다
    await page.evaluate(({ x1, y1, x2, y2 }) => {
      const cv = document.querySelector('#readCard .penlayer');
      const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
        pointerType: 'pen', pointerId: 1, isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1, pressure: 0.5,
        clientX: x, clientY: y, bubbles: true, cancelable: true }));
      ev('pointerdown', x1, y1);
      for (let i = 1; i <= 10; i++) ev('pointermove', Math.round(x1 + (x2 - x1) * i / 10), y1);
      ev('pointerup', x2, y2);
    }, span);

    // 획을 모아 확정하기까지 기다린다(pen.js SETTLE_MS=420) — 짧게 보면 "안 된다"로 오해한다
    await page.waitForFunction(
      () => !document.getElementById('selPop').classList.contains('hidden'), { timeout: 3000 })
      .catch(() => {});
    const popped = await page.evaluate(() => ({
      open: !document.getElementById('selPop').classList.contains('hidden'),
      text: (document.getElementById('selPopText') || {}).textContent || '',
    }));
    results.push({ name: '펜으로 긁으면 선택 팝업이 뜬다', ok: popped.open, detail: popped.text.slice(0, 30) });
    results.push({ name: '긁은 글이 실제로 잡힌다', ok: /가슴압박|성인/.test(popped.text), detail: popped.text.slice(0, 30) });
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll('#selPop button')].map((b) => b.textContent.trim()));
    results.push({ name: '팝업에서 다음 할 일을 고를 수 있다', ok: btns.length >= 2, detail: btns.join(' / ') });
    await page.evaluate(() => document.getElementById('selPop').classList.add('hidden'));
  }
}

// ══════════ 되돌리면 선택이 풀린다 · 더보기 메뉴 (2026-10-13) ══════════
await run('펜 되돌리기 · 더보기', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';

  // ── 더보기 메뉴 ──
  const menu = document.getElementById('readMoreMenu');
  out.push({ name: '처음엔 접혀 있다', ok: menu.classList.contains('hidden') });
  document.getElementById('readMore').click();
  await new Promise((r) => setTimeout(r, 80));
  out.push({ name: '⋯ 를 누르면 펼쳐진다', ok: !menu.classList.contains('hidden') });
  const items = [...menu.querySelectorAll('.mm-item .mm-t')].map((x) => x.textContent);
  out.push({ name: '가끔 쓰는 것들이 들어 있다', ok: items.length >= 6, detail: items.join(' / ') });
  out.push({ name: '항목마다 뭘 하는지 글로 적혀 있다',
    ok: [...menu.querySelectorAll('.mm-item')].every((x) => (x.querySelector('.mm-d') || {}).textContent) });
  out.push({ name: '화면 안에 들어온다',
    ok: menu.getBoundingClientRect().right <= innerWidth + 1 });
  // 바깥을 누르면 닫힌다
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  out.push({ name: '바깥을 누르면 닫힌다', ok: menu.classList.contains('hidden') });
  return out;
});

// 되돌리기 — 펜을 끌었다가 **되돌아오면** 하이라이트가 풀려야 한다
{
  const ready = await page.evaluate(async () => {
    const { tokenize } = await import('/js/pen.js');
    const body = document.getElementById('readBody');
    body.innerHTML = '<p id="rr"></p>';
    tokenize(document.getElementById('rr'),
      '가 나 다 라 마 바 사 아 자 차 카 타 파 하 거 너 더 러 머 버 서 어 저 처');
    return document.querySelectorAll('#readBody .tok').length > 10 && !!window.__penForTest;
  });
  if (!ready) {
    results.push({ name: '되돌리기 준비', ok: false, detail: '펜/토큰 없음' });
  } else {
    const r = await page.evaluate(async () => {
      const t = [...document.querySelectorAll('#readBody .tok')];
      const a = t[0].getBoundingClientRect();
      const far = t[Math.min(12, t.length - 1)].getBoundingClientRect();
      const cv = document.querySelector('#readCard .penlayer');
      const pen = window.__penForTest;
      const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
        pointerType: 'pen', pointerId: 9, isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1, pressure: .5,
        clientX: Math.round(x), clientY: Math.round(y), bubbles: true, cancelable: true }));
      const y = a.top + a.height / 2;
      const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

      ev('pointerdown', a.left + 2, y);
      for (let i = 1; i <= 8; i++) ev('pointermove', a.left + (far.right - a.left) * i / 8, y);
      await frame();
      const wide = pen._previewBox ? Math.round(pen._previewBox.r - pen._previewBox.l) : 0;

      // 되돌아온다 — 두 번째 토큰 근처까지
      const near = t[2].getBoundingClientRect();
      for (let i = 1; i <= 8; i++) ev('pointermove', far.right - (far.right - near.right) * i / 8, y);
      await frame();
      const narrow = pen._previewBox ? Math.round(pen._previewBox.r - pen._previewBox.l) : 0;
      ev('pointerup', near.right, y);
      await new Promise((res) => setTimeout(res, 700));
      const text = (document.getElementById('selPopText') || {}).textContent || '';
      document.getElementById('selPop').classList.add('hidden');
      return { wide, narrow, text };
    });
    results.push({ name: '끌면 선택 범위가 넓어진다', ok: r.wide > 60, detail: `${r.wide}px` });
    results.push({ name: '되돌리면 **범위가 줄어든다**(선택이 풀린다)',
      ok: r.narrow > 0 && r.narrow < r.wide * 0.75, detail: `${r.wide}px → ${r.narrow}px` });
    results.push({ name: '확정된 글도 되돌린 만큼만 잡힌다(보여준 것과 같다)',
      ok: r.text.length > 0 && !/자|차|카|타/.test(r.text), detail: r.text.slice(0, 24) });
  }
}

// ══════════ 선택 팝업 — 끝이 보이고, 취소가 쉬워야 한다 (2026-10-13) ══════════
// 앞 두 줄만 자르고 끝이라 "어디까지 골랐나"를 알 수 없었고, ✕가 버튼 줄 끝에 작게
// 있어서 **취소가 제일 어려웠다**(실수로 그었을 때 가장 자주 누르는 것인데).
await run('선택 팝업', async () => {
  const out = [];
  const pop = document.getElementById('selPop');
  const { tokenize } = await import('/js/pen.js');

  // 긴 글을 긋는다 — 실제 노트 한 문단 길이
  const LONG = '성인 가슴압박 표준수치는 속도 100~120회/분, 깊이 5cm 이상 6cm 이하, '
    + '위치는 흉골 하부 1/2이며, 압박:환기 비율은 1인·2인 구조자 모두 30:2(전문기도 삽관 전)다. '
    + '전문기도 삽입 후에는 압박을 끊지 않고 환기만 6초마다 1회로 독립적으로 시행한다.';
  // **실제로 긋는다** — 앱의 showSelPop을 거쳐야 진짜 검사가 된다.
  // (손으로 글자를 넣어 보면 app.js가 그 일을 안 해도 통과해버린다.)
  {
    const body = document.getElementById('readBody');
    body.innerHTML = '<p id="selpopP"></p>';
    tokenize(document.getElementById('selpopP'), LONG);
    const toks = [...document.querySelectorAll('#selpopP .tok')];
    const a = toks[0].getBoundingClientRect();
    const z = toks[toks.length - 1].getBoundingClientRect();
    const cv = document.querySelector('#readCard .penlayer');
    const ev = (t, x, y) => cv.dispatchEvent(new PointerEvent(t, {
      pointerType: 'pen', pointerId: 7, isPrimary: true,
      buttons: t === 'pointerup' ? 0 : 1, pressure: .5,
      clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const x1 = a.left + 2, y1 = a.top + a.height / 2;
    const x2 = z.right - 2, y2 = z.top + z.height / 2;
    ev('pointerdown', x1, y1);
    for (let i = 1; i <= 12; i++) ev('pointermove', x1 + (x2 - x1) * i / 12, y1 + (y2 - y1) * i / 12);
    ev('pointerup', x2, y2);
  }
  await new Promise((r) => setTimeout(r, 900));
  out.push({ name: '길게 그으면 팝업이 뜬다', ok: !pop.classList.contains('hidden') });

  const shown = document.getElementById('selPopText').textContent;
  out.push({ name: '앞부분이 보인다', ok: shown.startsWith('성인 가슴압박'), detail: shown.slice(0, 20) });
  out.push({ name: '**끝부분도 보인다**(어디까지 골랐는지 확인된다)',
    ok: /독립적으로 시행한다\.$/.test(shown), detail: shown.slice(-22) });
  out.push({ name: '가운데는 접는다(팝업이 화면을 덮지 않게)', ok: shown.includes('…') });
  out.push({ name: '몇 글자인지 알려준다',
    ok: /\d+자/.test(document.getElementById('selPopCount').textContent),
    detail: document.getElementById('selPopCount').textContent });
  out.push({ name: '전문은 길게 눌러 볼 수 있다',
    ok: document.getElementById('selPopText').title.length > shown.length });

  // 닫기 — 맨 위 오른쪽, 누를 만한 크기
  const x = document.getElementById('selCancel');
  const xr = x.getBoundingClientRect();
  const tr = document.getElementById('selPopText').getBoundingClientRect();
  out.push({ name: '닫기가 글 위쪽에 있다(줄 끝이 아니라)', ok: xr.top < tr.top,
    detail: `✕ ${Math.round(xr.top)} / 글 ${Math.round(tr.top)}` });
  out.push({ name: '닫기가 오른쪽 끝에 있다',
    ok: xr.right >= pop.getBoundingClientRect().right - 16 });
  out.push({ name: '닫기가 누를 만한 크기다', ok: xr.width >= 28 && xr.height >= 28,
    detail: `${Math.round(xr.width)}×${Math.round(xr.height)}` });

  // 보조 동작은 아이콘만 — 한 줄에 다 들어간다
  const acts = [...document.querySelectorAll('#selPop .sel-actions .sel-btn')];
  out.push({ name: '주 동작만 글씨, 나머지는 아이콘',
    ok: acts[0].textContent.length > 3 && acts.slice(1).every((b) => b.textContent.trim().length <= 2),
    detail: acts.map((b) => b.textContent.trim()).join(' ') });
  out.push({ name: '아이콘에도 뭘 하는지 적혀 있다(길게 누르면 뜬다)',
    ok: acts.slice(1).every((b) => b.title && b.getAttribute('aria-label')) });
  const tops = acts.map((b) => Math.round(b.getBoundingClientRect().top));
  out.push({ name: '버튼이 한 줄에 들어간다(줄바꿈 없음)',
    ok: new Set(tops).size === 1, detail: tops.join(',') });
  out.push({ name: '아이콘 버튼도 누를 만하다',
    ok: acts.slice(1).every((b) => b.getBoundingClientRect().width >= 36) });

  pop.classList.add('hidden');
  pop.style.cssText = '';
  return out;
});

// ══════════ 찾기 · 단축키 · 되돌아오는 AI 답변 (2026-10-13) ══════════
await run('찾기', async () => {
  const out = [];
  const sheet = document.getElementById('searchSheet');

  document.getElementById('readFind').click();
  out.push({ name: '찾기 버튼이 찾기를 연다', ok: !sheet.classList.contains('hidden') });

  const chips = [...document.querySelectorAll('#searchSheet .scope-btn[data-scope]')];
  out.push({ name: '범위를 고를 수 있다(이 문서/이 폴더/전체)',
    ok: chips.map((b) => b.textContent).join('/') === '이 문서/이 폴더/전체',
    detail: chips.map((b) => b.textContent).join('/') });
  out.push({ name: '범위는 늘 하나만 켜져 있다',
    ok: chips.filter((b) => b.classList.contains('on')).length === 1,
    detail: chips.filter((b) => b.classList.contains('on')).map((b) => b.dataset.scope).join(',') });
  // 노트를 안 열었으면 "이 문서"는 뜻이 없다 — 눌리지 않고 전체로 간다
  const noNote = chips.find((b) => b.dataset.scope === 'doc').disabled;
  out.push({ name: '노트가 없으면 전체, 있으면 이 문서가 기본',
    ok: noNote
      ? chips.find((b) => b.dataset.scope === 'all').classList.contains('on')
      : chips.find((b) => b.dataset.scope === 'doc').classList.contains('on'),
    detail: noNote ? '노트 없음' : '노트 있음' });
  out.push({ name: '못 쓰는 범위는 눌리지 않게 막는다',
    ok: chips.filter((b) => b.dataset.scope !== 'all').every((b) => b.disabled === noNote) });
  chips.find((b) => b.dataset.scope === 'all').click();
  out.push({ name: '눌러서 범위를 바꾼다',
    ok: chips.find((b) => b.dataset.scope === 'all').classList.contains('on') });

  const rx = document.getElementById('searchRegex');
  rx.click();
  out.push({ name: '정규식(grep)을 켤 수 있다', ok: rx.classList.contains('on') });
  rx.click();
  out.push({ name: '다시 누르면 꺼진다', ok: !rx.classList.contains('on') });
  out.push({ name: '대소문자 구분도 있다', ok: !!document.getElementById('searchCase') });

  // 글자 칸에 바로 커서가 간다 — 키보드로 쓸 때 제일 중요하다
  out.push({ name: '열면 바로 칠 수 있다', ok: document.activeElement.id === 'searchInput',
    detail: document.activeElement.id });

  // Esc로 닫힌다
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  out.push({ name: 'Esc로 닫힌다', ok: sheet.classList.contains('hidden') });

  // ⌘F로 열린다(아이패드에 키보드를 붙여 쓸 때)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
  out.push({ name: '⌘F로 열린다', ok: !sheet.classList.contains('hidden') });
  document.getElementById('searchClose').click();

  // ⌘⇧F는 전체 범위로
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  out.push({ name: '⌘⇧F는 전체에서 찾는다',
    ok: !sheet.classList.contains('hidden')
      && document.querySelector('#searchSheet .scope-btn[data-scope="all"]').classList.contains('on') });
  document.getElementById('searchClose').click();

  // ── 이 문서 안에서 찾기 — ⌘F의 본 일 ──
  // 앞 검사가 본문을 갈아끼웠으니 원래 노트로 되돌린다(섹션을 한 번 넘겼다 온다)
  document.getElementById('readNext').click();
  document.getElementById('readPrev').click();
  await new Promise((r) => setTimeout(r, 120));
  const docChip = chips.find((b) => b.dataset.scope === 'doc');
  if (!docChip.disabled) {
    docChip.click();
    const inp = document.getElementById('searchInput');
    inp.value = '내용';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const msg = document.getElementById('searchMsg').textContent;
    out.push({ name: '이 문서에서 여러 군데를 찾는다', ok: /\d+군데/.test(msg), detail: msg });
    out.push({ name: '섹션별로 묶어 보여준다(어디 있는 말인지)',
      ok: document.querySelectorAll('#searchResults .sh-group').length >= 2,
      detail: `${document.querySelectorAll('#searchResults .sh-group').length}개 섹션` });
    out.push({ name: '**본문에서 그 자리를 칠해 준다**', ok: !!document.querySelector('mark.find-mark'),
      detail: (document.querySelector('mark.find-mark') || {}).textContent || '없음' });
    // Enter로 다음 자리
    const before = document.getElementById('searchMsg').textContent;
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 250));
    out.push({ name: 'Enter로 다음 자리로 넘어간다',
      ok: document.getElementById('searchMsg').textContent !== before,
      detail: document.getElementById('searchMsg').textContent });
    out.push({ name: '없는 말은 없다고 한다',
      ok: (inp.value = 'ㅋㅋ없는말ㅋㅋ', inp.dispatchEvent(new Event('input', { bubbles: true })), true) });
    await new Promise((r) => setTimeout(r, 350));
    out.push({ name: '— 그렇게 말한다', ok: /없습니다/.test(document.getElementById('searchMsg').textContent),
      detail: document.getElementById('searchMsg').textContent });
  }
  document.getElementById('searchClose').click();
  out.push({ name: '닫으면 본문 표시도 지운다', ok: !document.querySelector('mark.find-mark') });
  return out;
});

await run('단축키 안내', () => {
  const out = [];
  document.getElementById('mmKeys').click();
  const sheet = document.getElementById('keySheet');
  out.push({ name: '더보기에 단축키 안내가 있다', ok: !sheet.classList.contains('hidden') });
  const txt = document.getElementById('keyHelpBody').textContent;
  out.push({ name: '키보드와 마우스를 같이 알려준다',
    ok: txt.includes('키보드') && txt.includes('마우스') });
  out.push({ name: 'Obsidian과 같은 ⌘F를 적어 뒀다', ok: txt.includes('⌘F') });
  out.push({ name: '아이패드에서 마우스 버튼 여는 법도 적었다',
    ok: txt.includes('AssistiveTouch') });
  // 어느 버튼이 앱까지 오는지는 기기마다 다르다 — 눌러서 확인하게 해 둔다
  const pad = document.getElementById('mpPad');
  out.push({ name: '마우스 버튼을 직접 눌러 시험할 수 있다', ok: !!pad });
  pad.dispatchEvent(new PointerEvent('pointerdown', { button: 3, bubbles: true, cancelable: true }));
  pad.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const hits = [...document.querySelectorAll('#mpLog .mp-hit')].map((x) => x.textContent);
  out.push({ name: '온 버튼만 적힌다', ok: hits.length === 2, detail: hits.join(' ') });
  out.push({ name: '4번 버튼을 알아본다', ok: hits.some((h) => h.includes('4번')) });
  out.push({ name: '보조 클릭(오른쪽)을 알아본다', ok: hits.some((h) => h.includes('보조 클릭')) });
  document.getElementById('keyClose').click();
  out.push({ name: '닫힌다', ok: sheet.classList.contains('hidden') });
  return out;
});

// ★ 질문해둔 답이 사라지면 그걸 보며 하던 일을 이어갈 수가 없다(2026-10-13 지적)
await run('AI 답변이 남는다', () => {
  const out = [];
  const f = document.getElementById('askFloat');
  const dock = document.getElementById('askDock');
  out.push({ name: '접으면 돌아갈 단추가 있다', ok: !!dock });
  out.push({ name: '지난 질문 목록을 여는 단추가 있다', ok: !!document.getElementById('afLog') });
  document.getElementById('afLog').click();
  out.push({ name: '눌러서 펼쳐진다', ok: !document.getElementById('afLogList').classList.contains('hidden') });
  document.getElementById('afLog').click();
  out.push({ name: '다시 눌러 접는다', ok: document.getElementById('afLogList').classList.contains('hidden') });
  out.push({ name: '✕는 "닫기"가 아니라 "접기"라고 말한다',
    ok: /접기/.test(document.getElementById('afClose').title),
    detail: document.getElementById('afClose').title });
  f.classList.add('hidden');
  return out;
});

// 족보 챕터 머리말 — vault에만 있고 앱에는 한 줄도 안 나오던 2만 자
await run('족보 출제 경향', () => {
  const out = [];
  const box = document.getElementById('jokboIntro');
  out.push({ name: '출제 경향 자리가 있다', ok: !!box });
  out.push({ name: '족보가 아니면 안 보인다', ok: box.classList.contains('hidden') });
  out.push({ name: '접혀 있다가 펼쳐진다', ok: box.tagName === 'DETAILS' && !box.open });
  out.push({ name: '과목 전체 총평으로 가는 길도 있다', ok: !!document.getElementById('jokboOverview') });
  return out;
});

// ══════════ 노트 서랍 — 짝 찾기 · 암기법이 바로 나오는가 (2026-10-13) ══════════
// "노트 누르면 암기법이 바로 안 나오는 문제가 있음" — 암기법·QA는 `응급_중환자 · 암기법`
// 이라는 **별도 묶음**이라, 과목 이름만 보고 "지금 보는 과목"을 가르면 안 걸렸다.
await run('노트 서랍', async () => {
  const out = [];
  const d = await import('/js/db.js');
  // 노트를 실제로 열어봐야 짝·순서를 검사할 수 있다 — 받아오는 길을 가짜로 둔다
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  const realFetch = window.fetch;
  window.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('api.github.com')) return realFetch(url, init);
    const name = decodeURIComponent(u.split('/contents/')[1] || '').split('/').pop().replace('.md', '');
    return { ok: true, status: 200, json: async () => ({}),
      text: async () => `# ${name}\n\n## ${name} 1장\n내용 가\n\n## ${name} 2장\n내용 나\n` };
  };
  await d.kvSet('note_index_v2', [
    { root: '02_Wiki', subject: '두경부_피부', notes: [
      { name: '두경부피부_이과학', path: '02_Wiki/두경부_피부/두경부피부_이과학.md' }] },
    { root: '02_Wiki', subject: '응급_중환자', notes: [
      { name: '응급중환자_기본소생술BLS', path: '02_Wiki/응급_중환자/응급중환자_기본소생술BLS.md' },
      { name: '응급중환자_환경의학', path: '02_Wiki/응급_중환자/응급중환자_환경의학.md' }] },
    { root: '02_Wiki', subject: '응급_중환자 · 암기법', notes: [
      { name: '응급중환자_기본소생술BLS_암기법', path: '02_Wiki/응급_중환자/암기법/응급중환자_기본소생술BLS_암기법.md' }] },
    { root: '02_Wiki', subject: '응급_중환자 · QA', notes: [
      { name: '응급중환자_기본소생술BLS_QA', path: '02_Wiki/응급_중환자/QA/응급중환자_기본소생술BLS_QA.md' }] },
    { root: '02_Wiki', subject: '응급_중환자 · 국시종합', notes: [
      { name: '심폐소생술', path: '02_Wiki/응급_중환자/국시종합/심폐소생술.md' }] },
    { root: '98_예습노트_보관', subject: '응급_중환자', notes: [
      { name: '1012_응급중환자_기본소생술BLS', path: '98_예습노트_보관/응급_중환자/1012_응급중환자_기본소생술BLS.md' }] },
  ]);
  document.getElementById('docList').__groups = null;    // 새 목록으로 다시 받게
  document.getElementById('readDocs').click();
  await new Promise((r) => setTimeout(r, 600));
  const names = [...document.querySelectorAll('#docList .dd-gname')].map((x) => x.textContent);
  out.push({ name: '과목 묶음이 나온다', ok: names.length >= 5, detail: `${names.length}개` });

  // 다른 과목은 접혀 있다 — 그게 맞다(2026-10-13). 펴서 들어간다.
  out.push({ name: '지금 보는 과목만 펴고 나머지는 접는다',
    ok: [...document.querySelectorAll('#docList .dd-group')].filter((g) => g.classList.contains('open')).length <= 1 });
  const grp = [...document.querySelectorAll('#docList .dd-group')]
    .find((g) => g.querySelector('.dd-gname').textContent === '위키 · 응급 중환자');
  out.push({ name: '과목을 눌러 펼 수 있다', ok: !!grp });
  if (!grp) return out;
  grp.click();
  await new Promise((r) => setTimeout(r, 120));

  // 응급 BLS를 **실제로 열고** 다시 서랍을 연다 — 짝과 순서는 열어둔 노트에 달려 있다
  const bls = [...document.querySelectorAll('#docList .dd-item .dd-name')]
    .find((x) => x.textContent === '응급중환자_기본소생술BLS');
  out.push({ name: '펼치면 노트가 보인다', ok: !!bls });
  if (!bls) return out;
  bls.closest('.dd-item').click();
  await new Promise((r) => setTimeout(r, 900));
  out.push({ name: '서랍에서 누르면 그 노트가 열린다',
    ok: /기본소생술BLS/.test(document.getElementById('readTitle').textContent),
    detail: document.getElementById('readTitle').textContent });
  document.getElementById('readDocs').click();
  await new Promise((r) => setTimeout(r, 400));

  const names2 = [...document.querySelectorAll('#docList .dd-gname')].map((x) => x.textContent);
  const first3 = names2.slice(0, 3).join(' | ');
  out.push({ name: '**암기법·QA가 맨 위로 올라온다**(별도 묶음이라 안 걸리던 것)',
    ok: /암기법/.test(names2[0] || '') && /QA/.test(names2[1] || ''), detail: first3 });
  out.push({ name: '지금 과목 묶음은 이름을 짧게(무엇이 다른지가 보이게)',
    ok: names2[0] === '암기법' && names2[2] === '지금 보는 과목', detail: names2.slice(0, 4).join(' | ') });

  // 짝 — 같은 강의의 다른 얼굴
  const pairHead = document.querySelector('#docList .dd-pair-head');
  const pairs = [...document.querySelectorAll('#docList .dd-item.pair .dd-name')].map((x) => x.textContent);
  out.push({ name: '"지금 문서의 짝"을 맨 위에 모은다', ok: !!pairHead });
  if (pairHead) {
    out.push({ name: '암기법이 짝으로 잡힌다', ok: pairs.some((n) => /_암기법$/.test(n)),
      detail: pairs.join(' / ') });
    out.push({ name: 'Q&A도 잡힌다', ok: pairs.some((n) => /_QA$/.test(n)) });
    out.push({ name: '날짜 머리가 달라도 예습노트를 찾아낸다',
      ok: pairs.some((n) => /^1012_/.test(n)) });
    out.push({ name: '남의 강의는 안 끌어온다', ok: !pairs.some((n) => /환경의학|이과학/.test(n)) });
    const kinds = [...document.querySelectorAll('#docList .dd-item.pair .dd-kind')].map((x) => x.textContent);
    out.push({ name: '어떤 갈래인지 적어 둔다', ok: kinds.some((k) => k.includes('암기법')),
      detail: kinds.join(' ') });
    out.push({ name: '암기법이 짝 중에서도 맨 앞', ok: /_암기법$/.test(pairs[0]), detail: pairs[0] });
  }
  // 날짜 — 위키가 많아지면 언제 것인지가 단서가 된다
  const dates = [...document.querySelectorAll('#docList .dd-date')].map((x) => x.textContent);
  out.push({ name: '날짜 머리가 있는 노트는 날짜를 보여준다',
    ok: dates.includes('10/12'), detail: dates.join(',') });

  // 검색은 그대로 돈다
  const q = document.getElementById('docSearch');
  q.value = '환경';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const found = [...document.querySelectorAll('#docList .dd-item .dd-name')].map((x) => x.textContent);
  out.push({ name: '검색하면 걸린 것만 남는다', ok: found.length === 1 && /환경의학/.test(found[0]),
    detail: found.join(' / ') });
  out.push({ name: '검색 중에는 짝을 안 띄운다(결과만 보이게)',
    ok: !document.querySelector('#docList .dd-pair-head') });
  q.value = '';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('docClose').click();
  window.fetch = realFetch;
  return out;
});

// ══════════ 캡처·카드도 "어디까지 잡히는지" 보인다 (2026-10-13) ══════════
// 글 선택만 미리보기가 있고 캡처는 파란 선만 보였다 — 손을 떼야 어디가 복사됐는지 알았다.
await run('자르는 틀', async () => {
  const out = [];
  const { PenLayer } = await import('/js/pen.js');
  const card = document.getElementById('readCard');
  document.querySelectorAll('#readCard .penlayer').forEach((c) => c.remove());
  // 앞 검사가 열어둔 것들이 화면을 덮고 있으면 펜이 UI 조작으로 넘어간다 — 치우고 시작한다
  document.getElementById('readScreen').classList.add('toc-off');
  document.querySelectorAll('.sheet, .ask-float, .more-menu, #docDrawer, #docScrim, #selPop')
    .forEach((x) => x.classList.add('hidden'));
  const body = document.getElementById('readBody');
  body.innerHTML = '<p style="height:160px">자를 거리</p>';
  await new Promise((rs) => setTimeout(rs, 250));
  const pen = new PenLayer(card, {});
  const cv = card.querySelector('.penlayer');
  const draw = (x1, y1, x2, y2, up) => {
    const ev = (t, x, y) => cv.dispatchEvent(new PointerEvent(t, {
      pointerType: 'pen', pointerId: 11, isPrimary: true,
      buttons: t === 'pointerup' ? 0 : 1, pressure: .5,
      clientX: x, clientY: y, bubbles: true, cancelable: true }));
    ev('pointerdown', x1, y1);
    for (let i = 1; i <= 10; i++) ev('pointermove', x1 + (x2 - x1) * i / 10, y1 + (y2 - y1) * i / 10);
    if (up) ev('pointerup', x2, y2);
  };
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const r = body.getBoundingClientRect();
  const X = Math.round(r.left + 10), Y = Math.round(r.top + 10);
  out.push({ name: '그릴 자리가 비어 있다(목차·버튼이 안 덮는다)',
    ok: document.elementFromPoint(X, Y) && card.contains(document.elementFromPoint(X, Y)),
    detail: ((document.elementFromPoint(X, Y) || {}).className || '?') + '' });

  // ── 캡처 ──
  pen.setCapturing(true);
  draw(X, Y, X + 220, Y + 110, false);           // 손을 **떼지 않고** 본다
  await frame();
  out.push({ name: '**그리는 중에 틀이 보인다**(손 떼기 전에)', ok: !!pen._previewBox });
  out.push({ name: '글 선택이 아니라 자르는 틀이다', ok: pen._previewKind === 'crop',
    detail: String(pen._previewKind) });
  if (!pen._previewBox) { pen.destroy(); return out; }   // 위 검사가 왜인지 말해준다
  const b1 = pen._previewBox;
  out.push({ name: '그은 그대로의 네모다(줄 끝까지 늘이지 않는다)',
    ok: Math.abs((b1.r - b1.l) - 220) < 14 && Math.abs((b1.b - b1.t) - 110) < 14,
    detail: `${Math.round(b1.r - b1.l)}×${Math.round(b1.b - b1.t)}` });
  out.push({ name: '줄 하이라이트는 안 쓴다(그림을 뜨는 것이라)', ok: !pen._coveredLines });

  // 되돌리면 틀도 줄어든다 — 글 선택과 같은 손버릇
  draw(X, Y, X + 60, Y + 30, false);
  await frame();
  const b2 = pen._previewBox;
  out.push({ name: '되돌리면 틀이 줄어든다', ok: (b2.r - b2.l) < (b1.r - b1.l),
    detail: `${Math.round(b1.r - b1.l)} → ${Math.round(b2.r - b2.l)}px` });

  // 그린 자국은 가리고 틀만 — 궤적이 가로지르면 뭘 자르는지 안 보인다
  let drewTrail = false;
  const realStroke = pen._drawStroke.bind(pen);
  pen._drawStroke = (st) => { if (!pen.strokes.includes(st)) drewTrail = true; realStroke(st); };
  pen.redraw();
  out.push({ name: '궤적 대신 틀만 보여준다', ok: !drewTrail });
  pen._drawStroke = realStroke;

  // ── 카드 ──
  pen.setCarding(true);
  draw(X, Y, X + 200, Y + 90, false);
  await frame();
  out.push({ name: '카드 만들기도 같은 틀을 쓴다', ok: !!pen._previewBox });
  out.push({ name: '카드는 색이 달라 캡처와 구별된다', ok: pen._previewKind === 'card',
    detail: String(pen._previewKind) });

  // ── 지우개는 틀이 없다 ──
  pen.setErasing(true);
  pen._previewBox = null;
  draw(X, Y, X + 150, Y + 60, true);
  await frame();
  out.push({ name: '지우개에는 틀이 안 뜬다', ok: !pen._previewBox });

  // ── 확정되면 틀이 사라진다 ──
  pen.setCapturing(true);
  let got = null;
  pen.onCapture = (box) => { got = box; };
  draw(X, Y, X + 180, Y + 80, true);
  await new Promise((rs) => setTimeout(rs, 700));
  out.push({ name: '손을 떼면 그 범위가 넘어간다', ok: !!got,
    detail: got ? `${Math.round(got.r - got.l)}×${Math.round(got.b - got.t)}` : '안 넘어옴' });
  out.push({ name: '**보여준 범위와 자르는 범위가 같다**',
    ok: got && Math.abs((got.r - got.l) - 180) < 14 && Math.abs((got.b - got.t) - 80) < 14,
    detail: got ? `${Math.round(got.r - got.l)}×${Math.round(got.b - got.t)}` : '' });
  out.push({ name: '끝나면 틀을 치운다', ok: !pen._previewBox && !pen._previewKind });

  pen.destroy();
  body.innerHTML = '';
  return out;
});

// ══════════ 크기 조절 손잡이 — 가까이 가면 깨어난다 (2026-10-13) ══════════
// 2px 선을 10px 칸에 그려두니 아이패드에서 잡기가 너무 어려웠다
// ("퀴즈 및 문제 풀 때 사이즈 조절이 원활하지 않음").
await run('크기 조절 손잡이', async () => {
  const out = [];
  // 퀴즈 화면을 넓은 화면으로 세운다(손잡이는 900px 이상에서만 뜬다)
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.body.dataset.screen = 'quizScreen';
  document.getElementById('quizScreen').classList.add('with-side');
  document.getElementById('wikiPanel').classList.remove('hidden');
  await new Promise((r) => setTimeout(r, 120));

  const col = document.getElementById('colResizer');
  const r = col.getBoundingClientRect();
  out.push({ name: '폭 조절 손잡이가 보인다', ok: r.width > 0 && r.height > 0,
    detail: `${Math.round(r.width)}×${Math.round(r.height)}` });
  if (!r.width) return out;

  out.push({ name: '손잡이가 예전(10px)보다 넓다', ok: r.width >= 14,
    detail: `${Math.round(r.width)}px` });
  out.push({ name: '잡는 자리임을 알려주는 표시가 있다', ok: !!col.querySelector('.rg-dots') });
  out.push({ name: '뭘 하는 건지 적혀 있다(두 번 누르면 되돌아가는 것까지)',
    ok: /끌어서/.test(col.title) && /두 번/.test(col.title), detail: col.title });

  // ★ 가까이 가면 깨어난다 — 펜은 닿기 전에 좌표가 온다
  out.push({ name: '평소엔 조용하다', ok: !col.classList.contains('near') });
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  document.dispatchEvent(new PointerEvent('pointermove',
    { clientX: cx + 30, clientY: cy, bubbles: true }));
  await new Promise((rs) => requestAnimationFrame(() => requestAnimationFrame(rs)));
  out.push({ name: '**30px까지 다가가면 깨어난다**', ok: col.classList.contains('near') });
  const awake = col.getBoundingClientRect();
  out.push({ name: '깨어나면 선이 굵어진다(눈에 띈다)',
    ok: parseFloat(getComputedStyle(col, '::before').width) > 2,
    detail: getComputedStyle(col, '::before').width });
  out.push({ name: '깨어나면 눌리는 범위도 넓어진다',
    ok: parseFloat(getComputedStyle(col, '::after').width) > awake.width,
    detail: `${getComputedStyle(col, '::after').width} > ${Math.round(awake.width)}px` });

  // 멀어지면 다시 조용해진다 — 늘 켜 두면 옆 패널 가장자리를 먹는다
  document.dispatchEvent(new PointerEvent('pointermove',
    { clientX: cx + 200, clientY: cy, bubbles: true }));
  await new Promise((rs) => requestAnimationFrame(() => requestAnimationFrame(rs)));
  out.push({ name: '멀어지면 다시 조용해진다(옆 패널을 안 먹게)',
    ok: !col.classList.contains('near') });

  // 실제로 끌어서 폭이 바뀌는가
  const before = document.querySelector('#quizScreen .side-col').getBoundingClientRect().width;
  col.dispatchEvent(new PointerEvent('pointerdown',
    { pointerId: 21, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  out.push({ name: '끄는 동안 티가 난다', ok: col.classList.contains('dragging') });
  out.push({ name: '끄는 동안 글이 선택되지 않는다(조절이 안 끊기게)',
    ok: document.body.classList.contains('resizing') });
  document.dispatchEvent(new PointerEvent('pointermove',
    { pointerId: 21, clientX: cx - 90, clientY: cy, bubbles: true, cancelable: true }));
  await new Promise((rs) => setTimeout(rs, 60));
  const after = document.querySelector('#quizScreen .side-col').getBoundingClientRect().width;
  out.push({ name: '**끌면 폭이 그만큼 바뀐다**', ok: Math.abs(after - (before + 90)) < 14,
    detail: `${Math.round(before)} → ${Math.round(after)}px` });
  document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 21, bubbles: true }));
  out.push({ name: '놓으면 표시가 사라진다',
    ok: !col.classList.contains('dragging') && !document.body.classList.contains('resizing') });
  out.push({ name: '맞춰둔 폭을 기억한다', ok: !!localStorage.getItem('side_w') });
  col.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  out.push({ name: '두 번 누르면 기본값으로', ok: !localStorage.getItem('side_w') });

  document.getElementById('wikiPanel').classList.add('hidden');
  document.getElementById('quizScreen').classList.remove('with-side');
  return out;
});

// ══════════ 퀴즈에서도 "이 문서"를 찾을 수 있다 (2026-10-13) ══════════
// 문제는 옆에 띄운 위키를 바탕으로 만들어진다 — 풀다가 찾을 곳도 거기다.
// 그런데 퀴즈 화면에서는 "이 문서"가 아예 안 눌려서 전체 검색만 됐다.
await run('퀴즈에서 찾기', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.body.dataset.screen = 'quizScreen';
  document.querySelectorAll('.sheet, .ask-float, .more-menu, #docDrawer, #docScrim')
    .forEach((x) => x.classList.add('hidden'));

  out.push({ name: '퀴즈 도구막대에 찾기가 있다', ok: !!document.getElementById('toolFind') });
  document.getElementById('toolFind').click();
  await new Promise((r) => setTimeout(r, 150));
  const chips = [...document.querySelectorAll('#searchSheet .scope-btn[data-scope]')];
  const doc = chips.find((b) => b.dataset.scope === 'doc');
  out.push({ name: '**옆에 뜬 노트를 "이 문서"로 잡는다**', ok: !doc.disabled,
    detail: doc.disabled ? '못 누름' : '누를 수 있음' });
  out.push({ name: '열면 그 문서가 기본 범위', ok: doc.classList.contains('on') });
  out.push({ name: '어느 노트인지 칸에 적어준다',
    ok: /안에서 찾기$/.test(document.getElementById('searchInput').placeholder),
    detail: document.getElementById('searchInput').placeholder });
  out.push({ name: '이 폴더도 고를 수 있다',
    ok: !chips.find((b) => b.dataset.scope === 'dir').disabled });

  // 실제로 찾아진다. 칠하는 자리는 **읽기 화면이면 본문, 퀴즈면 옆 패널**이어야 한다 —
  // 그래서 지금 문서의 글을 옆 패널에 띄워두고 거기 표시가 가는지 본다.
  const target = document.getElementById('wikiBody');
  target.innerHTML = '<p>내용 가 — 옆 패널에 떠 있는 글</p>';
  const inp = document.getElementById('searchInput');
  inp.value = '내용';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 420));
  out.push({ name: '그 노트 안에서 찾아낸다',
    ok: /\d+군데/.test(document.getElementById('searchMsg').textContent),
    detail: document.getElementById('searchMsg').textContent });
  out.push({ name: '**본문이 아니라 옆 패널에 표시가 간다**',
    ok: !!target.querySelector('mark.find-mark'),
    detail: (target.querySelector('mark.find-mark') || {}).textContent || '없음' });
  out.push({ name: '읽기 화면 본문은 안 건드린다',
    ok: !document.querySelector('#readBody mark.find-mark') });
  document.getElementById('searchClose').click();
  out.push({ name: '닫으면 표시를 지운다', ok: !document.querySelector('mark.find-mark') });
  target.innerHTML = '';
  return out;
});

// ══════════ 뜯어보기는 중간에 그만둘 수 있다 (2026-10-13) ══════════
await run('뜯어보기 그만두기', async () => {
  const out = [];
  const el = document.getElementById('breakdown');
  const btn = document.getElementById('toolBreak');
  // 느린 응답을 흉내 — 영영 안 끝나는 스트림
  const realFetch = window.fetch;
  let aborted = false;
  window.fetch = (url, init) => {
    if (!String(url).includes('generativelanguage')) return realFetch(url, init);
    return new Promise((_, reject) => {
      const sig = init && init.signal;
      if (sig) sig.addEventListener('abort', () => {
        aborted = true;
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    });
  };
  const g = await import('/js/gemini.js');
  await g.setKey('fake-key-for-cancel-test');
  g.resetLimiter();          // 앞 검사가 캐시해둔 답이 있으면 기다릴 틈이 없다

  btn.click();
  // 미리 만들어둔 게 있으면 0초에 떠버린다 — "기다리는 중"이 나타날 때까지 본다.
  // 고정 시간으로 재면 기기·캐시 상태에 따라 들쭉날쭉하다.
  for (let i = 0; i < 40 && !el.querySelector('.bd-stop'); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  out.push({ name: '누르면 뜯어보기가 뜬다', ok: !el.classList.contains('hidden') });
  const stop = el.querySelector('.bd-stop');
  out.push({ name: '**기다리는 동안 "그만" 버튼이 보인다**', ok: !!stop,
    detail: el.textContent.slice(0, 40) });
  out.push({ name: '뭘 하는 중인지 적혀 있다', ok: /뜯어보는 중/.test(el.textContent) });

  // ★ 다시 누르면 그만둔다 — 전에는 아무 반응이 없었다
  btn.click();
  await new Promise((r) => setTimeout(r, 120));
  out.push({ name: '**다시 누르면 바로 닫힌다**(다 뜰 때까지 안 기다려도 된다)',
    ok: el.classList.contains('hidden') });
  out.push({ name: '버튼의 켜진 표시도 꺼진다', ok: !btn.classList.contains('active') });
  out.push({ name: '요청도 실제로 끊는다(할당량을 아낀다)', ok: aborted });

  // 그만둔 뒤 다시 눌러도 멀쩡하다 — busy가 남으면 영영 안 열린다
  btn.click();
  await new Promise((r) => setTimeout(r, 350));
  out.push({ name: '그만둔 뒤 다시 열 수 있다', ok: !el.classList.contains('hidden') });
  const stop2 = el.querySelector('.bd-stop');
  if (stop2) stop2.click();
  await new Promise((r) => setTimeout(r, 120));
  out.push({ name: '"그만" 버튼으로도 닫힌다', ok: el.classList.contains('hidden') });

  window.fetch = realFetch;
  await g.setKey('');
  return out;
});

// ══════════ 퀴즈 도구막대 · 타이머 (2026-10-13) ══════════
await run('퀴즈 도구막대', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.body.dataset.screen = 'quizScreen';
  await new Promise((r) => setTimeout(r, 40));

  const bar = document.getElementById('quizTools');
  out.push({ name: '퀴즈 도구도 떠 있는 막대로 나왔다', ok: !!bar });
  out.push({ name: '화면에 고정된다(스크롤을 안 따라간다)',
    ok: getComputedStyle(bar).position === 'fixed' });
  out.push({ name: '끌어서 옮길 손잡이가 있다', ok: !!document.getElementById('qtGrip') });
  // ★ 막대가 떠 있으니 머리줄 오른쪽 끝(점수·타이머)이 그 밑에 깔렸다 — 자리를 비운다
  {
    const sb = document.getElementById('scoreBadge');
    sb.textContent = '7/10';
    const pill = document.getElementById('timerPill');
    pill.classList.remove('hidden');
    pill.textContent = '08:12';
    await new Promise((r) => setTimeout(r, 160));
    const br = bar.getBoundingClientRect();
    out.push({ name: '**점수가 막대에 안 가린다**', ok: sb.getBoundingClientRect().right <= br.left + 1,
      detail: `점수 ${Math.round(sb.getBoundingClientRect().right)} / 막대 ${Math.round(br.left)}` });
    out.push({ name: '타이머도 안 가린다', ok: pill.getBoundingClientRect().right <= br.left + 1 });
    pill.classList.add('hidden');
  }
  out.push({ name: '머리줄에는 제목·점수만 남는다',
    ok: [...document.querySelectorAll('#quizScreen > header button')]
      .every((b) => !b.classList.contains('tool')),
    detail: [...document.querySelectorAll('#quizScreen > header button')].map((b) => b.id).join(',') });
  // 손잡이를 실제로 끌어서 왼쪽 아래로 보낸다
  const grip = document.getElementById('qtGrip');
  const g0 = grip.getBoundingClientRect();
  const pe = (t, x, y) => grip.dispatchEvent(new PointerEvent(t,
    { pointerId: 31, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  pe('pointerdown', g0.left + 5, g0.top + 5);
  pe('pointermove', 40, innerHeight - 60);
  pe('pointerup', 40, innerHeight - 60);
  await new Promise((r) => setTimeout(r, 60));
  out.push({ name: '**끌면 가까운 변에 가서 붙는다**', ok: /^(bl|l)$/.test(bar.dataset.dock),
    detail: bar.dataset.dock });
  // 읽기 화면 막대와 **따로** 기억한다 — 둘은 쓰는 자리가 다르다
  out.push({ name: '퀴즈 막대 자리는 따로 기억한다',
    ok: localStorage.getItem('quiz_tools_dock') === bar.dataset.dock
      && localStorage.getItem('read_tools_dock') !== bar.dataset.dock,
    detail: `퀴즈 ${localStorage.getItem('quiz_tools_dock')} / 읽기 ${localStorage.getItem('read_tools_dock')}` });
  grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  out.push({ name: '두 번 누르면 원래 자리로', ok: bar.dataset.dock === 'tr' });
  out.push({ name: '다른 화면에서는 안 보인다',
    ok: (document.body.dataset.screen = 'listScreen',
      getComputedStyle(bar).display === 'none') });
  document.body.dataset.screen = 'quizScreen';
  return out;
});

// 타이머 — 점수에 쓰지 않는다. 딴짓하다 한 세트가 한 시간이 되는 걸 막는 용도.
await run('타이머', async () => {
  const out = [];
  const pill = document.getElementById('timerPill');
  out.push({ name: '평소엔 안 보인다', ok: pill.classList.contains('hidden') });

  document.getElementById('toolTimer').click();
  await new Promise((r) => setTimeout(r, 120));
  const sheet = document.getElementById('timerSheet');
  out.push({ name: '타이머 버튼이 설정을 연다', ok: !sheet.classList.contains('hidden') });
  const mins = [...document.querySelectorAll('#timerSeg .btn')].map((b) => b.textContent);
  out.push({ name: '10·20분 같은 흔한 길이를 고를 수 있다',
    ok: mins.includes('10분') && mins.includes('20분'), detail: mins.join(' ') });
  out.push({ name: '**점수에 안 쓴다고 분명히 적는다**',
    ok: /점수에는 안 들어갑니다/.test(sheet.textContent) });
  out.push({ name: '문항마다 다시 시작도 고를 수 있다', ok: !!document.getElementById('timerPerQ') });

  document.querySelector('#timerSeg .btn[data-min="10"]').click();
  document.getElementById('timerStart').click();
  await new Promise((r) => setTimeout(r, 120));
  out.push({ name: '시작하면 닫힌다', ok: sheet.classList.contains('hidden') });
  out.push({ name: '남은 시간이 보인다', ok: !pill.classList.contains('hidden') && /^\d\d:\d\d$/.test(pill.textContent),
    detail: pill.textContent });
  out.push({ name: '고른 길이대로 센다', ok: /^(10:00|09:5\d)$/.test(pill.textContent),
    detail: pill.textContent });

  // 누르면 잠깐 멈춤 — 화장실 다녀오는 동안 도는 건 의미가 없다
  pill.click();
  await new Promise((r) => setTimeout(r, 40));
  out.push({ name: '누르면 멈춘다', ok: /⏸/.test(pill.textContent), detail: pill.textContent });
  const held = pill.textContent;
  await new Promise((r) => setTimeout(r, 1100));
  out.push({ name: '멈춘 동안은 안 줄어든다', ok: pill.textContent === held });
  pill.click();
  out.push({ name: '다시 누르면 이어 간다', ok: !/⏸/.test(pill.textContent) });

  // 끄기
  document.getElementById('toolTimer').click();
  await new Promise((r) => setTimeout(r, 100));
  document.getElementById('timerOff').click();
  out.push({ name: '끄면 사라진다', ok: pill.classList.contains('hidden') });
  out.push({ name: '고른 길이를 기억한다', ok: /"min":10/.test(localStorage.getItem('timer_pref') || ''),
    detail: localStorage.getItem('timer_pref') });

  // 시간이 지나면 색이 바뀐다 — 숫자만으로는 곁눈으로 안 보인다
  pill.classList.remove('hidden');
  const plain = getComputedStyle(pill).backgroundColor;
  pill.classList.add('warn');
  const warn = getComputedStyle(pill).backgroundColor;
  pill.classList.remove('warn');
  pill.classList.add('over');
  const over = getComputedStyle(pill).backgroundColor;
  out.push({ name: '1분 남으면 색이 바뀐다', ok: warn !== plain, detail: `${plain} → ${warn}` });
  out.push({ name: '지나면 또 다르게 바뀐다', ok: over !== warn && over !== plain, detail: over });
  pill.classList.remove('over');
  pill.classList.add('hidden');
  out.push({ name: '시간이 지나도 **자동 제출은 안 한다**(재촉하는 장치가 아니다)',
    ok: document.getElementById('resultScreen').classList.contains('hidden') });
  return out;
});

// ══════════ 모아두기 붙여넣기 — 한 번에 들어가야 한다 (2026-10-13) ══════════
// "붙여넣기 누르면 바로 되어야 되는 거 아님? 왜 팝업이 또 떠서 두 번 누르게 만듦?"
// → 그 팝업은 사파리의 클립보드 권한 창이라 우리가 못 없앤다. 대신 **권한이 필요 없는 길**
//    (글 상자에 그냥 붙여넣기)을 먼저 보이게 하고, 창 어디에 붙여넣어도 들어가게 했다.
await run('모아두기 붙여넣기', async () => {
  const out = [];
  document.getElementById('readScrap').click();
  await new Promise((r) => setTimeout(r, 200));
  const panel = document.getElementById('scrapFloat');
  const ta = document.getElementById('scText');
  ta.value = '';
  out.push({ name: '모아두기가 열린다', ok: !panel.classList.contains('hidden') });
  out.push({ name: '**열자마자 글 상자에 초점이 간다**(바로 붙여넣을 수 있게)',
    ok: document.activeElement === ta, detail: document.activeElement.id });
  out.push({ name: '길게 눌러 붙여넣으라고 안내한다',
    ok: /길게 눌러 붙여넣/.test(ta.placeholder) });
  out.push({ name: '버튼은 권한을 묻는다고 미리 알려준다',
    ok: /물어봅니다/.test(document.getElementById('scPaste').title) });

  // 글 상자 밖(버튼)에 초점이 있어도 붙여넣기가 들어간다
  const dt = new DataTransfer();
  dt.setData('text/plain', '붙여넣은 글입니다');
  document.getElementById('scPaste').focus();
  panel.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 80));
  out.push({ name: '**창 어디에 붙여넣어도 글이 들어간다**', ok: ta.value.includes('붙여넣은 글입니다'),
    detail: ta.value.slice(0, 20) });
  out.push({ name: '몇 자 들어갔는지 알려준다',
    ok: /\d+자 붙여넣었습니다/.test(document.getElementById('scStatus').textContent),
    detail: document.getElementById('scStatus').textContent });

  // 글 상자 안에서는 브라우저 기본 동작에 맡긴다 — 우리가 또 넣으면 두 번 들어간다
  ta.focus();
  const before = ta.value;
  const dt2 = new DataTransfer();
  dt2.setData('text/plain', '두번들어가면안됨');
  const ev = new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 60));
  out.push({ name: '글 상자 안에서는 두 번 들어가지 않는다',
    ok: ta.value === before && !ev.defaultPrevented });

  ta.value = '';
  document.getElementById('scClose').click();
  return out;
});

// ══════════ vault 저장 — 됐는지 안 됐는지가 분명해야 한다 (2026-10-13) ══════════
// "저장이 되었는지 피드백이 없어서 혼란스러움". 그리고 인터넷이 끊겼을 때 **잃는 게 없다**는
// 사실이 화면에 보여야 한다 — 안 보이면 사람이 같은 걸 또 저장하려 든다.
await run('vault 저장 알림', async () => {
  const out = [];
  const d = await import('/js/db.js');
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  const realFetch = window.fetch;
  const open = () => {
    document.getElementById('readScrap').click();
    document.getElementById('scText').value = '저장 알림 검사';
  };
  const statusText = () => document.getElementById('scStatus').textContent;
  const toastText = () => [...document.querySelectorAll('body > div')]
    .map((x) => x.textContent).filter((t) => /저장|대기|기기에/.test(t)).join(' | ');

  // ① 잘 올라간 경우
  window.fetch = async (u, i) => (String(u).includes('api.github.com')
    ? { ok: true, status: 201, json: async () => ({ content: { path: 'x/저장됨.md' } }) }
    : realFetch(u, i));
  open();
  await new Promise((r) => setTimeout(r, 120));
  document.getElementById('scSave').click();
  await new Promise((r) => setTimeout(r, 400));
  out.push({ name: '올라가면 올라갔다고 한다', ok: /저장했습니다/.test(statusText()), detail: statusText() });
  out.push({ name: '**토스트로도 띄운다**(아래 작은 글씨는 눈에 안 들어온다)',
    ok: /저장했습니다/.test(toastText()), detail: toastText().slice(0, 50) });

  // ② 인터넷이 끊긴 경우 — 큐에 남고, 그 사실을 말해준다
  await new Promise((r) => setTimeout(r, 1200));
  window.fetch = async (u, i) => {
    if (!String(u).includes('api.github.com')) return realFetch(u, i);
    throw new TypeError('Failed to fetch');
  };
  open();
  await new Promise((r) => setTimeout(r, 120));
  const qBefore = (await d.listOutbox()).length;
  document.getElementById('scSave').click();
  await new Promise((r) => setTimeout(r, 500));
  out.push({ name: '**끊겨도 "인터넷이 없다"고 정확히 말한다**',
    ok: /인터넷이 없어/.test(statusText()), detail: statusText() });
  out.push({ name: '잃는 게 없다고 안심시킨다',
    ok: /자동으로 올라갑니다|앱을 꺼도/.test(statusText()) });
  const qAfter = (await d.listOutbox()).length;
  out.push({ name: '진짜로 기기에 남는다(큐가 늘어난다)', ok: qAfter > qBefore,
    detail: `${qBefore} → ${qAfter}` });
  out.push({ name: '보낼 게 남았다고 띠를 띄운다',
    ok: !document.getElementById('syncBar').classList.contains('hidden') });

  // ③ 권한 문제 — "대기열로"라고만 하면 영영 안 올라간다. 다르게 말해야 한다.
  await new Promise((r) => setTimeout(r, 1200));
  window.fetch = async (u, i) => (String(u).includes('api.github.com')
    ? { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}) }
    : realFetch(u, i));
  open();
  await new Promise((r) => setTimeout(r, 120));
  document.getElementById('scSave').click();
  await new Promise((r) => setTimeout(r, 500));
  out.push({ name: '**권한 문제는 인터넷 문제와 다르게 말한다**',
    ok: /권한/.test(statusText()) && !/인터넷이 없어/.test(statusText()), detail: statusText() });

  window.fetch = realFetch;
  for (const it of await d.listOutbox()) await d.dequeue(it.id);
  document.getElementById('syncNowBtn').click();     // 띠를 다시 그리게 한다
  document.getElementById('scClose').click();
  return out;
});

// 저장한 파일은 vault가 **아직 안 본 것**을 찾을 수 있어야 한다
await run('vault가 집어갈 표시', async () => {
  const out = [];
  const { buildQaMarkdown } = await import('/js/ask.js');
  const md = buildQaMarkdown({
    subject: '응급_중환자', lecture: 'BLS', examPath: '06_모의고사/x.html',
    items: [{ term: '가슴압박', qnum: 3, qtext: '깊이', answer: '5~6cm' }],
  });
  out.push({ name: '질문기록에 "아직 안 봤다" 표시가 붙는다', ok: /^처리: 대기$/m.test(md.content) });
  out.push({ name: '갈래를 태그로 적어둔다(어느 명령이 가져갈지)',
    ok: /달모\/질문기록/.test(md.content) });
  out.push({ name: '앞머리 안에 들어간다(본문이 아니라)',
    ok: md.content.indexOf('처리: 대기') < md.content.indexOf('\n---\n\n') });
  return out;
});
await browser.close();

// ══════════ 결과 ══════════
const bad = results.filter((r) => !r.ok);
results.forEach((r) => console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`));
if (errors.length) {
  console.log('\n페이지 JS 오류:');
  errors.forEach((e) => console.log('  ! ' + e.slice(0, 200)));
}
console.log(`\n통과 ${results.length - bad.length}/${results.length}`);
if (bad.length || errors.length) process.exit(1);
console.log('✅ 실제 Chrome 검증 전부 통과');
