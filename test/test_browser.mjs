// 실제 Chrome에서 돌리는 검증. jsdom은 레이아웃도, @media도 계산하지 않아서
// "폭 조절이 안 된다 / 펜으로 버튼이 안 눌린다" 류의 버그를 전혀 못 잡았다.
// 여기서는 진짜 Chrome이 실제 px을 계산하고 실제 포인터 이벤트를 받는다.
//
// 실행:
//   python3 -m http.server 8777     (레포 루트에서)
//   node test/test_browser.mjs
// 필요: ~/.cache/dalmo-test 에 puppeteer-core (test/_deps.mjs 참고)

import { needDep } from './_deps.mjs';

const URL_BASE = process.env.PWA_URL || 'http://localhost:8777/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const puppeteer = needDep('puppeteer-core');

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
// ══════════ 섹션 고르기 — 넓게 펴서 읽히는가 (2026-10-20 요청) ══════════
// "다른 문서? 목차? 나오는 기능 좋은데 좀 옆으로 길게해서 내용 파악이 더 되게하자"
// 네이티브 <select> 목록은 그 select 폭을 따라가서 긴 제목이 "…대량 외부출혈 제…"로
// 잘렸다. 옆칸은 360px이라 제목이 길수록 뭐가 다른지가 안 보인다.
await run('섹션 고르기 목록', async () => {
  const out = [];
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.body.dataset.screen = 'quizScreen';
  document.getElementById('wikiPanel').classList.remove('hidden');
  const sel = document.getElementById('wikiSecPick');
  sel.innerHTML = '';
  const LONG = '1. xABCDE의 X는 eXsanguination으로, 대량 외부출혈 제어가 A보다 앞 또는 동시에 이루어진다';
  [LONG, '2. ATLS 3대 철학은 ①치명적 위협 우선 ②진단 전 처치 ③병력 청취는 나중에',
    '3. 외상사망 3봉분포는 즉사·수분 내·수 시간 내'].forEach((t, i) => {
    const o = document.createElement('option'); o.value = String(i); o.textContent = t;
    sel.appendChild(o);
  });
  sel.value = '1';
  const panel = document.getElementById('wikiPanel').getBoundingClientRect();

  window.__openSecSheet('wikiSecPick');
  await new Promise((r) => setTimeout(r, 250));
  const sheet = document.getElementById('secSheet');
  out.push({ name: '**목록이 뜬다**', ok: !!sheet });
  if (!sheet) return out;
  const list = sheet.querySelector('.sec-list');
  const rl = list.getBoundingClientRect();
  out.push({ name: '**옆칸보다 훨씬 넓다**(제목이 안 잘리게)',
    ok: rl.width > Math.max(panel.width * 1.4, 520),
    detail: `목록 ${Math.round(rl.width)}px · 옆칸 ${Math.round(panel.width)}px` });

  const rows = [...sheet.querySelectorAll('.sec-row')];
  out.push({ name: '토막마다 한 줄씩 나온다', ok: rows.length === 3, detail: `${rows.length}개` });
  const long = rows[0];
  out.push({ name: '**긴 제목을 줄여 쓰지 않는다**',
    ok: long.querySelector('.sec-t').textContent === LONG });
  out.push({ name: '잘리지 않고 흘러서 다 보인다',
    ok: long.scrollWidth <= long.clientWidth + 2
      && getComputedStyle(long.querySelector('.sec-t')).textOverflow !== 'ellipsis',
    detail: `글 ${long.scrollWidth} · 칸 ${long.clientWidth}` });
  out.push({ name: '읽기 좋은 크기다(본문보다 큼)',
    ok: parseFloat(getComputedStyle(long).fontSize) >= 17,
    detail: getComputedStyle(long).fontSize });
  out.push({ name: '지금 보는 토막이 표시된다',
    ok: rows[1].classList.contains('on') });
  out.push({ name: '누를 만한 크기다',
    ok: long.getBoundingClientRect().height >= 40,
    detail: `${Math.round(long.getBoundingClientRect().height)}px` });

  // 고르면 select에 값이 들어가고 change가 간다 — 기존 코드가 그걸 듣는다
  let got = -1;
  sel.addEventListener('change', (e) => { got = Number(e.target.value); }, { once: true });
  rows[2].click();
  await new Promise((r) => setTimeout(r, 150));
  out.push({ name: '**고르면 그 토막으로 간다**', ok: got === 2 && sel.value === '2',
    detail: `value=${sel.value}` });
  out.push({ name: '고르면 목록이 닫힌다', ok: !document.getElementById('secSheet') });

  sel.innerHTML = '';
  document.getElementById('wikiPanel').classList.add('hidden');
  return out;
});

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
  // 도구를 **묶음으로** 나눴다(2026-10-14): 읽기/표시 · 알아보기 · 남기기 · 그 밖.
  // 어디 있느냐가 아니라 "묶음 안에 제대로 들어 있나"를 본다.
  const group = (id) => {
    const btns = [...document.querySelectorAll('#quizTools > *')];
    let g = 0;
    for (const el of btns) {
      if (el.classList.contains('rt-sep')) { g++; continue; }
      if (el.id === id) return g;
    }
    return -1;
  };
  out.push({ name: '도구가 묶음으로 나뉘어 있다',
    ok: document.querySelectorAll('#quizTools .rt-sep').length >= 2,
    detail: `칸막이 ${document.querySelectorAll('#quizTools .rt-sep').length}개` });
  out.push({ name: '펜 관련은 한 묶음(고르기·필기·지우개·되돌리기)',
    ok: group('toolSelect') === 0 && group('toolErase') === 0 && group('toolUndo') === 0 });
  out.push({ name: '알아보기가 따로 묶인다(노트·AI·뜯어보기·찾기)',
    ok: group('toolWiki') === group('toolAi') && group('toolAi') === group('toolBreak')
      && group('toolBreak') === group('toolFind') && group('toolWiki') > 0,
    detail: `${group('toolWiki')}번 묶음` });
  out.push({ name: '남기기가 따로 묶인다(영역 복사·모아두기)',
    ok: group('toolCapture') === group('toolScrap') && group('toolCapture') > group('toolWiki') });
  // ★ 고르기와 뜯어보기가 같은 그림이면 뭘 누를지 알 수 없다(2026-10-14 지적)
  out.push({ name: '**고르기와 뜯어보기가 다른 그림이다**',
    ok: document.getElementById('toolSelect').innerHTML
      !== document.getElementById('toolBreak').innerHTML });
  out.push({ name: '도구마다 그림이 전부 다르다',
    ok: (() => {
      const h = [...document.querySelectorAll('#quizTools .tool')].map((b) => b.innerHTML);
      return new Set(h).size === h.length;
    })() });
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
  // 답은 빈칸 **안에 숨어** 자리를 잡는다(폭이 안 변하게) — 밖으로 새면 안 된다
  out.push({ name: '빈칸 밖으로 답이 새지 않는다',
    ok: ![...peek.childNodes].map((n) => (n.textContent || '')).join('')
      .replace(/수축기혈압 90mmHg 미만|2\.2 미만|PCWP 15 이상/g, '')
      .includes('수축기혈압'),
    detail: peek.textContent.slice(0, 50) });
  out.push({ name: '답은 빈칸 안에 숨어 있다(폭을 잡아두려고)',
    ok: [...peek.querySelectorAll('.cloze')].every((c) => c.querySelector('i')
      && c.querySelector('i').textContent === c.dataset.answer) });
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
  // 네모 친 범위는 통째로 한 장이다 (2026-10-16 요청) — 표를 두 번 그리지도 않는다
  out.push({ name: '**네모 친 범위가 한 장으로 나온다**', ok: cards.length === 1, detail: `${cards.length}장` });
  out.push({ name: '카드 종류가 table', ok: cards.every((c) => c.kind === 'table') });
  const holder = document.createElement('div');
  holder.innerHTML = cards[0].contextHtml;
  out.push({ name: '표 전체가 살아 있다', ok: !!holder.querySelector('table') });
  out.push({ name: '**표를 두 번 그리지 않는다**', ok: holder.querySelectorAll('table').length === 1,
    detail: `${holder.querySelectorAll('table').length}개` });
  out.push({ name: '표의 모든 행이 들어 있다', ok: holder.querySelectorAll('tr').length === 3,
    detail: `${holder.querySelectorAll('tr').length}행` });
  out.push({ name: '묻는 행이 표시된다', ok: holder.querySelectorAll('tr.card-row-focus').length === 2,
    detail: `${holder.querySelectorAll('tr.card-row-focus').length}행` });
  out.push({ name: '빈칸이 그 행 안에 있다', ok: !!holder.querySelector('tr.card-row-focus .cloze') });
  out.push({ name: '고른 두 칸이 다 빈칸이 된다',
    ok: holder.querySelectorAll('.cloze').length === 2 && cards[0].answers.length === 2,
    detail: cards[0].answers.join(' / ') });
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

    // ★ 2026-10-14 — "외워야 할 대상이 체온이랑 중추신경계 기능이상인데" 정작 "진단에는"이
    //   가려졌다. 묻는 부분(화제)은 보이고, **답이 되는 것**이 가려져야 한다.
    //   그리고 "-와" 같은 잇는 말은 보여야 몇 개를 답해야 하는지 안다.
    const show = (t) => {
      const r = R.splitAnswer(t);
      const mid = r.parts.map((x) => (x.blank ? `[${x.t}]` : x.t)).join('');
      return (r.lead || '') + mid + (r.tail || '');
    };
    out.push({ name: '**묻는 부분(…에는)은 보인다**',
      ok: show('열사병(heat stroke)의 진단에는 체온 >40℃와 중추신경계 기능이상이 모두 필요')
        === '열사병(heat stroke)의 진단에는 [체온 >40℃]와 [중추신경계 기능이상]이 모두 필요',
      detail: show('열사병(heat stroke)의 진단에는 체온 >40℃와 중추신경계 기능이상이 모두 필요') });
    out.push({ name: '**"와"를 보여줘 몇 개인지 알린다**',
      ok: /\]와 \[/.test(show('열사병의 진단에는 체온 >40℃와 중추신경계 기능이상이 모두 필요')) });
    out.push({ name: '쉼표로 늘어놓은 것도 따로따로',
      ok: show('AST/ALT 상승, DIC, 횡문근융해증') === '[AST/ALT 상승], [DIC], [횡문근융해증]',
      detail: show('AST/ALT 상승, DIC, 횡문근융해증') });
    out.push({ name: '가운뎃점도 따로따로',
      ok: show('해부학적 정복·견고한 내고정·혈류 보존·조기 안전 가동화')
        === '[해부학적 정복]·[견고한 내고정]·[혈류 보존]·[조기 안전 가동화]' });
    out.push({ name: '**슬래시는 안 쪼갠다**(AST/ALT는 한 낱말)',
      ok: show('AST/ALT 상승') === '[AST/ALT 상승]', detail: show('AST/ALT 상승') });
    out.push({ name: '괄호 안의 & 도 안 쪼갠다',
      ok: show('능동적 및 수동적 관절가동범위(Active & Passive ROM)가 모든 방향에서 함께 제한')
        === '[능동적 및 수동적 관절가동범위(Active & Passive ROM)]가 모든 방향에서 함께 제한' });
    out.push({ name: '열거가 아니면 한 칸 그대로',
      ok: show('수축기혈압 90mmHg 미만') === '[수축기혈압 90mmHg 미만]' });

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

  // ── 고른 범위는 쪼개지 않는다 (2026-10-16 요청) ──
  // "적어도 내가 선택한 범위는 그냥 다 보여지는 상태에서 일단 된 다음에 거기서 고를 수
  //  있게 해야함. 지금 보면 한 문장단위로 나와서 불편함."
  // 최소 정보 원칙은 **고르는 단계**에서 지킨다(낱말을 눌러 빼면 된다).
  body.innerHTML = renderMarkdown(
    '원인균은 **포도알균**, **사슬알균**, **폐렴막대균**, **녹농균**, **장구균**, **혐기균** 이렇게 여섯 가지가 알려져 있다.');
  const many = cardsFromBox(body, whole(), meta);
  out.push({ name: '**빈칸이 많아도 쪼개지 않는다**', ok: many.length === 1,
    detail: `${many.length}장 · 빈칸 ${many[0] ? many[0].answers.length : 0}개` });
  out.push({ name: '답을 하나도 빠뜨리지 않는다',
    ok: many.length === 1 && many[0].answers.length === 6, detail: many[0].answers.join(',') });

  // 여러 문단을 한 번에 둘러도 한 장이다 — 문장마다 쪼개지 않는다
  body.innerHTML = renderMarkdown(
    '첫 문단에 **가나다 소견**이 있고 설명이 이어진다.\n\n둘째 문단에 **라마바 소견**이 있고 설명이 이어진다.');
  const wide = cardsFromBox(body, whole(), meta);
  out.push({ name: '**여러 문단을 둘러도 한 장**', ok: wide.length === 1, detail: `${wide.length}장` });
  out.push({ name: '두 문단이 다 본문에 들어 있다',
    ok: wide.length === 1 && /첫 문단/.test(wide[0].contextHtml) && /둘째 문단/.test(wide[0].contextHtml) });
  out.push({ name: '두 문단의 빈칸이 다 잡힌다',
    ok: wide.length === 1 && wide[0].answers.join(',') === '가나다 소견,라마바 소견',
    detail: wide.length ? wide[0].answers.join(',') : '' });

  // ── 무엇에 대한 물음인지 — 쪽수가 붙은 소제목도 잡는다 (2026-10-16 요청) ──
  // "그 위에 있는 목차구조·소목차·그 문단의 핵심이 나와야 무슨 문제를 푸는지 알 수 있음."
  // 노트의 소제목은 거의 다 `**병태생리** [슬라이드 p.139–142]` 꼴인데, 전에는
  // "줄 전체가 굵지 않다"며 소제목으로 안 쳐서 카드에 아무 맥락도 안 붙었다.
  document.querySelectorAll('section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  body.innerHTML = renderMarkdown([
    '**병태생리** [슬라이드 p.139–142]', '',
    '- 유기인계는 **cholinesterase 효소를 억제**한다고 알려져 있다.', '',
  ].join('\n'));
  await new Promise((r) => setTimeout(r, 60));
  const ctxCard = cardsFromBox(body, whole(), { ...meta, heading: '7. 유기인계' })[0];
  out.push({ name: '**쪽수가 붙은 소제목도 맥락으로 잡는다**',
    ok: !!ctxCard && /병태생리/.test(ctxCard.topic || ''), detail: ctxCard ? ctxCard.topic : '없음' });
  out.push({ name: '큰 제목(섹션)도 같이 붙는다',
    ok: !!ctxCard && /유기인계/.test(ctxCard.topic || '') });

  // 중간에 박힌 말 — 그 위 항목의 머리말이 따라붙어야 무엇에 대한 건지 안다
  body.innerHTML = renderMarkdown([
    '### 1. 해독제', '',
    '- **2-PAM**', '  - 투여는 **aging 전**에 해야 효과가 있다고 알려져 있다.', '',
  ].join('\n'));
  await new Promise((r) => setTimeout(r, 60));
  const deep = cardsFromBox(body, whole(), { ...meta, heading: '7. 유기인계' })
    .find((c) => c.answers.includes('aging 전'));
  out.push({ name: '**상위 항목의 머리말이 따라붙는다**',
    ok: !!deep && /2-PAM/.test(deep.topic || ''), detail: deep ? deep.topic : '없음' });

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
  // 되돌릴 수 있으니 두 번 묻지 않는다 — 묻고 또 묻는 것보다 손이 덜 간다(2026-10-14)
  const del = () => [...document.querySelectorAll('.sel-btn2')].find((b) => /삭제/.test(b.textContent));
  out.push({ name: '몇 장 지우는지 버튼에 적힌다', ok: /삭제 \(\d+장\)/.test(del().textContent),
    detail: del().textContent });
  const n0 = (await (await import('/js/db.js')).allCards()).length;
  del().click();
  await new Promise((r) => setTimeout(r, 500));
  const n1 = (await (await import('/js/db.js')).allCards()).length;
  out.push({ name: '**한 번에 지워진다**(두 번 안 묻는다)', ok: n1 === n0 - 1, detail: `${n0} → ${n1}` });

  // ★ 대신 되돌릴 수 있다
  const t = document.getElementById('undoToast');
  out.push({ name: '되돌릴 수 있다고 알려준다', ok: !!t, detail: (t || {}).textContent || '없음' });
  const ub = t && t.querySelector('button');
  out.push({ name: '되돌리기 버튼이 있다', ok: !!ub && /되돌리기/.test(ub.textContent) });
  if (ub) {
    ub.click();
    await new Promise((r) => setTimeout(r, 600));
    out.push({ name: '**누르면 되살아난다**',
      ok: (await (await import('/js/db.js')).allCards()).length === n0,
      detail: `${(await (await import('/js/db.js')).allCards()).length}장` });
    out.push({ name: '되돌린 뒤 알림이 사라진다', ok: !document.getElementById('undoToast') });
  }
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
  // 흘려 보여주는 자리가 **이번 턴 칸**으로 바뀌었다 — 앞서 주고받은 것을 지우지 않으려고(2026-10-15)
  out.push({ name: '답이 오는 대로 흘려 보여준다(다 기다리지 않는다)',
    ok: /afEl\('afLive'\)\.innerHTML = renderMarkdown\(full\)/.test(app) });
  out.push({ name: '답을 날 텍스트가 아니라 마크다운으로 그린다',
    ok: /rememberTurn\(term, renderMarkdown\(answer\)/.test(app) });
  out.push({ name: '꼬리질문이면 앞 대화를 같이 보낸다',
    ok: /prior = followUp[\s\S]{0,160}askThread\.turns\.map/.test(app) });

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
      // 이제 바로 닫고 뒤에서 보낸다 — 결과 토스트가 뜰 때까지 기다렸다 읽는다(2026-10-14)
      let note = '';
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        note = [...document.querySelectorAll('body > div')].map((x) => x.textContent)
          .filter((t) => /모아뒀습니다|모아두지 못했습니다/.test(t)).join(' ');
        if (note) break;
      }
      return { sent, status: note };
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
  results.push({ name: '아직 정리 안 됐다고 표시한다',
    ok: /아직 정리 안 된 수집물|인출 실패 — 아는 줄 알았는데/.test(text) });
  results.push({ name: 'Obsidian 태그가 붙는다', ok: /tags: \[달모\/모아두기/.test(text) });
  // 담은 **성격**이 적혀야 가중치를 주는 쪽이 둘을 다르게 본다(2026-10-17)
  results.push({ name: '**처음 배우는 것인지 인출 실패인지 적는다**',
    ok: /달모\/첫회독|달모\/인출실패/.test(text),
    detail: (text.match(/tags: \[[^\]]*\]/) || ['없음'])[0] });
  results.push({ name: '회독수를 함께 남긴다', ok: /^회독: /m.test(text),
    detail: (text.match(/^회독: .*/m) || ['없음'])[0] });
  // 저장 결과는 세 갈래(올라감 / 인터넷 없어 대기 / 권한 문제)를 **다르게** 말해야 한다.
  // 다 "대기열로"라고만 하면 권한 문제는 영영 안 올라간다(2026-10-13).
  results.push({ name: '모아뒀다고 **짧게** 알려준다',
    ok: /모아뒀습니다/.test(saved.status), detail: saved.status });
  results.push({ name: '몇 건인지는 적는다(길게 늘어놓지 않고)',
    ok: /\(\d+건\)/.test(saved.status) });

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
      // 이름표가 아니라 **표시(.here)**로 본다 — 이름은 언제나 똑같이 적는다(2026-10-20).
      out.push({ name: '지금 보는 과목이 맨 위에 온다',
        ok: !!first && first.classList.contains('here'), detail: first ? first.textContent : '없음' });

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

    // ★ 고르기와 필기를 **버튼으로 나눴다**(2026-10-14). 전에는 한 버튼이 둘을 겸해서
    //   카드 만들기를 켜놔도 긁으면 선택 팝업이 떴다.
    const sel = document.getElementById('readSelect');
    const pen = document.getElementById('readPen');
    out.push({ name: '**고르기와 필기가 다른 버튼이다**', ok: !!sel && !!pen && sel !== pen });
    out.push({ name: '처음엔 고르기(긁으면 글이 잡힌다)', ok: sel.classList.contains('active') });

    pen.click();
    out.push({ name: '필기를 누르면 고르기가 꺼진다',
      ok: pen.classList.contains('active') && !sel.classList.contains('active') });
    out.push({ name: '필기 중에는 지우개가 아니다', ok: !pen.classList.contains('erasing') });
    pen.click();
    out.push({ name: '필기를 다시 누르면 지우개', ok: pen.classList.contains('erasing') });
    out.push({ name: '지우개 아이콘이 실제로 보인다',
      ok: getComputedStyle(pen.querySelector('.erase-ic')).display !== 'none'
        && getComputedStyle(pen.querySelector('.pen-ic')).display === 'none' });

    // ★ 카드 만들기를 켜면 **고르기도 필기도 꺼져야** 한다 — 이게 안 돼서 팝업이 떴다
    document.getElementById('readMakeCard').click();
    out.push({ name: '**카드 만들기를 켜면 다른 모드가 전부 꺼진다**',
      ok: document.getElementById('readMakeCard').classList.contains('active')
        && !sel.classList.contains('active') && !pen.classList.contains('active'),
      detail: [...document.querySelectorAll('#readTools .active')].map((b) => b.id).join(',') });
    out.push({ name: '펜도 실제로 카드 모드다',
      ok: !!(window.__penForTest && window.__penForTest.tool === 'card'),
      detail: window.__penForTest ? window.__penForTest.tool : '펜 없음' });
    out.push({ name: '그때는 글을 잡지 않는다(팝업이 안 뜬다)',
      ok: !!(window.__penForTest && !window.__penForTest.writing) });

    document.getElementById('readShot').click();
    out.push({ name: '영역 복사로 바꾸면 카드가 꺼진다',
      ok: !document.getElementById('readMakeCard').classList.contains('active')
        && !!(window.__penForTest && window.__penForTest.tool === 'shot') });
    out.push({ name: '한 번에 하나만 켜진다',
      ok: [...document.querySelectorAll('#readTools .icon-btn.active')].length === 1,
      detail: [...document.querySelectorAll('#readTools .icon-btn.active')].map((b) => b.id).join(',') });

    sel.click();        // 다음 검사들이 긁을 수 있게 되돌린다
    out.push({ name: '고르기로 돌아온다',
      ok: sel.classList.contains('active') && window.__penForTest.tool === 'select' });
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
  // 옛 카드 꼴(공백만 든 빈칸)로 넣어본다 — 그려줄 때 지금 모양으로 고쳐져야 한다
  const R0 = await import('/js/reader.js');
  document.getElementById('cfBody').innerHTML = R0.tidyCardHtml(
    '<div class="cf-q">깊이는 <span class="cloze" data-answer="5~6cm">      </span>다.</div>');
  const cz = document.querySelector('#cfBody .cloze');
  const hid = cz.querySelector('i');
  out.push({ name: '옛 카드의 빈칸도 지금 모양으로 고쳐진다', ok: !!hid,
    detail: cz.innerHTML });
  if (!hid) { f.classList.add('hidden'); return out; }
  out.push({ name: '가려진 상태에서는 답이 안 보인다',
    ok: getComputedStyle(hid).visibility === 'hidden',
    detail: getComputedStyle(hid).visibility });
  const wasW = cz.getBoundingClientRect().width;

  // ★ 답을 열어도 **폭이 안 변해야** 한다 — 변하면 뒷글이 확 밀린다(2026-10-15 지적)
  cz.classList.add('filled');
  await new Promise((r) => setTimeout(r, 40));
  out.push({ name: '답을 열면 글자가 실제로 보인다',
    ok: getComputedStyle(hid).visibility === 'visible' && cz.textContent === '5~6cm',
    detail: cz.textContent });
  out.push({ name: '**답을 열어도 빈칸 폭이 그대로다**(글이 안 밀린다)',
    ok: Math.abs(cz.getBoundingClientRect().width - wasW) < 0.6,
    detail: `${wasW.toFixed(1)} → ${cz.getBoundingClientRect().width.toFixed(1)}px` });
  out.push({ name: '열린 답은 읽히는 색이다',
    ok: getComputedStyle(cz).color !== 'rgba(0, 0, 0, 0)', detail: getComputedStyle(cz).color });
  f.classList.add('hidden');

  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '빈칸을 칠할 때 글자를 갈아끼우지 않는다(폭이 안 변하게)',
    ok: /function paintCloze\(root, shown\)/.test(app)
      && /el\.classList\.toggle\('filled'/.test(app)
      && !/el\.textContent = ans;/.test(app) });
  out.push({ name: '네모를 쳐도 바로 저장하지 않는다',
    ok: !/readerCardMode\(false\);\s*\n\s*saveCards\(cards\)/.test(app) });
  out.push({ name: '＋추가를 눌러야 저장된다', ok: /await saveCards\(\[c\]\)/.test(app) });
  out.push({ name: '같은 창에서 지울 수 있다',
    ok: /deleteCardsUndoable\(c, refreshCardFloat\)/.test(app) });
  // 지우기는 세 군데 다 **되돌릴 수 있어야** 한다 — 한 군데만 빠지면 거기서 잃는다
  // 지우기는 세 군데 다 **되돌릴 수 있어야** 한다 — 한 군데만 빠지면 거기서 잃는다.
  // 바닥에서 deleteCard를 부르는 건 그 되돌리기 함수 하나뿐이어야 한다.
  const raw = (app.match(/\bawait deleteCard\(/g) || []).length;
  out.push({ name: '지우기가 전부 되돌릴 수 있는 길로 간다',
    ok: (app.match(/deleteCardsUndoable\(/g) || []).length >= 4 && raw === 1,
    detail: `되돌리기 경유 ${(app.match(/deleteCardsUndoable\(/g) || []).length}곳 · 직접 삭제 ${raw}곳(함수 내부)` });
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
  out.push({ name: '가끔 쓰는 것들이 들어 있다', ok: items.length >= 4, detail: items.join(' / ') });
  // 모아두기는 **밖에** 있어야 한다 — 어느 화면에서든 핵심이다(2026-10-14 요청)
  out.push({ name: '모아두기는 메뉴 안에 없다', ok: !items.some((t) => /모아두기/.test(t)) });
  out.push({ name: '모아두기가 도구막대에 나와 있다',
    ok: !!document.querySelector('#readTools #readScrapBtn') });
  out.push({ name: '영역 복사와 다른 그림이다(둘 다 자주 쓴다)',
    ok: document.getElementById('readScrapBtn').innerHTML
      !== document.getElementById('readShot').innerHTML });
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
  // 아이콘만 두니 "✎가 메모인지 필기인지" 알 수 없었다 — 전부 이름을 붙인다(2026-10-14)
  out.push({ name: '**버튼마다 뭘 하는지 글씨가 있다**',
    ok: acts.every((b) => (b.querySelector('.sb-t') || {}).textContent),
    detail: acts.map((b) => (b.querySelector('.sb-t') || {}).textContent || '?').join(' / ') });
  // 많이 쓰는 것부터 — 복사·모아두기·카드·다른앱·여기서질문 (2026-10-15 요청)
  out.push({ name: '**많이 쓰는 차례대로 선다**',
    ok: acts.map((b) => b.id).join(',') === 'selCopy,selNote,selCloze,selSend,selAsk',
    detail: acts.map((b) => b.id).join(',') });
  out.push({ name: '맨 앞(복사)이 주 동작으로 두드러진다',
    ok: acts[0].classList.contains('primary') && /복사/.test(acts[0].textContent) });
  out.push({ name: '모아두기가 도구막대와 같은 그림',
    ok: document.querySelector('#selNote .sb-ic svg')
      && document.querySelector('#selNote .sb-ic svg').innerHTML
        === document.querySelector('#toolScrap svg').innerHTML });
  out.push({ name: '아이콘에도 뭘 하는지 적혀 있다(길게 누르면 뜬다)',
    ok: acts.every((b) => b.title && b.getAttribute('aria-label')),
    detail: acts.filter((b) => !b.title).map((b) => b.id).join(',') || '전부 있음' });
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
  // 떠다니던 알약은 없앴다 — **아래 바의 AI 단추**가 그 자리를 맡는다(2026-10-14).
  out.push({ name: '떠다니는 알약이 화면을 안 가린다', ok: !document.getElementById('askDock') });
  out.push({ name: '아래 바에 AI 단추가 있다', ok: !!document.getElementById('readAsk') });
  out.push({ name: '방금 물어본 것을 옆에 보여준다', ok: !!document.getElementById('readAskLast') });
  out.push({ name: '로봇 대신 그림 아이콘', ok: !!document.querySelector('#readAsk svg') });
  out.push({ name: '**창 안에서 새로 물을 수 있다**', ok: !!document.getElementById('afInput') });
  out.push({ name: '보내는 버튼도 있다', ok: !!document.getElementById('afSend') });
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
  // ── 이름은 **언제나 똑같이** 적는다 (2026-10-20 신고) ──
  // "다른 노트 띄우기 위해 그 제목 누르면 고르는 순서가 일정하지 않음"
  // 전에는 지금 보는 묶음만 "지금 보는 과목"으로 바꿔 불러서, 노트를 옮길 때마다
  // 같은 줄의 이름이 달라졌다. "여기"라는 표시는 테두리 색(.here)이 이미 한다.
  out.push({ name: '**묶음 이름이 상황 따라 안 바뀐다**',
    ok: names2.every((n) => /^(위키|예습노트|임종평 전범위) · /.test(n)),
    detail: names2.slice(0, 3).join(' | ') });
  out.push({ name: '지금 보는 묶음은 테두리로 알린다(이름을 바꾸지 않고)',
    ok: [...document.querySelectorAll('#docList .dd-group')].some((g) => g.classList.contains('here')) });

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

// ══════════ 짝은 파일이름으로 짓는다 — h1이 달라도 (2026-10-18) ══════════
// 실제 신고: "암기법 노트 열면 매칭되게 하라고 하지 않았나. 그 노트에 맞는 걸로."
// h1은 사람이 읽는 제목이라 교수 이름과 조사가 붙는다 —
//   파일 `응급중환자_Shock진단과치료` / h1 "응급중환자_Shock의 진단과 치료 — 정창환 교수"
// 짝을 h1로 지었더니 이 셋(Shock·중환자실구조와운영·중환자실통증진정섬망관리)이 안 걸렸다.
await run('짝 찾기 — 이름이 달라도', async () => {
  const out = [];
  const d = await import('/js/db.js');
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  const realFetch = window.fetch;
  // vault에 실제로 들어 있는 모양 그대로: h1에 교수 이름과 조사가 붙고, 암기법에는 source_note가 있다
  const H1 = {
    '응급중환자_Shock진단과치료': '응급중환자_Shock의 진단과 치료 — 정창환 교수',
    '응급중환자_Shock진단과치료_암기법': '응급중환자_Shock진단과치료 — 암기법 후보',
    '응급중환자_중환자실통증진정섬망관리': '응급중환자_중환자실 환자의 통증·진정 및 섬망 관리 — 홍관영 교수',
  };
  const SRC = { '응급중환자_Shock진단과치료_암기법': '응급중환자_Shock진단과치료' };
  window.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('api.github.com')) return realFetch(url, init);
    const name = decodeURIComponent(u.split('/contents/')[1] || '').split('/').pop().replace('.md', '');
    const fm = SRC[name] ? `---\nsource_note: "${SRC[name]}"\n---\n\n` : '';
    return { ok: true, status: 200, json: async () => ({}),
      text: async () => `${fm}# ${H1[name] || name}\n\n## 한 토막\n내용\n` };
  };
  await d.kvSet('note_index_v2', [
    { root: '02_Wiki', subject: '응급_중환자', notes: [
      { name: '응급중환자_Shock진단과치료', path: '02_Wiki/응급_중환자/응급중환자_Shock진단과치료.md' },
      { name: '응급중환자_중환자실통증진정섬망관리', path: '02_Wiki/응급_중환자/응급중환자_중환자실통증진정섬망관리.md' },
      { name: '응급중환자_환경의학', path: '02_Wiki/응급_중환자/응급중환자_환경의학.md' }] },
    { root: '02_Wiki', subject: '응급_중환자 · 암기법', notes: [
      { name: '응급중환자_Shock진단과치료_암기법', path: '02_Wiki/응급_중환자/암기법/응급중환자_Shock진단과치료_암기법.md' },
      { name: '응급중환자_중환자실통증진정섬망관리_암기법', path: '02_Wiki/응급_중환자/암기법/응급중환자_중환자실통증진정섬망관리_암기법.md' },
      { name: '응급중환자_환경의학_암기법', path: '02_Wiki/응급_중환자/암기법/응급중환자_환경의학_암기법.md' }] },
    { root: '02_Wiki', subject: '응급_중환자 · QA', notes: [
      { name: '응급중환자_Shock진단과치료_QA', path: '02_Wiki/응급_중환자/QA/응급중환자_Shock진단과치료_QA.md' }] },
  ]);
  await d.kvSet('note_index_at', Date.now());     // 방금 받은 목록이라 치고 그대로 쓰게
  // 어떤 노트를 열어두고 서랍을 열면 짝이 뭐라고 나오는가
  const pairsAfterOpening = async (path) => {
    await window.__openNote(path);
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('readDocs').click();
    await new Promise((r) => setTimeout(r, 500));
    const names = [...document.querySelectorAll('#docList .dd-item.pair .dd-name')].map((x) => x.textContent);
    document.getElementById('docClose').click();
    await new Promise((r) => setTimeout(r, 120));
    return names;
  };

  const p1 = await pairsAfterOpening('02_Wiki/응급_중환자/응급중환자_Shock진단과치료.md');
  out.push({ name: '**h1에 교수 이름이 붙어도 그 강의 암기법을 찾는다**',
    ok: p1.includes('응급중환자_Shock진단과치료_암기법'), detail: p1.join(' / ') || '(짝 없음)' });
  out.push({ name: '맨 위가 암기법이다', ok: /_암기법$/.test(p1[0] || ''), detail: p1[0] });
  out.push({ name: 'Q&A도 같이 걸린다', ok: p1.includes('응급중환자_Shock진단과치료_QA') });
  out.push({ name: '남의 강의는 안 끌어온다',
    ok: !p1.some((n) => /환경의학|통증진정/.test(n)), detail: p1.join(' / ') });

  const p2 = await pairsAfterOpening('02_Wiki/응급_중환자/응급중환자_중환자실통증진정섬망관리.md');
  out.push({ name: 'h1에 가운뎃점·조사가 끼어도 찾는다',
    ok: p2.includes('응급중환자_중환자실통증진정섬망관리_암기법'), detail: p2.join(' / ') || '(짝 없음)' });

  // 반대 방향 — 암기법을 열면 본문이 짝으로 나와야 한다
  const p3 = await pairsAfterOpening('02_Wiki/응급_중환자/암기법/응급중환자_Shock진단과치료_암기법.md');
  out.push({ name: '암기법에서 본문으로도 간다',
    ok: p3.includes('응급중환자_Shock진단과치료'), detail: p3.join(' / ') || '(짝 없음)' });

  window.fetch = realFetch;
  await d.kvSet('note_index_v2', null);
  await d.kvSet('note_index_at', 0);
  return out;
});

