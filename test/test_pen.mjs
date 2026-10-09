// pen.js 테스트 — 모드 전환 없는 새 상호작용(탭 / 네모 영역 선택)을 검증.
// 선택은 획을 다 그은 뒤 SETTLE_MS 뒤에 확정되므로 테스트도 기다린다(끊어 그어도 한 번으로 묶임).
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

// ---- DOM/Canvas 스텁 ----
const R = (l, t, w, h) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h });
function mkEl(cls = '', text = '', box = R(0, 0, 10, 10)) {
  const el = {
    className: cls, textContent: text, style: {}, dataset: {}, _children: [],
    _cls: new Set(cls.split(' ').filter(Boolean)), _ev: {},
    classList: {
      add: (...c) => c.forEach((x) => el._cls.add(x)),
      remove: (...c) => c.forEach((x) => el._cls.delete(x)),
      toggle: (c, f) => { f === undefined ? (el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c)) : (f ? el._cls.add(c) : el._cls.delete(c)); },
      contains: (c) => el._cls.has(c),
    },
    appendChild(c) { el._children.push(c); return c; },
    remove() {}, focus() {},
    addEventListener(t, fn) { el._ev[t] = fn; },
    setPointerCapture() {},
    getBoundingClientRect: () => box,
    querySelectorAll: (sel) => (el._query ? el._query(sel) : []),
    querySelector: (sel) => (el._query ? el._query(sel)[0] : undefined),
    getContext: () => ({
      setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {},
      moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
      strokeRect() {}, fillRect() {},
    }),
    toDataURL: () => 'data:image/png;base64,FAKE',
    set innerHTML(v) { el._html = v; el._children = []; }, get innerHTML() { return el._html || ''; },
  };
  return el;
}
global.ResizeObserver = class { observe() {} disconnect() {} };
global.window = { devicePixelRatio: 2 };
let elementAt = null;
global.document = {
  createElement: () => mkEl(),
  createDocumentFragment: () => { const f = mkEl(); f.isFrag = true; return f; },
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  elementFromPoint: () => elementAt,
};

const { PenLayer, tokenize, classify } = await import(pathToFileURL(`${PWA}/js/pen.js`).href);

// ---- classify: 획 모양 판별 ----
const line = (x1, y1, x2, y2, n = 10) =>
  Array.from({ length: n }, (_, i) => ({ x: x1 + (x2 - x1) * i / (n - 1), y: y1 + (y2 - y1) * i / (n - 1), p: .5 }));
ok('짧은 점 → tap', classify([{ x: 10, y: 10, p: .5 }, { x: 13, y: 12, p: .5 }]) === 'tap');
ok('긴 획 → stroke', classify(line(10, 50, 200, 52)) === 'stroke');
ok('세로 획도 stroke', classify(line(50, 10, 55, 160)) === 'stroke');

// ---- tokenize ----
const te = mkEl();
tokenize(te, '급성 심근경색 환자');
const toks = te._children[0]._children.filter((c) => c.className === 'tok');
ok('tokenize 단어 수', toks.length === 3);

// ---- PenLayer: 손가락은 통과, 펜만 처리 ----
const host = mkEl('split', '', R(0, 0, 400, 300));
let selected = null, tapped = null;
const pen = new PenLayer(host, {
  onSelect: (t) => { selected = t; },
  onTap: (el) => { tapped = el; return true; },
});
const ev = (x, y, type = 'pen') => ({
  pointerType: type, clientX: x, clientY: y, pressure: .5, pointerId: 1,
  preventDefault() {}, getCoalescedEvents: null,
});
const settle = () => new Promise((r) => setTimeout(r, 520));   // SETTLE_MS(420) 이후
/** 한 획 긋기 */
function draw(x1, y1, x2, y2, n = 8) {
  pen._down(ev(x1, y1));
  line(x1, y1, x2, y2, n).slice(1).forEach((p) => pen._move(ev(p.x, p.y)));
  pen._up(ev(x2, y2));
}

pen._down(ev(10, 10, 'touch')); pen._move(ev(80, 12, 'touch')); pen._up(ev(80, 12, 'touch'));
ok('손가락은 획을 안 남김(통과)', pen.strokes.length === 0);
ok('손가락은 선택도 안 함', selected === null);

