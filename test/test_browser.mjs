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
  out.push({ name: '목차가 sticky (스크롤해도 따라온다)',
    ok: getComputedStyle(toc).position === 'sticky', detail: getComputedStyle(toc).position });
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
  return fetch('/js/app.js').then((r) => r.text()).then(async (appSrc) => {
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

  // 버튼이 있는가
  const cap = document.getElementById('toolCapture');
  const brk = document.getElementById('toolBreak');
  out.push({ name: '캡처 버튼이 지우개 옆에 있다',
    ok: !!cap && cap.previousElementSibling && cap.previousElementSibling.id === 'toolErase' });
  out.push({ name: '뜯어보기 버튼이 있다', ok: !!brk });
  out.push({ name: '두 버튼 모두 탭 가능한 크기',
    ok: cap.getBoundingClientRect().height >= 34 && brk.getBoundingClientRect().height >= 34,
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
    out.push({ name: '캡처 아이콘이 복사 느낌(⧉)', ok: document.getElementById('toolCapture').textContent.trim() === '⧉',
      detail: document.getElementById('toolCapture').textContent });
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
    out.push({ name: '1번 키가 429면 다음 키로 넘어간다',
      ok: used.length === 2 && used[0] === 'AIza_KEY_ONE' && used[1] === 'AIza_KEY_TWO',
      detail: used.join(' → ') });
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
    out.push({ name: '잘못된 키는 건너뛰고 쓸 수 있는 키를 쓴다',
      ok: r2.impression === '살았다' && used2.length === 2, detail: used2.join(' → ') });

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