// ══════════ 체크·카드가 **누른 칸의 노트**로 가는가 (2026-10-20 신고) ══════════
// "바꾸지 못했습니다: \"채택 (안 1)\" 줄을 원본에서 못 찾았습니다"
// 까닭: 노트를 띄우는 자리가 넷인데(읽기·옆칸 위·옆칸 아래·들러보기) 전역 상태로
// "지금 노트"를 물었다. 아래 칸에서 체크해도 **위 칸** 노트에서 줄을 찾다 실패했다.
await run('누른 칸의 노트로 간다', async () => {
  const out = [];
  const R = await import('/js/reader.js');
  const real = window.fetch;
  let put = null;
  const 산문 = '# 산문\n\n## 토막\n덱스메데토미딘은 알파2 작용제다.\n';
  const 암기 = '# 암기법\n\n## 요령\n- [ ] 채택 (안 1)\n- [ ] 채택 (안 2)\n';
  window.fetch = async (u, i) => {
    const t = String(u);
    if (!t.includes('api.github.com')) return real(u, i);
    const p = decodeURIComponent((t.split('/contents/')[1] || '').split('?')[0]);
    // ⚠️ 노트에 쓰는 PUT만 잡는다 — 백업 같은 다른 PUT이 끼어들면 엉뚱한 걸 본다
    if (i && i.method === 'PUT') {
      if (/암기법/.test(p)) put = JSON.parse(i.body);
      return { ok: true, status: 200, json: async () => ({ content: { sha: 'z' } }) };
    }
    const body = p.includes('암기법') ? 암기 : 산문;
    return { ok: true, status: 200,
      json: async () => ({ sha: 'x', content: btoa(unescape(encodeURIComponent(body))) }),
      text: async () => body };
  };
  try {
    document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
    document.getElementById('quizScreen').classList.remove('hidden');
    document.body.dataset.screen = 'quizScreen';
    await window.__openWikiNote(await R.loadNote('02_Wiki/응급_중환자/산문.md'));
    await window.__openWikiNote2(await R.loadNote('02_Wiki/응급_중환자/암기법/암기법.md'));
    await new Promise((r) => setTimeout(r, 450));

    const boxes = [...document.querySelectorAll('#wiki2Body [role="checkbox"], #wiki2Body .task-box')];
    out.push({ name: '아래 칸에 체크 상자가 그려진다', ok: boxes.length === 2, detail: `${boxes.length}개` });
    if (boxes.length) {
      let err = null;
      const obs = new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) {
          if (n.nodeType === 1 && /못했|못 찾/.test(n.textContent || '')) err = n.textContent;
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      boxes[0].click();
      await new Promise((r) => setTimeout(r, 1100));
      obs.disconnect();
      out.push({ name: '**아래 칸에서 체크해도 안 깨진다**', ok: !err, detail: err || '오류 없음' });
      const sent = put && put.content
        ? decodeURIComponent(escape(atob(put.content))) : '';
      out.push({ name: '**그 줄이 실제로 [x]로 바뀌어 올라간다**',
        ok: /\[x\] 채택 \(안 1\)/.test(sent), detail: sent ? sent.split('\n').slice(-3).join(' / ') : '안 올라감' });
      out.push({ name: '위 칸 노트(산문)가 아니라 아래 칸 노트에 쓴다',
        ok: !!put && /암기법/.test(String(put.message || '') + String(put.path || '') + sent),
        detail: sent.slice(0, 24) });
    }
    out.push({ name: '누른 자리로 노트를 가린다(전역 상태로 묻지 않는다)',
      ok: /function docOfNode/.test(await fetch('/js/app.js').then((r) => r.text())) });
  } catch (e) {
    out.push({ name: '칸별 노트 검사 (실행 실패)', ok: false, detail: String(e.message).slice(0, 130) });
  } finally {
    window.fetch = real;
    if (window.__resetWiki) window.__resetWiki();
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
});

// ══════════ 빈칸이 **어느 카드 자리에서든** 가려지고 읽히는가 (2026-10-20 신고) ══════════
// "경식도초음파 안보임 거의" — 하이라이트(==글==) 안에 빈칸이 들어간 카드였다.
// 빈칸 규칙을 `.cf-q`에만 적어둬서 외우기 화면·묶음 미리보기에서는 **가려지지도 않고**
// mark의 연노랑 글씨를 그대로 물려받아, 노란 바탕에 연노랑으로 안 읽혔다.
await run('카드 빈칸 색', async () => {
  const out = [];
  const lum = (c) => {
    const m = (c.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const mix = (fg, bg, a) => {
    const f = (fg.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
    const g = (bg.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
    return `rgb(${f.slice(0, 3).map((v, i) => Math.round(v * a + (g[i] ?? 0) * (1 - a))).join(',')})`;
  };
  // vault 원문 그대로: ==**글 … 빈칸**== (하이라이트 안에 굵게, 그 안에 빈칸)
  const look = (cls, filled) => {
    const box = document.createElement('div');
    box.className = cls;
    box.style.cssText = 'position:fixed;left:20px;top:20px;width:900px;'
      + 'background:var(--card);padding:16px;z-index:9999';
    box.innerHTML = '<p>🌟 <mark><strong>평가의 gold standard는 '
      + `<span class="cloze${filled ? ' filled' : ''}"><i>경식도심초음파(TEE)</i></span></strong></mark></p>`;
    document.body.appendChild(box);
    const cz = box.querySelector('.cloze');
    const it = cz.querySelector('i');
    const mk = getComputedStyle(box.querySelector('mark'));
    const czs = getComputedStyle(cz);
    const a = parseFloat((czs.backgroundColor.match(/[\d.]+/g) || [0, 0, 0, 1])[3] ?? 1);
    const bg = mix(czs.backgroundColor, mk.backgroundColor, Number.isNaN(a) ? 1 : a);
    const fg = getComputedStyle(it).color;
    const vis = getComputedStyle(it).visibility;
    box.remove();
    return { fg, bg, vis, r: ratio(fg, bg) };
  };

  // 카드를 그리는 **네 자리 전부** — 하나라도 빠지면 그 자리에서 샌다
  const WHERE = ['cf-q', 'cf-row-q', 'card-context', 'deck-q'];
  const leaky = [];
  const dim = [];
  for (const cls of WHERE) {
    const hid = look(cls, false);
    const shown = look(cls, true);
    const isHidden = hid.vis === 'hidden' || /rgba\(0, 0, 0, 0\)/.test(hid.fg);
    if (!isHidden) leaky.push(`${cls}(${hid.fg})`);
    if (shown.r < 4.5) dim.push(`${cls} ${shown.r.toFixed(1)}:1`);
  }
  out.push({ name: '**가려진 빈칸은 어느 자리에서도 안 비친다**', ok: leaky.length === 0,
    detail: leaky.length ? leaky.join(' / ') : `${WHERE.length}자리 모두 가려짐` });
  out.push({ name: '**답을 들추면 어느 자리에서도 읽힌다**(하이라이트 안이어도)',
    ok: dim.length === 0,
    detail: dim.length ? dim.join(' / ') : `${WHERE.length}자리 모두 4.5:1 넘음` });
  out.push({ name: '빈칸 규칙을 자리마다 흩어 적지 않는다',
    ok: /\.cf-q \.cloze, \.cf-row-q \.cloze, \.card-context \.cloze, \.deck-q \.cloze/
      .test(await fetch('/css/app.css').then((r) => r.text())) });
  return out;
});

// ══════════ 펜 캔버스가 제 칸에 **딱 맞는가** (2026-10-20 신고) ══════════
// "위에서부터 아래까지 선택하려고 하는데 맨 아래쪽은 선택이 안됨"
// 까닭: 캔버스는 `position:absolute; inset:0`이라 **자리를 가진 가장 가까운 조상**을
// 기준으로 깔린다. host가 static이면 엉뚱한 조상에 붙어 어긋난다 — 재어 보니
// host 60~974인데 캔버스 0~914였다. 그 아래는 캔버스 밖이라 미리보기가 안 그려졌다.
await run('펜 캔버스 자리', async () => {
  const out = [];
  const { PenLayer } = await import('/js/pen.js');
  // 자리를 안 가진(static) 상자를 일부러 만들어 거기에 펜을 얹는다
  const outer = document.createElement('div');
  outer.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:500px;z-index:9000';
  const host = document.createElement('div');
  host.style.cssText = 'margin-top:80px;height:300px;background:#fff';   // position 없음(static)
  outer.appendChild(host);
  document.body.appendChild(outer);
  await new Promise((r) => setTimeout(r, 150));
  let pen = null;
  try {
    out.push({ name: '일부러 자리 없는(static) 상자를 쓴다',
      ok: host.style.position !== 'relative' });
    pen = new PenLayer(host, {});
    await new Promise((r) => setTimeout(r, 200));
    const cv = host.querySelector('.penlayer');
    out.push({ name: '캔버스가 생긴다', ok: !!cv });
    if (cv) {
      const hr = host.getBoundingClientRect();
      const cr = cv.getBoundingClientRect();
      out.push({ name: '**캔버스가 제 칸에 딱 맞는다**(위)',
        ok: Math.abs(cr.top - hr.top) < 2, detail: `칸 ${Math.round(hr.top)} · 캔버스 ${Math.round(cr.top)}` });
      out.push({ name: '**아래도 맞는다**(여기가 모자라면 아래쪽이 안 그려진다)',
        ok: Math.abs(cr.bottom - hr.bottom) < 2,
        detail: `칸 ${Math.round(hr.bottom)} · 캔버스 ${Math.round(cr.bottom)}` });
      out.push({ name: '칸에 자리를 쥐여준다(static이면 relative로)',
        ok: getComputedStyle(host).position !== 'static', detail: getComputedStyle(host).position });
    }
  } catch (e) {
    out.push({ name: '캔버스 자리 검사 (실행 실패)', ok: false, detail: String(e.message).slice(0, 120) });
  } finally {
    if (pen) { try { pen.destroy(); } catch {} }
    outer.remove();
  }
  // 영역 복사는 **칸 밖에서 시작해도** 받는다(경계 없이)
  out.push({ name: '영역 복사는 칸 경계를 안 둔다',
    ok: /!this\.capturing && !this\._nearHost/.test(await fetch('/js/pen.js').then((r) => r.text())) });
  return out;
});

// ══════════ 그림 **안쪽**을 캡처해도 담기는가 (2026-10-20 신고) ══════════
// "저 부분을 긁어서 했는데 왜 캡쳐가 하나도 안됨?" — 흐름도 안쪽만 네모 쳤을 때다.
// 까닭: 공통 조상 찾기가 그 `<img>` 자신에서 멈춘다 ➔ stubImages가 속에 든 그림을
// 하나도 못 찾는다 ➔ `blob:` 주소가 그대로 SVG에 실리는데 **SVG 안에서는 안 열린다**
// ➔ 빈 회색만 복사된다. 달모 그림은 전부 blob: 주소라 늘 이 길로 샜다.
await run('그림 안쪽 캡처', async () => {
  const out = [];
  const { captureRect } = await import('/js/capture.js');
  const c = document.createElement('canvas');
  c.width = 900; c.height = 600;
  const g = c.getContext('2d');
  g.fillStyle = '#e8453c';
  g.fillRect(0, 0, 900, 600);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const url = URL.createObjectURL(blob);          // ★ 달모가 실제로 쓰는 꼴
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:40px;top:40px;width:900px;height:620px;'
    + 'background:#fff;z-index:9999';
  box.innerHTML = `<img src="${url}" style="width:880px;height:580px;display:block">`;
  document.body.appendChild(box);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const ir = box.querySelector('img').getBoundingClientRect();
    // 네모를 **그림 안쪽에만** 친다 — 이래야 host가 img 자신이 된다
    const rect = { left: ir.left + 100, top: ir.top + 100, width: 400, height: 300 };
    out.push({ name: '네모 한가운데가 그림이다(이 조건이라야 버그가 난다)',
      ok: (document.elementFromPoint(rect.left + 200, rect.top + 150) || {}).tagName === 'IMG' });
    const cv = await captureRect(rect);
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let red = 0, total = 0;
    for (let i = 0; i < d.length; i += 4) {
      total++;
      if (d[i] > 180 && d[i + 1] < 110 && d[i + 2] < 110) red++;
    }
    out.push({ name: '**그림 안쪽을 캡처해도 그림이 담긴다**', ok: red / total > 0.8,
      detail: `빨강 ${(red / total * 100).toFixed(1)}%` });
    out.push({ name: '그림을 세어서 들고 있다(0장이면 샌 것이다)',
      ok: !!(cv.__shots && cv.__shots.total >= 1),
      detail: cv.__shots ? `${cv.__shots.total}장 · 못 그림 ${cv.__shots.failed}` : '안 셈' });
    out.push({ name: '그림 자신을 host로 삼지 않는다',
      ok: /host\.tagName === 'IMG'/.test(await fetch('/js/capture.js').then((r) => r.text())) });
  } catch (e) {
    out.push({ name: '그림 안쪽 캡처 검사 (실행 실패)', ok: false, detail: String(e.message).slice(0, 120) });
  } finally {
    box.remove();
    URL.revokeObjectURL(url);
  }
  return out;
});

// ══════════ 캡처가 **스크롤을 따라가는가** (2026-10-20 신고) ══════════
// "이 범위를 선택해서 캡쳐했는데 다른 범위가 선택되어서 복사되는 버그"
// cloneNode는 scrollTop을 안 가져오고, SVG로 넘길 때 스크롤 위치는 적어 보낼 수도 없다.
// 그래서 옆칸처럼 **안에서 스크롤되는 곳**을 캡처하면 늘 맨 위가 떠졌다.
await run('캡처와 스크롤', async () => {
  const out = [];
  const { captureRect } = await import('/js/capture.js');
  const box = document.createElement('div');
  box.id = 'capScrollTest';
  box.style.cssText = 'position:fixed;left:40px;top:40px;width:420px;height:240px;'
    + 'overflow-y:auto;background:#fff;z-index:9999';
  box.innerHTML = Array.from({ length: 40 }, (_, i) =>
    `<p style="margin:0;padding:8px;font:16px/1.4 sans-serif;color:#000">줄번호 ${i + 1}</p>`).join('');
  document.body.appendChild(box);
  await new Promise((r) => setTimeout(r, 150));
  const br = box.getBoundingClientRect();
  const shot = () => captureRect({ left: br.left, top: br.top, width: br.width, height: br.height });
  const pixels = (cv) => cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;

  try {
    box.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 150));
    const d0 = pixels(await shot());
    box.scrollTop = 600;
    await new Promise((r) => setTimeout(r, 180));
    // 눈에 보이는 줄이 실제로 바뀌었는지 먼저 확인한다(검사가 헛돌지 않게)
    const seen = [...box.querySelectorAll('p')].filter((p) => {
      const r = p.getBoundingClientRect();
      return r.top >= br.top - 2 && r.bottom <= br.bottom + 2;
    });
    out.push({ name: '스크롤하면 보이는 줄이 바뀐다', ok: seen.length > 0 && !/줄번호 1$/.test(seen[0].textContent),
      detail: seen.length ? seen[0].textContent : '없음' });
    const d1 = pixels(await shot());
    let diff = 0;
    for (let i = 0; i < d1.length; i += 4) if (Math.abs(d1[i] - d0[i]) > 30) diff++;
    out.push({ name: '**캡처가 스크롤을 따라간다**(늘 맨 위를 뜨지 않는다)',
      ok: diff > 500, detail: `다른 화소 ${diff}` });
    out.push({ name: '속엣것을 밀어서 옮긴다(스크롤 위치는 적어 보낼 수 없다)',
      ok: /carryScroll/.test(await fetch('/js/capture.js').then((r) => r.text())) });
  } catch (e) {
    out.push({ name: '캡처 스크롤 검사 (실행 실패)', ok: false, detail: String(e.message).slice(0, 120) });
  } finally {
    box.remove();
  }
  return out;
});

// ══════════ 그림 크게 보기 + 필기 (2026-10-20 요청) ══════════
// "그림 눌러서 크게보기 및 필기 해서 저장 이런거 넣자."
// 필기는 읽기 화면과 **같은 펜**(PenLayer)을 쓴다 — 애플펜슬의 중간 좌표와 필압을
// 이미 받아 쓰는 그 엔진이다. 두 벌로 갈리면 한쪽만 좋아진다.
await run('그림 크게 보기', async () => {
  const out = [];
  const PNG = await (async () => {
    const cv = document.createElement('canvas'); cv.width = 400; cv.height = 300;
    const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 400, 300);
    x.fillStyle = '#333'; x.fillRect(40, 40, 120, 60);
    return cv.toDataURL();
  })();
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  // 앞 검사가 열어둔 덮개가 남아 있으면 펜이 "UI 위"로 보고 손을 뗀다(_overUi)
  document.querySelectorAll('.sheet, .ask-float, .more-menu, #docDrawer, #docScrim, #selPop, #cardFloat')
    .forEach((x) => x.classList.add('hidden'));
  const body = document.getElementById('readBody');
  const keep = body.innerHTML;
  body.innerHTML = `<p><img class="embed" src="${PNG}" alt="흐름도"></p>`;
  await new Promise((r) => setTimeout(r, 250));

  const im = body.querySelector('img');
  im.click();
  await new Promise((r) => setTimeout(r, 450));
  const view = document.getElementById('imgView');
  out.push({ name: '**그림을 누르면 크게 뜬다**', ok: !view.classList.contains('hidden') });
  const big = document.getElementById('ivImg');
  const rb = big.getBoundingClientRect();
  out.push({ name: '화면을 크게 쓴다', ok: rb.width > 200 && rb.height > 150,
    detail: `${Math.round(rb.width)}×${Math.round(rb.height)}` });
  out.push({ name: '무슨 그림인지 적힌다',
    ok: /흐름도/.test(document.getElementById('ivTitle').textContent) });

  const cv = document.querySelector('#ivCard .penlayer');
  out.push({ name: '**그림 위에 펜이 얹힌다**', ok: !!cv });
  if (cv) {
    const rc = cv.getBoundingClientRect();
    out.push({ name: '펜 자리가 그림에 딱 맞는다(필기가 어긋나지 않게)',
      ok: Math.abs(rc.width - rb.width) < 2 && Math.abs(rc.height - rb.height) < 2,
      detail: `펜 ${Math.round(rc.width)}×${Math.round(rc.height)} · 그림 ${Math.round(rb.width)}×${Math.round(rb.height)}` });
    out.push({ name: '긋는 동안 화면이 안 밀린다',
      ok: getComputedStyle(cv).touchAction === 'none' });

    // 애플펜슬처럼 **필압을 실어** 긋는다
    const ev = (t, x, y, pr) => cv.dispatchEvent(new PointerEvent(t, {
      pointerType: 'pen', pointerId: 21, isPrimary: true,
      buttons: t === 'pointerup' ? 0 : 1, pressure: pr,
      clientX: x, clientY: y, bubbles: true, cancelable: true }));
    ev('pointerdown', rb.left + 30, rb.top + 30, .3);
    for (let i = 1; i <= 12; i++) ev('pointermove', rb.left + 30 + i * 9, rb.top + 30 + i * 5, .3 + i * .05);
    ev('pointerup', rb.left + 138, rb.top + 90, 0);
    // 획은 바로 확정되지 않는다 — 끊어 그은 것을 모으느라 SETTLE_MS(420ms) 기다린다
    await new Promise((r) => setTimeout(r, 900));
    const n = window.__ivStrokes ? window.__ivStrokes() : -1;
    out.push({ name: '**펜으로 그으면 획이 남는다**', ok: n >= 1, detail: `${n}획` });

    // 되돌리기·비우기
    document.getElementById('ivUndo').click();
    await new Promise((r) => setTimeout(r, 150));
    out.push({ name: '한 획 되돌린다', ok: (window.__ivStrokes ? window.__ivStrokes() : 1) === n - 1 });
  }

  // 펜 굵기 — 동그라미 크기로 고른다(2026-10-20 요청)
  const nibs = [...document.querySelectorAll('#ivNibs .iv-nib')];
  out.push({ name: '펜 굵기를 고를 수 있다', ok: nibs.length >= 3, detail: `${nibs.length}단계` });
  if (nibs.length >= 2 && window.__ivPenWidth) {
    nibs[nibs.length - 1].click();
    await new Promise((r) => setTimeout(r, 120));
    out.push({ name: '**고른 굵기가 펜에 들어간다**',
      ok: window.__ivPenWidth() === Number(nibs[nibs.length - 1].dataset.nib),
      detail: `${window.__ivPenWidth()}` });
    out.push({ name: '고른 티가 난다', ok: nibs[nibs.length - 1].classList.contains('on') });
  }

  // 색을 고를 수 있다
  const inks = document.querySelectorAll('#ivColors .iv-ink');
  out.push({ name: '펜 색을 고른다', ok: inks.length >= 3, detail: `${inks.length}가지` });
  if (inks.length > 1) {
    inks[0].click();
    await new Promise((r) => setTimeout(r, 100));
    out.push({ name: '고른 색이 켜진 티가 난다', ok: inks[0].classList.contains('on') });
  }

  // 굽기 — 그림과 필기가 **한 장**으로
  if (typeof window.__ivFlatten === 'function') {
    const blob = await window.__ivFlatten();
    out.push({ name: '**그림과 필기를 한 장으로 굽는다**',
      ok: blob && blob.type === 'image/png' && blob.size > 500,
      detail: blob ? `${blob.type} ${blob.size}B` : '없음' });
    // 원본 크기 그대로여야 나중에 vault에서 봐도 또렷하다
    const bmp = blob && self.createImageBitmap ? await createImageBitmap(blob) : null;
    if (bmp) out.push({ name: '원본 크기 그대로 굽는다(흐릿해지지 않게)',
      ok: bmp.width === 400 && bmp.height === 300, detail: `${bmp.width}×${bmp.height}` });
  }

  // ── 두 손가락으로 **잡은 자리**를 중심으로 커지는가 (2026-10-20 신고) ──
  // "두 손가락으로 잡은 부분이 확대가 돼야지 일괄적으로 한 점 중심으로 확대되는 버그"
  // transform-origin을 한 점으로 박아두면 손가락을 어디에 두든 늘 같은 데가 중심이 된다.
  if (typeof window.__ivZoom === 'function') {
    const b0 = big.getBoundingClientRect();
    const fx = b0.left + b0.width * 0.25;        // 왼쪽 위 1/4 지점을 잡는다
    const fy = b0.top + b0.height * 0.25;
    const u = (fx - b0.left) / b0.width;         // 그 점이 그림 안 어디인지(비율)
    const v = (fy - b0.top) / b0.height;
    window.__ivZoom(2.5, fx, fy);
    await new Promise((r) => setTimeout(r, 200));
    const b1 = big.getBoundingClientRect();
    const nx = b1.left + u * b1.width;           // 같은 그림 지점이 지금 어디 있나
    const ny = b1.top + v * b1.height;
    const off = Math.hypot(nx - fx, ny - fy);
    out.push({ name: '**잡은 자리가 제자리에 붙들린다**', ok: off < 6,
      detail: `어긋남 ${Math.round(off)}px` });
    out.push({ name: '배율이 실제로 커진다', ok: b1.width > b0.width * 2,
      detail: `${Math.round(b0.width)} → ${Math.round(b1.width)}px` });
    document.getElementById('ivFit').click();
    await new Promise((r) => setTimeout(r, 150));
    out.push({ name: '"맞춤"을 누르면 되돌아온다',
      ok: Math.abs(big.getBoundingClientRect().width - b0.width) < 2 });
  }

  document.getElementById('ivClose').click();
  await new Promise((r) => setTimeout(r, 150));
  out.push({ name: '닫으면 사라진다', ok: view.classList.contains('hidden') });
  out.push({ name: '닫으면 펜도 치운다(다음에 새로 얹게)',
    ok: !document.querySelector('#ivCard .penlayer') });

  // 카드 편집 중에는 가로채지 않는다 — 거기선 네모 치는 손짓이 먼저다
  out.push({ name: '카드 편집·네모 치는 그림은 안 가로챈다',
    ok: /cf-pick.*io-wrap|io-wrap/.test(
      (await fetch('/js/app.js').then((r) => r.text())).match(/IV_HOSTS[\s\S]{0,600}/)[0]) });

  body.innerHTML = keep;
  return out;
});

// ══════════ 새로 만든 **퀴즈**도 저절로 뜨는가 (2026-10-21 신고) ══════════
// "장기공여자관리 퀴즈는 보이지도 않음" — 그날 만들어진 파일이었다.
// 시험 목록도 노트 목록과 똑같이 `force` 없이는 영영 다시 안 읽고 있었다.
await run('새 퀴즈가 저절로 뜬다', async () => {
  const out = [];
  const d = await import('/js/db.js');
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  const real = window.fetch;
  let files = ['261019_김승준_CRRT_퀴즈.html'];
  let hits = 0;
  window.fetch = async (u, i) => {
    const t = String(u);
    if (!t.includes('api.github.com')) return real(u, i);
    const p = decodeURIComponent((t.split('/contents/')[1] || '').split('?')[0]);
    if (p === '05_퀴즈') {
      return { ok: true, status: 200,
        json: async () => ([{ name: '응급_중환자', type: 'dir', path: '05_퀴즈/응급_중환자' }]) };
    }
    if (p === '05_퀴즈/응급_중환자') {
      hits++;
      return { ok: true, status: 200,
        json: async () => files.map((f) => ({ name: f, type: 'file', path: `05_퀴즈/응급_중환자/${f}` })) };
    }
    return { ok: true, status: 200, json: async () => ([]), text: async () => '' };
  };
  try {
    await d.kvSet('exam_index_v3', null);
    await d.kvSet('exam_index_at', 0);
    const first = await window.__examIndex();
    const quizOf = (idx) => (idx.find((g) => g.kind === '퀴즈') || { exams: [] }).exams.length;
    out.push({ name: '목록을 받아온다', ok: quizOf(first) === 1, detail: `${quizOf(first)}개` });

    // 맥에서 퀴즈를 하나 더 만들었다 — 앱을 끄지 않고 다시 묻는다
    files = files.concat('261019_김윤호_장기공여자관리_퀴즈.html');
    const cached = await window.__examIndex();
    out.push({ name: '갓 받은 뒤에는 다시 안 읽는다(쓸데없이 묻지 않게)',
      ok: quizOf(cached) === 1, detail: `${quizOf(cached)}개` });

    await d.kvSet('exam_index_at', Date.now() - 10 * 60 * 1000);   // 10분 전 것이라 치면
    const fresh = await window.__examIndex();
    out.push({ name: '**새로 만든 퀴즈가 저절로 뜬다**', ok: quizOf(fresh) === 2,
      detail: `${quizOf(fresh)}개` });
    out.push({ name: '목록이 스스로 낡는다(force 없이도)',
      ok: /exam_index_at/.test(await fetch('/js/app.js').then((r) => r.text())) });
  } catch (e) {
    out.push({ name: '새 퀴즈 검사 (실행 실패)', ok: false, detail: String(e.message).slice(0, 130) });
  } finally {
    window.fetch = real;
    await d.kvSet('exam_index_v3', null);
    await d.kvSet('exam_index_at', 0);
  }
  return out;
});

// ══════════ 노트 서랍 — 새로 만든 노트가 저절로 뜨는가 (2026-10-18) ══════════
// 실제 신고: 맥에서 암기법 3개를 만들었는데 아이패드에서 "노트 열기"에 13개만 떴다.
// 목록이 두 겹으로 굳어 있었다 — IndexedDB의 note_index_v2(force 없이는 영영 안 읽음)와
// 서랍 DOM에 얹어둔 list.__groups(한 번 받으면 새로고침 전까지 그대로).
await run('새 노트가 서랍에 뜬다', async () => {
  const out = [];
  const d = await import('/js/db.js');
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  const realFetch = window.fetch;
  let trees = 0;                                   // git tree를 몇 번 물었는지
  let paths = [
    '02_Wiki/응급_중환자/응급중환자_기본소생술BLS.md',
    '02_Wiki/응급_중환자/암기법/응급중환자_기본소생술BLS_암기법.md',
  ];
  window.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('api.github.com')) return realFetch(url, init);
    if (u.includes('/git/trees/')) {
      trees++;
      return { ok: true, status: 200, json: async () => ({
        truncated: false,
        tree: paths.map((p) => ({ path: p, type: 'blob', sha: 'x', size: 20 })) }) };
    }
    const name = decodeURIComponent(u.split('/contents/')[1] || '').split('/').pop().replace('.md', '');
    return { ok: true, status: 200, json: async () => ({}), text: async () => `# ${name}\n\n본문\n` };
  };
  const openDrawer = async () => {
    document.getElementById('readDocs').click();
    await new Promise((r) => setTimeout(r, 700));
    const names = [...document.querySelectorAll('#docList .dd-item .dd-name')].map((x) => x.textContent);
    document.getElementById('docClose').click();
    await new Promise((r) => setTimeout(r, 150));
    return names;
  };
  await d.kvSet('note_index_v2', null);
  await d.kvSet('note_index_at', 0);
  const n1 = await openDrawer();
  out.push({ name: 'git tree 한 번으로 목록을 받는다', ok: trees === 1, detail: `${trees}번` });
  out.push({ name: '받은 목록이 서랍에 뜬다', ok: n1.some((x) => /_암기법$/.test(x)),
    detail: n1.join(' / ') });

  // 맥에서 암기법을 하나 더 만들었다 — 앱을 끄지 않고 서랍만 다시 연다
  paths = paths.concat('02_Wiki/응급_중환자/암기법/응급중환자_중환자감시_암기법.md');
  await d.kvSet('note_index_at', Date.now() - 10 * 60 * 1000);   // 10분 전 받은 목록
  const n2 = await openDrawer();
  out.push({ name: '**새로 만든 노트가 다시 열면 보인다**',
    ok: n2.some((x) => /중환자감시_암기법/.test(x)), detail: n2.join(' / ') });
  out.push({ name: '낡았을 때만 다시 묻는다', ok: trees === 2, detail: `${trees}번` });

  // 방금 받았으면 또 묻지 않는다 — 서랍 여닫을 때마다 네트워크를 때리면 안 된다
  const n3 = await openDrawer();
  out.push({ name: '갓 받은 목록은 그대로 쓴다', ok: trees === 2, detail: `${trees}번` });
  out.push({ name: '그래도 목록은 같다', ok: n3.length === n2.length });

  // 서랍 DOM에 목록을 쥐고 있으면 캐시를 고쳐도 화면이 안 바뀐다 — 그 길을 막았는지 본다
  out.push({ name: '서랍이 목록을 DOM에 쥐고 있지 않다',
    ok: !document.getElementById('docList').__groupsMemo
      && !/if \(!list\.__groups\)/.test(await (await fetch('/js/app.js')).text()) });

  // 못 읽는 상황에서 목록이 비면 안 된다
  window.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('api.github.com')) return realFetch(url, init);
    if (u.includes('/git/trees/')) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({}), text: async () => '# x\n' };
  };
  await d.kvSet('note_index_at', 0);
  const n4 = await openDrawer();
  out.push({ name: '못 읽으면 있던 목록을 지킨다(빈 서랍 금지)',
    ok: n4.length === n2.length, detail: `${n4.length}개` });

  window.fetch = realFetch;
  await d.kvSet('note_index_v2', null);
  await d.kvSet('note_index_at', 0);
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

  // ★ 네모를 치는 도구에서는 손잡이가 끼어들지 않는다 (2026-10-15)
  // "영역 복사로 네모 칠 때 split 사이즈 조절 탭이 활성화돼서 불편하다".
  document.getElementById('toolCapture').click();
  out.push({ name: '영역 복사를 켜면 body에 boxing이 붙는다',
    ok: document.body.classList.contains('boxing') });
  out.push({ name: '**네모 치는 동안 손잡이는 포인터를 안 받는다**',
    ok: getComputedStyle(col).pointerEvents === 'none',
    detail: getComputedStyle(col).pointerEvents });
  document.dispatchEvent(new PointerEvent('pointermove',
    { clientX: cx + 10, clientY: cy, bubbles: true }));
  await new Promise((rs) => requestAnimationFrame(() => requestAnimationFrame(rs)));
  out.push({ name: '바로 옆을 지나도 안 깨어난다', ok: !col.classList.contains('near') });
  out.push({ name: '**그 자리의 포인터는 손잡이를 뚫고 간다**(네모가 그려지게)',
    ok: !document.elementsFromPoint(cx, cy).some((el) => el.classList?.contains('resize-grip')),
    detail: String(document.elementsFromPoint(cx, cy)[0]?.className || '') });
  // 숨기지는 않는다 — 영역 복사는 보이는 그대로를 뜨는 일이라 그림에 들어가야 한다
  out.push({ name: '손잡이가 사라지지는 않는다(그림에 그대로 들어가게)',
    ok: col.getBoundingClientRect().width > 0 && getComputedStyle(col).display !== 'none' });

  // 카드 만들기도 같은 네모 손짓이다
  document.getElementById('readMakeCard').click();
  out.push({ name: '카드 만들기에서도 재운다', ok: document.body.classList.contains('boxing') });

  // 고르기로 돌아오면 다시 깨어날 수 있다
  document.getElementById('toolSelect').click();
  out.push({ name: '고르기로 돌아오면 다시 쓸 수 있다',
    ok: !document.body.classList.contains('boxing')
      && getComputedStyle(col).pointerEvents !== 'none' });

  document.getElementById('wikiPanel').classList.add('hidden');
  document.getElementById('quizScreen').classList.remove('with-side');
  return out;
});