// ---- 밑줄 → 줄 통째로 ----
// 1줄: "65세 남자가 쓰러졌다" (y 50~70), 2줄: "맥박이 없다" (y 80~100)
function word(text, l, t, w = 40, h = 20) {
  const e = mkEl('tok', text, R(l, t, w, h));
  e._cls = new Set(['tok']);
  return e;
}
const L1 = [word('65세', 10, 50), word('남자가', 55, 50), word('쓰러졌다', 100, 50)];
const L2 = [word('맥박이', 10, 80), word('없다', 55, 80)];
host._query = (sel) => (sel === '.tok' ? [...L1, ...L2] : []);

// 밑줄 긋듯 한 줄 아래를 지나가기
selected = null;
draw(20, 72, 130, 73);
await settle();
ok('밑줄: 그 줄 전체', selected === '65세 남자가 쓰러졌다', `"${selected}"`);
ok('선택 궤적은 획으로 안 남음', pen.strokes.length === 0, `${pen.strokes.length}`);

// 일부만 (65세 x10~50, 남자가 x55~95, 쓰러졌다 x100~140)
selected = null;
draw(12, 72, 44, 72, 6);     // '남자가'(x55~)에 닿지 않게
await settle();
ok('일부만 걸치면 그 단어만', selected === '65세', `"${selected}"`);

selected = null;
draw(12, 72, 92, 72);
await settle();
ok('두 단어에 걸치면 둘 다', selected === '65세 남자가', `"${selected}"`);

// ★ 끊어 그어도 하나로 묶인다 — 이게 이번 변경의 핵심(밑줄이 잘 끊기던 문제)
selected = null;
draw(12, 72, 48, 72, 4);    // 첫 조각
draw(52, 72, 92, 73, 4);    // 끊겼다가 이어서
await settle();
ok('끊어 그어도 한 번의 선택으로', selected === '65세 남자가', `"${selected}"`);

// 네모로 두 줄 감싸기(캡처하듯)
selected = null;
draw(5, 45, 150, 45, 4);
draw(150, 45, 150, 105, 4);
draw(150, 105, 5, 105, 4);
draw(5, 105, 5, 45, 4);
await settle();
ok('네모: 감싼 두 줄 모두', selected === '65세 남자가 쓰러졌다 맥박이 없다', `"${selected}"`);

// 대충 그은 네모(닫히지 않아도)
selected = null;
draw(5, 46, 148, 48, 4);
draw(148, 48, 146, 102, 4);
draw(146, 102, 8, 100, 4);
await settle();
ok('안 닫힌 네모도 동작', selected === '65세 남자가 쓰러졌다 맥박이 없다', `"${selected}"`);

// ---- 펜 탭 → 선지 선택 ----
tapped = null;
elementAt = mkEl('badge');
pen._down(ev(200, 200)); pen._up(ev(202, 201));
ok('펜 탭 → onTap 호출', tapped === elementAt);
ok('탭은 획으로 안 남음', pen.strokes.length === 0);

// ---- 글자 없는 곳에 그으면 필기로 남는다 ----
host._query = () => [];
draw(300, 250, 340, 258, 6);
await settle();
ok('글자 없는 곳은 필기로 남음', pen.strokes.length === 1, `${pen.strokes.length}`);
pen.undo();
ok('undo', pen.strokes.length === 0);

// 10px 미만은 탭으로 처리된다(획이 안 남음)
tapped = null; elementAt = mkEl('nothing');
draw(300, 250, 306, 253, 3);
ok('아주 짧은 획은 탭', tapped === elementAt && pen.strokes.length === 0);

// 탭보다 크지만 BOX_MIN(18) 미만이면 선택이 아니라 필기로 남는다
draw(300, 250, 314, 256, 4);
await settle();
ok('작은 끄적임은 필기로 남음', pen.strokes.length === 1, `${pen.strokes.length}`);
pen.clear();

// ---- 지우개 ----
draw(100, 200, 140, 200, 5);
await settle();
ok('지우개 전 1획', pen.strokes.length === 1);
pen.setErasing(true);
pen._down(ev(110, 200)); pen._up(ev(110, 200));
ok('지우개로 삭제', pen.strokes.length === 0);
pen.setErasing(false);

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