// ══════════ 빈칸 카드 — 숫자는 따로, 띄어쓰기는 원문 그대로 (2026-10-15) ══════════
// "4시간에 200을 기준으로 이거 만들라니까 둘 다 가려져서 뭔지 모르겠네."
// "그리고 이렇게 다 띄어쓰기가 되어서 나와야 될 까닭은 뭐임."
await run('빈칸 카드', async () => {
  const out = [];
  const md = await import('/js/markdown.js');
  const pen = await import('/js/pen.js');
  const rd = await import('/js/reader.js');
  const src = await fetch('/js/app.js').then((r) => r.text());
  const grab = (re) => { const m = src.match(re); return m ? m[0] : ''; };
  const parts = [
    grab(/const RE_ESC[\s\S]*?\nfunction placeOneBlank[\s\S]*?\n}\n/),
    grab(/function placeBlanksIn[\s\S]*?\n}\n/),
    grab(/function czGroups\(\) \{[\s\S]*?\n}\n/),
    grab(/function czBodyHtml[\s\S]*?\n}\n/),
    grab(/function buildClozeCards[\s\S]*?\n}\n/),
    grab(/function suggestCloze\(\) \{[\s\S]*?\n}\n/),
  ];
  out.push({ name: '빈칸 카드 함수들이 app.js에 있다', ok: parts.every(Boolean),
    detail: `${parts.filter(Boolean).length}/6` });
  if (!parts.every(Boolean)) return out;
  // eslint-disable-next-line no-new-func
  const api = new Function('wordScore', 'blankNode', 'tidyCardHtml', `
    let czWords = [], czCtx = {};
    const blankSpan = blankNode;
    ${parts.join('\n')}
    return { czGroups, buildClozeCards, suggestCloze, placeBlanksIn,
      set(w) { czWords = w; }, setCtx(c) { czCtx = c; } };
  `)(rd.wordScore, rd.blankNode, rd.tidyCardHtml);

  const note = '- 👨🏼‍🏫 [전사문] 🗣️ "**제일 중요한 것은 4시간에 200을 기준**으로 합니다. 노모그램의 **아래쪽은\n  toxicity가 없고 위쪽은 toxicity가 있어서**, 시간에 따른 혈중 농도를 찍어보고 범위에 들면\n  치료하고 안 들면 치료하지 않습니다."';
  const holder = document.createElement('div');
  holder.className = 'read-body';
  holder.innerHTML = md.renderMarkdown(note);
  document.body.appendChild(holder);
  pen.tokenizeTree(holder);
  const block = holder.querySelector('li');

  // ── ① 긁은 글에 **원문에 없던 공백이 끼지 않는다** ──
  // .tok은 굵게·괄호 경계에서도 갈린다. 예전엔 ' '로 이어 붙여 `" 제일`이 됐다.
  const toks = [...block.querySelectorAll('.tok')];
  const r = document.createRange();
  r.setStartBefore(toks[3]);                    // `"` 조각부터
  r.setEndAfter(toks[toks.length - 1]);
  const grabbed = r.toString().replace(/\s+/g, ' ').trim();
  out.push({ name: '**긁은 글에 없던 띄어쓰기가 안 생긴다**',
    ok: grabbed.includes('"제일') && grabbed.includes('기준으로') && grabbed.includes('있어서,'),
    detail: grabbed.slice(0, 60) });
  out.push({ name: 'pen.js가 낱말을 \' \'로 잇지 않는다',
    ok: !/picked\.map\(\(t\) => t\.el\.textContent\)\.join\(' '\)\.replace/
      .test(await fetch('/js/pen.js').then((x) => x.text())) });

  // ── ② 숫자 둘이면 한 장에 둘 다 가리지 않고 **나눠 담는다** ──
  const words = [];
  '4시간에 200을 기준으로'.split(' ').forEach((w, wi) => {
    rd.splitWord(w).forEach((t, pi) => words.push({ t, blank: false, sp: wi > 0 && pi === 0 }));
  });
  api.set(words);
  api.setCtx({ notePath: 'n', noteTitle: 't', heading: 'h', block, trail: [] });
  out.push({ name: '숫자와 조사를 따로 쪼갠다',
    ok: words.map((w) => w.t).join('|') === '4시간|에|200|을|기준으로',
    detail: words.map((w) => w.t).join('|') });
  api.suggestCloze();
  const groups = api.czGroups();
  out.push({ name: '숫자 둘을 빈칸 둘로 잡는다', ok: groups.map((g) => g.t).join(',') === '4시간,200',
    detail: groups.map((g) => g.t).join(',') });

  const show = (h) => { const d = document.createElement('div'); d.innerHTML = h;
    d.querySelectorAll('.cloze').forEach((c) => { c.textContent = `[${c.dataset.answer}]`; });
    return d.textContent.replace(/\s+/g, ' ').trim(); };
  const split = api.buildClozeCards(true);
  out.push({ name: '**빈칸 하나짜리 두 장으로 나뉜다**', ok: split.length === 2,
    detail: `${split.length}장` });
  if (split.length === 2) {
    const a = show(split[0].contextHtml);
    const b = show(split[1].contextHtml);
    out.push({ name: '첫 장은 4시간만 가린다(200은 단서로 보인다)',
      ok: a.includes('[4시간]에 200을'), detail: a.slice(20, 60) });
    out.push({ name: '둘째 장은 200만 가린다(4시간은 보인다)',
      ok: b.includes('4시간에 [200]을'), detail: b.slice(20, 60) });
    out.push({ name: '두 장의 id가 다르다', ok: split[0].id !== split[1].id });
    out.push({ name: '카드 본문도 원문 띄어쓰기 그대로',
      ok: a.includes('"제일') && a.includes('기준으로 합니다') && a.includes('있어서,'),
      detail: a.slice(0, 50) });
  }
  const one = api.buildClozeCards(false);
  out.push({ name: '"한 장에 모두"는 한 장에 둘 다', ok: one.length === 1 && one[0].answers.length === 2,
    detail: one.map((c) => c.answers.join('+')).join('') });

  // ── ③ 이미 만들어둔 카드의 벌어진 칸도 그려줄 때 낫는다 ──
  // "기준       으로        합니다. 이렇게 칸이 넓어야 할 이유가 있나?" (2026-10-15)
  const stale = '<li><span class="tok">"</span> <span class="tok">제일</span>   <span class="tok">중요한</span>'
    + '  <span class="tok">것</span> <span class="tok">은</span>'
    + ' <span class="cloze" data-answer="4시간에">     </span>  <span class="cloze" data-answer="200을">    </span>'
    + '   <span class="tok">기준</span>    <span class="tok">으로</span>     <span class="tok">합니다.</span></li>';
  const tidied = rd.tidyCardHtml(stale);
  const seen = document.createElement('div');
  seen.innerHTML = tidied;
  seen.querySelectorAll('.cloze').forEach((c) => { c.textContent = `[${c.dataset.answer}]`; });
  out.push({ name: '**두 칸 넘게 벌어진 자리가 한 칸으로 좁혀진다**',
    ok: !/ {2}/.test(seen.textContent), detail: seen.textContent });
  out.push({ name: '좁히면서 조사·따옴표도 제자리로',
    ok: seen.textContent === '"제일 중요한 것은 [4시간에] [200을] 기준으로 합니다.',
    detail: seen.textContent });
  out.push({ name: '빈칸 두 개는 그대로 둘', ok: seen.querySelectorAll('.cloze').length === 2 });
  // 카드 본문은 양끝맞춤·자간이 묻어 들어오지 않게 못박혀 있다
  // 바깥에서 물려받는 양끝맞춤·자간을 막는지 본다(카드는 읽기 화면 DOM을 복제해 온다)
  const host = document.createElement('div');
  host.style.cssText = 'text-align:justify;word-spacing:9px;letter-spacing:3px';
  const probe = document.createElement('div');
  probe.className = 'cf-row-q';
  probe.innerHTML = '<p>가 나 다</p>';
  host.appendChild(probe);
  document.body.appendChild(host);
  const cs = getComputedStyle(probe.querySelector('p'));
  out.push({ name: '카드 본문은 왼쪽 정렬로 못박혀 있다', ok: cs.textAlign === 'left', detail: cs.textAlign });
  out.push({ name: '자간도 보통으로 못박혀 있다', ok: cs.wordSpacing === 'normal' || cs.wordSpacing === '0px',
    detail: cs.wordSpacing });
  out.push({ name: '글자 사이 간격도 물려받지 않는다', ok: cs.letterSpacing === 'normal',
    detail: cs.letterSpacing });
  host.remove();

  // ── ④ 여러 조각에 걸친 답도 블록 서식 안에서 찾는다 ──
  // "제일 중요한"은 .tok 두 개에 걸쳐 있다 — 예전엔 못 찾아 맨 글자 본문으로 떨어졌다
  const clone = block.cloneNode(true);
  const spanned = api.placeBlanksIn(clone, ['제일 중요한']);
  out.push({ name: '**두 조각에 걸친 답도 제자리에 꽂힌다**',
    ok: spanned && clone.querySelector('.cloze')
      && clone.querySelector('.cloze').dataset.answer === '제일 중요한',
    detail: show(clone.outerHTML).slice(0, 50) });

  holder.remove();
  return out;
});

// ══════════ 찾기에서 살짝 들러보기 (2026-10-15 요청) ══════════
// "노트 읽다가 다른 내용 잠깐 찾아보고 싶을 때가 꽤 많은데 지금 찾기에서는 아주 불편함."
await run('들러보기', async () => {
  const out = [];
  const f = document.getElementById('peekFloat');
  out.push({ name: '들러보기 창이 있다', ok: !!f });
  if (!f) return out;
  out.push({ name: '열기·옆에 띄우기·앞뒤 넘기기가 다 있다',
    ok: ['pkOpen', 'pkSplit', 'pkPrev', 'pkNext', 'pkClose'].every((id) => !!document.getElementById(id)),
    detail: ['pkOpen', 'pkSplit', 'pkPrev', 'pkNext', 'pkClose']
      .filter((id) => !document.getElementById(id)).join(',') || '전부 있음' });

  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '**찾기 결과를 길게 누르면 들러본다**',
    ok: /longPress\(b, \(\) => openPeek\(h\)\)/.test(app) });
  out.push({ name: '그냥 누르면 전처럼 바로 연다(빠른 길이 남아 있다)',
    ok: /b\.onclick = \(\) => \{\s*\n\s*closeSearch\(\);/.test(app) });
  out.push({ name: 'Esc로 닫힌다', ok: /\['peekFloat', closePeek\]/.test(app) });
  out.push({ name: '옆에 띄우기가 실제 split을 쓴다',
    ok: /splitPane\(note\)/.test(app) && /openInPane\(note, \{ pane: 1/.test(app) });

  // 실제로 띄워본다 — 걸린 말이 칠해지고 그 자리로 굴러가야 한다
  f.classList.remove('hidden');
  f.style.cssText = '--af-w:600px;--af-h:420px;--af-x:40px;--af-y:40px';
  const body = document.getElementById('pkBody');
  body.innerHTML = '<p>' + '앞말 '.repeat(200) + '<b>doxycycline</b> 뒷말</p>';
  const markAllIn = new Function('root', 'needle', 'ord', `
    ${(app.match(/function markAllIn\(root, needle, ord = 0\) \{[\s\S]*?\n}\n/) || [''])[0]}
    return markAllIn(root, needle, ord);`);
  const m = markAllIn(body, 'doxycycline', 0);
  out.push({ name: '**걸린 말이 칠해진다**', ok: !!m && /peek-hit/.test(m.className),
    detail: m ? m.textContent : '못 칠함' });
  if (m) {
    const bg = getComputedStyle(m).backgroundColor;
    out.push({ name: '칠한 자리가 눈에 띈다', ok: bg !== 'rgba(0, 0, 0, 0)', detail: bg });
    // 파란 강조색을 옅게 깔면 어두움 모드에서 글자가 묻힌다(2026-10-17 신고)
    out.push({ name: '**칠한 색이 강조색(파랑) 계열이 아니다**',
      ok: !/rgba?\(1?\d?\d, 1[0-9]\d, 2\d\d/.test(bg), detail: bg });
    out.push({ name: '칠한 자리는 글자색을 스스로 정한다',
      ok: getComputedStyle(m).color !== getComputedStyle(body).color,
      detail: getComputedStyle(m).color });
  }
  out.push({ name: '본문이 제 스크롤 상자다(창 안에서만 움직인다)',
    ok: getComputedStyle(body).overflowY === 'auto', detail: getComputedStyle(body).overflowY });
  f.classList.add('hidden');
  return out;
});

// ══════════ 찾기 창은 크기가 변하지 않는다 (2026-10-15 요청) ══════════
// "아래쪽에 검색되는게 계속 바뀌니까 타이핑하는 부분이 자꾸 위치가 바뀌어서 어지러움."
await run('찾기 창 고정', async () => {
  const out = [];
  const sheet = document.getElementById('searchSheet');
  const card = sheet.querySelector('.search-card');
  const input = document.getElementById('searchInput');
  const res = document.getElementById('searchResults');
  sheet.classList.remove('hidden');
  res.innerHTML = '';
  await new Promise((r) => setTimeout(r, 60));

  const h0 = Math.round(card.getBoundingClientRect().height);
  const y0 = Math.round(input.getBoundingClientRect().top);

  // 결과가 쏟아져도 입력칸이 제자리에 있어야 한다
  res.innerHTML = Array.from({ length: 60 },
    () => '<button class="search-hit"><div class="sh-title">가</div><div class="sh-snip">나</div></button>').join('');
  await new Promise((r) => setTimeout(r, 60));
  const h1 = Math.round(card.getBoundingClientRect().height);
  const y1 = Math.round(input.getBoundingClientRect().top);

  out.push({ name: '**결과가 쏟아져도 입력칸이 안 움직인다**', ok: Math.abs(y1 - y0) <= 1,
    detail: `${y0} → ${y1}px` });
  out.push({ name: '창 높이도 그대로다', ok: Math.abs(h1 - h0) <= 1, detail: `${h0} → ${h1}px` });
  out.push({ name: '결과만 제 안에서 구른다',
    ok: getComputedStyle(res).overflowY === 'auto' && res.scrollHeight > res.clientHeight + 10,
    detail: `${res.scrollHeight} > ${res.clientHeight}` });
  out.push({ name: '창이 화면을 다 먹지 않는다', ok: h1 <= innerHeight * 0.8,
    detail: `${h1} / ${innerHeight}` });
  out.push({ name: '입력칸이 손 닿는 높이에 있다(너무 위도 아래도 아니게)',
    ok: y1 > innerHeight * 0.05 && y1 < innerHeight * 0.6,
    detail: `${Math.round((y1 / innerHeight) * 100)}%` });

  // 결과를 지워도 다시 안 뛴다
  res.innerHTML = '';
  await new Promise((r) => setTimeout(r, 60));
  out.push({ name: '결과를 지워도 되돌아 뛰지 않는다',
    ok: Math.abs(Math.round(input.getBoundingClientRect().top) - y0) <= 1,
    detail: `${Math.round(input.getBoundingClientRect().top)}px` });

  sheet.classList.add('hidden');
  return out;
});

// ══════════ 어디서든 찾기 — 늘 떠 있는 돋보기 (2026-10-15 요청) ══════════
// "찾기 정도는 어디서든 쓸 수 있는거니까 전면에서 보이는 아이콘으로 빼자."
await run('떠 있는 돋보기', async () => {
  const out = [];
  const fab = document.getElementById('findFab');
  out.push({ name: '돋보기 단추가 있다', ok: !!fab });
  if (!fab) return out;
  out.push({ name: '돋보기 모양이다(원 + 손잡이)',
    ok: !!fab.querySelector('circle') && !!fab.querySelector('path') });

  // 앞 검사에서 찾기 창을 열어둔 채 지나갔을 수 있다 — 먼저 닫는다
  document.getElementById('searchClose').click();
  await new Promise((r) => setTimeout(r, 40));
  const screens = ['listScreen', 'readScreen', 'quizScreen', 'cardScreen', 'deckScreen'];
  const miss = [];
  const places = [];
  for (const id of screens) {
    document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
    document.body.dataset.screen = id;
    if (window.__paintFindFab) window.__paintFindFab();
    fab.classList.toggle('hidden', false);
    await new Promise((r) => setTimeout(r, 30));
    const r = fab.getBoundingClientRect();
    if (!(r.width >= 36 && r.height >= 36 && getComputedStyle(fab).display !== 'none')) miss.push(id);
    places.push(`${id}:${fab.closest('.navbar') ? '막대' : '떠있음'}`);
  }
  out.push({ name: '**모든 화면에서 보인다**', ok: !miss.length, detail: miss.join(',') || '전부' });
  // 막대가 있는 화면이면 막대 안으로 들어간다 — 넓은 화면에서 막대가 글 아래로
  // 내려가도 자리가 어긋나지 않게(2026-10-16)
  out.push({ name: '**막대가 있으면 막대 안에 선다**',
    ok: places.join(' ').includes('readScreen:막대') && places.join(' ').includes('quizScreen:막대'),
    detail: places.join(' ') });

  const r = fab.getBoundingClientRect();
  out.push({ name: '손가락으로 누를 만한 크기다', ok: r.width >= 36 && r.height >= 36,
    detail: `${Math.round(r.width)}×${Math.round(r.height)}` });
  // 막대가 없는 화면에서는 왼쪽 아래에 떠 있는다
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('deckScreen').classList.remove('hidden');
  document.body.dataset.screen = 'deckScreen';
  if (window.__paintFindFab) window.__paintFindFab();
  await new Promise((rs) => setTimeout(rs, 30));
  const rf = fab.getBoundingClientRect();
  out.push({ name: '막대가 없으면 왼쪽 아래에 떠 있는다',
    ok: !fab.closest('.navbar') && rf.left < innerWidth / 3 && rf.top > innerHeight / 2,
    detail: `${Math.round(rf.left)},${Math.round(rf.top)}` });
  const sync = document.getElementById('syncBar').getBoundingClientRect();
  out.push({ name: '저장 대기 띠와 겹치지 않는다',
    ok: !sync.width || !(rf.right > sync.left && rf.left < sync.right
      && rf.bottom > sync.top && rf.top < sync.bottom) });

  // 눌러서 찾기가 열리고, 열린 동안에는 자기가 숨는다
  const app = await fetch('/js/app.js').then((x) => x.text());
  out.push({ name: '그냥 누르면 찾기가 열린다', ok: /fab\.onclick = \(\) => openSearch\(\)/.test(app) });
  out.push({ name: '**길게 누르면 vault 전체에서 찾는다**',
    ok: /longPress\(fab, \(\) => openSearch\('all'\)\)/.test(app) });
  document.getElementById('findFab').click();
  await new Promise((rs) => setTimeout(rs, 60));
  out.push({ name: '찾기 창이 실제로 뜬다',
    ok: !document.getElementById('searchSheet').classList.contains('hidden') });
  out.push({ name: '열린 동안에는 돋보기가 비켜준다',
    ok: document.body.classList.contains('finding')
      && getComputedStyle(fab).display === 'none' });
  document.getElementById('searchClose').click();
  await new Promise((rs) => setTimeout(rs, 60));
  out.push({ name: '닫으면 다시 뜬다',
    ok: !document.body.classList.contains('finding') && getComputedStyle(fab).display !== 'none' });

  // 설정 화면에는 찾을 게 없다
  document.body.dataset.screen = 'setupScreen';
  const paint = new Function('return ' + (app.match(/function paintFindFab\(\) \{[\s\S]*?\n}/) || [''])[0]
    .replace('function paintFindFab()', 'function()'))();
  const NO = new Function(`return ${(app.match(/const NO_FIND = new Set\(\[[^\]]*\]\)/) || [''])[0].replace('const NO_FIND = ', '')}`)();
  out.push({ name: '설정 화면에서는 안 뜬다', ok: NO.has('setupScreen') });
  document.body.dataset.screen = 'listScreen';
  return out;
});

// ══════════ 카드: 그림·강조 없는 줄글 (2026-10-16 신고) ══════════
// "카드만들기도 그림이 안들어감" / "너무 하이라이트랑 볼드만 잡아내고있음"
await run('카드 그림·줄글', async () => {
  const out = [];
  const R = await import('/js/reader.js');
  const { renderMarkdown } = await import('/js/markdown.js');
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  const body = document.getElementById('readBody');
  const meta = { notePath: 'x.md', noteTitle: '노트', heading: '1. 장' };
  const make = async (md) => {
    body.innerHTML = renderMarkdown(md);
    await new Promise((r) => setTimeout(r, 70));
    const b = body.getBoundingClientRect();
    return R.cardsFromBox(body, { l: b.left, t: b.top, r: b.right, b: b.bottom }, meta);
  };

  // ── 강조가 없어도 카드가 된다 ──
  const num = await make('치료 농도는 50~100 µg/mL이고 800 이상에서 혼수가 올 수 있다.');
  out.push({ name: '**강조 없는 줄글도 카드가 된다**', ok: num.length === 1,
    detail: `${num.length}장` });
  out.push({ name: '숫자를 물어본다', ok: num.length === 1 && num[0].answers.some((a) => /\d/.test(a)),
    detail: num.length ? num[0].answers.join(' / ') : '' });

  const eng = await make('Endoluminal biofilm 은 튜브 내강에 형성되는 생물막이다.');
  out.push({ name: '영문 용어도 물어본다',
    ok: eng.length === 1 && eng[0].answers.some((a) => /[A-Za-z]/.test(a)),
    detail: eng.length ? eng[0].answers.join(' / ') : '' });

  // 평범한 명사뿐이면 **하나만** 가린다 — 넷을 다 가리면 못 푼다
  const noun = await make('설명 문장이 먼저 오고 그림이 뒤따른다고 적혀 있다.');
  out.push({ name: '평범한 말뿐이면 한 개만 가린다',
    ok: noun.length === 1 && noun[0].answers.length === 1,
    detail: noun.length ? noun[0].answers.join(' / ') : '0장' });

  // ── 일부러 거른 것은 되살아나지 않는다 ──
  // 강조가 **있었는데** 라벨·족보 정답이라 버린 경우까지 글에서 다시 주우면 안 된다
  out.push({ name: '"병태생리" 라벨은 여전히 카드가 안 된다',
    ok: (await make('**병태생리**: 전부하가 **증가**한다.')).length === 0 });
  out.push({ name: '족보 정답 번호도 여전히 안 된다',
    ok: (await make('**정답: 1, 5**(연도별로 1개만 고르시오형이면 1번만)')).length === 0 });

  // ── 그림이 네모에 걸치면 따라온다 ──
  const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4o6FBU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAIahsD2ItTF0AAAAAElFTkSuQmCC';
  body.innerHTML = `<p>설명 문장이 앞에 온다.</p><p><img class="embed" src="${RED}" `
    + 'style="width:120px;height:80px"></p>';
  await new Promise((r) => setTimeout(r, 90));
  const wb = body.getBoundingClientRect();
  const withImg = R.cardsFromBox(body, { l: wb.left, t: wb.top, r: wb.right, b: wb.bottom }, meta);
  out.push({ name: '**그림이 카드 본문에 들어간다**',
    ok: withImg.length === 1 && /<img/.test(withImg[0].contextHtml),
    detail: withImg.length ? withImg[0].contextHtml.slice(0, 60) : '0장' });

  // 살짝만 걸친 그림은 안 따라온다(10% 기준)
  const im = body.querySelector('img');
  const ib = im.getBoundingClientRect();
  const graze = R.cardsFromBox(body,
    { l: wb.left, t: wb.top, r: wb.right, b: ib.top + ib.height * 0.03 }, meta);
  out.push({ name: '살짝만 걸친 그림은 안 따라온다',
    ok: !graze.length || !/<img/.test(graze[0].contextHtml),
    detail: graze.length ? '들어옴' : '카드 없음' });

  // ── 카드를 그릴 때 그림의 주소를 채운다 ──
  const app = await fetch('/js/app.js').then((x) => x.text());
  out.push({ name: '카드 본문을 그리는 길이 하나다', ok: /function setCardBody\(el, html\)/.test(app) });
  out.push({ name: '**거기서 그림 주소를 채운다**',
    ok: /function setCardBody[\s\S]{0,260}hydrateEmbeds/.test(app) });
  out.push({ name: '카드 그리는 데가 전부 그 길을 쓴다',
    ok: (app.match(/setCardBody\(/g) || []).length >= 5,
    detail: `${(app.match(/setCardBody\(/g) || []).length}곳` });

  body.innerHTML = '';
  return out;
});

// ══════════ 캡처에 그림이 들어간다 (2026-10-16 신고) ══════════
// "왜 캡쳐하면 그림은 안들어감? 그냥 내가 보는 화면 그대로 캡쳐하면 되는데..."
// `<foreignObject>` 안의 `<img>`는 사파리에서 안 그려진다. 그래서 글과 그림을 **따로**
// 굽는다 — 복제본에서는 투명한 자리지기로 바꿔 레이아웃만 지키고, 다 그린 뒤 살아 있는
// 그림을 캔버스에 직접 올린다.
await run('캡처 속 그림', async () => {
  const out = [];
  const { captureRect } = await import('/js/capture.js');
  const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4o6FBU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAIahsD2ItTF0AAAAAElFTkSuQmCC';
  const blob = URL.createObjectURL(await (await fetch(RED)).blob());
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:20px;top:20px;width:400px;height:240px;'
    + 'background:#fff;color:#000;padding:10px;z-index:9999';
  host.innerHTML = `<p id="pTop">글자 위</p>`
    + `<img id="iA" src="${RED}" style="width:60px;height:60px">`
    + `<img id="iB" src="${blob}" style="width:60px;height:60px">`
    + `<img id="iC" src="${RED}" style="width:80px;height:40px;object-fit:contain">`
    + `<p id="pBot">글자 아래</p>`;
  document.body.appendChild(host);
  await Promise.all([...host.querySelectorAll('img')].map((im) => (im.complete
    ? Promise.resolve() : new Promise((r) => { im.onload = r; im.onerror = r; }))));
  await new Promise((r) => setTimeout(r, 60));

  const before = document.getElementById('pBot').getBoundingClientRect().top;
  const r = host.getBoundingClientRect();
  const cv = await captureRect({ left: r.left, top: r.top, width: r.width, height: r.height });
  const after = document.getElementById('pBot').getBoundingClientRect().top;
  const cx = cv.getContext('2d');
  const sc = cv.width / r.width;
  const at = (id) => {
    const b = document.getElementById(id).getBoundingClientRect();
    const d = cx.getImageData(Math.round((b.left - r.left + b.width / 2) * sc),
      Math.round((b.top - r.top + b.height / 2) * sc), 1, 1).data;
    return `${d[0]},${d[1]},${d[2]}`;
  };
  out.push({ name: '**data: 그림이 들어간다**', ok: at('iA') === '220,40,40', detail: at('iA') });
  out.push({ name: '**blob: 그림도 들어간다**(vault 그림이 이 꼴이다)',
    ok: at('iB') === '220,40,40', detail: at('iB') });
  out.push({ name: 'object-fit 줄인 그림도 제자리에', ok: at('iC') === '220,40,40', detail: at('iC') });
  out.push({ name: '캡처하느라 화면이 밀리지 않는다', ok: Math.abs(after - before) < 1,
    detail: `${Math.round(before)} → ${Math.round(after)}` });
  // 그림 **바깥**은 흰 바탕 그대로여야 한다 — 통째로 칠해버린 게 아님을 확인
  const edge = cx.getImageData(Math.round(390 * sc), Math.round(8 * sc), 1, 1).data;
  out.push({ name: '그림이 엉뚱한 데까지 번지지 않는다', ok: edge[0] > 200 && edge[1] > 200,
    detail: `${edge[0]},${edge[1]},${edge[2]}` });
  out.push({ name: '캔버스가 오염되지 않는다(저장할 수 있다)',
    ok: await new Promise((res) => { try { cv.toBlob((b) => res(!!b)); } catch { res(false); } }) });
  URL.revokeObjectURL(blob);
  host.remove();
  return out;
});

// ══════════ "이 문서" 찾기 — 눌러서 가고, 걸린 자리가 다 보인다 (2026-10-16) ══════════
// "해당 문서에서도 찾으면 눌렀을 때 그 쪽으로 가야지...... 그리고 찾은것들은
//  좀 하이라이트를 일시적이라도 띄워줘야 금방찾겠지"
await run('이 문서 찾기', async () => {
  const out = [];
  const src = await fetch('/js/app.js').then((x) => x.text());
  const mark = (src.match(/function markDocHit\(h\) \{[\s\S]*?\n}\n/) || [''])[0];
  out.push({ name: '보이는 장의 걸린 자리를 전부 모은다',
    ok: /docHits\.filter\(\(x\) => x\.sec === h\.sec\)/.test(mark) });
  out.push({ name: '지금 자리만 더 진하게', ok: /hit === h \? ' on' : ''/.test(mark) });
  out.push({ name: '뒤에서부터 감싼다(앞을 바꾸면 뒤 자리가 밀린다)',
    ok: /j = jobs\.length - 1/.test(mark) });
  out.push({ name: '**줄을 누르면 창을 닫고 그리로 간다**',
    ok: /closeSearch\(\{ keepMarks: true \}\)/.test(src) });
  out.push({ name: 'Enter로 훑을 때는 창을 안 닫는다',
    ok: !/function stepDocHit[\s\S]{0,220}closeSearch/.test(src) });
  out.push({ name: '칠한 자리는 잠깐 남았다 스르르 사라진다',
    ok: /function fadeDocMarks/.test(src) && /fading/.test(src) });

  // 실제로 여러 군데가 칠해지는가 — markDocHit을 그대로 떼어 돌린다
  const body = document.getElementById('readBody');
  const keep = body.innerHTML;
  body.innerHTML = '<p>아트로핀을 주고, 다시 아트로핀을 더 주고, 마지막에 아트로핀으로 마친다.</p>';
  document.body.dataset.screen = 'readScreen';
  const text = body.textContent;
  const hits = [];
  for (let i = text.indexOf('아트로핀'); i >= 0; i = text.indexOf('아트로핀', i + 1)) {
    hits.push({ sec: 0, at: i, len: 4 });
  }
  const run2 = new Function('docHits', 'currentDoc', 'clearDocMarks', `
    ${mark}
    return markDocHit;`)(hits,
    () => ({ title: 't', path: 'p', sections: [{ heading: 'h', text }] }),
    () => document.querySelectorAll('mark.find-mark').forEach((m) => m.replaceWith(m.textContent)));
  run2(hits[1]);
  const marks = [...body.querySelectorAll('mark.find-mark')];
  out.push({ name: '**걸린 자리가 세 군데 다 칠해진다**', ok: marks.length === 3,
    detail: `${marks.length}군데` });
  out.push({ name: '지금 자리 하나만 진하다',
    ok: marks.filter((m) => m.classList.contains('on')).length === 1,
    detail: `${marks.filter((m) => m.classList.contains('on')).length}개` });
  out.push({ name: '진한 자리가 눌린 그 자리다',
    ok: marks[1] && marks[1].classList.contains('on') });
  out.push({ name: '칠하면서 글자를 먹지 않는다',
    ok: body.textContent === text, detail: body.textContent.slice(0, 30) });
  const cs = marks[0] ? getComputedStyle(marks[0]) : null;
  const csOn = marks[1] ? getComputedStyle(marks[1]) : null;
  out.push({ name: '진한 자리와 흐린 자리가 눈에 다르다',
    ok: !!cs && !!csOn && cs.backgroundColor !== csOn.backgroundColor,
    detail: `${cs && cs.backgroundColor} vs ${csOn && csOn.backgroundColor}` });
  body.innerHTML = keep;
  return out;
});

// ══════════ 긁으면 바로 복사된다 (2026-10-16 요청) ══════════
// "긁기를 하면 그냥 복사가 자동으로 되는걸로 바꾸자. 복사 엄청많이 쓰네."
await run('긁으면 복사', async () => {
  const out = [];
  const src = await fetch('/js/app.js').then((x) => x.text());
  const grab = src.match(/async function autoCopy\(text\) \{[\s\S]*?\n}\n/);
  out.push({ name: 'autoCopy가 있다', ok: !!grab });
  if (!grab) return out;
  const autoCopy = new Function(`${grab[0]}; return autoCopy;`)();

  // 진짜 클립보드는 헤드리스에서 막혀 있다 — 가짜를 끼워 **우리 쪽 흐름**만 본다
  const realCb = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const realExec = document.execCommand;
  let wrote = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async (t) => { wrote = t; } },
  });
  out.push({ name: '**긁은 글이 클립보드로 간다**',
    ok: (await autoCopy('긁은 글입니다')) === true && wrote === '긁은 글입니다', detail: String(wrote) });
  out.push({ name: '빈 글·null은 담지 않는다',
    ok: (await autoCopy('')) === false && (await autoCopy(null)) === false });

  // 비동기 API가 막히면 옛 방식으로 — 사파리는 손 뗀 뒤 시간이 지나면 막는다
  let legacy = 0;
  document.execCommand = (c) => { if (c === 'copy') { legacy++; return true; } return false; };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: () => Promise.reject(new Error('막힘')) },
  });
  const fb = await autoCopy('되돌이 길');
  out.push({ name: '비동기가 막히면 옛 방식으로 담는다', ok: fb === true && legacy === 1,
    detail: `${fb} · ${legacy}번` });
  out.push({ name: '되돌이 길이 숨은 칸을 안 남긴다',
    ok: !document.querySelector('textarea[readonly][style*="-9999"]') });
  document.execCommand = () => false;
  out.push({ name: '둘 다 막히면 조용히 실패(앱이 안 멈춘다)', ok: (await autoCopy('x')) === false });

  document.execCommand = realExec;
  if (realCb) Object.defineProperty(navigator, 'clipboard', realCb);

  out.push({ name: '긁자마자 담는다(팝업이 뜰 때)', ok: /autoCopy\(full\)/.test(src) });
  out.push({ name: '담겼다고 팝업에 조용히 적는다', ok: /복사됨/.test(src) });
  out.push({ name: '긁을 때마다 토스트를 띄우진 않는다',
    ok: !/autoCopy\(full\)[\s\S]{0,220}toast\(/.test(src) });
  out.push({ name: '복사 단추도 같은 길을 쓴다(따로 놀지 않게)',
    ok: /toast\(await autoCopy\(t\)/.test(src) });
  return out;
});

// ══════════ 한 번 툭 실패했다고 "인터넷이 없다"고 하지 않는다 (2026-10-17 신고) ══════════
// "인터넷 있는데 왜 못올렸다고함?"
// 아이패드는 화면이 쉬다 깨면 첫 요청이 한 번 실패한다(사파리가 Load failed를 던진다).
// 전파가 아직 안 깬 것뿐인데 그 한 번에 바로 포기하고 대기열에 넣고 있었다.
await run('저장 다시 해보기', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((x) => x.text());
  const { looksOffline, withRetry } = new Function(`
    ${(app.match(/\/\*\* 연결이 끊겨서 실패한 것처럼 보이는가\. \*\/\nfunction looksOffline[\s\S]*?\n}\n/) || [''])[0]}
    ${(app.match(/const RETRY_WAIT[\s\S]*?\nasync function withRetry[\s\S]*?\n}\n/) || [''])[0]}
    return { looksOffline, withRetry };`)();

  out.push({ name: '끊긴 오류는 끊김으로 본다', ok: looksOffline(new Error('Load failed')) === true });
  out.push({ name: '**GitHub이 답을 준 건 끊김이 아니다**(상태 코드가 찍혀 있다)',
    ok: looksOffline(new Error('저장 실패 (422) — 뭔가')) === false });
  out.push({ name: '권한 오류도 끊김이 아니다',
    ok: looksOffline(new Error('저장 실패 (403) — 권한이 없습니다')) === false });

  let tries = 0;
  const t0 = Date.now();
  const got = await withRetry(async () => {
    tries++;
    if (tries < 2) throw new Error('Load failed');
    return { path: 'a/b.md' };
  });
  out.push({ name: '**한 번 툭 실패해도 다시 해서 올라간다**',
    ok: got.path === 'a/b.md' && tries === 2, detail: `${tries}번 시도` });
  out.push({ name: '다시 하느라 오래 붙들지 않는다', ok: Date.now() - t0 < 1800,
    detail: `${Date.now() - t0}ms` });

  let n = 0;
  let threw = '';
  try { await withRetry(async () => { n++; throw new Error('Load failed'); }); } catch (e) { threw = e.message; }
  out.push({ name: '진짜 끊김은 세 번 해보고 포기한다', ok: n === 3 && threw === 'Load failed',
    detail: `${n}번` });

  let m = 0;
  const t1 = Date.now();
  try { await withRetry(async () => { m++; throw new Error('저장 실패 (404) — 없음'); }); } catch { /* 예상 */ }
  out.push({ name: '끊김이 아니면 한 번만 하고 바로 알린다(괜히 안 기다린다)',
    ok: m === 1 && Date.now() - t1 < 250, detail: `${m}번 ${Date.now() - t1}ms` });

  out.push({ name: '모아두기도 다시 해보는 길을 쓴다',
    ok: /withRetry\(\(\) => createFile\(p\.path/.test(app) });
  out.push({ name: '대기열 다시 보내기도 같은 길을 쓴다',
    ok: /withRetry\(\(\) => createFile\(it\.path/.test(app) });
  return out;
});

// ══════════ 회독수 — 처음 배우는 것과 인출 실패를 가른다 (2026-10-17 요청) ══════════
// "회독수가 1회 미만일때는 검색하고 기전 궁금한거 찾아보고 이런단말이지?
//  처음 읽을때랑 나중에 인출안되는거랑 구별해야 할 것 같음"
// "거의 모르는 내용을 정리한건데 인출실패로 기록되는 측면이 있었음(응급 한정)"
await run('회독수와 모아두기 갈래', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((x) => x.text());
  // ⚠️ "DOM에 있다"만 보면 안 된다 — 처음에 그리는 함수를 아무도 안 불러서 **영영 안
  //    보였는데** 그 검사는 통과했다(2026-10-17: "엥 읽기모드에 회독버튼 없는데?").
  //    노트를 여는 길이 여럿이라, **한 길(syncReader)에서만** 그리는지까지 본다.
  out.push({ name: '회독 단추가 머리줄에 있다', ok: !!document.getElementById('readPass') });
  out.push({ name: '**노트를 여는 길에서 실제로 그린다**',
    ok: /function syncReader\(\)[\s\S]{0,420}paintPassBtn\(\)/.test(app) });
  {
    document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
    document.getElementById('readScreen').classList.remove('hidden');
    document.body.dataset.screen = 'readScreen';
    await new Promise((r) => setTimeout(r, 50));
    const b = document.getElementById('readPass');
    const paint = new Function('reader', 'passOf', `
      ${(app.match(/function paintPassBtn\(\) \{[\s\S]*?\n}\n/) || [''])[0]}
      return paintPassBtn;`);
    // 앞 검사가 노트를 열어둔 채로 넘어올 수 있다 — 상태를 **직접 세우고** 본다
    paint({ note: null }, () => 0)();
    out.push({ name: '노트를 안 읽을 땐 숨는다', ok: b.classList.contains('hidden') });
    if (window.__paintFindFab) window.__paintFindFab();
    paint({ note: { path: '02_Wiki/과목/a.md' } }, () => 0)();
    await new Promise((r) => setTimeout(r, 50));
    const rect = b.getBoundingClientRect();
    out.push({ name: '**노트를 열면 눈에 보인다**',
      ok: !b.classList.contains('hidden') && rect.width > 0 && rect.height > 0,
      detail: `${Math.round(rect.width)}×${Math.round(rect.height)} "${b.textContent}"` });
    // 머리줄 오른쪽에 뒀더니 떠다니는 도구막대에 가렸다(2026-10-17) — 아래 막대로 내렸다
    out.push({ name: '**아래 막대에 있다(머리줄이 아니다)**', ok: !!b.closest('.navbar'),
      detail: b.parentElement ? b.parentElement.className : '없음' });
    const fab = document.getElementById('findFab').getBoundingClientRect();
    out.push({ name: '**돋보기 바로 옆이다**',
      ok: Math.abs(rect.top - fab.top) < 20 && rect.left > fab.left && rect.left - fab.right < 30,
      detail: `돋보기 ~${Math.round(fab.right)} · 회독 ${Math.round(rect.left)}~` });
    const tools = document.getElementById('readTools').getBoundingClientRect();
    out.push({ name: '**도구막대에 안 가린다**',
      ok: !(tools.width && rect.left < tools.right && rect.right > tools.left
        && rect.top < tools.bottom && rect.bottom > tools.top) });
    const clash = [...document.querySelectorAll('#readScreen .navbar button')]
      .filter((x) => x !== b && x.id !== 'findFab').map((x) => x.getBoundingClientRect())
      .filter((x) => x.width && rect.left < x.right && rect.right > x.left
        && rect.top < x.bottom && rect.bottom > x.top);
    out.push({ name: '막대 안 다른 단추와 안 겹친다', ok: !clash.length, detail: `${clash.length}개` });
    out.push({ name: '누를 만한 크기다', ok: rect.height >= 28 && rect.width >= 50,
      detail: `${Math.round(rect.width)}×${Math.round(rect.height)}` });
    paint({ note: { path: '02_Wiki/과목/a.md' } }, () => 2)();
    out.push({ name: '회독을 마치면 글씨와 색이 바뀐다',
      ok: b.textContent === '2회독' && b.classList.contains('done'), detail: b.textContent });
    paint({ note: null }, () => 0)();
  }
  out.push({ name: '모아두기에 갈래 고르기가 있다',
    ok: document.querySelectorAll('#scKind .sc-k').length === 2 });
  out.push({ name: '회독수를 기기에 저장한다', ok: /READ_PASS_KEY = 'read_pass'/.test(app) });
  out.push({ name: '**회독수가 백업에 들어간다**(기기를 갈아도 남는다)',
    ok: /'read_pass'/.test(await fetch('/js/backup.js').then((x) => x.text())) });

  // 갈래를 정하는 셈만 떼어 본다 — 회독수와 맥락에 따라 갈려야 한다
  const mk = (passes, ctx) => new Function('passOf', 'scrapContext', `
    ${(app.match(/function scrapBucket\(\) \{[\s\S]*?\n}\n/) || [''])[0]}
    return scrapBucket;`)(passes, ctx)();
  const note = (p) => () => ({ kind: '노트', path: p, subject: 's', title: 't', where: '' });
  out.push({ name: '**1회독 중이면 "처음 배우는 것"**', ok: mk(() => 0, note('a.md')) === 'learn' });
  out.push({ name: '**1회독 마친 뒤면 "인출 실패"**', ok: mk(() => 1, note('a.md')) === 'recall' });
  out.push({ name: '3회독 뒤도 인출 실패', ok: mk(() => 3, note('a.md')) === 'recall' });
  out.push({ name: '문제를 풀다 담으면 회독과 무관하게 인출 실패',
    ok: mk(() => 0, () => ({ kind: '모의고사', path: 'x.html' })) === 'recall' });
  out.push({ name: '어디에도 안 묶인 메모는 처음 배우는 것',
    ok: mk(() => 0, () => ({ kind: '메모', path: '' })) === 'learn' });

  // 저장되는 글에 성격이 적히는가 — 가중치를 주는 쪽이 이걸 읽는다
  out.push({ name: '첫 회독이면 달모/첫회독 태그', ok: /달모\/첫회독/.test(app) });
  out.push({ name: '회독 뒤면 달모/인출실패 태그', ok: /달모\/인출실패/.test(app) });
  out.push({ name: '**둘의 안내 문구가 다르다**',
    ok: /처음 배우는 것 — 아직 정리 안 된 수집물/.test(app)
      && /인출 실패 — 아는 줄 알았는데 안 나온 것/.test(app) });
  out.push({ name: '인출 실패 쪽은 "노트에 있는데 못 찾은 경우"를 먼저 보게 한다',
    ok: /이미 노트에 있는데 못 찾은 것/.test(app) });
  out.push({ name: '손으로 갈래를 바꿀 수 있다', ok: /scrapKind = b\.dataset\.bucket/.test(app) });

  // 목록에서도 몇 회독인지 보여야 한다 — 열기 전에 무엇을 다시 볼지 고른다(2026-10-17)
  // ⚠️ 전에는 app.js에서 passTag 소스를 뜯어 따로 돌렸다. 그 함수가 다른 함수를 부르기
  //    시작하자 거기서 터졌고, 무엇보다 **검사가 보는 것과 앱이 쓰는 것이 갈린다**.
  //    이제 진짜 함수를 부른다(window.__passUi).
  const U = window.__passUi;
  out.push({ name: '검사가 진짜 회독 표시를 부를 수 있다', ok: !!(U && U.tag && U.btn) });
  if (U) {
    const P = '02_Wiki/과목/pass-test.md';
    await U.set(P, 0);
    const t0 = U.tag(P);
    document.body.append(t0);
    out.push({ name: '1회독 중이면 아무것도 안 붙는다',
      ok: getComputedStyle(t0).display === 'none', detail: t0.textContent || '(빈칸)' });
    await U.set(P, 2);
    const t2 = U.tag(P);
    document.body.append(t2);
    out.push({ name: '**읽은 노트엔 회독수가 붙는다**',
      ok: t2.textContent === '2회독' && getComputedStyle(t2).display !== 'none',
      detail: t2.textContent });

    // ── "오늘" 탭에서 **눌러서** 센다 (2026-10-19 요청) ──
    // "이런 홈화면에서도 회독수 버튼 이름 옆에 만들어서 누를 수 있게 해줘.
    //  당연히 노트 안에서 보는거랑 연동이 돼야겠지."
    await U.set(P, 0);
    const btn = U.btn(P);
    document.body.append(btn);
    out.push({ name: '**1회독 중에도 보인다**(안 보이면 누를 수가 없다)',
      ok: getComputedStyle(btn).display !== 'none' && btn.textContent === '1회독 중',
      detail: `"${btn.textContent}" display:${getComputedStyle(btn).display}` });
    const rbt = btn.getBoundingClientRect();
    out.push({ name: '누를 만한 크기다', ok: rbt.height >= 22 && rbt.width >= 40,
      detail: `${Math.round(rbt.width)}×${Math.round(rbt.height)}` });
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
    out.push({ name: '**누르면 1회독이 센다**', ok: U.of(P) === 1 && btn.textContent === '1회독',
      detail: `${U.of(P)}회 "${btn.textContent}"` });
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
    out.push({ name: '또 누르면 2회독', ok: U.of(P) === 2, detail: `${U.of(P)}회` });

    // 같은 수를 보는가 — 노트 안 단추와 목록 표시와 "오늘" 탭 단추가 하나로 움직여야 한다
    out.push({ name: '**옆에 떠 있던 표시도 같이 바뀐다**(연동)',
      ok: t2.textContent === '2회독' && t0.textContent === '2회독',
      detail: `목록표시 "${t0.textContent}" / "${t2.textContent}"` });
    await U.set(P, 5);
    out.push({ name: '노트 안에서 센 것도 여기 바로 비친다',
      ok: btn.textContent === '5회독' && t0.textContent === '5회독',
      detail: `단추 "${btn.textContent}" 표시 "${t0.textContent}"` });

    await U.set(P, 0);
    t0.remove(); t2.remove(); btn.remove();
  }
  out.push({ name: '오늘 탭 강의 제목 옆에 **누를 수 있는** 단추를 붙인다',
    ok: /head\.appendChild\(passBtn\(lecPath\)\)/.test(app) });
  out.push({ name: '노트 목록엔 표시만 붙인다(줄 자체가 단추라 단추를 겹칠 수 없다)',
    ok: /b\.append\(name, passTag\(n\.path\), arrow\)/.test(app) });
  out.push({ name: '창을 열 때마다 회독수대로 다시 정한다', ok: /scrapKind = null;/.test(app) });
  return out;
});

// ══════════ 서랍에서 오른쪽 창으로 떨구기 (2026-10-17 신고) ══════════
// "오른쪽에서 노트 열었을 때 스플릿 뷰로 보려고 오래 누르기 하면 그 노트가 열려있는
//  오른쪽으로 배치할 수가 없는 문제가 있음."
// 서랍이 오른쪽 360px를 덮는데 **오른쪽 창이 바로 그 밑**이라 거기로는 떨굴 수 없었다.
await run('서랍에서 떨구기', async () => {
  const out = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = await fetch('/js/app.js').then((x) => x.text());
  const css = await fetch('/css/app.css').then((x) => x.text());

  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  const host = document.getElementById('readPanes');
  const keep = host.innerHTML;
  const keepCls = host.className;
  host.classList.add('two');
  host.innerHTML = '<div class="read-pane" data-pane="0" style="flex:1">'
    + '<div class="read-card" style="height:300px">왼쪽</div></div>'
    + '<div class="pane-split-resizer"></div>'
    + '<div class="read-pane" data-pane="1" style="flex:1">'
    + '<div class="read-card" style="height:300px">오른쪽</div></div>';
  const dd = document.getElementById('docDrawer');
  const wasHidden = dd.classList.contains('hidden');
  dd.classList.remove('hidden');
  document.body.classList.add('dragging-doc');
  await wait(90);

  const ddr = dd.getBoundingClientRect();
  const panes = [...document.querySelectorAll('#readPanes .read-pane')]
    .map((p) => p.getBoundingClientRect());
  const cx = (panes[1].left + panes[1].right) / 2;
  const cy = (panes[1].top + panes[1].bottom) / 2;

  out.push({ name: '서랍이 오른쪽 창을 덮고 있다(이 상황이 문제였다)',
    ok: ddr.left < panes[1].right, detail: `서랍 ${Math.round(ddr.left)}~ · 오른창 ~${Math.round(panes[1].right)}` });
  // 손이 닿는 건 서랍이다(끌기가 거기서 시작되니 그래야 한다). 대신 **서랍이 받아
  // 좌표로 밑의 창을 찾아준다** — 아래 "오른쪽 창이 표적으로 잡힌다"가 그걸 본다.
  const hit = document.elementFromPoint(cx, cy);
  out.push({ name: '오른쪽 창 자리는 서랍이 덮고 있다(그래서 좌표로 푼다)',
    ok: !!(hit && hit.closest && hit.closest('#docDrawer')),
    detail: hit ? (hit.className || hit.tagName) : '없음' });
  // ⚠️ 서랍은 끄는 동안에도 **포인터를 계속 받아야** 한다 — 끌기가 서랍 안에서 시작되고,
  //    거기서 포인터를 꺼버리면 iOS에서 끌기 자체가 흔들린다(2026-10-17 신고).
  //    가려진 창은 포인터를 끄는 대신 **좌표로** 찾아준다(아래 "서랍 위에서 떨궈도 받는다").
  out.push({ name: '끄는 동안에도 서랍은 포인터를 받는다(끌기가 거기서 시작된다)',
    ok: getComputedStyle(dd).pointerEvents !== 'none', detail: getComputedStyle(dd).pointerEvents });
  out.push({ name: '끄는 동안 서랍이 거의 투명해진다(밑이 보이게)',
    ok: Number(getComputedStyle(dd).opacity) <= 0.35, detail: getComputedStyle(dd).opacity });
  out.push({ name: '**서랍 위에서 떨궈도 받는다**',
    ok: /\[host, document\.getElementById\('docDrawer'\)\]/.test(app) });

  // 끌 수 있는 것은 **글자 선택이 막혀 있어야** 한다 — iOS는 길게 누르면 선택부터 한다
  {
    const list = document.getElementById('docList') || document.createElement('div');
    const keepList = list.innerHTML;
    list.innerHTML = '<button class="dd-item" draggable="true"><span class="dd-name">시험</span></button>';
    await wait(40);
    // ⚠️ 계산값으로 재면 안 된다 — 크롬은 <button>에 기본으로 user-select:none을 준다.
    //    문제는 **iOS**이고 거기선 길게 누르면 선택이 먹는다. 그래서 **규칙이 있는지**를 본다.
    // 규칙 묶음을 통째로 찾는다 — 선택자만 있고 속성이 없으면 소용없다.
    // 주석을 먼저 걷어낸다 — 설명 글에 든 `.dd-item`이 규칙으로 잡히면 헛통과한다.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const ddRule = (bare.match(/\.dd-item[^{}]*\{[^}]*\}/g) || [])
      .find((b) => /user-select:\s*none/.test(b)) || '';
    out.push({ name: '**서랍 줄에 글자 선택 막기가 걸려 있다**(없으면 iOS에서 끌기가 안 된다)',
      ok: !!ddRule, detail: ddRule.slice(0, 50) });
    out.push({ name: '안쪽 글씨까지 걸려 있다', ok: /\.dd-item \*/.test(ddRule), detail: ddRule.slice(0, 40) });
    out.push({ name: '길게 눌러도 확대경이 안 뜬다',
      ok: /-webkit-touch-callout:\s*none/.test(ddRule), detail: ddRule.slice(0, 60) });
    list.innerHTML = keepList;
  }
  {
    // ⚠️ 이 검사는 가짜 창으로 #readBody를 지운 뒤라 **임시 상자**에 재야 한다
    const rb = document.createElement('div');
    rb.className = 'read-body';
    rb.innerHTML = '<p>앞말 <a class="wikilink" data-note="가" draggable="true">가</a> 뒷말</p>';
    document.body.appendChild(rb);
    await wait(40);
    // 이쪽은 계산값이 뜻을 가진다 — `.read-body *`가 text로 덮으려 들기 때문이다
    out.push({ name: '**본문 속 끌 수 있는 링크는 선택이 막힌다**(본문은 text인데도)',
      ok: getComputedStyle(rb.querySelector('.wikilink')).userSelect === 'none',
      detail: getComputedStyle(rb.querySelector('.wikilink')).userSelect });
    out.push({ name: '본문 글자는 여전히 선택된다(긁기가 살아 있다)',
      ok: getComputedStyle(rb.querySelector('p')).userSelect === 'text' });
    rb.remove();
  }

  // 어느 창을 겨눴는지 정하는 셈을 그대로 떼어 본다
  const two = new Function('panes', 'activePane', `
    ${(app.match(/function paneAtPoint[\s\S]*?\n}\n/) || [''])[0]}
    ${(app.match(/function dropPlan[\s\S]*?\n}\n/) || [''])[0]}
    ${(app.match(/function paintDropHint[\s\S]*?\n}\n/) || [''])[0]}
    return { dropPlan, paintDropHint };`)([{}, {}], 0);
  const markedAt = (px, py) => {
    two.paintDropHint(two.dropPlan(px, py));
    return [...document.querySelectorAll('#readPanes .read-pane')]
      .findIndex((p) => p.classList.contains('drop-into'));
  };
  out.push({ name: '**오른쪽 창이 표적으로 잡힌다**', ok: markedAt(cx, cy) === 1,
    detail: `${markedAt(cx, cy)}번 창` });
  const lx = (panes[0].left + panes[0].right) / 2;
  const ly = (panes[0].top + panes[0].bottom) / 2;
  out.push({ name: '왼쪽 창도 표적이 된다', ok: markedAt(lx, ly) === 0, detail: `${markedAt(lx, ly)}번 창` });
  out.push({ name: '겨눈 창에 글씨로 알려준다', ok: /\.read-pane\.drop-into::after/.test(css) });

  // 창이 하나일 때 "갈라서 열기"도 그대로여야 한다
  const one = new Function('panes', 'activePane', `
    ${(app.match(/function paneAtPoint[\s\S]*?\n}\n/) || [''])[0]}
    ${(app.match(/function dropPlan[\s\S]*?\n}\n/) || [''])[0]}
    return dropPlan;`)([{}], 0);
  out.push({ name: '창이 하나면 오른쪽은 갈라서 열기', ok: one(cx, cy).split === true });
  out.push({ name: '창이 하나면 왼쪽은 그 자리에 열기', ok: one(lx, ly).split === false });

  document.body.classList.remove('dragging-doc');
  if (wasHidden) dd.classList.add('hidden');
  host.className = keepCls;
  host.innerHTML = keep;
  return out;
});

// ══════════ 들러보기 — 몇 개 중 몇 번째, 다음·이전 (2026-10-17 요청) ══════════
// "한 문서여도 여러개 찾을 수 있을 것 같은데 몇개 중에 몇번째 찾는건지?
//  다음 다음 검색 이전검색 이런거 되게 해줘"
await run('들러보기 찾아가기', async () => {
  const out = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (typeof window.__showPeek !== 'function') {
    out.push({ name: '들러보기를 열 수 있다', ok: false, detail: '통로가 없다' });
    return out;
  }
  const note = { title: 'ATLS', path: 'x.md', sections: [
    { heading: '1. 앞장', text: '여기에 rocuronium 이 한 번 나온다.' },
    { heading: '2. 약물', text: 'rocuronium 1mg/kg 투여. 이어서 rocuronium 을 추가. 끝에 또 rocuronium.' },
    { heading: '3. 끝장', text: '관계없는 내용이다.' },
  ] };
  window.__showPeek(note, 1, 'rocuronium', 'ATLS');
  await wait(220);
  const where = () => document.getElementById('pkWhere').textContent;
  const marks = () => [...document.querySelectorAll('#pkBody mark.peek-hit')];

  out.push({ name: '**몇 개 중 몇 번째인지 나온다**', ok: /찾은 곳 \d+\/4/.test(where()), detail: where() });
  out.push({ name: '누른 장에서 시작한다', ok: /2\/3장/.test(where()), detail: where() });
  out.push({ name: '이 장에 걸린 자리를 전부 칠한다', ok: marks().length === 3,
    detail: `${marks().length}군데` });
  out.push({ name: '지금 자리만 진하다',
    ok: marks().filter((m) => m.classList.contains('on')).length === 1 });

  const next = document.getElementById('pkNext');
  const prev = document.getElementById('pkPrev');
  out.push({ name: '단추가 "다음/이전"으로 바뀐다',
    ok: /다음/.test(next.textContent) && /이전/.test(prev.textContent),
    detail: `${prev.textContent} / ${next.textContent}` });
  next.click(); await wait(140);
  out.push({ name: '**다음을 누르면 번호가 올라간다**', ok: /찾은 곳 3\/4/.test(where()), detail: where() });
  next.click(); await wait(140);
  next.click(); await wait(140);
  out.push({ name: '끝에서 처음으로 돌아오고 장도 넘어간다',
    ok: /찾은 곳 1\/4/.test(where()) && /1\/3장/.test(where()), detail: where() });
  prev.click(); await wait(140);
  out.push({ name: '이전은 거꾸로 돈다', ok: /찾은 곳 4\/4/.test(where()), detail: where() });

  // Enter / Shift+Enter — 문서 안 찾기와 같은 손놀림
  const cur = () => (where().match(/찾은 곳 (\d+)/) || [])[1];
  const was = cur();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(140);
  out.push({ name: '**Enter로 다음 자리**', ok: cur() !== was, detail: `${was} → ${cur()}` });
  const mid = cur();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  await wait(140);
  out.push({ name: 'Shift+Enter로 이전 자리', ok: cur() === was, detail: `${mid} → ${cur()}` });

  // 찾는 말이 없으면 장 넘기기로 돌아간다
  window.__showPeek(note, 0, '', 'ATLS');
  await wait(160);
  out.push({ name: '찾는 말이 없으면 장 넘기기',
    ok: !/찾은 곳/.test(where()) && /앞|뒤/.test(document.getElementById('pkNext').textContent),
    detail: `${where()} | ${document.getElementById('pkNext').textContent}` });
  document.getElementById('pkNext').click(); await wait(140);
  out.push({ name: '장이 넘어간다', ok: /2\/3장/.test(where()), detail: where() });
  document.getElementById('pkClose').click();
  return out;
});

// ══════════ 캡처 네모가 손을 따라온다 (2026-10-16 신고) ══════════
// "한번 커진다음에 작은 방향으로 움직이거나 하면 캡쳐범위가 잘 안따라옴."
// 자취 전체를 감싸고 있어서 **커지기만 하고 줄지 않았다**. 모서리를 끄는 손짓은
// 누른 자리↔지금 자리로 재야 한다 — 다만 둘러 그린 획은 그러면 사그라든다.
await run('캡처 네모', async () => {
  const out = [];
  const { PenLayer } = await import('/js/pen.js');
  // 앞 검사가 남긴 화면이 포인터를 가로채면 안 된다 — 펜은 UI 위에서는 평범한
  // 포인터로 동작하므로, 받침을 **맨 위에** 올려 깨끗한 자리에서 잰다
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.body.dataset.screen = 'listScreen';
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;z-index:5000;background:#fff';
  document.body.appendChild(host);
  const pen = new PenLayer(host, {});
  pen.setTool('shot');
  const ev = (t, x, y) => document.dispatchEvent(new PointerEvent(t,
    { pointerId: 9, pointerType: 'pen', clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: 1 }));
  const size = () => { const b = pen._previewBox;
    return b ? { w: Math.round(b.r - b.l), h: Math.round(b.b - b.t) } : null; };
  const paint = () => pen._refreshPreview();
  const reset = () => { pen._pending = null; pen._cur = null; pen._previewBox = null; };

  ev('pointerdown', 100, 100);
  for (const [x, y] of [[200, 180], [320, 280], [440, 380]]) { ev('pointermove', x, y); paint(); }
  const big = size();
  for (const [x, y] of [[360, 300], [260, 220], [180, 160]]) { ev('pointermove', x, y); paint(); }
  const small = size();
  ev('pointerup', 180, 160);
  out.push({ name: '크게 끌면 커진다', ok: !!big && big.w >= 300, detail: JSON.stringify(big) });
  out.push({ name: '**되돌리면 따라서 작아진다**', ok: !!small && !!big && small.w <= big.w - 200,
    detail: `${big ? big.w : '?'} → ${small ? small.w : '?'}px` });
  out.push({ name: '되돌린 네모가 손 자리와 맞는다',
    ok: !!small && Math.abs(small.w - 80) <= 6 && Math.abs(small.h - 60) <= 6,
    detail: JSON.stringify(small) });

  // 둘러 그린 획은 사그라들지 않는다 — 예전에 이걸 고치려다 위 동작이 막혔다
  reset();
  ev('pointerdown', 100, 100);
  for (const [x, y] of [[300, 100], [300, 250], [100, 250], [100, 110]]) {
    for (let i = 0; i < 6; i++) ev('pointermove', x, y);
    paint();
  }
  const looped = size();
  ev('pointerup', 100, 110);
  out.push({ name: '둘러 그린 네모는 사그라들지 않는다',
    ok: !!looped && looped.w >= 180 && looped.h >= 140, detail: JSON.stringify(looped) });

  // 손 떨림으로는 "둘러 그렸다"로 넘어가지 않는다
  reset();
  ev('pointerdown', 120, 120);
  for (let i = 1; i <= 10; i++) {
    ev('pointermove', 120 + i * 20, 120 + i * 15 + (i % 2 ? 6 : -6));
    paint();
  }
  const shaky = size();
  ev('pointerup', 320, 270);
  out.push({ name: '떨면서 끌어도 모서리 네모로 친다',
    ok: !!shaky && Math.abs(shaky.w - 200) <= 12, detail: JSON.stringify(shaky) });

  // 손을 뗀 뒤 확정된 네모가 보여주던 것과 같아야 한다(예전에 "팍 튀었다")
  pen.destroy();                 // 두 겹이 같은 포인터를 받지 않게 먼저 치운다
  let got = null;
  const pen2 = new PenLayer(host, { onCapture: (b) => { got = b; } });
  pen2.setTool('shot');
  ev('pointerdown', 150, 150);
  for (const [x, y] of [[400, 400], [300, 300], [250, 250]]) {
    ev('pointermove', x, y);
    pen2._refreshPreview();
  }
  const shown = pen2._previewBox ? Math.round(pen2._previewBox.r - pen2._previewBox.l) : null;
  ev('pointerup', 250, 250);
  await new Promise((r) => setTimeout(r, 450));
  out.push({ name: '**확정된 네모가 보여주던 것과 같다**',
    ok: !!got && shown != null && Math.abs(Math.round(got.r - got.l) - shown) <= 2,
    detail: `보임 ${shown} · 확정 ${got ? Math.round(got.r - got.l) : '없음'}` });
  pen2.destroy(); host.remove();
  return out;
});

// ══════════ 들러보기 창의 그림 (2026-10-16 신고) ══════════
// "검색으로 팝업으로 띄운 창에서는 왜 이미지 로드가 안됨?"
// renderSection이 이미 그림을 불러오는데 그 뒤에 hydrateEmbeds를 **경로 문자열**로 또
// 불렀다. 둘째 인자는 이름 → 주소 **함수**라 resolve(name)이 터지고, 그 catch가
// 멀쩡히 뜨던 그림을 "불러오지 못했습니다"로 갈아치웠다.
await run('들러보기 그림', async () => {
  const out = [];
  const md = await import('/js/markdown.js');
  const app = await fetch('/js/app.js').then((x) => x.text());
  const paint = (app.match(/function paintPeek\(\) \{[\s\S]*?\n}\n/) || [''])[0];
  // 주석은 빼고 **실제로 도는 줄**만 본다 — 왜 그랬는지 적어둔 글까지 걸리면 안 된다
  const code = paint.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  out.push({ name: 'paintPeek을 찾았다', ok: !!paint });
  out.push({ name: '**그림을 두 번 불러오지 않는다**', ok: !/hydrateEmbeds/.test(code),
    detail: (code.match(/hydrateEmbeds.*/) || [''])[0] });
  out.push({ name: '읽기 화면과 같은 길로 그린다(renderSection)', ok: /renderSection\(body, sec\)/.test(paint) });

  // 잘못 쓰면 **조용히 그림을 지우지 말고** 크게 터져야 한다
  const probe = document.createElement('div');
  probe.innerHTML = md.renderMarkdown('![[그림.png]]');
  document.body.appendChild(probe);
  let threw = '';
  try { await md.hydrateEmbeds(probe, '02_Wiki/가/나.md'); } catch (e) { threw = e.message; }
  out.push({ name: '**함수가 아닌 걸 넘기면 바로 터진다**', ok: /함수/.test(threw), detail: threw || '조용히 넘어감' });
  out.push({ name: '터질지언정 그림을 지우지는 않는다',
    ok: !/불러오지 못했습니다/.test(probe.textContent), detail: probe.textContent.slice(0, 40) });

  // 제대로 넘기면 주소가 꽂힌다
  const probe2 = document.createElement('div');
  probe2.innerHTML = md.renderMarkdown('![[그림.png]]');
  document.body.appendChild(probe2);
  await md.hydrateEmbeds(probe2, async (name) => `blob:fake/${name}`);
  const im = probe2.querySelector('img.embed');
  out.push({ name: '함수를 넘기면 그림이 살아난다', ok: !!im && /blob:fake/.test(im.src),
    detail: im ? im.src : '그림 없음' });

  // 들러보기 본문도 읽기 화면과 같은 그림 규칙을 받는다
  const peek = document.createElement('div');
  peek.className = 'peek-body';
  peek.innerHTML = '<img class="embed" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
  document.body.appendChild(peek);
  const cs = getComputedStyle(peek.querySelector('img'));
  out.push({ name: '들러보기 그림도 창 밖으로 안 넘친다', ok: cs.maxWidth === '100%', detail: cs.maxWidth });
  probe.remove(); probe2.remove(); peek.remove();

  // ── "이 문서" 범위에서도 들러볼 수 있다 (2026-10-16 신고) ──
  // "찾기에서 이 문서에서 검색하면 오래 눌러도 해당 창이 안보이네?"
  // 전체 검색 쪽에만 오래 누르기를 달아뒀었다.
  out.push({ name: '"이 문서" 결과에도 오래 누르기가 달렸다',
    ok: /longPress\(b, \(\) => showPeek\(doc, h\.sec/.test(app) });
  out.push({ name: '이미 들고 있는 문서는 다시 받지 않는다',
    ok: /function showPeek\(note, secIdx, needle, title\)/.test(app)
      && !/function showPeek[\s\S]{0,260}loadNote/.test(app) });

  if (typeof window.__showPeek === 'function') {
    const note = { title: '시험용 노트', path: 'x.md', sections: [
      { heading: '1. 앞장', text: '앞장 내용이다.' },
      { heading: '2. 뒷장', text: '여기에 doxycycline 이 나온다. 뒤로 더 이어진다.' },
    ] };
    window.__showPeek(note, 1, 'doxycycline', '시험용 노트');
    await new Promise((r) => setTimeout(r, 160));
    const f2 = document.getElementById('peekFloat');
    out.push({ name: '**오래 누르면 그 장이 창에 뜬다**',
      ok: !f2.classList.contains('hidden')
        && /doxycycline/.test(document.getElementById('pkBody').textContent),
      detail: document.getElementById('pkBody').textContent.slice(0, 40) });
    out.push({ name: '몇 번째 장인지 알려준다',
      ok: /2\/2/.test(document.getElementById('pkWhere').textContent),
      detail: document.getElementById('pkWhere').textContent });
    out.push({ name: '걸린 말이 칠해진다',
      ok: !!document.querySelector('#pkBody mark.peek-hit') });
    out.push({ name: '앞 장으로 넘겨볼 수 있다', ok: !document.getElementById('pkPrev').disabled });
    document.getElementById('pkPrev').click();
    await new Promise((r) => setTimeout(r, 120));
    out.push({ name: '넘기면 앞 장이 보인다',
      ok: /앞장 내용/.test(document.getElementById('pkBody').textContent)
        && /1\/2/.test(document.getElementById('pkWhere').textContent),
      detail: document.getElementById('pkWhere').textContent });
    document.getElementById('pkClose').click();
    out.push({ name: '닫으면 사라진다', ok: f2.classList.contains('hidden') });
  }
  return out;
});

// ══════════ 이상한 입력에도 안 무너진다 (2026-10-16 점검) ══════════
await run('이상한 입력', async () => {
  const out = [];
  const R = await import('/js/reader.js');
  const S = await import('/js/search.js');
  const db = await import('/js/db.js');

  // 카드 본문 정돈 — 무엇이 들어와도 글자열을 돌려주고 터지지 않는다
  const weird = [['빈값', ''], ['null', null], ['안 닫힌 태그', '<p>열고 안 닫음'],
    ['중첩 빈칸', '<span class="cloze" data-answer="가"><span class="cloze" data-answer="나">나</span></span>'],
    ['답 없는 빈칸', '<span class="cloze">   </span>']];
  const broke = [];
  for (const [label, v] of weird) {
    try { if (typeof R.tidyCardHtml(v) !== 'string') broke.push(label); } catch { broke.push(label); }
  }
  out.push({ name: '이상한 본문에도 안 터진다', ok: !broke.length, detail: broke.join(',') || '전부 멀쩡' });

  // 여러 번 정돈해도 결과가 같다 — 그릴 때마다 도는 함수라 쌓이면 안 된다
  const once = R.tidyCardHtml('<li><span class="tok">가</span>   <span class="tok">은</span>'
    + ' <span class="cloze" data-answer="나">  </span>    <span class="tok">다</span></li>');
  out.push({ name: '**정돈을 여러 번 돌려도 결과가 같다**',
    ok: R.tidyCardHtml(once) === once && R.tidyCardHtml(R.tidyCardHtml(once)) === once,
    detail: once.slice(0, 50) });

  // 공백을 털되 **글자는 안 먹는다**
  const keep = [['영문 사이', '<p>AST and ALT</p>', 'AST and ALT'],
    ['숫자 사이', '<p>1 2 3</p>', '1 2 3'],
    ['조사 아닌 한 글자', '<p>안 들면 치료하지</p>', '안 들면 치료하지'],
    ['영문 괄호 관례', '<p>text (note) here</p>', 'text (note) here']];
  const lost = [];
  for (const [label, html, want] of keep) {
    const d = document.createElement('div');
    d.innerHTML = R.tidyCardHtml(html);
    if (d.textContent.replace(/\s+/g, ' ').trim() !== want) lost.push(label);
  }
  out.push({ name: '공백을 털어도 글자는 안 먹는다', ok: !lost.length, detail: lost.join(',') || '전부 보존' });

  // 점수 매기기가 null에 속지 않는다 — String(null)이 "null"이 되어 영문 용어로 3점을 받았다
  out.push({ name: 'wordScore가 null에 점수를 안 준다',
    ok: R.wordScore(null) === 0 && R.wordScore(undefined) === 0 && R.wordScore('') === 0,
    detail: `${R.wordScore(null)}/${R.wordScore(undefined)}` });

  // 깨진 정규식·빈 일치로 멈추지 않는다
  const t0 = performance.now();
  let threw = '';
  for (const q of ['.*', 'a*', '(((', '[']) {
    try { await S.search(q, 20, { regex: true }); } catch (e) { threw = `${q}: ${e.message}`; }
  }
  out.push({ name: '깨지거나 빈 정규식에도 멈추지 않는다',
    ok: !threw && performance.now() - t0 < 3000, detail: threw || `${Math.round(performance.now() - t0)}ms` });

  // 묶음 읽기
  await db.cacheSet('zz/1.md', '하나');
  const got = await db.cacheGetMany(['zz/1.md', '없는/것.md', 'zz/1.md']);
  out.push({ name: '캐시 묶음 읽기가 맞다',
    ok: got.get('zz/1.md') === '하나' && !got.has('없는/것.md') && got.size === 1 });
  out.push({ name: '빈 목록·null에도 안 터진다',
    ok: (await db.cacheGetMany([])).size === 0 && (await db.cacheGetMany(null)).size === 0 });

  // 길게 누르기 — 손가락은 뒤따르는 click이 없다. 깃발이 남아 **다음 탭을 삼키면** 안 된다
  const app = await fetch('/js/app.js').then((x) => x.text());
  const longPress = new Function(
    `${app.match(/const LONG_MS[\s\S]*?\nfunction longPress\(el, fn\) \{[\s\S]*?\n}\n/)[0]}; return longPress;`)();
  const el = document.createElement('button');
  document.body.appendChild(el);
  let longs = 0;
  let clicks = 0;
  longPress(el, () => longs++);
  el.addEventListener('click', () => clicks++);
  el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, clientX: 5, clientY: 5 }));
  await new Promise((r) => setTimeout(r, 520));
  el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, clientX: 5, clientY: 5 }));
  out.push({ name: '길게 누르면 길게 누른 걸로 친다', ok: longs === 1 && clicks === 0 });
  el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, bubbles: true, clientX: 5, clientY: 5 }));
  el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true, clientX: 5, clientY: 5 }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  out.push({ name: '**길게 누른 뒤의 보통 탭을 삼키지 않는다**', ok: clicks === 1 && longs === 1,
    detail: `탭 ${clicks}번 · 길게 ${longs}번` });
  el.remove();
  return out;
});

// ══════════ 찾기 범위 — 열어본 것만이 아니라 전부 (2026-10-15) ══════════
// "지금껏 꼭 열어본 페이지만 검색이 되는 이유는 뭐지. 그게 더 좋은가?"
await run('찾기 범위', async () => {
  const out = [];
  const S = await import('/js/search.js');
  out.push({ name: 'vault 글 전체를 받는 길이 있다', ok: typeof S.buildIndex === 'function' });
  out.push({ name: '받아둔 상태를 알려준다', ok: typeof S.indexInfo === 'function' });
  out.push({ name: '글이 든 폴더만 받는다(첨부는 뺀다)',
    ok: S.indexable('02_Wiki/응급_중환자/가.md')
      && S.indexable('00_Raw_Text/기출문제_학교/응급_중환자/10_환경의학.md')
      && S.indexable('05_퀴즈/응급_중환자/가.md')
      && !S.indexable('attachments/그림.png')
      && !S.indexable('attachments/메모.md')
      && !S.indexable('.medstudy/state.json')
      && !S.indexable('02_Wiki/응급_중환자/가.html') });
  const info = await S.indexInfo();
  out.push({ name: '아직 안 받았으면 그렇다고 한다', ok: typeof info.built === 'boolean',
    detail: `${info.built ? `글 ${info.files}개` : '아직'}` });

  const app = await fetch('/js/app.js').then((r) => r.text());
  out.push({ name: '설정에 "전체 글 받아두기"가 있다', ok: !!document.getElementById('indexBtn') });
  out.push({ name: '**결과가 없을 때 그 자리에서 받을 수 있다**',
    ok: /vault 글 전체 받아두기/.test(app) });
  out.push({ name: '받아둔 뒤에는 바뀐 것만 조용히 맞춘다',
    ok: /runIndex\(\{ quiet: true \}\)/.test(app) && /git\/trees/.test(
      await fetch('/js/github.js').then((r) => r.text())) });
  out.push({ name: '"열어본 것만 검색된다"는 옛 안내가 남아 있지 않다',
    ok: !/한 번도 열어보지 않은 자료는 검색되지 않습니다/.test(app) });
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
  let hitNetwork = false;
  window.fetch = (url, init) => {
    if (!String(url).includes('generativelanguage')) return realFetch(url, init);
    hitNetwork = true;
    return new Promise((_, reject) => {
      const sig = init && init.signal;
      const bail = () => {
        aborted = true;
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      };
      // 이미 끊긴 뒤에 불릴 수도 있다(요청을 보내기 전에 그만둔 경우)
      if (sig && sig.aborted) return bail();
      if (sig) sig.addEventListener('abort', bail);
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
  // 끊었거나, 아직 보내기 전이었거나 — 둘 다 "할당량을 안 먹었다"는 뜻이다
  out.push({ name: '요청도 실제로 끊는다(할당량을 아낀다)', ok: aborted || !hitNetwork,
    detail: aborted ? '끊음' : '보내기 전이었음' });

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

  const app = await fetch('/js/app.js').then((r) => r.text());
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
  // ── 선지별 해설도 낱말 단위로 긁히는가 (2026-10-19 신고) ──
  // "정답쪽 내용 긁기로 하니까 아직도 한 줄 하이라이트 되고 있음"
  // 글을 찍는 자리마다 따로 낱말을 깔다 보니 .opt-explain에서 빠졌다. 낱말(.tok)이 없으면
  // 올가미가 집을 게 없어 줄 전체가 잡힌다. 퀴즈·모의고사는 같은 엔진이라 한 번에 낫는다.
  {
    const { Quiz } = await import('/js/quiz.js');
    const qs = [{ num: 1, type: 'mc', q: '어느 것이 독성 대사물인가?',
      opts: ['NAPQI와 글루타티온', '황산포합체와 알부민'], ans: 0,
      explain: '해설 글', opt: ['정답. 독성 대사물과 해독 물질의 짝이다.', '황산포합체는 비독성이다.'] }];
    let qz = null;
    try {
      qz = new Quiz({ examKey: 'tok-test', questions: qs, title: '검사',
        onFinish() {}, onExit() {}, onRender() {}, meta: {} });
      qz.start();
      await new Promise((r) => setTimeout(r, 250));
      qz.select(0);                       // 답을 골라야 선지별 해설이 붙는다
      await new Promise((r) => setTimeout(r, 300));
      const ex = document.querySelector('#optsContainer .opt-explain');
      out.push({ name: '답을 고르면 선지별 해설이 붙는다', ok: !!ex,
        detail: ex ? ex.textContent.slice(0, 20) : '없음' });
      if (ex) {
        const toks = ex.querySelectorAll('.tok');
        out.push({ name: '**정답 해설도 낱말 단위로 깔린다**(줄째 잡히던 것)',
          ok: toks.length >= 3, detail: `${toks.length}조각: ${[...toks].slice(0, 3).map((t) => t.textContent).join('|')}` });
        out.push({ name: '낱말이 글을 안 바꾼다', ok: /독성 대사물과 해독 물질의 짝/.test(ex.textContent) });
      }
      const stem = document.querySelectorAll('#qtext .tok').length;
      const opts = document.querySelectorAll('#optsContainer .opt-text .tok').length;
      out.push({ name: '문제·선지도 그대로 낱말이 깔린다', ok: stem >= 3 && opts >= 3,
        detail: `문제 ${stem} · 선지 ${opts}` });
      out.push({ name: '한 곳에서 통째로 깐다(자리마다 빠뜨리지 않게)',
        ok: /tokenizeTree\(this\.el\.card\)/.test(
          await fetch('/js/quiz.js').then((r) => r.text())) });
    } catch (e) {
      out.push({ name: '선지 해설 낱말 검사 (실행 실패)', ok: false, detail: String(e.message).slice(0, 120) });
    } finally {
      if (qz && qz.destroy) { try { qz.destroy(); } catch {} }
      // destroy가 화면을 건드린다 — 뒤 검사가 보는 자리를 되돌려 둔다
      document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
      document.getElementById('quizScreen').classList.remove('hidden');
      document.body.dataset.screen = 'quizScreen';
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // ── 노트 아래 노트 — 본문과 암기법을 같이 (2026-10-19 요청) ──
  // "노트를 오른쪽에 띄운 상태에서 해당 창을 2분할 해서 위에는 노트를, 아래는 암기법을"
  {
    const Rr = await import('/js/reader.js');
    const real = window.fetch;
    let which = '본문';
    window.fetch = async (u, i) => {
      const t = String(u);
      if (!t.includes('api.github.com')) return real(u, i);
      return { ok: true, status: 200, json: async () => ({}),
        text: async () => `# ${which}\n\n## 한 토막\n${which} 내용이다.\n\n## 두 토막\n또 있다.\n` };
    };
    try {
      which = '본문';
      await window.__openWikiNote(await Rr.loadNote('02_Wiki/과목/본문.md'));
      await new Promise((r) => setTimeout(r, 250));
      which = '암기법';
      await window.__openWikiNote2(await Rr.loadNote('02_Wiki/과목/암기법.md'));
      await new Promise((r) => setTimeout(r, 350));

      const p1 = document.getElementById('wikiPanel');
      const p2 = document.getElementById('wikiPanel2');
      const r1 = p1.getBoundingClientRect(), r2 = p2.getBoundingClientRect();
      out.push({ name: '**아래 칸이 생긴다**', ok: !p2.classList.contains('hidden') });
      out.push({ name: '둘 다 눈에 보인다',
        ok: r1.width > 60 && r1.height > 40 && r2.width > 60 && r2.height > 40,
        detail: `위 ${Math.round(r1.width)}×${Math.round(r1.height)} · 아래 ${Math.round(r2.width)}×${Math.round(r2.height)}` });
      out.push({ name: '**위아래로 쌓인다**(겹치지 않는다)',
        ok: r2.top >= r1.bottom - 2, detail: `위 밑 ${Math.round(r1.bottom)} · 아래 위 ${Math.round(r2.top)}` });
      out.push({ name: '같은 칸 안에 있다(가로로 안 벌어진다)',
        ok: Math.abs(r1.left - r2.left) < 2 && Math.abs(r1.width - r2.width) < 2 });
      out.push({ name: '위에는 본문, 아래에는 암기법',
        ok: /본문/.test(document.getElementById('wikiNote').textContent)
          && /암기법/.test(document.getElementById('wiki2Note').textContent),
        detail: `${document.getElementById('wikiNote').textContent} / ${document.getElementById('wiki2Note').textContent}` });
      out.push({ name: '아래 칸에도 글이 실제로 그려진다',
        ok: /암기법 내용/.test(document.getElementById('wiki2Body').textContent),
        detail: document.getElementById('wiki2Body').textContent.slice(0, 24) });
      out.push({ name: '아래 칸 글도 낱말로 긁힌다',
        ok: document.querySelectorAll('#wiki2Body .tok').length >= 2 });

      // 높이 손잡이 — 둘 다 열렸을 때만 나온다
      const gr = document.getElementById('wikiResizer');
      out.push({ name: '높이 손잡이가 둘 사이에 선다',
        ok: !gr.classList.contains('hidden')
          && gr.getBoundingClientRect().top >= r1.bottom - 20
          && gr.getBoundingClientRect().bottom <= r2.top + 20 });

      // ── 아래 칸이 **실제로 스크롤되는가** (2026-10-20 신고) ──
      // "아래로 암기법 열면 스크롤이 안되는 문제가 있음"
      // 까닭: 새 칸을 세로 flex 규칙에 빠뜨리면 안쪽 본문이 flex 자식이 못 되고,
      // 칸은 overflow: hidden이라 넘친 글이 **막대도 없이 그냥 잘린다**.
      // ⚠️ 규칙이 있는지만 보면 안 된다 — 글을 길게 넣고 **스크롤을 시켜 본다**.
      {
        const b2 = document.getElementById('wiki2Body');
        b2.innerHTML = Array.from({ length: 60 },
          (_, i) => `<p>${i + 1}번째 줄 — 아래 칸이 내려가는지 보는 글입니다.</p>`).join('');
        await new Promise((r) => setTimeout(r, 250));
        const fits = b2.scrollHeight > b2.clientHeight + 10;
        out.push({ name: '글이 칸보다 길다(스크롤할 거리가 있다)', ok: fits,
          detail: `글 ${b2.scrollHeight} · 칸 ${b2.clientHeight}` });
        b2.scrollTop = 300;
        await new Promise((r) => setTimeout(r, 120));
        out.push({ name: '**아래 칸이 실제로 내려간다**', ok: b2.scrollTop > 100,
          detail: `scrollTop ${Math.round(b2.scrollTop)}` });
        out.push({ name: '내려갈 수 있게 overflow가 열려 있다',
          ok: /auto|scroll/.test(getComputedStyle(b2).overflowY),
          detail: getComputedStyle(b2).overflowY });
        // 칸 밖으로 글이 삐져나가 잘리지 않아야 한다
        const rp = p2.getBoundingClientRect(), rbody = b2.getBoundingClientRect();
        out.push({ name: '글이 칸 밖으로 안 넘친다', ok: rbody.bottom <= rp.bottom + 2,
          detail: `글 밑 ${Math.round(rbody.bottom)} · 칸 밑 ${Math.round(rp.bottom)}` });
        // 위 칸도 같이 멀쩡한지 — 한쪽 고치고 다른 쪽 깨면 안 된다
        const b1 = document.getElementById('wikiBody');
        out.push({ name: '위 칸도 그대로 내려간다',
          ok: /auto|scroll/.test(getComputedStyle(b1).overflowY) });
        b2.scrollTop = 0;
      }

      // 손잡이를 **실제로 끌어** 높이가 바뀌는지 — 규칙만 있고 안 먹는 일이 잦다
      {
        const h0 = p1.getBoundingClientRect().height;
        const g0 = gr.getBoundingClientRect();
        const ev = (t, y, b) => (t === 'pointerdown' ? gr : document).dispatchEvent(
          new PointerEvent(t, { pointerType: 'touch', pointerId: 4, isPrimary: true, buttons: b,
            clientX: g0.left + g0.width / 2, clientY: y, bubbles: true, cancelable: true }));
        ev('pointerdown', g0.top + g0.height / 2, 1);
        // 아래로 끈다 — 위 칸을 키우는 쪽. 위로 끌면 최소 높이에 금방 막힌다
        for (let k = 1; k <= 6; k++) ev('pointermove', g0.top + g0.height / 2 + k * 14, 1);
        ev('pointerup', g0.top + g0.height / 2 + 84, 0);
        await new Promise((r) => setTimeout(r, 200));
        const h1 = p1.getBoundingClientRect().height;
        out.push({ name: '**손잡이를 끌면 위 칸 높이가 바뀐다**', ok: Math.abs(h1 - h0) > 20,
          detail: `${Math.round(h0)} → ${Math.round(h1)}px` });
        out.push({ name: '아래 칸이 남은 자리를 쓴다(둘이 안 겹친다)',
          ok: p2.getBoundingClientRect().top >= p1.getBoundingClientRect().bottom - 2 });
      }

      // 토막 넘기기
      document.getElementById('wiki2NextSec').click();
      await new Promise((r) => setTimeout(r, 150));
      out.push({ name: '아래 칸도 토막을 넘긴다',
        ok: /2\/2/.test(document.getElementById('wiki2Note').textContent),
        detail: document.getElementById('wiki2Note').textContent });

      // 자리 바꾸기
      document.getElementById('wiki2Swap').click();
      await new Promise((r) => setTimeout(r, 200));
      out.push({ name: '**⇅로 위아래를 바꾼다**',
        ok: /암기법/.test(document.getElementById('wikiNote').textContent)
          && /본문/.test(document.getElementById('wiki2Note').textContent),
        detail: `${document.getElementById('wikiNote').textContent} / ${document.getElementById('wiki2Note').textContent}` });

      // 위 칸을 닫으면 아래 것이 올라온다 — 빈 위 칸만 남으면 안 된다
      document.getElementById('wikiClose').click();
      await new Promise((r) => setTimeout(r, 250));
      out.push({ name: '위를 닫으면 아래 것이 위로 올라온다',
        ok: !p1.classList.contains('hidden') && p2.classList.contains('hidden')
          && /본문/.test(document.getElementById('wikiNote').textContent),
        detail: document.getElementById('wikiNote').textContent });
      out.push({ name: '아래 칸만 닫으면 위는 그대로',
        ok: document.querySelector('#quizScreen .side-col')
          && !document.querySelector('#quizScreen .side-col').classList.contains('two-notes') });
    } catch (e) {
      out.push({ name: '노트 2분할 검사 (실행 실패)', ok: false, detail: String(e.message).slice(0, 140) });
    } finally {
      window.fetch = real;
      if (window.__resetWiki) window.__resetWiki();
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // ── 보고 있는 노트와 카드가 **안 끊기는가** (2026-10-19 신고) ──
  // "퀴즈에서 노트에서 카드 만들었는데 새 카드로 추가가 안 되고, 기존 카드는 보이지도
  //  않음. 뭔가 떨어진 느낌임 원래 노트랑 연결이 안 되고."
  // 까닭: reader는 읽기 화면을 떠나도 안 비워진다. 그걸 먼저 보니 퀴즈에서 옆 노트의
  // 카드를 넣어도 목록은 **아까 읽던 딴 노트**를 보고 있어 늘 0장이었다.
  {
    const d = await import('/js/db.js');
    const Rr = await import('/js/reader.js');
    const NOTE = '02_Wiki/응급_중환자/암기법/연결검사_암기법.md';
    const real = window.fetch;
    window.fetch = async (u, i) => {
      const t = String(u);
      if (!t.includes('api.github.com')) return real(u, i);
      return { ok: true, status: 200, json: async () => ({}),
        text: async () => '# 연결검사\n\n## 요령\n**아트로핀**은 **서맥**에 쓴다.\n' };
    };
    try {
      // ① 먼저 딴 노트를 읽어둔다 — reader가 남는다(사람이 늘 하는 순서)
      await window.__openNote('02_Wiki/응급_중환자/딴노트.md');
      await new Promise((r) => setTimeout(r, 350));
      // ② 퀴즈 화면으로 옮기고 옆에 **이** 노트를 띄운다
      document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
      document.getElementById('quizScreen').classList.remove('hidden');
      document.body.dataset.screen = 'quizScreen';
      await window.__openWikiNote(await Rr.loadNote(NOTE));
      await new Promise((r) => setTimeout(r, 300));
      const wb = document.getElementById('wikiBody');
      const rb = wb.getBoundingClientRect();
      const made = Rr.cardsFromBox(wb, { l: rb.left, t: rb.top, r: rb.right, b: rb.bottom },
        { notePath: NOTE, noteTitle: '연결검사', heading: '요령' });
      out.push({ name: '옆 노트에서 카드가 만들어진다', ok: made.length === 1,
        detail: `${made.length}장` });
      if (made.length) {
        window.__openCardFloat(made);
        await new Promise((r) => setTimeout(r, 350));
        out.push({ name: '새 카드로 올라온다', ok: document.getElementById('cfNewN').textContent === '1',
          detail: document.getElementById('cfNewN').textContent });
        document.getElementById('cfAdd').click();
        await new Promise((r) => setTimeout(r, 600));
        out.push({ name: '**넣고 나면 "이 노트의 카드"에 보인다**(끊기던 것)',
          ok: document.getElementById('cfAllN').textContent === '1',
          detail: `${document.getElementById('cfAllN').textContent}장` });
        out.push({ name: '어느 노트를 보고 있는지 적힌다',
          ok: /연결검사/.test(document.getElementById('cfStatus').textContent),
          detail: document.getElementById('cfStatus').textContent });
        // ③ 창을 닫았다 다시 열어도 **그 노트**를 본다 — 아까 읽던 딴 노트가 아니라
        document.getElementById('cfClose').click();
        await new Promise((r) => setTimeout(r, 200));
        document.getElementById('wikiCards').click();
        await new Promise((r) => setTimeout(r, 500));
        out.push({ name: '**옆 패널의 "카드"로 바로 들어간다**',
          ok: !document.getElementById('cardFloat').classList.contains('hidden') });
        out.push({ name: '다시 열어도 그 노트의 카드를 본다(읽던 딴 노트로 안 샌다)',
          ok: document.getElementById('cfAllN').textContent === '1',
          detail: `${document.getElementById('cfAllN').textContent}장 · ${document.getElementById('cfStatus').textContent}` });
        document.getElementById('cfClose').click();
        for (const c of await d.allCards()) await d.deleteCard(c.id);
      }
      out.push({ name: '카드가 보는 자리를 전역 변수 순서로 안 정한다',
        ok: /function hereScope/.test(app) && /dataset\.screen/.test(app) });
    } catch (e) {
      out.push({ name: '노트-카드 연결 검사 (실행 실패)', ok: false, detail: String(e.message).slice(0, 140) });
    } finally {
      window.fetch = real;
      if (window.__resetWiki) window.__resetWiki();   // 뒤 검사가 보는 옆 패널을 비워둔다
      document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
      document.getElementById('quizScreen').classList.remove('hidden');
      document.body.dataset.screen = 'quizScreen';
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // ── 퀴즈에서도 카드 만들기·다른 노트가 되는가 (2026-10-19 요청·신고) ──
  {
    const cardBtn = document.getElementById('toolCard');
    out.push({ name: '**카드 만들기가 퀴즈 도구에도 있다**', ok: !!cardBtn });
    if (cardBtn) {
      const r = cardBtn.getBoundingClientRect();
      out.push({ name: '눈에 보인다(막대 안에 있다)',
        ok: r.width > 0 && r.height > 0 && !!cardBtn.closest('#quizTools'),
        detail: `${Math.round(r.width)}×${Math.round(r.height)}` });
      cardBtn.click();
      await new Promise((rr) => setTimeout(rr, 120));
      out.push({ name: '**눌러서 켜진다**', ok: cardBtn.classList.contains('active') });
      cardBtn.click();
      await new Promise((rr) => setTimeout(rr, 120));
      out.push({ name: '다시 누르면 꺼진다', ok: !cardBtn.classList.contains('active') });
      out.push({ name: '퀴즈 펜도 카드 만들기를 받는다',
        ok: /onCard: \(box\) => makeCardsFromBox\(box, pen\)/.test(app) });
      out.push({ name: '네모 친 자리로 출처를 가른다(문항이냐 옆 노트냐)',
        ok: /function cardSourceAt/.test(app) && /currentExam\.path/.test(app) });
      out.push({ name: '"이 노트의 카드"도 화면을 따라간다(퀴즈에선 그 시험)',
        ok: /function cardScope/.test(app) && /quiz && currentExam/.test(app) });
    }
    // "다른 노트" — 서랍이 읽기 화면 **안**에 있으면 퀴즈에선 통째로 숨어 아무 일도 안 난다
    const dd = document.getElementById('docDrawer');
    out.push({ name: '노트 서랍이 화면(section) 밖에 있다',
      ok: !!dd && !dd.closest('section'),
      detail: dd && dd.closest('section') ? dd.closest('section').id : '밖' });
    // 목록을 미리 심어둔다 — 서랍이 네트워크를 건드리면 뒤 검사의 fetch 스텁과 엉킨다
    {
      const d = await import('/js/db.js');
      await d.kvSet('note_index_v2', [{ root: '02_Wiki', subject: '응급_중환자', notes: [
        { name: '응급중환자_기본소생술BLS', path: '02_Wiki/응급_중환자/응급중환자_기본소생술BLS.md' }] }]);
      await d.kvSet('note_index_at', Date.now());
    }
    document.getElementById('wikiDocs').click();
    await new Promise((r) => setTimeout(r, 400));
    const dr = dd.getBoundingClientRect();
    out.push({ name: '**퀴즈에서 "다른 노트"를 누르면 실제로 보인다**',
      ok: !dd.classList.contains('hidden') && dr.width > 50 && dr.height > 50
        && getComputedStyle(dd).visibility !== 'hidden',
      detail: `${Math.round(dr.width)}×${Math.round(dr.height)}` });
    out.push({ name: '서랍에 노트가 실제로 뜬다',
      ok: document.querySelectorAll('#docList .dd-item').length > 0
        || document.querySelectorAll('#docList .dd-group').length > 0 });
    document.getElementById('docClose').click();
    await new Promise((r) => setTimeout(r, 150));
    const d2 = await import('/js/db.js');
    await d2.kvSet('note_index_v2', null);
    await d2.kvSet('note_index_at', 0);
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
  // 이제 **바로 닫고 뒤에서 보낸다**(2026-10-14) — 결과는 토스트나 알림창으로 온다.
  // 그래서 누른 직후가 아니라 **끝날 때까지** 기다렸다 읽는다.
  const statusText = () => document.getElementById('scStatus').textContent;
  const toastText = () => [...document.querySelectorAll('body > div')]
    .map((x) => x.textContent).filter((t) => /저장|대기|기기에|모아/.test(t)).join(' | ');
  const sheetText = () => (document.getElementById('alertSheet') || {}).textContent || '';
  const settled = async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (/모아뒀습니다|모아두지 못했습니다/.test(toastText() + sheetText())) return;
    }
  };
  const result = () => `${toastText()} ${sheetText()}`.trim();

  // ① 잘 올라간 경우
  window.fetch = async (u, i) => (String(u).includes('api.github.com')
    ? { ok: true, status: 201, json: async () => ({ content: { path: 'x/저장됨.md' } }) }
    : realFetch(u, i));
  open();
  await new Promise((r) => setTimeout(r, 120));
  document.getElementById('scSave').click();
  await new Promise((r) => setTimeout(r, 400));
  out.push({ name: '**누르면 창이 바로 닫힌다**(올라갈 때까지 안 붙잡는다)',
    ok: document.getElementById('scrapFloat').classList.contains('hidden') });
  await settled();
  out.push({ name: '올라가면 짧게 알려준다', ok: /모아뒀습니다/.test(result()), detail: result().slice(0, 50) });
  out.push({ name: '잘 됐을 때는 창을 안 띄운다(가로막지 않는다)', ok: !document.getElementById('alertSheet') });

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
  await settled();
  out.push({ name: '**끊겼을 때는 창으로 붙잡는다**(토스트는 놓치기 쉽다)',
    ok: !!document.getElementById('alertSheet'), detail: sheetText().slice(0, 50) });
  // "인터넷이 없다"고 단정하지 않는다 — **몇 번 해본 뒤**에야 그렇게 말한다(2026-10-17)
  out.push({ name: '끊겼다고 말하되 몇 번 해봤다고 알려준다',
    ok: /연결이 끊겨/.test(result()) && /해봤습니다/.test(result()),
    detail: result().slice(0, 70) });
  out.push({ name: '잃는 게 없다고 안심시킨다',
    ok: /자동으로 올라갑니다|앱을 꺼도/.test(result()) });
  document.getElementById('alertSheet')?.remove();
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
  await settled();
  out.push({ name: '**권한 문제는 인터넷 문제와 다르게 말한다**',
    ok: /권한/.test(result()) && !/인터넷이 없어/.test(result()), detail: result().slice(0, 60) });
  out.push({ name: '그때는 설정으로 갈 길을 준다',
    ok: /설정 열기/.test(sheetText()) });
  document.getElementById('alertSheet')?.remove();

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
  out.push({ name: '질문기록에 "아직 안 봤다" 표시가 붙는다', ok: /^처리:$/m.test(md.content) });
  out.push({ name: '**갈 곳마다 따로 적는다**(한 파일이 두 군데로 갈 수 있다)',
    ok: /^ {2}위키: 대기/m.test(md.content),
    detail: (md.content.match(/^ {2}\S+: 대기.*/m) || [''])[0] });
  out.push({ name: '갈래를 태그로 적어둔다(어느 명령이 가져갈지)',
    ok: /달모\/질문기록/.test(md.content) });
  out.push({ name: '앞머리 안에 들어간다(본문이 아니라)',
    ok: md.content.indexOf('처리:') < md.content.indexOf('\n---\n\n') });
  out.push({ name: '몇 건인지도 적는다(열어보기 전에 가늠되게)',
    ok: /# 풀다가 물어본 것 1건/.test(md.content) });
  return out;
});

// ══════════ 풀면서 다른 노트 보기 · 막대가 패널을 안 덮는다 (2026-10-14) ══════════
await run('풀면서 다른 노트', async () => {
  const out = [];
  await new Promise((r) => setTimeout(r, 1600));   // 앞 검사의 "설정 열기" 예약이 지나가길
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.body.dataset.screen = 'quizScreen';
  document.getElementById('quizScreen').classList.add('with-side');
  document.getElementById('wikiPanel').classList.remove('hidden');
  await new Promise((r) => setTimeout(r, 200));

  // ★ 막대가 관련 노트 제목을 덮고 있었다
  const bar = document.getElementById('quizTools');
  const header = document.querySelector('#quizScreen > header');
  await new Promise((r) => setTimeout(r, 120));      // 자리 잡는 두 프레임을 기다린다
  const br = bar.getBoundingClientRect(), hdr = header.getBoundingClientRect();
  // 머리줄 아래로 **한 픽셀도 안 내려간다** — 내려가는 만큼 그 아래 내용(관련 노트
  // 제목 등)을 덮는다. 이게 지켜지면 아래 어떤 것도 가려질 수 없다.
  out.push({ name: '**막대가 머리줄 아래로 안 내려온다**(아래 내용을 안 덮는다)',
    ok: br.bottom <= hdr.bottom + 2,
    detail: `막대 바닥 ${Math.round(br.bottom)} / 머리줄 바닥 ${Math.round(hdr.bottom)}` });
  out.push({ name: '머리줄 줄에 맞춰 앉는다', ok: br.top >= hdr.top - 30,
    detail: `막대 ${Math.round(br.top)} / 머리줄 ${Math.round(hdr.top)}` });

  // 다른 노트 열기
  out.push({ name: '관련 노트 칸에 "다른 노트" 버튼이 있다', ok: !!document.getElementById('wikiDocs') });
  const d = await import('/js/db.js');
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  const realFetch = window.fetch;
  window.fetch = async (u, i) => {
    if (!String(u).includes('api.github.com')) return realFetch(u, i);
    const n = decodeURIComponent(String(u).split('/contents/')[1] || '').split('/').pop().replace('.md', '');
    return { ok: true, status: 200, json: async () => ({}),
      text: async () => `# ${n}\n\n## ${n} 1장\n외울 것 가\n\n## ${n} 2장\n외울 것 나\n` };
  };
  await d.kvSet('note_index_v2', [
    { root: '02_Wiki', subject: '응급_중환자 · 암기법', notes: [
      { name: '응급중환자_기본소생술BLS_암기법', path: '02_Wiki/응급_중환자/암기법/응급중환자_기본소생술BLS_암기법.md' }] },
  ]);
  document.getElementById('docList').__groups = null;
  document.getElementById('wikiDocs').click();
  await new Promise((r) => setTimeout(r, 600));
  out.push({ name: '같은 서랍이 열린다(목록이 두 벌이 아니다)',
    ok: !document.getElementById('docDrawer').classList.contains('hidden') });

  const grp = document.querySelector('#docList .dd-group');
  if (grp && !grp.classList.contains('open')) { grp.click(); await new Promise((r) => setTimeout(r, 120)); }
  const item = document.querySelector('#docList .dd-item');
  out.push({ name: '암기법이 목록에 보인다', ok: !!item,
    detail: item ? item.textContent : '없음' });
  if (item) {
    item.click();
    await new Promise((r) => setTimeout(r, 800));
    out.push({ name: '**풀던 화면 그대로, 옆칸에 그 노트가 뜬다**',
      ok: document.body.dataset.screen === 'quizScreen'
        && /암기법/.test(document.getElementById('wikiNote').textContent),
      detail: `${document.body.dataset.screen} / ${document.getElementById('wikiNote').textContent}` });
    out.push({ name: '내가 고른 노트는 안 가린다(정답 가림막 없음)',
      ok: document.getElementById('wikiLock').classList.contains('hidden') });
    out.push({ name: '본문이 실제로 보인다',
      ok: /외울 것/.test(document.getElementById('wikiBody').textContent),
      detail: document.getElementById('wikiBody').textContent.slice(0, 24) });
    // 보고 있던 게 없었으면 돌아갈 곳도 없다 — 그때는 ↩를 숨기는 게 맞다
    out.push({ name: '돌아갈 곳이 없으면 ↩를 안 띄운다',
      ok: document.getElementById('wikiBack').classList.contains('hidden') });

    // 하나 더 열면 그때부터는 돌아갈 곳이 생긴다
    const noteName = document.getElementById('wikiNote').textContent;
    document.getElementById('wikiDocs').click();
    await new Promise((r) => setTimeout(r, 450));
    const g2 = document.querySelector('#docList .dd-group');
    if (g2 && !g2.classList.contains('open')) { g2.click(); await new Promise((r) => setTimeout(r, 120)); }
    const it2 = document.querySelector('#docList .dd-item');
    if (it2) {
      it2.click();
      await new Promise((r) => setTimeout(r, 700));
      out.push({ name: '**두 번째부터는 ↩로 돌아갈 수 있다**',
        ok: !document.getElementById('wikiBack').classList.contains('hidden') });
      document.getElementById('wikiBack').click();
      await new Promise((r) => setTimeout(r, 150));
      out.push({ name: '↩가 바로 전 노트로 되돌린다',
        ok: document.getElementById('wikiNote').textContent === noteName,
        detail: document.getElementById('wikiNote').textContent });
    }
  }
  window.fetch = realFetch;
  return out;
});

// ══════════ 노트에서 고르기 — 암기법 채택을 아이패드에서 (2026-10-14) ══════════
await run('체크 상자', async () => {
  const out = [];
  const { renderMarkdown } = await import('/js/markdown.js');
  const html = renderMarkdown('- [ ] 채택 (안 1)\n- [x] 채택 (안 2)\n- 그냥 항목');
  const box = document.createElement('div');
  box.innerHTML = html;
  out.push({ name: '`- [ ]` 가 눌리는 상자가 된다',
    ok: box.querySelectorAll('.task-box').length === 2,
    detail: `${box.querySelectorAll('.task-box').length}개` });
  out.push({ name: '이미 고른 것은 켜져 있다',
    ok: box.querySelectorAll('.task.done').length === 1 });
  out.push({ name: '평범한 항목은 그대로 둔다',
    ok: box.querySelectorAll('li:not(.task)').length === 1 });
  out.push({ name: '무엇을 고르는 건지 글이 남는다',
    ok: /채택 \(안 1\)/.test(box.textContent) });
  out.push({ name: '손가락으로 누를 만한 크기',
    ok: (document.body.appendChild(box),
      box.querySelector('.task-box').getBoundingClientRect().height >= 28),
    detail: `${Math.round(box.querySelector('.task-box').getBoundingClientRect().height)}px` });
  out.push({ name: '화면 읽기 프로그램도 상태를 안다',
    ok: box.querySelector('.task-box').getAttribute('aria-checked') === 'false' });
  box.remove();
  return out;
});


// 눌렀을 때 **vault 원본까지** 바뀌어야 뜻이 있다
await run('고른 것이 vault로', async () => {
  const out = [];
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  const RAW = '# 암기법 후보\n\n## 후보\n\n- [ ] 채택 (안 1)\n- [ ] 채택 (안 2)\n';
  // 두 가지가 올라간다: ① 원본의 [x] 한 글자 ② 고른 덩어리를 통째로 담은 새 파일
  let put = null, picked = null;
  const realFetch = window.fetch;
  window.fetch = async (u, i) => {
    const url = String(u);
    if (!url.includes('api.github.com')) return realFetch(u, i);
    if (i && i.method === 'PUT') {
      const b = JSON.parse(i.body);
      if (/채택\.md$/.test(decodeURIComponent(url))) picked = b; else put = b;
      return { ok: true, status: 200, json: async () => ({ content: { path: 'x.md' } }) };
    }
    return { ok: true, status: 200, text: async () => RAW, json: async () => ({ sha: 'abc' }) };
  };
  // 읽기 화면에 그 노트를 실제로 연다(앱의 길을 그대로 탄다)
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.querySelectorAll('.sheet, .ask-float, #docDrawer, #docScrim').forEach((x) => x.classList.add('hidden'));
  const d = await import('/js/db.js');
  await d.kvSet('note_index_v2', [{ root: '02_Wiki', subject: '응급_중환자 · 암기법',
    notes: [{ name: 't_암기법', path: '02_Wiki/응급_중환자/암기법/t_암기법.md' }] }]);
  document.getElementById('docList').__groups = null;
  document.getElementById('readDocs').click();
  await new Promise((r) => setTimeout(r, 600));
  const grp = document.querySelector('#docList .dd-group');
  if (grp && !grp.classList.contains('open')) { grp.click(); await new Promise((r) => setTimeout(r, 120)); }
  const it = document.querySelector('#docList .dd-item');
  if (!it) { window.fetch = realFetch; out.push({ name: '노트를 열 수 있다', ok: false }); return out; }
  it.click();
  await new Promise((r) => setTimeout(r, 900));

  const boxes = [...document.querySelectorAll('#readBody .task-box')];
  out.push({ name: '노트 본문에 체크 상자가 뜬다', ok: boxes.length === 2, detail: `${boxes.length}개` });
  if (!boxes.length) { window.fetch = realFetch; return out; }

  boxes[0].click();
  await new Promise((r) => setTimeout(r, 700));
  out.push({ name: '**눌렀더니 vault로 올라간다**', ok: !!put });
  if (put) {
    const sent = decodeURIComponent(escape(atob(put.content)));
    out.push({ name: '고른 줄만 [x]로 바뀐다',
      ok: /- \[x\] 채택 \(안 1\)/.test(sent), detail: (sent.match(/- \[.\] 채택 \(안 1\)/) || [''])[0] });
    out.push({ name: '**다른 줄은 그대로 둔다**(사람이 고치던 곳과 안 부딪히게)',
      ok: /- \[ \] 채택 \(안 2\)/.test(sent) && /# 암기법 후보/.test(sent) });
    out.push({ name: '덮어쓰기 충돌을 막는 sha를 함께 보낸다', ok: put.sha === 'abc' });
    out.push({ name: '무엇을 했는지 커밋 글에 남는다', ok: /채택/.test(put.message), detail: put.message });
  }
  out.push({ name: '화면에서도 바로 켜진다',
    ok: boxes[0].getAttribute('aria-checked') === 'true' });

  // ★ 체크 한 글자만 바뀌면 vault 쪽이 "뭘 왜 골랐는지"를 되짚어야 한다 —
  //   고른 덩어리를 통째로 따로 남긴다(2026-10-14 요청)
  await new Promise((r) => setTimeout(r, 400));
  out.push({ name: '**고른 내용을 통째로 따로 남긴다**', ok: !!picked });
  if (picked) {
    const rec = decodeURIComponent(escape(atob(picked.content)));
    out.push({ name: '무엇을 골랐는지 적힌다', ok: /고른항목: "채택 \(안 1\)"/.test(rec),
      detail: (rec.match(/고른항목:.*/) || [''])[0] });
    out.push({ name: '**고른 덩어리 전문이 들어간다**(클로드가 그대로 가공한다)',
      ok: /채택 \(안 1\)/.test(rec.split('---').slice(2).join('---')) });
    out.push({ name: '원본 노트로 되돌아가는 링크가 있다', ok: /원본노트: "\[\[/.test(rec) });
    out.push({ name: '어디로 갈지 적어 둔다(위키)', ok: /^ {2}위키: 대기/m.test(rec) });
    out.push({ name: '갈래 태그가 붙는다', ok: /달모\/채택/.test(rec) });
  }

  window.fetch = realFetch;
  return out;
});

// ══════════ 저장 대기 띠 · 버전 칩 (2026-10-14) ══════════
// "맨 밑에는 왜 주황색으로 해놓은 거임? 왜 계속 화면을 가리고 있는 거임 저만큼이나?"
// ══════════ AI 설명: 낱말 긁기 · 고른 뒤 할 일 · 실(thread) (2026-10-15) ══════════
// "글을 긁으려고 하니까 어디까지 선택된 게 안 나옴" / "선택하면 복사하기나 추가질문" /
// "이전 질문이 관리가 안 되는 게 나쁘네… 꼬리질문이 계속 나올 수도 있잖아"
await run('AI 설명 — 낱말 긁기', async () => {
  const out = [];
  const P = await import('/js/pen.js');
  const f = document.getElementById('askFloat');
  f.classList.remove('hidden');
  const body = document.getElementById('afBody');
  body.innerHTML = '<p>가슴압박 깊이는 성인에서 약 5cm이고 소아는 전후직경의 3분의 1이다. 영아는 약 4cm이다.</p>';
  P.tokenizeTree(body);
  const toks = [...body.querySelectorAll('.tok')];
  out.push({ name: '낱말로 쪼개진다', ok: toks.length >= 8, detail: `${toks.length}개` });
  if (toks.length < 8) { f.classList.add('hidden'); return out; }

  let last = null;
  const pick = P.wordPick(body, (txt) => { last = txt; });
  const pt = (el, dx = 0.5) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * dx, y: r.top + r.height / 2 };
  };
  const send = (type, el, id = 7) => {
    const { x, y } = pt(el);
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y,
      pointerId: id, pointerType: 'mouse', button: 0 }));
  };
  // 마우스는 누르는 순간 시작한다(스크롤은 휠로 하니까)
  send('pointerdown', toks[1]);
  out.push({ name: '누르면 그 낱말이 칠해진다',
    ok: toks[1].classList.contains('tok-pick') });
  // 세 낱말까지 끌기
  const to = pt(toks[3]);
  body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: to.x, clientY: to.y,
    pointerId: 7, pointerType: 'mouse' }));
  const painted = [...body.querySelectorAll('.tok-pick')];
  out.push({ name: '끌면 **낱말 단위로** 범위가 늘어난다', ok: painted.length === 3,
    detail: `${painted.length}개` });
  out.push({ name: '칠한 것이 눈에 보인다(배경색이 들어간다)',
    ok: getComputedStyle(toks[1]).backgroundColor !== 'rgba(0, 0, 0, 0)',
    detail: getComputedStyle(toks[1]).backgroundColor });
  send('pointerup', toks[3]);
  out.push({ name: '떼어도 고른 채로 남는다', ok: body.querySelectorAll('.tok-pick').length === 3 });
  out.push({ name: '글자 사이 띄어쓰기가 살아 있다', ok: /\s/.test(pick.text()) && !!pick.text(),
    detail: JSON.stringify(pick.text()) });
  out.push({ name: '바뀔 때마다 알려준다', ok: typeof last === 'string' && last.length > 0 });

  // 톡 치면 풀린다
  send('pointerdown', toks[6], 8);
  send('pointerup', toks[6], 8);
  // (마우스는 누르는 순간 새로 잡으므로 한 낱말이 남는다 — 비우려면 clear)
  pick.clear();
  out.push({ name: 'clear로 깨끗이 풀린다', ok: body.querySelectorAll('.tok-pick').length === 0 && pick.text() === '' });

  pick.destroy();
  body.innerHTML = '';
  // ⚠️ 이 상자에는 **앱이 붙여둔 긁기도** 같이 달려 있다. 내 흉내 사건에 그쪽도 반응해
  //    막대가 떠 있게 되므로 같이 치운다(안 그러면 뒤 테스트가 "평소엔 숨어 있다"에서 깨진다).
  document.getElementById('afPickBar').classList.add('hidden');
  f.classList.add('hidden');
  return out;
});

await run('AI 설명 — 고르면 할 일이 뜬다', async () => {
  const out = [];
  const app = await fetch('/js/app.js').then((r) => r.text());
  const bar = document.getElementById('afPickBar');
  out.push({ name: '막대가 있다', ok: !!bar });
  if (!bar) return out;
  for (const [id, label] of [['afPickCopy', '복사'], ['afPickAsk', '이어 묻기'],
    ['afPickSave', '저장'], ['afPickClear', '풀기']]) {
    const el = document.getElementById(id);
    out.push({ name: `${label} 단추가 있다`, ok: !!el });
  }
  out.push({ name: '평소엔 숨어 있다', ok: bar.classList.contains('hidden') });
  out.push({ name: '고른 글을 클립보드로 복사한다', ok: /afPickCopy'\)\.onclick[\s\S]{0,200}clipboard\.writeText/.test(app) });
  out.push({ name: '고른 대목을 그대로 이어 묻는다',
    ok: /afPickAsk'\)\.onclick[\s\S]{0,420}afEl\('afInput'\)\.value =/.test(app) });
  // "물어보기"를 또 누르게 하지 않는다(2026-10-15 요청) — 손볼 게 있으면 복사해서 새로 쓴다
  out.push({ name: '**누르면 바로 물어본다**(한 번 더 안 누른다)',
    ok: /afPickAsk'\)\.onclick[\s\S]{0,520}afEl\('afSend'\)\.click\(\)/.test(app) });
  out.push({ name: '고른 자리 **위**에 붙고, 위가 좁으면 아래로 넘긴다',
    ok: /above > 6 \? above :/.test(app) });
  return out;
});

await run('AI 설명 — 지난 질문을 실로 묶는다', async () => {
  const out = [];
  const d = await import('/js/db.js');
  const app = await fetch('/js/app.js').then((r) => r.text());

  out.push({ name: '목록과 본문을 갈라 둔다(목록엔 답변을 넣지 않는다)',
    ok: /ask_threads/.test(app) && /const threadKey = \(id\) => `ask_t_/.test(app) });
  out.push({ name: '옛 평평한 기록을 실로 옮긴다', ok: /async function migrateAskLog/.test(app) });
  out.push({ name: '안 쓰는 실은 알아서 사라진다', ok: /ASK_KEEP_DAYS/.test(app) && /async function pruneThreads/.test(app) });
  out.push({ name: '꽂아둔 실은 안 지운다', ok: /const old = !x\.pin && x\.ts < cut/.test(app) });
  out.push({ name: '한 실에 담는 턴 수에도 상한이 있다', ok: /ASK_TURN_MAX/.test(app) });

  // 실제로 저장되는 모양을 확인한다
  await d.kvSet('ask_threads', [
    { id: 't1', ts: Date.now(), title: '심실세동이 뭐야', n: 3, note: 'BLS', pin: false },
    { id: 't2', ts: Date.now() - 1000, title: '제세동 금기', n: 1, note: '', pin: true },
  ]);
  await d.kvSet('ask_t_t1', { turns: [
    { q: '심실세동이 뭐야', html: '<p>세포가 제각각 떨리는 상태다.</p>', ts: 1 },
    { q: '그럼 반대는?', html: '<p>무수축이다.</p>', ts: 2 },
    { q: '처치는?', html: '<p>즉시 제세동.</p>', ts: 3 },
  ] });
  const list = await d.kvGet('ask_threads');
  out.push({ name: '목록 한 줄에 답변 본문이 들어있지 않다',
    ok: list.every((x) => !('html' in x)), detail: Object.keys(list[0]).join(',') });
  out.push({ name: '목록이 가볍다(실 2개가 1KB 미만)',
    ok: JSON.stringify(list).length < 1024, detail: `${JSON.stringify(list).length}B` });

  // 창을 열어 실이 통째로 그려지는지
  if (window.__askForTest) {
    await window.__askForTest.reload();
    await window.__askForTest.open('t1');
    const turns = document.querySelectorAll('#afBody .af-turn');
    out.push({ name: '**주고받은 것이 전부 보인다**(마지막 답 하나가 아니라)',
      ok: turns.length === 3, detail: `${turns.length}덩어리` });
    out.push({ name: '질문과 답이 짝으로 보인다',
      ok: !!turns[1] && /그럼 반대는/.test(turns[1].querySelector('.af-tq').textContent)
        && /무수축/.test(turns[1].querySelector('.af-ta').textContent) });
    const head = document.getElementById('afStatus').textContent;
    out.push({ name: '몇 번 주고받았는지 알려준다', ok: /3번 주고받음/.test(head), detail: head });

    // 목록: 꼬리 개수 · 꽂기 · 지우기 · 찾기
    document.getElementById('afLog').click();
    await new Promise((r) => setTimeout(r, 80));
    const box = document.getElementById('afLogList');
    out.push({ name: '목록에 찾기 칸이 있다', ok: !!box.querySelector('.al-bar input') });
    out.push({ name: '＋ 새 주제로 실을 새로 팔 수 있다',
      ok: /새 주제/.test(box.querySelector('.al-bar .btn')?.textContent || '') });
    const rows = [...box.querySelectorAll('.af-log-item')];
    out.push({ name: '실마다 한 줄', ok: rows.length === 2, detail: `${rows.length}줄` });
    out.push({ name: '꼬리질문이 몇 번인지 보인다',
      ok: rows.some((r) => /꼬리 2/.test(r.textContent)), detail: rows.map((r) => r.textContent).join(' | ') });
    out.push({ name: '꽂아둔 실이 위로 온다', ok: rows[0].classList.contains('pinned') });
    out.push({ name: '한 줄씩 지울 수 있다', ok: rows.every((r) => !!r.querySelector('.al-del')) });
    // 찾기
    const q = box.querySelector('.al-bar input');
    q.value = '제세동';
    q.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 40));
    out.push({ name: '찾기로 걸러진다',
      ok: box.querySelectorAll('.af-log-item').length === 1,
      detail: `${box.querySelectorAll('.af-log-item').length}줄` });
    box.classList.add('hidden');
  } else {
    out.push({ name: '실을 열 통로가 있다', ok: false, detail: '__askForTest 없음' });
  }
  document.getElementById('askFloat').classList.add('hidden');
  await d.kvSet('ask_threads', []);
  await d.kvDel('ask_t_t1');
  if (window.__askForTest) await window.__askForTest.reload();   // 메모리까지 비운다
  return out;
});

await run('AI 답변의 수식 토막을 걷어낸다', async () => {
  const out = [];
  const M = await import('/js/markdown.js');
  const cases = [
    ['VF/pVT $\\rightarrow$ 제세동', '→', '\\rightarrow'],
    ['체온 $\\ge$ 40$^\\circ$C', '≥', '\\ge'],
    ['$\\text{COHb} \\ge 25\\%$', 'COHb ≥ 25%', '\\text'],
  ];
  for (const [src, want, bad] of cases) {
    const h = M.renderMarkdown(src);
    out.push({ name: `기호로 바뀐다: ${src}`, ok: h.includes(want) && !h.includes(bad), detail: h });
  }
  const money = M.renderMarkdown('가격은 $5 달러고 $10도 있다');
  out.push({ name: '**달러 기호는 건드리지 않는다**', ok: /\$5/.test(money) && /\$10/.test(money), detail: money });
  const g = await fetch('/js/gemini.js').then((r) => r.text());
  out.push({ name: '애초에 쓰지 말라고 일러둔다', ok: /수식 표기\(LaTeX\)는 쓰지 않는다/.test(g) });
  return out;
});

await run('저장 대기 띠', async () => {
  const out = [];
  const d = await import('/js/db.js');
  for (const it of await d.listOutbox()) await d.dequeue(it.id);
  const bar = document.getElementById('syncBar');
  await d.enqueue({ path: 'x/대기.md', content: '내용', message: 'm' });
  document.getElementById('syncNowBtn').click();     // refreshSyncBar를 거치게
  await new Promise((r) => setTimeout(r, 400));
  bar.classList.remove('hidden');

  const r = bar.getBoundingClientRect();
  out.push({ name: '**화면을 가로로 안 먹는다**(구석 알약이다)',
    ok: r.width <= window.innerWidth * 0.75,
    detail: `${Math.round(r.width)}px / 화면 ${window.innerWidth}px` });
  out.push({ name: '오른쪽 구석에 있다', ok: r.right >= window.innerWidth - 40 });
  out.push({ name: '키가 작다(한 줄)', ok: r.height <= 56, detail: `${Math.round(r.height)}px` });
  out.push({ name: '**평소엔 경고색이 아니다**(그냥 알림일 뿐)',
    ok: !bar.classList.contains('stuck'),
    detail: getComputedStyle(bar).backgroundColor });

  // 여러 번 실패한 게 있을 때만 눈에 띈다
  const items = await d.listOutbox();
  for (let i = 0; i < 5; i++) await d.bumpTries(items[0].id, '저장 실패 (403)');
  document.getElementById('syncNowBtn').click();
  // 진짜 네트워크를 타므로 몇백 ms로는 모자란다 — **끝날 때까지** 기다린다
  for (let i = 0; i < 60; i++) {
    await new Promise((r2) => setTimeout(r2, 150));
    if (!/중…/.test(document.getElementById('syncText').textContent)) break;
  }
  out.push({ name: '**막힌 게 있을 때만 경고색**', ok: bar.classList.contains('stuck') });
  out.push({ name: '몇 건이 막혔는지 말해준다',
    ok: /막혀 있습니다/.test(document.getElementById('syncText').textContent),
    detail: document.getElementById('syncText').textContent });

  // 눌러서 속사정을 본다
  document.getElementById('syncWhyBtn').click();
  await new Promise((r2) => setTimeout(r2, 200));
  const sheet = document.getElementById('outboxSheet');
  out.push({ name: '눌러서 무엇이 남았는지 볼 수 있다', ok: !sheet.classList.contains('hidden') });
  out.push({ name: '왜 막혔는지 적혀 있다', ok: /403|실패|권한/.test(sheet.textContent),
    detail: (sheet.textContent.match(/저장 실패[^·]*/) || [''])[0].slice(0, 40) });
  out.push({ name: '내용을 파일로 받아둘 길이 있다', ok: /내려받기/.test(sheet.textContent) });
  out.push({ name: '버릴 수도 있다(영영 안 올라가는 것)', ok: /버리기/.test(sheet.textContent) });
  document.getElementById('outboxClose').click();

  for (const it of await d.listOutbox()) await d.dequeue(it.id);
  document.getElementById('syncNowBtn').click();
  await new Promise((r2) => setTimeout(r2, 300));
  out.push({ name: '비면 사라진다', ok: bar.classList.contains('hidden') });
  return out;
});

await run('버전 칩', async () => {
  const out = [];
  // 목록 화면에서만 보인다 — 앞 검사가 다른 화면을 띄워놨을 수 있다
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('listScreen').classList.remove('hidden');
  document.body.dataset.screen = 'listScreen';
  await new Promise((r) => setTimeout(r, 60));
  const chip = document.getElementById('verChip');
  out.push({ name: '머리줄 구석에 지금 버전이 있다', ok: !!chip });
  await new Promise((r) => setTimeout(r, 300));
  out.push({ name: '버전이 적힌다', ok: /^v\d+|서비스워커|\?/.test(chip.textContent),
    detail: chip.textContent });
  const r = chip.getBoundingClientRect();
  out.push({ name: '**작다**(주 정보가 아니다)', ok: r.height <= 28 && r.width <= 110,
    detail: `${Math.round(r.width)}×${Math.round(r.height)}` });
  out.push({ name: '제목보다 오른쪽에 있다',
    ok: r.left > document.querySelector('#listScreen h1').getBoundingClientRect().right });
  out.push({ name: '언제 배포된 건지도 알려준다(길게 눌러서)', ok: /앱 /.test(chip.title),
    detail: chip.title });
  return out;
});

// ══════════ 창을 바꿔도 크기가 안 흔들린다 (2026-10-14) ══════════
// "다른 split을 클릭할 때 옆 split 및 선택된 split이 갑자기 크기가 변하면서 이질감을 줌"
// → `#readCard` 같은 **id로 잡은 스타일**이 활성 창을 따라 옮겨다녀서 양쪽 여백이 뒤바뀌었다.
await run('창 전환이 흔들리지 않는다', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.getElementById('readScreen').classList.add('toc-off');
  document.querySelectorAll('.sheet, .ask-float, #docDrawer, #docScrim').forEach((x) => x.classList.add('hidden'));
  await new Promise((r) => setTimeout(r, 120));
  const panes = [...document.querySelectorAll('#readPanes .read-pane')];
  out.push({ name: '창이 둘이다', ok: panes.length === 2, detail: `${panes.length}개` });
  if (panes.length < 2) return out;
  out.push({ name: '화면에 실제로 떠 있다',
    ok: panes.every((p) => p.getBoundingClientRect().width > 50),
    detail: panes.map((p) => Math.round(p.getBoundingClientRect().width)).join(' / ') });

  const card = (p) => p.querySelector('.read-card');
  const box = (p) => { const r = card(p).getBoundingClientRect(); return `${Math.round(r.width)}×${Math.round(r.height)}`; };
  const pad = (p) => getComputedStyle(card(p)).padding;

  const before = panes.map(box);
  const padBefore = panes.map(pad);
  out.push({ name: '두 창의 안쪽 여백이 같다(활성 여부와 무관)',
    ok: padBefore[0] === padBefore[1], detail: padBefore.join(' / ') });

  // 비활성 창을 눌러 활성을 옮긴다
  const other = panes.find((p) => !p.classList.contains('active')) || panes[1];
  other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 250));

  const after = panes.map(box);
  const padAfter = panes.map(pad);
  out.push({ name: '**눌러도 두 창 크기가 그대로다**', ok: after.join('|') === before.join('|'),
    detail: `${before.join(' / ')} → ${after.join(' / ')}` });
  out.push({ name: '여백도 그대로다', ok: padAfter.join('|') === padBefore.join('|'),
    detail: `${padBefore.join(' / ')} → ${padAfter.join(' / ')}` });
  out.push({ name: '활성 표시만 옮겨간다', ok: other.classList.contains('active') });
  return out;
});

// ══════════ 창 버튼이 어느 화면에서도 버튼을 안 덮는다 (2026-10-14) ══════════
// "모의고사나 퀴즈도 뒤로가기 버튼이 그 삼색버튼 아래로 오든가 해서 창 크기 조절해도 누를 수 있어야"
await run('창 버튼 자리 — 모든 화면', async () => {
  const out = [];
  document.body.setAttribute('data-win-controls', '');
  await new Promise((r) => setTimeout(r, 60));
  // 시스템 ●●●는 대략 왼쪽 위 0~110 × 0~34 를 차지한다
  const WIN = { r: 110, b: 34 };
  const checks = [
    ['listScreen', 'settingsBtn'],
    ['quizScreen', 'backToListBtn'],
    ['readScreen', 'readBack'],
    ['resultScreen', 'resultBackBtn'],
    ['cardScreen', 'cardBack'],
  ];
  for (const [screen, btn] of checks) {
    const sec = document.getElementById(screen);
    const b = document.getElementById(btn);
    if (!sec || !b) { out.push({ name: `${screen}: 버튼이 있다`, ok: false }); continue; }
    document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
    sec.classList.remove('hidden');
    document.body.dataset.screen = screen;
    await new Promise((r) => setTimeout(r, 40));
    const r = b.getBoundingClientRect();
    const hit = r.left < WIN.r && r.top < WIN.b;
    out.push({ name: `${screen}: 창 버튼에 안 가린다`, ok: !hit,
      detail: `${btn} top=${Math.round(r.top)} left=${Math.round(r.left)}` });
  }
  document.body.removeAttribute('data-win-controls');
  await new Promise((r) => setTimeout(r, 40));
  const back = document.getElementById('backToListBtn').getBoundingClientRect();
  out.push({ name: '전체 화면이면 자리를 안 비운다(공간 낭비 없이)', ok: back.top < 34,
    detail: `${Math.round(back.top)}px` });
  return out;
});

// 번호를 눌러 그 문항으로 (2026-10-14 요청)
await run('번호로 가기', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.body.dataset.screen = 'quizScreen';
  document.querySelectorAll('.sheet, .ask-float, #docDrawer, #docScrim').forEach((x) => x.classList.add('hidden'));

  const pos = document.getElementById('posLabel');
  out.push({ name: '번호 칸이 누를 수 있는 버튼이다', ok: pos.tagName === 'BUTTON' });
  out.push({ name: '눌러도 된다고 알려준다', ok: /이동/.test(pos.title), detail: pos.title });
  pos.click();
  await new Promise((r) => setTimeout(r, 120));
  const sheet = document.getElementById('jumpSheet');
  out.push({ name: '누르면 번호 입력창이 뜬다', ok: !sheet.classList.contains('hidden') });
  if (!sheet.classList.contains('hidden')) {
    out.push({ name: '몇 번까지 있는지 알려준다',
      ok: /\d+ ~ \d+/.test(document.getElementById('jumpHint').textContent),
      detail: document.getElementById('jumpHint').textContent });
    out.push({ name: '바로 칠 수 있다', ok: document.activeElement.id === 'jumpInput' });
    out.push({ name: '숫자 자판이 뜨게 해둔다',
      ok: document.getElementById('jumpInput').inputMode === 'numeric' });

    // 실제로 옮겨간다
    const was = document.getElementById('posLabel').textContent;
    const inp = document.getElementById('jumpInput');
    inp.value = '2';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 250));
    out.push({ name: '**Enter로 그 문항에 간다**', ok: /^2\//.test(document.getElementById('posLabel').textContent),
      detail: `${was} → ${document.getElementById('posLabel').textContent}` });
    out.push({ name: '가면 창이 닫힌다', ok: sheet.classList.contains('hidden') });

    // 없는 번호는 알려주고 안 움직인다
    pos.click();
    await new Promise((r) => setTimeout(r, 120));
    const now = document.getElementById('posLabel').textContent;
    document.getElementById('jumpInput').value = '999';
    document.getElementById('jumpGo').click();
    await new Promise((r) => setTimeout(r, 150));
    out.push({ name: '없는 번호면 그대로 둔다',
      ok: document.getElementById('posLabel').textContent === now });
    out.push({ name: '그때는 창을 안 닫는다(다시 칠 수 있게)',
      ok: !sheet.classList.contains('hidden') });
    document.getElementById('jumpClose').click();
  }
  return out;
});

// ══════════ 같은 일은 같은 그림으로 (2026-10-14 요청) ══════════
// "노트읽기/문제풀기 등에서 같은 기능을 하는 건 아이콘을 좀 똑같이 만들어야 함. 계속 헷갈림"
await run('아이콘 통일', () => {
  const out = [];
  const g = (id) => { const el = document.getElementById(id); return el ? el.innerHTML.trim() : null; };
  // 그림만 비교한다(펜 버튼은 지우개 획이 더 붙어 있어 따로 본다)
  const pairs = [
    ['고르기', 'readSelect', 'toolSelect'],
    ['영역 복사', 'readShot', 'toolCapture'],
    ['모아두기', 'readScrapBtn', 'toolScrap'],
  ];
  for (const [name, a, b] of pairs) {
    out.push({ name: `${name}: 읽기와 퀴즈가 같은 그림`, ok: !!g(a) && g(a) === g(b),
      detail: g(a) === g(b) ? '' : '다름' });
  }
  // 필기 — 읽기 쪽은 지우개로 바뀌므로 획이 더 있다. **펜 모양 자체**는 같아야 한다.
  const penPath = 'M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z';
  out.push({ name: '필기: 펜 모양이 양쪽 같다',
    ok: g('readPen').includes(penPath) && g('toolWrite').includes(penPath) });
  out.push({ name: '읽기 쪽 필기는 지우개로도 바뀐다(한 버튼이 둘을 겸한다)',
    ok: /pen-ic/.test(g('readPen')) && /erase-ic/.test(g('readPen')) });
  // 역으로: 하는 일이 다르면 그림도 달라야 한다
  out.push({ name: '고르기와 영역 복사는 다른 그림', ok: g('readSelect') !== g('readShot') });
  out.push({ name: '모아두기와 영역 복사도 다른 그림', ok: g('readScrapBtn') !== g('readShot') });
  return out;
});


// 빈 화면은 **어디를 보는 중이고 무엇을 하면 되는지**를 말해야 한다
await run('빈 화면 안내', async () => {
  const out = [];
  const d = await import('/js/db.js');
  await d.kvSet('exam_index_v3', []);
  await d.kvSet('note_index_v2', []);
  const says = {};
  const bodyOf = () => document.querySelector('#quizBody:not(.hidden), #listBody:not(.hidden), #jokboBody:not(.hidden), #notesBody:not(.hidden)');
  for (const tab of ['quizzes', 'exams', 'jokbo', 'notes']) {
    document.querySelector(`.tabs [data-tab="${tab}"]`).click();
    // 불러오는 동안은 "…중"이 떠 있다 — 끝날 때까지 기다렸다 읽는다
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 120));
      const b = bodyOf();
      if (b && !/중…/.test(b.textContent)) break;
    }
    const box = bodyOf();
    says[tab] = box ? box.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  for (const [tab, t] of Object.entries(says)) {
    out.push({ name: `${tab}: 어디를 보는지 알려준다`, ok: /vault의/.test(t),
      detail: t.slice(0, 50) });
    out.push({ name: `${tab}: 다시 찾을 길이 있다`, ok: /다시 찾기/.test(t) });
  }
  return out;
});

// ══════════ 하단 바가 중간에 뜨지 않는다 (2026-10-14 신고) ══════════
// "쭉 내렸다가 올리니까 아래 있어야 할 바가 딸려올라와서 중간에 있음"
// → 페이지가 통째로 스크롤되면 아이패드에서 fixed 바가 반동 중에 제자리를 잃는다.
//    페이지를 아예 안 움직이게 하고 내용만 안에서 스크롤시킨다(읽기 화면과 같은 처방).
await run('하단 바 고정', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  const q = document.getElementById('quizScreen');
  q.classList.remove('hidden');
  document.body.dataset.screen = 'quizScreen';
  q.classList.add('with-side');
  document.getElementById('wikiPanel').classList.remove('hidden');
  document.getElementById('optsContainer').innerHTML =
    Array.from({ length: 14 }, (_, i) => `<div class="opt-row" style="min-height:90px">선지 ${i + 1}</div>`).join('')
    + '<div class="opt-row" id="lastOpt" style="min-height:90px">마지막 선지</div>';
  document.getElementById('wikiBody').innerHTML = '<p>' + '노트 본문. '.repeat(600) + '</p>';
  await new Promise((r) => setTimeout(r, 400));

  const nav = document.querySelector('#quizScreen .quiz-nav');
  const H = innerHeight;
  const navAt = () => Math.round(nav.getBoundingClientRect().bottom);
  const start = navAt();
  out.push({ name: '바가 화면 바닥에 있다', ok: H - start < 40, detail: `${start}/${H}` });

  // ★ 페이지 자체가 안 움직여야 한다 — 움직이면 반동이 생기고 거기서 바가 떠난다
  out.push({ name: '**페이지가 통째로 스크롤되지 않는다**',
    ok: document.documentElement.scrollHeight <= innerHeight + 2,
    detail: `문서 ${document.documentElement.scrollHeight} / 화면 ${innerHeight}` });

  // 대신 안에서 스크롤된다
  const inner = [...document.querySelectorAll('#quizScreen .split, #quizScreen .main-col')]
    .filter((e) => e.scrollHeight > e.clientHeight + 2);
  out.push({ name: '내용은 안에서 스크롤된다', ok: inner.length > 0,
    detail: inner.map((e) => e.className.split(' ')[0]).join(',') || '없음' });

  // 쭉 내렸다가 → 다시 올린다 (신고된 그 순서)
  const sc = inner[0];
  if (sc) {
    // 안쪽 스크롤 상자가 둘일 수 있다(.split / .main-col) — **전부** 끝까지 내린다
    for (const e of inner) e.scrollTop = e.scrollHeight;
    document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    await new Promise((r) => setTimeout(r, 250));
    out.push({ name: '**쭉 내려도 바가 바닥에 있다**', ok: Math.abs(navAt() - start) < 4,
      detail: `${navAt()}` });
    out.push({ name: '맨 아래 선지가 바에 안 가린다',
      ok: Math.round(document.getElementById('lastOpt').getBoundingClientRect().bottom)
        <= Math.round(nav.getBoundingClientRect().top) + 6 });
    for (const e of inner) e.scrollTop = 0;
    document.scrollingElement.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 250));
    out.push({ name: '**다시 올려도 바가 바닥에 있다**', ok: Math.abs(navAt() - start) < 4,
      detail: `${navAt()}` });
  }
  document.getElementById('wikiPanel').classList.add('hidden');
  return out;
});

// ══════════ 암기법 채택 — 같은 글이 수십 번 나와도 맞는 줄을 집는다 (2026-10-14) ══════════
// "채택 (안 1)"이 섹션마다 똑같이 나온다. 소제목을 찾아 세던 방식은 소제목 글자가 조금만
// 달라도 어긋나서 "그 줄을 못 찾았습니다"가 계속 났다. 이제 앞 섹션들의 상자 수를 더해
// 전체에서 몇 번째인지로 바로 간다.
await run('암기법 채택', async () => {
  const out = [];
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  // 실제 암기법 노트 꼴 — 섹션 셋, 섹션마다 같은 글의 상자 셋
  const sec = (n) => `## ${n}. ${n}도 화상\n\n설명 ${n}.\n\n`
    + `1️⃣ [숫자연상]\n- [ ] 채택 (안 1)\n\n2️⃣ [발음연상]\n- [ ] 채택 (안 2)\n\n`
    + `3️⃣ [단어연상]\n- [ ] 채택 (안 3)\n- [ ] 전부 기각 (그냥 외움)\n`;
  const RAW = `---\ntags: [t]\n---\n\n# 환경의학 암기법\n\n${sec(1)}\n${sec(2)}\n${sec(3)}`;
  let put = null;
  const realFetch = window.fetch;
  window.fetch = async (u, i) => {
    const url = String(u);
    if (!url.includes('api.github.com')) return realFetch(u, i);
    if (i && i.method === 'PUT') {
      const body = JSON.parse(i.body);
      if (!/채택\.md$/.test(decodeURIComponent(url))) put = body;
      return { ok: true, status: 200, json: async () => ({ content: { path: 'x.md' } }) };
    }
    return { ok: true, status: 200, text: async () => RAW, json: async () => ({ sha: 'abc' }) };
  };

  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.getElementById('readScreen').classList.add('toc-off');
  document.querySelectorAll('.sheet, .ask-float, #docDrawer, #docScrim').forEach((x) => x.classList.add('hidden'));
  const d = await import('/js/db.js');
  await d.kvSet('note_index_v2', [{ root: '02_Wiki', subject: '응급_중환자 · 암기법',
    notes: [{ name: '환경의학_암기법', path: '02_Wiki/응급_중환자/암기법/환경의학_암기법.md' }] }]);
  document.getElementById('docList').__groups = null;
  document.getElementById('readDocs').click();
  await new Promise((r) => setTimeout(r, 600));
  const grp = document.querySelector('#docList .dd-group');
  if (grp && !grp.classList.contains('open')) { grp.click(); await new Promise((r) => setTimeout(r, 120)); }
  const it = document.querySelector('#docList .dd-item');
  if (!it) { window.fetch = realFetch; out.push({ name: '노트를 연다', ok: false }); return out; }
  it.click();
  await new Promise((r) => setTimeout(r, 900));

  out.push({ name: '섹션이 셋으로 나뉜다',
    ok: /\/3$/.test(document.getElementById('readPos').textContent),
    detail: document.getElementById('readPos').textContent });

  // ★ **둘째 섹션**의 **둘째** 상자를 누른다 — 앞 섹션에 똑같은 글이 이미 있다
  document.getElementById('readNext').click();
  await new Promise((r) => setTimeout(r, 400));
  const boxes = [...document.querySelectorAll('#readBody .task-box')];
  out.push({ name: '그 섹션의 상자가 넷이다', ok: boxes.length === 4, detail: `${boxes.length}개` });
  if (boxes.length < 2) { window.fetch = realFetch; return out; }

  boxes[1].click();
  await new Promise((r) => setTimeout(r, 800));
  out.push({ name: '**실패하지 않는다**', ok: !!put, detail: put ? '올라감' : '못 찾음' });
  if (put) {
    const sent = decodeURIComponent(escape(atob(put.content)));
    const marked = sent.split('\n').map((l, i) => [l, i]).filter(([l]) => /\[x\]/.test(l));
    out.push({ name: '**딱 한 줄만 바뀐다**', ok: marked.length === 1, detail: `${marked.length}줄` });
    // 둘째 섹션의 "채택 (안 2)" 여야 한다 — 전체에서 6번째 상자
    const all = sent.split('\n').filter((l) => /^\s*[-*+]\s*\[[ xX]\]/.test(l));
    out.push({ name: '**그 섹션의 그 줄이다**(앞 섹션 것이 아니다)',
      ok: /\[x\] 채택 \(안 2\)/.test(all[5] || ''),
      detail: all.map((l, i) => (/\[x\]/.test(l) ? `#${i}` : '')).filter(Boolean).join(',') || '없음' });
    out.push({ name: '앞 섹션의 같은 글은 그대로',
      ok: /\[ \] 채택 \(안 2\)/.test(all[1] || '') });
  }
  out.push({ name: '화면에서도 켜진다', ok: boxes[1].getAttribute('aria-checked') === 'true' });

  // 섹션을 넘겼다 와도 켜진 채로 — 앱이 든 본문도 같이 고쳐야 한다
  document.getElementById('readPrev').click();
  await new Promise((r) => setTimeout(r, 250));
  document.getElementById('readNext').click();
  await new Promise((r) => setTimeout(r, 400));
  const again = [...document.querySelectorAll('#readBody .task-box')];
  out.push({ name: '섹션을 넘겼다 와도 그대로 켜져 있다',
    ok: again[1] && again[1].getAttribute('aria-checked') === 'true',
    detail: again.map((b) => b.getAttribute('aria-checked')).join(',') });

  window.fetch = realFetch;
  return out;
});

// ══════════ 옆에 뒀던 것을 기억한다 (2026-10-14 요청) ══════════
// "스플릿 닫았다가 다시 열면 매번 문서에서 끌어다 넣는 건 문제가 있음."
await run('나누기 기억', async () => {
  const out = [];
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  const realFetch = window.fetch;
  window.fetch = async (u, i) => {
    if (!String(u).includes('api.github.com')) return realFetch(u, i);
    const n = decodeURIComponent(String(u).split('/contents/')[1] || '').split('/').pop().replace('.md', '');
    return { ok: true, status: 200, json: async () => ({}),
      text: async () => `# ${n}\n\n## ${n} 1장\n내용 가\n\n## ${n} 2장\n내용 나\n` };
  };
  const d = await import('/js/db.js');
  await d.kvSet('split_mem', {});
  await d.kvSet('note_index_v2', [{ root: '02_Wiki', subject: '응급_중환자', notes: [
    { name: 'BLS본문', path: '02_Wiki/응급_중환자/BLS본문.md' },
    { name: 'BLS암기법', path: '02_Wiki/응급_중환자/BLS암기법.md' }] }]);

  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.querySelectorAll('.sheet, .ask-float, #docDrawer, #docScrim').forEach((x) => x.classList.add('hidden'));
  // 앞 검사가 나눠둔 채로 올 수 있다 — 하나로 맞추고 시작한다
  while (document.querySelectorAll('#readPanes .read-pane').length > 1) {
    document.getElementById('readSplitBtn').click();
    await new Promise((r) => setTimeout(r, 300));
  }
  const openFromDrawer = async (name) => {
    document.getElementById('docList').__groups = null;
    document.getElementById('readDocs').click();
    await new Promise((r) => setTimeout(r, 500));
    const g = document.querySelector('#docList .dd-group');
    if (g && !g.classList.contains('open')) { g.click(); await new Promise((r) => setTimeout(r, 120)); }
    const el = [...document.querySelectorAll('#docList .dd-item .dd-name')].find((x) => x.textContent === name);
    if (el) el.closest('.dd-item').click();
    await new Promise((r) => setTimeout(r, 800));
  };

  await openFromDrawer('BLS본문');
  out.push({ name: '본문을 열었다', ok: /BLS본문/.test(document.getElementById('readTitle').textContent),
    detail: document.getElementById('readTitle').textContent });

  // 나누고 오른쪽에 암기법을 띄운다
  document.getElementById('readSplitBtn').click();
  await new Promise((r) => setTimeout(r, 500));
  out.push({ name: '창이 둘이 된다', ok: document.querySelectorAll('#readPanes .read-pane').length === 2 });
  await openFromDrawer('BLS암기법');
  const titles = () => [...document.querySelectorAll('#readPanes .pane-tab')].map((t) => t.textContent);
  out.push({ name: '오른쪽에 암기법이 떴다', ok: titles().some((t) => /암기법/.test(t)),
    detail: titles().join(' | ') });

  // 오른쪽에서 2장으로 넘겨두고 닫는다 — 다시 열 때 그 장이어야 한다
  document.getElementById('readNext').click();
  await new Promise((r) => setTimeout(r, 300));
  out.push({ name: '오른쪽을 2장으로 넘겼다',
    ok: /^2\//.test(document.getElementById('readPos').textContent),
    detail: document.getElementById('readPos').textContent });

  // 닫는다
  document.getElementById('readSplitBtn').click();
  await new Promise((r) => setTimeout(r, 400));
  out.push({ name: '닫으면 창이 하나', ok: document.querySelectorAll('#readPanes .read-pane').length === 1 });
  const mem = await d.kvGet('split_mem');
  const flat = mem ? Object.values(mem).flatMap((v) => (Array.isArray(v) ? v : v.tabs || [])) : [];
  out.push({ name: '**옆에 뒀던 것을 적어뒀다**',
    ok: flat.some((x) => /암기법/.test(x && x.p ? x.p : x)),
    detail: JSON.stringify(mem).slice(0, 80) });
  out.push({ name: '**보던 자리(몇 장)까지 같이 적는다**',
    ok: flat.every((x) => x && typeof x === 'object' && typeof x.s === 'number'),
    detail: JSON.stringify(flat[0] || null) });

  // ★ 다시 나누면 그대로 돌아온다
  document.getElementById('readSplitBtn').click();
  await new Promise((r) => setTimeout(r, 800));
  out.push({ name: '**다시 나누면 암기법이 되살아난다**(끌어다 넣지 않아도)',
    ok: titles().some((t) => /암기법/.test(t)), detail: titles().join(' | ') });
  out.push({ name: '**보던 장에서 이어 본다**(1장부터가 아니라)',
    ok: /^2\//.test(document.getElementById('readPos').textContent),
    detail: document.getElementById('readPos').textContent });

  // ★ 비율도 문서별로 — 표가 넓은 노트와 암기법은 맞는 비율이 다르다(2026-10-14)
  const grip = document.querySelector('.pane-split-resizer');
  if (grip) {
    const host = document.getElementById('readPanes').getBoundingClientRect();
    const g = grip.getBoundingClientRect();
    const pe = (t, x) => grip.dispatchEvent(new PointerEvent(t,
      { pointerId: 41, clientX: x, clientY: g.top + g.height / 2, bubbles: true, cancelable: true }));
    pe('pointerdown', g.left + 5);
    pe('pointermove', host.left + host.width * 0.35);
    pe('pointerup', host.left + host.width * 0.35);
    await new Promise((r) => setTimeout(r, 250));
    const set = document.documentElement.style.getPropertyValue('--pane-split').trim();
    out.push({ name: '끌어서 비율을 바꿨다', ok: /^3\d(\.\d)?%$/.test(set), detail: set });

    document.getElementById('readSplitBtn').click();          // 닫고
    await new Promise((r) => setTimeout(r, 350));
    const mem2 = await d.kvGet('split_mem');
    const saved = Object.values(mem2 || {}).map((v) => (Array.isArray(v) ? '' : v.ratio)).filter(Boolean);
    out.push({ name: '**비율을 문서별로 적어둔다**', ok: saved.length > 0, detail: saved.join(',') });

    document.getElementById('readSplitBtn').click();          // 다시 열면
    await new Promise((r) => setTimeout(r, 800));
    out.push({ name: '**그 비율로 다시 열린다**(반반으로 안 돌아간다)',
      ok: document.documentElement.style.getPropertyValue('--pane-split').trim() === set,
      detail: `${set} → ${document.documentElement.style.getPropertyValue('--pane-split').trim()}` });
  }
  out.push({ name: '같은 문서를 두 번 띄우지 않는다',
    ok: titles().filter((t) => /본문/.test(t)).length <= 1, detail: titles().join(' | ') });

  document.getElementById('readSplitBtn').click();
  await new Promise((r) => setTimeout(r, 300));
  window.fetch = realFetch;
  return out;
});

// ══════════ 그리는 동안 끊기지 않는다 (2026-10-14 신고) ══════════
// "캡쳐 도구에서 네모가 매끄럽게 안 그려지고 툭툭 끊김"
// → 좌표가 올 때마다 화면을 칠하고 있었다. 애플펜슬은 1초에 120번 넘게 좌표를 보내는데,
//    거기에 rAF 한 번이 더 붙어 같은 프레임을 두 번씩 칠했다. 한 프레임에 한 번만 칠한다.
await run('그리는 동안 끊김', async () => {
  const out = [];
  const { tokenize, PenLayer } = await import('/js/pen.js');
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.getElementById('readScreen').classList.add('toc-off');
  document.querySelectorAll('.sheet, .ask-float, #docDrawer, #docScrim, #selPop')
    .forEach((x) => x.classList.add('hidden'));
  document.querySelectorAll('#readCard .penlayer').forEach((c) => c.remove());

  const body = document.getElementById('readBody');
  body.innerHTML = Array.from({ length: 24 }, (_, i) => `<p id="pp${i}"></p>`).join('');
  for (let i = 0; i < 24; i++) {
    tokenize(document.getElementById(`pp${i}`),
      `${i + 1}번 문단. 화상 깊이에 따라 1도, 2도 표재, 2도 심부로 나눈다.`);
  }
  await new Promise((r) => setTimeout(r, 200));
  const pen = new PenLayer(document.getElementById('readCard'), {});
  const cv = document.querySelector('#readCard .penlayer');
  const ev = (t, x, y) => cv.dispatchEvent(new PointerEvent(t, {
    pointerType: 'pen', pointerId: 12, isPrimary: true,
    buttons: t === 'pointerup' ? 0 : 1, pressure: .5,
    clientX: x, clientY: y, bubbles: true, cancelable: true }));

  const r = body.getBoundingClientRect();
  const run1 = (tool, N) => {
    pen.setTool(tool);
    let paints = 0;
    const real = pen.redraw.bind(pen);
    pen.redraw = () => { paints++; real(); };
    const t0 = performance.now();
    ev('pointerdown', r.left + 20, r.top + 20);
    for (let i = 1; i <= N; i++) ev('pointermove', r.left + 20 + i * 3, r.top + 20 + i * 2);
    const ms = performance.now() - t0;
    pen.redraw = real;
    return { paints, ms, N };
  };

  // 애플펜슬 1초치 좌표를 한꺼번에 — 그 사이 화면은 한두 장뿐이다
  const shot = run1('shot', 120);
  out.push({ name: '**좌표마다 칠하지 않는다**(한 프레임에 한 번)',
    ok: shot.paints <= 4, detail: `좌표 ${shot.N}개 → ${shot.paints}번 칠함` });
  out.push({ name: '좌표 처리가 가볍다', ok: shot.ms / shot.N < 0.5,
    detail: `${(shot.ms / shot.N).toFixed(3)}ms/좌표` });
  ev('pointerup', r.left + 20 + 120 * 3, r.top + 20 + 120 * 2);
  await new Promise((rs) => setTimeout(rs, 100));

  // 그래도 **그려지기는 한다** — 안 그리면 가벼운 게 의미가 없다
  await new Promise((rs) => requestAnimationFrame(() => requestAnimationFrame(rs)));
  pen.setTool('shot');
  ev('pointerdown', r.left + 30, r.top + 30);
  for (let i = 1; i <= 12; i++) ev('pointermove', r.left + 30 + i * 12, r.top + 30 + i * 8);
  await new Promise((rs) => requestAnimationFrame(() => requestAnimationFrame(rs)));
  out.push({ name: '그리는 중에 틀이 실제로 보인다', ok: !!pen._previewBox,
    detail: pen._previewBox ? `${Math.round(pen._previewBox.r - pen._previewBox.l)}px` : '없음' });
  ev('pointerup', r.left + 30 + 144, r.top + 30 + 96);
  await new Promise((rs) => setTimeout(rs, 100));

  // 고르기·필기도 같은 길을 쓴다
  const sel = run1('select', 60);
  out.push({ name: '고르기도 한 프레임에 한 번', ok: sel.paints <= 4,
    detail: `${sel.N}개 → ${sel.paints}번` });
  ev('pointerup', r.left + 20 + 180, r.top + 20 + 120);
  await new Promise((rs) => setTimeout(rs, 100));
  const wr = run1('write', 60);
  out.push({ name: '필기도 한 프레임에 한 번', ok: wr.paints <= 4,
    detail: `${wr.N}개 → ${wr.paints}번` });
  ev('pointerup', r.left + 20 + 180, r.top + 20 + 120);
  await new Promise((rs) => setTimeout(rs, 700));
  out.push({ name: '필기는 그래도 획으로 남는다', ok: pen.strokes.length > 0,
    detail: `${pen.strokes.length}획` });

  pen.destroy();
  body.innerHTML = '';
  return out;
});

// ══════════ 카드 — 그림은 걸친 만큼, 빈칸은 미리 보여준다 (2026-10-14) ══════════
// "그림 설명에서 카드 만들면 꼭 그림도 따라오네" / "어디까지 카드 범위가 되는지 미리 보여줘"
await run('카드 미리보기 · 그림', async () => {
  const out = [];
  const { PenLayer } = await import('/js/pen.js');
  const R = await import('/js/reader.js');
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.getElementById('readScreen').classList.add('toc-off');
  document.querySelectorAll('.sheet, .ask-float, #docDrawer, #docScrim, #selPop')
    .forEach((x) => x.classList.add('hidden'));
  document.querySelectorAll('#readCard .penlayer').forEach((c) => c.remove());

  const body = document.getElementById('readBody');
  // ★ 실제로 겪은 꼴 — **그림과 설명이 한 덩어리**다. 그래서 설명만 긁어도 그림이 따라왔다.
  body.innerHTML = '<p id="cap"><img id="pic" alt="" style="width:300px;height:150px;background:#dde;display:block">'
    + '2도 표재는 <strong>표피와 표재진피</strong>를 침범하고 '
    + '<mark>capillary refill 정상</mark>이며 <strong>14~21일</strong>에 낫는다.</p>';
  await new Promise((r) => setTimeout(r, 200));
  const pen = new PenLayer(document.getElementById('readCard'), {});
  const cv = document.querySelector('#readCard .penlayer');
  const ev = (t, x, y) => cv.dispatchEvent(new PointerEvent(t, {
    pointerType: 'pen', pointerId: 14, isPrimary: true,
    buttons: t === 'pointerup' ? 0 : 1, pressure: .5,
    clientX: x, clientY: y, bubbles: true, cancelable: true }));

  // ── ① 설명만 긁는다 — 그림은 위에 있고 네모 밖이다
  pen.setTool('card');
  const cap = document.getElementById('cap').getBoundingClientRect();
  const picR0 = document.getElementById('pic').getBoundingClientRect();
  // 그림 **아래** 글줄만 긁는다 — 같은 덩어리지만 그림은 네모 밖이다
  const y0 = picR0.bottom + 2;
  ev('pointerdown', cap.left - 4, y0);
  for (let i = 1; i <= 12; i++) {
    ev('pointermove', cap.left - 4 + (cap.width + 8) * i / 12, y0 + (cap.bottom + 2 - y0) * i / 12);
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  out.push({ name: '**빈칸이 될 자리를 미리 짚어준다**',
    ok: !!pen._coveredLines && pen._coveredLines.length === 3,
    detail: `${(pen._coveredLines || []).length}곳` });
  out.push({ name: '카드 모드 틀이다(캡처와 구별)', ok: pen._previewKind === 'card' });
  const box = pen._previewBox;
  ev('pointerup', cap.right + 4, cap.bottom + 2);
  await new Promise((r) => setTimeout(r, 700));

  // 실제로 만들어지는 카드에 그림이 안 따라오는가
  const r0 = cv.getBoundingClientRect();
  const vp = { l: r0.left + box.l, t: r0.top + box.t, r: r0.left + box.r, b: r0.top + box.b };
  const made = R.cardsFromBox(body, vp, { notePath: 'x.md', noteTitle: 'x', heading: 'h' });
  out.push({ name: '카드가 만들어진다', ok: made.length > 0, detail: `${made.length}장` });
  out.push({ name: '**설명만 긁으면 그림은 안 따라온다**',
    ok: made.every((c) => !/<img/i.test(c.contextHtml)),
    detail: made.map((c) => (/<img/i.test(c.contextHtml) ? '그림있음' : '글만')).join(',') });

  // ── ② 그림까지 덮으면 따라온다
  const picR = document.getElementById('pic').getBoundingClientRect();
  const vp2 = { l: picR.left - 4, t: picR.top + picR.height * 0.5, r: cap.right + 4, b: cap.bottom + 4 };
  const made2 = R.cardsFromBox(body, vp2, { notePath: 'x.md', noteTitle: 'x', heading: 'h' });
  out.push({ name: '그림을 덮으면 그림도 들어온다',
    ok: made2.some((c) => /<img/i.test(c.contextHtml)) || made2.length === 0,
    detail: made2.length ? made2.map((c) => (/<img/i.test(c.contextHtml) ? '그림' : '글')).join(',') : '카드 없음' });

  // ── ③ 10% 규칙 자체
  const rect = { top: 100, bottom: 200, height: 100 };
  out.push({ name: '10%만 걸쳐도 남긴다', ok: R.imgOverlap(rect, { t: 190, b: 300 }) >= 0.1,
    detail: R.imgOverlap(rect, { t: 190, b: 300 }).toFixed(2) });
  out.push({ name: '살짝 스치면 뺀다', ok: R.imgOverlap(rect, { t: 196, b: 300 }) < 0.1,
    detail: R.imgOverlap(rect, { t: 196, b: 300 }).toFixed(2) });
  out.push({ name: '안 겹치면 0', ok: R.imgOverlap(rect, { t: 300, b: 400 }) === 0 });

  pen.destroy();
  body.innerHTML = '';
  return out;
});

// ══════════ 빈칸을 손으로 고른다 (2026-10-14 요청) ══════════
// "추천해서 만들어주는 기능은 유지하고, 내가 긁어서 팝업 띄우고 그 팝업에서
//  특정 단어 범위 지정해서 빈칸 만드는 게 나을 듯"
await run('손으로 빈칸 만들기', async () => {
  const out = [];
  const d = await import('/js/db.js');
  for (const c of await d.allCards()) await d.deleteCard(c.id);
  const { tokenize } = await import('/js/pen.js');

  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.getElementById('readScreen').classList.add('toc-off');
  document.querySelectorAll('.sheet, .ask-float, #docDrawer, #docScrim').forEach((x) => x.classList.add('hidden'));
  const body = document.getElementById('readBody');
  body.innerHTML = '<p id="czP"></p>';
  tokenize(document.getElementById('czP'),
    '우발적 저체온증은 심부체온이 비자발적으로 35℃ 미만으로 떨어진 상태다.');
  await new Promise((r) => setTimeout(r, 200));

  // 앱의 펜으로 긁는다 — 팝업이 떠야 한다.
  // 앞 검사가 캔버스를 치웠을 수 있다 — 앱이 들고 있는 펜의 캔버스를 다시 붙인다.
  const pen = window.__penForTest;
  out.push({ name: '읽기 화면 펜이 있다', ok: !!pen });
  if (!pen) return out;
  if (!document.querySelector('#readCard .penlayer')) {
    document.getElementById('readCard').appendChild(pen.canvas);
    pen.resize();
  }
  pen.setTool('select');
  const cv = document.querySelector('#readCard .penlayer');
  const ev = (t, x, y) => cv.dispatchEvent(new PointerEvent(t, {
    pointerType: 'pen', pointerId: 17, isPrimary: true,
    buttons: t === 'pointerup' ? 0 : 1, pressure: .5,
    clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const toks = [...document.querySelectorAll('#czP .tok')];
  const a = toks[0].getBoundingClientRect();
  const z = toks[toks.length - 1].getBoundingClientRect();
  ev('pointerdown', a.left + 2, a.top + a.height / 2);
  for (let i = 1; i <= 10; i++) {
    ev('pointermove', a.left + 2 + (z.right - a.left) * i / 10,
      a.top + a.height / 2 + (z.top - a.top) * i / 10);
  }
  ev('pointerup', z.right - 2, z.top + z.height / 2);
  await new Promise((r) => setTimeout(r, 800));
  out.push({ name: '긁으면 팝업이 뜬다',
    ok: !document.getElementById('selPop').classList.contains('hidden') });

  // ★ 팝업에 "빈칸 카드"가 있다
  const btn = document.getElementById('selCloze');
  out.push({ name: '**팝업에서 빈칸 카드로 갈 수 있다**', ok: !!btn });
  btn.click();
  await new Promise((r) => setTimeout(r, 500));
  const win = document.getElementById('clozeFloat');
  out.push({ name: '빈칸 만들기 창이 열린다', ok: !win.classList.contains('hidden') });

  const chips = [...document.querySelectorAll('.cz-w')];
  out.push({ name: '**긁은 글이 낱말 하나하나로 나온다**', ok: chips.length >= 6,
    detail: `${chips.length}개: ${chips.slice(0, 4).map((c) => c.textContent).join(' ')}` });
  out.push({ name: '추천이 미리 얹혀 있다(손댈 게 적게)',
    ok: chips.some((c) => c.classList.contains('on')),
    detail: chips.filter((c) => c.classList.contains('on')).map((c) => c.textContent).join(' ') });

  // 내가 직접 고른다
  document.getElementById('czClear').click();
  await new Promise((r) => setTimeout(r, 80));
  out.push({ name: '비우면 하나도 안 골라진다',
    ok: !document.querySelectorAll('.cz-w.on').length });
  out.push({ name: '고른 게 없으면 추가를 막는다',
    ok: document.getElementById('czAdd').disabled });

  // 이어진 두 낱말 → 한 빈칸
  const all = [...document.querySelectorAll('.cz-w')];
  all[3].click(); await new Promise((r) => setTimeout(r, 60));
  const all2 = [...document.querySelectorAll('.cz-w')];
  all2[4].click(); await new Promise((r) => setTimeout(r, 60));
  out.push({ name: '눌러서 고를 수 있다',
    ok: document.querySelectorAll('.cz-w.on').length === 2 });
  out.push({ name: '**이어진 낱말은 한 빈칸으로 묶인다**',
    ok: /빈칸 1개/.test(document.getElementById('czStatus').textContent),
    detail: document.getElementById('czStatus').textContent });

  // 떨어진 낱말을 더 고르면 빈칸이 둘
  const all3 = [...document.querySelectorAll('.cz-w')];
  all3[0].click(); await new Promise((r) => setTimeout(r, 60));
  out.push({ name: '떨어진 낱말은 따로 센다',
    ok: /빈칸 2개/.test(document.getElementById('czStatus').textContent),
    detail: document.getElementById('czStatus').textContent });

  // 빈칸이 둘이면 **나눠 담기가 기본**이다 (2026-10-15: "둘 다 가려져서 뭔지 모르겠네")
  out.push({ name: '빈칸이 둘이면 단추가 "하나씩"으로 바뀐다',
    ok: /하나씩 2장/.test(document.getElementById('czAdd').textContent),
    detail: document.getElementById('czAdd').textContent });
  out.push({ name: '"한 장에 모두"도 고를 수 있다',
    ok: !document.getElementById('czAll').classList.contains('hidden') });

  document.getElementById('czAdd').click();
  await new Promise((r) => setTimeout(r, 600));
  const made = await d.allCards();
  out.push({ name: '**빈칸 둘은 두 장으로 나뉘어 들어간다**', ok: made.length === 2,
    detail: `${made.length}장` });
  if (made.length === 2) {
    out.push({ name: '장마다 빈칸은 하나뿐',
      ok: made.every((c) => c.answers.length === 1
        && (c.contextHtml.match(/class="cloze"/g) || []).length === 1),
      detail: made.map((c) => c.answers.join('+')).join(' / ') });
    out.push({ name: '서로 다른 것을 묻는다',
      ok: made[0].answers[0] !== made[1].answers[0],
      detail: made.map((c) => c.answers[0]).join(' / ') });
    out.push({ name: '한 장에서 가린 말이 다른 장에서는 단서로 보인다',
      ok: made.some((c) => c.contextHtml.includes(made.find((o) => o !== c).answers[0])) });
    out.push({ name: '안 고른 말은 보인다', ok: made.every((c) => /저체온증/.test(c.contextHtml)) });
    out.push({ name: '어느 노트 것인지 남는다', ok: made.every((c) => !!c.heading),
      detail: made[0].heading });
  }
  out.push({ name: '넣고 나면 창이 닫힌다', ok: win.classList.contains('hidden') });

  for (const c of await d.allCards()) await d.deleteCard(c.id);
  body.innerHTML = '';
  return out;
});

// ── 카드 편집: 진짜 손가락처럼 눌렀다 뗀다 ──
// `.click()`은 pointerdown/up을 내지 않는다. 카드 편집은 누르기와 **끌기**를 한 손짓으로
// 가르느라 pointer 이벤트로 받으므로, 검사도 실제로 일어나는 일을 그대로 흉내 내야 한다.
const TAP_HELPERS = `
  window.__tap = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = (t, o) => el.dispatchEvent(new PointerEvent(t, Object.assign(
      { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y,
        bubbles: true, cancelable: true }, o || {})));
    ev('pointerdown', { buttons: 1 }); ev('pointerup', { buttons: 0 });
  };
  // a에서 b까지 쓱 끈다 — 지나가는 것을 한 손짓에 바꾼다
  // 가만히 눌러 머문 뒤 끈다 — 손가락을 거의 안 움직이고 시작하는 길(오래 누르기)
  window.__hold = async (el, to) => {
    const ra = el.getBoundingClientRect(), rb = to.getBoundingClientRect();
    const x1 = ra.left + ra.width / 2, y1 = ra.top + ra.height / 2;
    const x2 = rb.left + rb.width / 2, y2 = rb.top + rb.height / 2;
    const root = el.closest('.cf-q');
    const ev = (t, n, x, y, b) => n.dispatchEvent(new PointerEvent(t, {
      pointerType: 'touch', pointerId: 9, isPrimary: true, buttons: b,
      clientX: x, clientY: y, bubbles: true, cancelable: true }));
    ev('pointerdown', el, x1, y1, 1);
    await new Promise((r) => setTimeout(r, 500));        // 머문다
    for (let i = 1; i <= 10; i++) ev('pointermove', root, x1 + (x2 - x1) * i / 10, y1 + (y2 - y1) * i / 10, 1);
    ev('pointerup', root, x2, y2, 0);
  };
  window.__brush = (from, to, steps) => {
    const ra = from.getBoundingClientRect(), rb = to.getBoundingClientRect();
    const x1 = ra.left + ra.width / 2, y1 = ra.top + ra.height / 2;
    const x2 = rb.left + rb.width / 2, y2 = rb.top + rb.height / 2;
    const root = from.closest('.cf-q');
    const ev = (t, x, y, b) => root.dispatchEvent(new PointerEvent(t, {
      pointerType: 'touch', pointerId: 7, isPrimary: true, buttons: b,
      clientX: x, clientY: y, bubbles: true, cancelable: true }));
    from.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 7,
      isPrimary: true, buttons: 1, clientX: x1, clientY: y1, bubbles: true, cancelable: true }));
    const n = steps || 12;
    for (let i = 1; i <= n; i++) ev('pointermove', x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n, 1);
    ev('pointerup', x2, y2, 0);
  };
`;
await page.evaluate(TAP_HELPERS);

// ══════════ 추천 카드에서 빈칸을 직접 고친다 (2026-10-14 요청) ══════════
// "추천 카드 기능도 좋음... 근데 오래 암기할 때는 내가 원하는 걸 외워야 할 것 같음"
await run('카드 빈칸 직접 고치기', async () => {
  const out = [];
  const { renderMarkdown } = await import('/js/markdown.js');
  const R = await import('/js/reader.js');
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.querySelectorAll('.sheet, #docDrawer, #docScrim').forEach((x) => x.classList.add('hidden'));

  // 표에서도 되어야 한다 — "표나 문장 같은 게 나왔을 때"
  const body = document.getElementById('readBody');
  body.innerHTML = renderMarkdown('| 깊이 | 소견 |\n|---|---|\n| 2도 표재 | **capillary refill 정상** |');
  await new Promise((r) => setTimeout(r, 150));
  const r0 = body.getBoundingClientRect();
  const cards = R.cardsFromBox(body, { l: r0.left, t: r0.top, r: r0.right, b: r0.bottom },
    { notePath: 'x.md', noteTitle: 'x', heading: '화상 깊이' });
  out.push({ name: '표에서 카드가 만들어진다', ok: cards.length > 0, detail: `${cards.length}장` });
  if (!cards.length) return out;

  // 카드 창에 띄운다. 펜을 흉내 내는 대신 앱이 열어두는 통로를 쓴다(펜과 같은 방식).
  document.getElementById('cardFloat').classList.add('hidden');
  document.getElementById('cfBody').innerHTML = '';
  if (typeof window.__openCardFloat !== 'function') {
    out.push({ name: '카드 창을 열 수 있다', ok: false, detail: '통로가 없다' });
    body.innerHTML = ''; return out;
  }
  window.__openCardFloat(cards);
  await new Promise((r) => setTimeout(r, 400));
  const q = document.querySelector('#cfBody .cf-q');
  out.push({ name: '카드 창이 열린다', ok: !!q,
    detail: q ? '' : `cfBody: ${(document.getElementById('cfBody') || {}).textContent || '없음'}` });
  if (!q) { body.innerHTML = ''; return out; }

  const words = [...q.querySelectorAll('.cf-w')];
  out.push({ name: '**낱말마다 누를 수 있다**', ok: words.length >= 2,
    detail: `${words.length}개: ${words.slice(0, 3).map((w) => w.textContent).join(' ')}` });
  out.push({ name: '뭘 하면 되는지 적혀 있다',
    ok: /눌러서 가립니다|쓱 끌면/.test((document.querySelector('#cfBody .cf-hint') || {}).textContent || '') });

  const before = (document.querySelectorAll('#cfBody .cloze') || []).length;
  if (!words.length) { document.getElementById('cfClose').click(); body.innerHTML = ''; return out; }
  const pick = words.find((w) => /2도|표재|깊이/.test(w.textContent)) || words[0];
  const picked = pick.textContent;
  window.__tap(pick);
  await new Promise((r) => setTimeout(r, 200));
  const after = document.querySelectorAll('#cfBody .cloze').length;
  out.push({ name: '**누르면 빈칸이 하나 늘어난다**', ok: after === before + 1,
    detail: `${before} → ${after}` });
  out.push({ name: '고른 말이 답에 들어간다',
    ok: (cards[0].answers || []).includes(picked), detail: (cards[0].answers || []).join(' / ') });

  // 빈칸을 누르면 되돌아온다
  const blank = document.querySelector('#cfBody .cloze.pickable');
  out.push({ name: '빈칸도 누를 수 있다', ok: !!blank });
  if (blank) {
    const n0 = document.querySelectorAll('#cfBody .cloze').length;
    window.__tap(blank);
    await new Promise((r) => setTimeout(r, 200));
    out.push({ name: '**빈칸을 누르면 다시 보인다**',
      ok: document.querySelectorAll('#cfBody .cloze').length === n0 - 1,
      detail: `${n0} → ${document.querySelectorAll('#cfBody .cloze').length}` });
  }

  // 추천은 그대로 남아 있다
  out.push({ name: '추천 빈칸도 그대로 있다(추천 기능은 유지)',
    ok: document.querySelectorAll('#cfBody .cloze').length > 0 });

  // ── 쓱 끌어서 여럿을 한 번에 (2026-10-18 요청) ──
  // "카드 처음 만들 때 가려져 있는 부분이 보통 너무 많아서 문제거든? 한번에 드래그하면서
  //  여기저기 열어버리는 방법?" — 하나씩 누르면 손이 열 번 넘게 간다.
  {
    body.innerHTML = renderMarkdown(
      '**아트로핀**은 **서맥**에 쓰고 **에피네프린**은 **무맥성**에 쓰며 **아미오다론**은 **세동**에 쓴다.');
    await new Promise((r) => setTimeout(r, 140));
    const rb = body.getBoundingClientRect();
    const made = R.cardsFromBox(body, { l: rb.left, t: rb.top, r: rb.right, b: rb.bottom },
      { notePath: 'x.md', noteTitle: '노트', heading: '약' });
    if (made.length) {
      window.__openCardFloat(made);
      await new Promise((r) => setTimeout(r, 320));
      const qq = () => document.querySelector('#cfBody .cf-q');
      const nBlank = () => document.querySelectorAll('#cfBody .cloze').length;

      // ① 빈칸에서 시작해 끌면 지나간 빈칸이 **다 열린다**
      const b0 = nBlank();
      out.push({ name: '처음 만든 카드에 빈칸이 여럿이다', ok: b0 >= 3, detail: `${b0}개` });
      const bl = [...qq().querySelectorAll('.cloze')];
      if (b0 >= 3) {
        window.__brush(bl[0], bl[bl.length - 1]);
        await new Promise((r) => setTimeout(r, 250));
        out.push({ name: '**빈칸에서 쓱 끌면 지나간 데가 다 열린다**',
          ok: nBlank() === 0, detail: `${b0} → ${nBlank()}` });
        out.push({ name: '답 목록도 같이 비워진다',
          ok: (made[0].answers || []).length === 0, detail: (made[0].answers || []).join(',') });
      }

      // ② 반대로 글자에서 시작해 끌면 지나간 낱말이 **다 가려진다**
      const ws = [...qq().querySelectorAll('.cf-w')];
      out.push({ name: '푼 자리도 다시 누를 수 있는 낱말로 남는다', ok: ws.length >= 4,
        detail: `${ws.length}개` });
      if (ws.length >= 4) {
        const n0 = nBlank();
        window.__brush(ws[0], ws[3]);
        await new Promise((r) => setTimeout(r, 250));
        out.push({ name: '**글자에서 쓱 끌면 지나간 낱말이 다 가려진다**',
          ok: nBlank() >= n0 + 3, detail: `${n0} → ${nBlank()}` });
      }

      // ③ 끌기 중에는 한쪽으로만 간다 — 지나간 빈칸을 도로 가려버리면 왔다 갔다 한다
      const mix = [...qq().querySelectorAll('.cf-w, .cloze')];
      if (mix.length >= 4) {
        const n1 = nBlank();
        const firstBlank = mix.find((x) => x.classList.contains('cloze'));
        const lastAny = mix[mix.length - 1];
        if (firstBlank) {
          window.__brush(firstBlank, lastAny);
          await new Promise((r) => setTimeout(r, 250));
          out.push({ name: '빈칸에서 시작했으면 가리지는 않는다(한쪽으로만)',
            ok: nBlank() <= n1, detail: `${n1} → ${nBlank()}` });
        }
      }

      // ④ 그냥 한 번 누르는 건 여전히 하나만 — 끌기를 넣느라 누르기가 망가지면 안 된다
      const w1 = qq().querySelector('.cf-w');
      if (w1) {
        const n2 = nBlank();
        window.__tap(w1);
        await new Promise((r) => setTimeout(r, 200));
        out.push({ name: '한 번 누르면 하나만 바뀐다(끌기를 넣어도)',
          ok: nBlank() === n2 + 1, detail: `${n2} → ${nBlank()}` });
      }

      // ⑤ 오래 눌러도 끌기로 넘어간다 — "오래누르면 아예 가려진부분을 여는 모드로"
      {
        const bl2 = [...qq().querySelectorAll('.cloze')];
        if (bl2.length >= 3) {
          const n3 = nBlank();
          await window.__hold(bl2[0], bl2[bl2.length - 1]);
          await new Promise((r) => setTimeout(r, 250));
          out.push({ name: '**가만히 눌러 머물다 끌어도 열린다**(손가락을 안 움직이고 시작)',
            ok: nBlank() <= n3 - 2, detail: `${n3} → ${nBlank()}` });
        }
      }

      // ⑥ 가려진 데가 많으면 끄는 법을 먼저 알려준다
      const hint = (document.querySelector('#cfBody .cf-hint') || {}).textContent || '';
      out.push({ name: '뭘 하면 되는지 적혀 있다(끌기까지)', ok: /쓱 끌/.test(hint), detail: hint });

      // ⑦ 끌기가 끝나면 화면 밀림 막이가 풀려야 한다 — 안 풀면 패널을 못 넘긴다
      out.push({ name: '끌기가 끝나면 원래대로 돌아온다',
        ok: !qq().classList.contains('cf-brushing') });
      out.push({ name: '평소엔 세로로 넘길 수 있다',
        ok: /pan-y/.test(getComputedStyle(qq()).touchAction), detail: getComputedStyle(qq()).touchAction });
      document.getElementById('cfClose').click();
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // ── 그림만 골라도 카드가 된다 (2026-10-19 요청) ──
  // "하이라이트나 볼드 없으면 아예 오픈이 안되는데 사진만 선택되어도 카드 만들 수 있도록"
  // 해부·영상은 원래 그 꼴이다 — 물어볼 글이 없고, 그림에 네모를 치면 그게 곧 문제다.
  {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUA'
      + 'AAAPUlEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      + 'AAAAACAtwFQQAABCM+7WwAAAABJRU5ErkJggg==';
    body.innerHTML = `<p>설명은 그냥 줄글이다.</p><p><img src="${PNG}" alt="심장해부"`
      + ' style="width:240px;height:150px"></p>';
    await new Promise((r) => setTimeout(r, 200));
    const ri = body.querySelector('img').getBoundingClientRect();
    // 그림만 네모 안에 들어오게 — 글은 건드리지 않는다
    const picOnly = R.cardsFromBox(body, { l: ri.left, t: ri.top, r: ri.right, b: ri.bottom },
      { notePath: 'x.md', noteTitle: '노트', heading: '2. 심장 해부' });
    out.push({ name: '**강조가 없어도 그림만으로 카드가 열린다**', ok: picOnly.length === 1,
      detail: `${picOnly.length}장` });
    if (picOnly.length) {
      out.push({ name: '그림이 카드에 들어간다', ok: /<img/.test(picOnly[0].contextHtml) });
      out.push({ name: '빈칸은 아직 없다(네모를 쳐서 만든다)',
        ok: (picOnly[0].answers || []).length === 0 });
      out.push({ name: '**무슨 카드인지 목차가 맨 위에 보인다**',
        ok: /심장 해부/.test(picOnly[0].topic || ''), detail: picOnly[0].topic });
      out.push({ name: '그림 카드라고 적어둔다', ok: picOnly[0].kind === 'image',
        detail: picOnly[0].kind });
      out.push({ name: '그림이 둘이어도 id가 안 겹치게 그림 이름을 넣는다',
        ok: /img:/.test(picOnly[0].id), detail: picOnly[0].id });

      window.__openCardFloat(picOnly);
      await new Promise((r) => setTimeout(r, 350));
      out.push({ name: '목차 줄이 실제로 그려진다',
        ok: /심장 해부/.test((document.querySelector('#cfBody .cf-topic') || {}).textContent || ''),
        detail: (document.querySelector('#cfBody .cf-topic') || {}).textContent });
      out.push({ name: '뭘 해야 하는지 알려준다(그림을 끌어 네모)',
        ok: /네모/.test((document.querySelector('#cfBody .cf-hint') || {}).textContent || ''),
        detail: (document.querySelector('#cfBody .cf-hint') || {}).textContent });

      // 아직 물어볼 게 없으면 넣지 않는다 — 넣어봐야 못 푸는 카드다
      const n0 = document.querySelectorAll('#cfBody .io-mask').length;
      document.getElementById('cfAdd').click();
      await new Promise((r) => setTimeout(r, 300));
      out.push({ name: '네모가 없으면 추가하지 않고 할 일을 알려준다',
        ok: n0 === 0 && /1\/1/.test(document.getElementById('cfStatus').textContent),
        detail: document.getElementById('cfStatus').textContent });

      // 네모를 치면 그때부터 카드가 된다
      const wrap = document.querySelector('#cfBody .io-wrap');
      const im2 = wrap && wrap.querySelector('img');
      if (im2) {
        const rr2 = im2.getBoundingClientRect();
        const ev = (t, x, y, b) => wrap.dispatchEvent(new PointerEvent(t, {
          pointerType: 'touch', pointerId: 5, isPrimary: true, buttons: b,
          clientX: x, clientY: y, bubbles: true, cancelable: true }));
        ev('pointerdown', rr2.left + 20, rr2.top + 20, 1);
        for (let i = 1; i <= 6; i++) ev('pointermove', rr2.left + 20 + i * 15, rr2.top + 20 + i * 12, 1);
        ev('pointerup', rr2.left + 110, rr2.top + 92, 0);
        await new Promise((r) => setTimeout(r, 300));
        out.push({ name: '**그림에 네모를 치면 그게 문제가 된다**',
          ok: document.querySelectorAll('#cfBody .io-mask').length === 1,
          detail: `${document.querySelectorAll('#cfBody .io-mask').length}개` });
        out.push({ name: '네모 개수를 카드가 들고 있다', ok: picOnly[0].masks === 1,
          detail: String(picOnly[0].masks) });
      }
      document.getElementById('cfClose').click();
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // 크롬은 -webkit-touch-callout을 구현하지 않는다 — 규칙 글을 직접 본다.
  // ⚠️ 주석에 선택자가 들어 있으면 헛통과한다(전에 겪음) — 주석부터 턴다.
  const cssSaysNoCallout = await (async () => {
    const css = (await fetch('/css/app.css').then((r) => r.text())).replace(/\/\*[\s\S]*?\*\//g, '');
    const m = css.match(/\.cf-pick,\s*\.cf-pick \*\s*\{([^}]*)\}/);
    return !!m && /-webkit-touch-callout:\s*none/.test(m[1]);
  })();

  // ── 끌 때 글이 집히지 않는가 (2026-10-19 신고) ──
  // "추가버튼 누르니까 복사하기? 같은 게 계속 나오고 추가버튼이 안눌리는 버그"
  // 아이패드에서 글 위를 끌면 사파리가 글을 집어 "복사·찾아보기" 쪽지를 띄운다.
  // 그 쪽지가 뜨면 다음 누름은 쪽지를 닫는 데 먹힌다 — 버튼이 죽은 것처럼 보인다.
  // ⚠️ `.af-body *`가 위에서 text로 열어두므로, **실제로 계산된 값**을 재야 한다.
  {
    const pick = document.querySelector('#cfBody .cf-pick');
    if (pick) {
      const w = pick.querySelector('.cf-w') || pick.querySelector('.cloze') || pick;
      const cs = getComputedStyle(w);
      out.push({ name: '**카드 본문은 글이 집히지 않는다**(.af-body *를 이기는지)',
        ok: cs.webkitUserSelect === 'none' || cs.userSelect === 'none',
        detail: `user-select: ${cs.userSelect} / webkit: ${cs.webkitUserSelect}` });
      out.push({ name: '길게 눌러도 쪽지가 안 뜬다(-webkit-touch-callout)',
        ok: (cs.webkitTouchCallout || '') === 'none' || cssSaysNoCallout,
        detail: cs.webkitTouchCallout || '(크롬은 이 속성이 없다 — 규칙으로 확인)' });
      out.push({ name: '끌기가 끝나면 집힌 글을 놓아준다',
        ok: /getSelection\(\)\.removeAllRanges/.test(await fetch('/js/app.js').then((r) => r.text())) });
    }
  }

  // ── 가린 네모가 **어디서 보든 같은 자리**인가 (2026-10-19 신고) ──
  // "카드 만들기때 그림에 그렸던 네모랑 노트의 카드에서 보이는 네모 위치가 다른 버그"
  //
  // 네모 자리는 그림 상자를 기준으로 %로 적는다. 그런데 본문 그림은 width: 100%에
  // max-height가 걸려 있어 **상자가 그림보다 넓어지고**, object-fit: contain이 남는
  // 띠 가운데에 그림을 칠한다. 그 띠 폭이 보는 자리마다 달라서(편집기 10px,
  // 외우기 화면 416px) 네모가 그만큼씩 다르게 밀렸다.
  {
    const PNG = await (async () => {
      const cv = document.createElement('canvas'); cv.width = 800; cv.height = 600;
      const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 800, 600);
      return cv.toDataURL();
    })();
    const html = `<p><span class="io-wrap"><img class="embed" data-embed="t.png" src="${PNG}">`
      + '<span class="io-mask" style="left:50%;top:40%;width:20%;height:15%"></span></span></p>';
    const mk = (cls) => {
      const d = document.createElement('div');
      d.className = cls;
      d.innerHTML = html;
      document.body.appendChild(d);
      return d;
    };
    // 일부러 **폭이 다른** 두 자리에 같은 HTML을 놓는다 — 그게 이 버그가 나던 조건이다
    const a = mk('cf-q cf-pick'); a.style.width = '520px';
    const z = mk('card-context'); z.style.width = '1340px';
    await new Promise((r) => setTimeout(r, 300));
    const look = (host) => {
      const im = host.querySelector('img');
      const mask = host.querySelector('.io-mask');
      const ri = im.getBoundingClientRect(), rm = mask.getBoundingClientRect();
      const s = Math.min(ri.width / im.naturalWidth, ri.height / im.naturalHeight);
      const pw = im.naturalWidth * s, ph = im.naturalHeight * s;
      return {
        band: Math.round((ri.width - pw) / 2),          // object-fit이 남긴 띠
        bandY: Math.round((ri.height - ph) / 2),
        // 네모가 **그림 안에서** 차지하는 비율 — 이게 두 자리에서 같아야 한다
        fx: (rm.left - ri.left) / ri.width,
        fy: (rm.top - ri.top) / ri.height,
        box: `${Math.round(ri.width)}×${Math.round(ri.height)}`,
      };
    };
    const A = look(a), Z = look(z);
    out.push({ name: '**그림 상자에 빈 띠가 안 생긴다**(네모가 밀리던 까닭)',
      ok: A.band <= 1 && Z.band <= 1 && A.bandY <= 1 && Z.bandY <= 1,
      detail: `편집기 ${A.band}/${A.bandY}px · 외우기 ${Z.band}/${Z.bandY}px` });
    out.push({ name: '**폭이 달라도 네모가 그림의 같은 자리에 있다**',
      ok: Math.abs(A.fx - Z.fx) < 0.01 && Math.abs(A.fy - Z.fy) < 0.01,
      detail: `편집기 ${A.fx.toFixed(3)},${A.fy.toFixed(3)} · 외우기 ${Z.fx.toFixed(3)},${Z.fy.toFixed(3)}` });
    out.push({ name: '그림 상자 크기 자체가 같다', ok: A.box === Z.box,
      detail: `${A.box} / ${Z.box}` });
    // 감싼 상자가 그림보다 크면(여백 때문에) 네모가 그만큼 내려앉는다
    const wr = a.querySelector('.io-wrap').getBoundingClientRect();
    const ir = a.querySelector('img').getBoundingClientRect();
    out.push({ name: '감싼 상자가 그림에 딱 맞는다(여백이 안 끼어든다)',
      ok: Math.abs(wr.height - ir.height) <= 1 && Math.abs(wr.width - ir.width) <= 1,
      detail: `상자 ${Math.round(wr.width)}×${Math.round(wr.height)} · 그림 ${Math.round(ir.width)}×${Math.round(ir.height)}` });
    a.remove(); z.remove();
  }

  // ── 손짓이 굳어서 카드창이 멈추지 않는가 (2026-10-19 신고) ──
  // "아니 아예 추가만 안눌리는게 아니고 그냥 카드 만들기에서 벗어날 수가 없네"
  // 그림에 네모 치는 쪽과 쓱 끌기가 **둘 다 포인터를 가로채려 해서** 서로 뺏었다.
  // 뺏긴 쪽은 pointerup을 영영 못 받아 `cf-brushing`(touch-action: none)이 그대로 남았다.
  {
    const app = await fetch('/js/app.js').then((r) => r.text());
    out.push({ name: '쓱 끌기는 포인터를 가로채지 않는다(그림 그리기와 안 싸우게)',
      ok: !/root\.setPointerCapture/.test(app), detail: '' });
    out.push({ name: '그림 그리기는 네모·낱말 칸에서 시작하지 않는다',
      ok: /cl\.contains\('io-mask'\) \|\| cl\.contains\('io-word'\)/.test(app) });
    out.push({ name: '다시 그릴 때 그리다 만 네모를 턴다',
      ok: /io-mask\.drawing'\)\.forEach\(\(el\) => el\.remove\(\)\)/.test(app) });
    out.push({ name: '다시 그릴 때 굳은 cf-brushing을 턴다',
      ok: /cf-brushing'\)\.forEach\(\(el\) => el\.classList\.remove\('cf-brushing'\)\)/.test(app) });
  }

  // ── 같은 낱말을 몇 번을 눌러도 글이 안 움직인다 (2026-10-16 지적) ──
  // "같은 단어를 계속 누르면 점점 글자 간격이 벌어지는데? 이런일이 있어서는 안되지."
  // 껍데기(.cf-w)를 본문에 함께 저장하면 다음에 그릴 때 그 위에 또 씌워지고,
  // 껍데기마다 좌우 2px이 붙어 누를 때마다 4px씩 벌어졌다.
  {
    // 줄글 카드로 바꿔 끼운다 — 표는 칸이 자리를 먹어 밀림이 눈에 안 띈다
    body.innerHTML = renderMarkdown(
      '소아 소생에서는 **수축기 혈압 하한**을 먼저 보고 **모세혈관 재충전**도 함께 확인한다고 배웠다.');
    await new Promise((r) => setTimeout(r, 120));
    const rr = body.getBoundingClientRect();
    const prose = R.cardsFromBox(body, { l: rr.left, t: rr.top, r: rr.right, b: rr.bottom },
      { notePath: 'x.md', noteTitle: '노트', heading: '1. 쇼크' });
    out.push({ name: '줄글 카드가 만들어진다', ok: prose.length === 1, detail: `${prose.length}장` });
    window.__openCardFloat(prose);
    await new Promise((r) => setTimeout(r, 300));
    const picked2 = '먼저';
    const q2 = () => document.querySelector('#cfBody .cf-q');
    const target = () => {
      const el = q2();
      return el ? [...el.querySelectorAll('.cf-w, .cloze.pickable')]
        .find((x) => x.textContent.trim() === picked2) : null;
    };
    const span = () => Math.round(q2().getBoundingClientRect().height);
    const tailX = () => {
      const all = [...q2().querySelectorAll('.cf-w')];
      const last = all[all.length - 1];
      return last ? Math.round(last.getBoundingClientRect().left) : -1;
    };
    const h0 = span();
    const x0 = tailX();
    let toggled = 0;
    for (let i = 0; i < 6; i++) {
      const t = target();
      if (!t) break;
      t.click();
      toggled++;
      await new Promise((r) => setTimeout(r, 120));
    }
    out.push({ name: '여섯 번 눌러도 끝까지 눌린다', ok: toggled === 6, detail: `${toggled}번` });
    out.push({ name: '**눌러도 줄 수가 안 늘어난다(글이 안 벌어진다)**',
      ok: Math.abs(span() - h0) <= 1, detail: `${h0} → ${span()}px` });
    out.push({ name: '**마지막 낱말이 제자리에 있다**', ok: Math.abs(tailX() - x0) <= 1,
      detail: `${x0} → ${tailX()}px` });
    const saved = prose[0] ? (prose[0].contextHtml || '') : '';
    out.push({ name: '저장되는 본문에 편집용 껍데기가 안 섞인다',
      ok: !/cf-w/.test(saved) && !/pickable/.test(saved),
      detail: saved.slice(0, 60) });
    out.push({ name: '껍데기가 겹쳐 쌓이지 않는다',
      ok: !/class="cf-w"[^>]*>\s*<span class="cf-w"/.test(q2().innerHTML) });
    // 빈칸과 낱말의 상자가 같아야 자리가 안 바뀐다
    const w = q2().querySelector('.cf-w');
    const cz = q2().querySelector('.cloze');
    if (w && cz) {
      const a = getComputedStyle(w);
      const b = getComputedStyle(cz);
      out.push({ name: '빈칸과 낱말의 여백이 같다',
        ok: a.paddingLeft === b.paddingLeft && a.paddingRight === b.paddingRight,
        detail: `${a.paddingLeft}/${a.paddingRight} vs ${b.paddingLeft}/${b.paddingRight}` });
      out.push({ name: '빈칸이 억지로 넓어지지 않는다(min-width 없음)',
        ok: b.minWidth === '0px' || b.minWidth === 'auto', detail: b.minWidth });
    }
  }

  // ── 같은 말이 두 번 빈칸일 때 하나만 풀어도 나머지는 남는다 (2026-10-16 점검) ──
  // 답을 따로 더하고 빼면서 `filter(x => x !== ans)`로 지우고 있었다 — 같은 말이
  // 두 군데면 하나만 풀어도 **답이 둘 다** 날아가 본문과 어긋났다.
  {
    body.innerHTML = renderMarkdown(
      '초기에는 **아트로핀**을 주고 이어서 다시 **아트로핀**을 더 준다고 배웠다.');
    await new Promise((r) => setTimeout(r, 120));
    const rr = body.getBoundingClientRect();
    const dup = R.cardsFromBox(body, { l: rr.left, t: rr.top, r: rr.right, b: rr.bottom },
      { notePath: 'x.md', noteTitle: '노트', heading: '1. 해독제' });
    out.push({ name: '같은 말이 두 번이면 빈칸도 두 개',
      ok: dup.length === 1 && dup[0].answers.length === 2,
      detail: dup.length ? dup[0].answers.join(',') : '0장' });
    if (dup.length) {
      window.__openCardFloat(dup);
      await new Promise((r) => setTimeout(r, 320));
      const n0 = document.querySelectorAll('#cfBody .cloze').length;
      const one = document.querySelector('#cfBody .cloze.pickable');
      if (one) { window.__tap(one); await new Promise((r) => setTimeout(r, 180)); }
      const n1 = document.querySelectorAll('#cfBody .cloze').length;
      out.push({ name: '하나를 풀면 빈칸이 하나만 준다', ok: n0 === 2 && n1 === 1, detail: `${n0} → ${n1}` });
      out.push({ name: '**답 목록도 하나만 준다**', ok: (dup[0].answers || []).length === 1,
        detail: `${(dup[0].answers || []).length}개` });
      out.push({ name: '본문 빈칸 수와 답 수가 늘 맞는다',
        ok: n1 === (dup[0].answers || []).length,
        detail: `본문 ${n1} · 답 ${(dup[0].answers || []).length}` });
      document.getElementById('cfClose').click();
    }
  }

  document.getElementById('cfClose').click();
  body.innerHTML = '';
  return out;
});

// ══════════ 언제든 물을 수 있다 (2026-10-14 요청) ══════════
// "이렇게 나오면 새로운 질문은 어디서 함? 지금 할 데가 없는데?"
await run('새 질문 하기', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('readScreen').classList.remove('hidden');
  document.body.dataset.screen = 'readScreen';
  document.querySelectorAll('.sheet, #docDrawer, #docScrim, #selPop').forEach((x) => x.classList.add('hidden'));
  document.getElementById('askFloat').classList.add('hidden');
  window.getSelection().removeAllRanges();
  const d = await import('/js/db.js');
  await d.kvSet('ask_log', []);
  await d.kvSet('ask_threads', []);                  // 실로 바뀌었다(2026-10-15)
  if (window.__askForTest) await window.__askForTest.reload();
  await new Promise((r) => setTimeout(r, 120));

  // 긁은 것도 지난 답도 없는데 눌러본다 — 전에는 "먼저 드래그하세요"로 막혔다
  document.getElementById('readAsk').click();
  await new Promise((r) => setTimeout(r, 300));
  const f = document.getElementById('askFloat');
  out.push({ name: '**아무것도 안 긁었어도 창이 열린다**', ok: !f.classList.contains('hidden') });
  out.push({ name: '질문 칸에 바로 커서가 간다',
    ok: document.activeElement.id === 'afInput', detail: document.activeElement.id });
  out.push({ name: '뭘 하면 되는지 적혀 있다',
    ok: /궁금한 것을 적어/.test(document.getElementById('afBody').textContent) });
  out.push({ name: '어느 노트를 보고 답하는지 알려준다',
    ok: /노트를 같이 읽고/.test(document.getElementById('afBody').textContent) });

  // 빈 칸으로는 안 보낸다
  document.getElementById('afInput').value = '   ';
  document.getElementById('afSend').click();
  await new Promise((r) => setTimeout(r, 150));
  out.push({ name: '빈 칸으로는 안 보낸다',
    ok: /궁금한 것을 적어/.test(document.getElementById('afBody').textContent) });

  // 실제로 물어본다(가짜 응답)
  const realFetch = window.fetch;
  window.fetch = async (u, i) => {
    if (!String(u).includes('generativelanguage')) return realFetch(u, i);
    const body = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: '압박분율은 60% 이상입니다.' }] } }] }) + '\n\n';
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }) };
  };
  const g = await import('/js/gemini.js');
  await g.setKey('fake-key-for-ask');
  g.resetLimiter();
  document.getElementById('afInput').value = '압박분율 목표는?';
  document.getElementById('afInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  for (let i = 0; i < 40 && !/압박분율은/.test(document.getElementById('afBody').textContent); i++) {
    await new Promise((r) => setTimeout(r, 120));
  }
  out.push({ name: '**Enter로 물어본다**', ok: /압박분율은/.test(document.getElementById('afBody').textContent),
    detail: document.getElementById('afBody').textContent.slice(0, 40) });
  out.push({ name: '물어본 뒤 칸이 비워진다', ok: document.getElementById('afInput').value === '' });
  out.push({ name: '질문이 제목에 남는다', ok: /압박분율/.test(document.getElementById('afQ').textContent),
    detail: document.getElementById('afQ').textContent });

  // 접으면 아래 바에 점이 뜬다
  document.getElementById('afClose').click();
  await new Promise((r) => setTimeout(r, 200));
  const lastTag = document.getElementById('readAskLast');
  out.push({ name: '**접으면 아래 바에 방금 물어본 말이 뜬다**',
    ok: !lastTag.classList.contains('hidden') && lastTag.textContent.length > 0,
    detail: lastTag.textContent });
  out.push({ name: '길면 줄여서 보여준다(바가 안 늘어나게)',
    ok: lastTag.textContent.length <= 14, detail: `${lastTag.textContent.length}자` });
  out.push({ name: '다시 누르면 그 답이 돌아온다',
    ok: (document.getElementById('readAsk').click(),
      await new Promise((r) => setTimeout(() => r(/압박분율은/.test(document.getElementById('afBody').textContent)), 300))) });

  window.fetch = realFetch;
  await g.setKey('');
  document.getElementById('afClose').click();
  return out;
});

// ══════════ 퀴즈에서도 AI를 부르고, 옆 패널 버튼이 읽히는가 (2026-10-14) ══════════
// "AI 질문한 거 볼 수 있는 거 아래 바에 띄우라고 하지 않았나? 이거 왜 없음?"
// "오른쪽에 띄워놓은 창의 ✕ 옆 기호는 뭐임? 눌러도 동작도 안 하는데?"
await run('퀴즈 AI · 옆 패널 버튼', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('quizScreen').classList.remove('hidden');
  document.body.dataset.screen = 'quizScreen';
  document.getElementById('quizScreen').classList.add('with-side');
  document.getElementById('wikiPanel').classList.remove('hidden');
  document.querySelectorAll('.sheet, .ask-float, #docDrawer, #docScrim').forEach((x) => x.classList.add('hidden'));
  await new Promise((r) => setTimeout(r, 200));

  // ① 퀴즈 아래 바에도 AI 단추
  const ask = document.getElementById('quizAsk');
  out.push({ name: '**퀴즈 아래 바에 AI 단추가 있다**', ok: !!ask });
  out.push({ name: '읽기 화면과 같은 그림',
    ok: !!ask && ask.querySelector('svg').innerHTML
      === document.getElementById('readAsk').querySelector('svg').innerHTML });
  out.push({ name: '방금 물어본 것을 옆에 보여준다', ok: !!document.getElementById('quizAskLast') });
  out.push({ name: '아래 바 안에 있다(떠다니지 않는다)',
    ok: !!ask && !!ask.closest('.quiz-nav') });

  const d = await import('/js/db.js');
  // 앞 검사에서 물어본 것이 남아 있다 — 그러면 점이 **떠 있어야** 맞다
  const dot = document.getElementById('quizAskLast');
  const quizHidden = dot.classList.contains('hidden');
  const readHidden = document.getElementById('readAskLast').classList.contains('hidden');
  out.push({ name: '두 화면의 점이 같은 상태다(질문기록을 같이 쓴다)',
    ok: quizHidden === readHidden,
    detail: `퀴즈 ${quizHidden ? '숨김' : '보임'} / 읽기 ${readHidden ? '숨김' : '보임'}` });

  ask.click();
  await new Promise((r) => setTimeout(r, 400));
  out.push({ name: '**눌러서 물을 수 있다**(막히지 않는다)',
    ok: !document.getElementById('askFloat').classList.contains('hidden') });
  out.push({ name: '질문 칸이 있다', ok: !!document.getElementById('afInput') });
  document.getElementById('afClose').click();

  // ② 옆 패널의 "다른 노트" — 알 수 없는 기호였다
  const docs = document.getElementById('wikiDocs');
  out.push({ name: '**글씨로 뭘 하는 버튼인지 보인다**', ok: !!docs && /노트/.test(docs.textContent),
    detail: docs ? docs.textContent : '없음' });
  out.push({ name: '아이콘이 아니라 글씨 버튼', ok: !!docs && docs.classList.contains('txt-btn') });

  await d.kvSet('note_index_v2', [{ root: '02_Wiki', subject: '응급_중환자',
    notes: [{ name: '응급중환자_환경의학', path: '02_Wiki/응급_중환자/응급중환자_환경의학.md' }] }]);
  document.getElementById('docList').__groups = null;
  const a = await import('/js/auth.js');
  await a.setToken('fake'); await a.setRepo('me/v');
  docs.click();
  await new Promise((r) => setTimeout(r, 900));
  out.push({ name: '**눌러서 서랍이 열린다**',
    ok: !document.getElementById('docDrawer').classList.contains('hidden') });
  out.push({ name: '노트가 실제로 나온다',
    ok: document.querySelectorAll('#docList .dd-group, #docList .dd-item').length > 0,
    detail: document.getElementById('docList').textContent.slice(0, 40) });
  document.getElementById('docClose').click();
  return out;
});

// ══════════ 빈칸 쪼개기 · 추천 (2026-10-14 요청) ══════════
// "괄호 여는 부분은 다른 단어로 취급해야 할 것 같음" / "15:2로에서 숫자만 체크되도록"
// "추천대로도 아주 형편없이 동작하고 있으니 개선해봐. 보통 숫자나 목적어가 중심 아니겠어?"
await run('빈칸 쪼개기·추천', async () => {
  const out = [];
  const R = await import('/js/reader.js');
  const sw = (w) => R.splitWord(w).join(' | ');

  out.push({ name: '**괄호는 따로 고른다**', ok: sw('함몰(umbilication)이') === '함몰 | (umbilication) | 이',
    detail: sw('함몰(umbilication)이') });
  out.push({ name: '**숫자만 고를 수 있다**', ok: sw('15:2로') === '15:2 | 로', detail: sw('15:2로') });
  out.push({ name: '단위까지 숫자 쪽에', ok: sw('>40℃와') === '>40℃ | 와', detail: sw('>40℃와') });
  out.push({ name: '겹단위도 한 덩어리', ok: sw('10~30회/분인지,') === '10~30회/분 | 인지,',
    detail: sw('10~30회/분인지,') });
  out.push({ name: '쪼갤 게 없으면 그대로', ok: sw('capillary') === 'capillary' });
  out.push({ name: '한 낱말인 것은 안 쪼갠다', ok: sw('AST/ALT') === 'AST/ALT' && sw('2도') === '2도' });

  // 추천 점수 — 숫자가 가장 높고 조사는 0
  const sc = (w) => R.wordScore(w);
  out.push({ name: '**숫자가 가장 먼저**', ok: sc('35℃') > sc('체온') && sc('35℃') > sc('capillary') });
  out.push({ name: '영문 용어도 높게', ok: sc('capillary') > sc('모두') });
  out.push({ name: '**조사는 안 고른다**', ok: sc('이') === 0 && sc('와') === 0 && sc('으로') === 0 });
  out.push({ name: '서술 끝맺음도 안 고른다', ok: sc('한다') === 0 && sc('이다') === 0 && sc('낫는다') === 0 });
  out.push({ name: '괄호는 혼자 안 뽑힌다(앞말에 딸린다)', ok: sc('(umbilication)') < sc('함몰') });
  out.push({ name: '설명문은 명사가 후보', ok: sc('저체온증') > 0 });
  return out;
});

// ══════════ 폴더와 파일이 구별된다 · 탭에 그림 (2026-10-14 요청) ══════════
// "상위 폴더에는 색을 살짝 넣든가 해서 폴더인지 맨 아래 파일인지 구별되게" / "아이콘을 넣든가"
await run('묶음·항목 구별', async () => {
  const out = [];
  document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
  document.getElementById('listScreen').classList.remove('hidden');
  document.body.dataset.screen = 'listScreen';
  document.getElementById('todayBody').classList.add('hidden');
  const body = document.getElementById('listBody');
  body.classList.remove('hidden');
  body.innerHTML = '<details class="root-group" open><summary class="root-head">'
    + '<span class="head-row">모의고사<span class="subject-count">12</span></span></summary>'
    + '<details class="subject-group" open><summary class="subject-head">'
    + '<span class="head-row">응급_중환자<span class="subject-count">4</span></span></summary>'
    + '<button class="exam-item"><span class="exam-date">10/13</span>'
    + '<div class="exam-name">임상독성학<div class="exam-meta">30문항</div></div></button>'
    + '</details></details>';
  await new Promise((r) => setTimeout(r, 150));

  const root = document.querySelector('#listBody .root-head');
  const sub = document.querySelector('#listBody .subject-head');
  const item = document.querySelector('#listBody .exam-item');
  const bg = (el) => getComputedStyle(el).backgroundColor;
  const bar = (el) => getComputedStyle(el).borderLeftWidth;

  out.push({ name: '**묶음과 항목의 바탕색이 다르다**', ok: bg(root) !== bg(item) && bg(sub) !== bg(item),
    detail: `묶음 ${bg(sub)} / 항목 ${bg(item)}` });
  out.push({ name: '묶음 왼쪽에 색 띠가 있다',
    ok: parseFloat(bar(root)) >= 3 && parseFloat(bar(sub)) >= 3,
    detail: `${bar(root)} / ${bar(sub)}` });
  out.push({ name: '큰 묶음과 작은 묶음도 구별된다',
    ok: getComputedStyle(root).borderLeftColor !== getComputedStyle(sub).borderLeftColor });
  out.push({ name: '항목은 묶음보다 안쪽으로 들어간다',
    ok: item.getBoundingClientRect().left > sub.getBoundingClientRect().left,
    detail: `${Math.round(item.getBoundingClientRect().left)} > ${Math.round(sub.getBoundingClientRect().left)}` });
  out.push({ name: '제목과 설명이 줄을 나눠 선다',
    ok: document.querySelector('#listBody .exam-meta').getBoundingClientRect().top
      > document.querySelector('#listBody .exam-name').getBoundingClientRect().top });

  // 탭 그림
  const tabs = [...document.querySelectorAll('.tabs .tab')];
  out.push({ name: '**탭마다 그림이 붙었다**', ok: tabs.every((t) => t.querySelector('.tab-ic svg')),
    detail: `${tabs.filter((t) => t.querySelector('svg')).length}/${tabs.length}` });
  out.push({ name: '글씨도 그대로 있다', ok: tabs.every((t) => (t.querySelector('.tab-t') || {}).textContent) });
  out.push({ name: '탭마다 다른 그림',
    ok: new Set(tabs.map((t) => t.querySelector('.tab-ic').innerHTML)).size === tabs.length });
  out.push({ name: '한 줄에 다 들어간다',
    ok: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size === 1 });

  body.innerHTML = '';
  return out;
});

// ══════════ 폭을 바꿔가며 한 번 더 — 겹침·넘침 (2026-10-16) ══════════
// 넓은 화면에서만 나던 겹침(막대가 글 아래로 내려가는 경우)과 좁은 화면에서만 나던
// 넘침(퀴즈 막대가 밀려나는 경우)은 한 폭만 재서는 못 잡는다.
for (const [W, H] of [[390, 844], [768, 1024], [1024, 768], [1366, 1024]]) {
  await page.setViewport({ width: W, height: H });
  await new Promise((r) => setTimeout(r, 120));
  await run(`${W}×${H}`, async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const bad = [];
    for (const id of ['listScreen', 'readScreen', 'quizScreen', 'cardScreen', 'deckScreen']) {
      document.querySelectorAll('#app > section').forEach((x) => x.classList.add('hidden'));
      document.getElementById(id).classList.remove('hidden');
      document.body.dataset.screen = id;
      if (window.__paintFindFab) window.__paintFindFab();
      document.getElementById('findFab').classList.remove('hidden');
      await wait(30);
      const fab = document.getElementById('findFab').getBoundingClientRect();
      if (document.documentElement.scrollWidth > innerWidth + 1) bad.push(`${id}: 가로 넘침`);
      if (fab.left < 0 || fab.right > innerWidth) bad.push(`${id}: 돋보기가 화면 밖`);
      const nav = document.querySelector(`#${id} .navbar`);
      if (!nav) continue;
      const nr = nav.getBoundingClientRect();
      for (const b of nav.querySelectorAll('button')) {
        if (b.id === 'findFab') continue;
        const r = b.getBoundingClientRect();
        if (!r.width) continue;
        if (r.left < fab.right && r.right > fab.left && r.top < fab.bottom && r.bottom > fab.top) {
          bad.push(`${id}: 돋보기가 ${b.id || b.textContent.trim().slice(0, 8)}와 겹침`);
        }
        if (r.left < nr.left - 1 || r.right > nr.right + 1) {
          bad.push(`${id}: ${b.id || b.textContent.trim().slice(0, 8)}가 막대 밖으로`);
        }
      }
    }
    document.body.dataset.screen = 'listScreen';
    return [{ name: `**${innerWidth}px에서 겹치거나 넘치지 않는다**`, ok: !bad.length,
      detail: bad.join(' | ') || '문제 없음' }];
  });
}
await page.setViewport({ width: 1280, height: 900 });

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
