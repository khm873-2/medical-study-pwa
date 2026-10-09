// pen.js 테스트 — 모드 전환 없는 새 상호작용(탭/밑줄/올가미 자동 판별)을 검증.
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
ok('가로로 긴 획 → underline', classify(line(10, 50, 200, 52)) === 'underline', classify(line(10, 50, 200, 52)));
ok('완만한 밑줄도 underline', classify(line(10, 50, 160, 60)) === 'underline');
// 닫힌 원
const circle = Array.from({ length: 24 }, (_, i) => {
  const a = (i / 23) * Math.PI * 2;
  return { x: 100 + Math.cos(a) * 40, y: 100 + Math.sin(a) * 40, p: .5 };
});
ok('닫힌 원 → lasso', classify(circle) === 'lasso', classify(circle));
ok('세로로 긴 획 → underline(기본값)', classify(line(50, 10, 55, 160)) === 'underline');

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

selected = null;
pen._down(ev(20, 72)); line(20, 72, 130, 73, 8).slice(1).forEach((p) => pen._move(ev(p.x, p.y))); pen._up(ev(130, 73));
ok('밑줄: 그 줄 전체를 가져옴', selected === '65세 남자가 쓰러졌다', `"${selected}"`);
ok('밑줄 궤적은 획으로 안 남음', pen.strokes.length === 0, `${pen.strokes.length}`);

// 일부만 그으면 가로로 걸친 단어만 (65세 x10~50, 남자가 x55~95, 쓰러졌다 x100~140)
selected = null;
pen._down(ev(12, 72)); line(12, 72, 50, 72, 6).slice(1).forEach((p) => pen._move(ev(p.x, p.y))); pen._up(ev(50, 72));
ok('밑줄 일부: 첫 단어만', selected === '65세', `"${selected}"`);

selected = null;
pen._down(ev(12, 72)); line(12, 72, 92, 72, 8).slice(1).forEach((p) => pen._move(ev(p.x, p.y))); pen._up(ev(92, 72));
ok('밑줄 일부: 걸친 두 단어', selected === '65세 남자가', `"${selected}"`);

// 두 줄에 걸친 올가미
selected = null;
const box2 = [[5,45],[150,45],[150,105],[5,105],[5,45]];
pen._down(ev(box2[0][0], box2[0][1]));
box2.slice(1).forEach(([x, y]) => pen._move(ev(x, y)));
pen._up(ev(5, 45));
ok('올가미: 두 줄 모두', selected === '65세 남자가 쓰러졌다 맥박이 없다', `"${selected}"`);

// ---- 펜 탭 → 선지 선택 ----
tapped = null;
elementAt = mkEl('badge');
pen._down(ev(200, 200)); pen._up(ev(202, 201));
ok('펜 탭 → onTap 호출', tapped === elementAt);
ok('탭은 획으로 안 남음', pen.strokes.length === 0);

// ---- 필기는 남는다 ----
host._query = () => [];     // 글자 없는 영역
pen._down(ev(300, 250)); line(300, 250, 330, 256, 6).slice(1).forEach((p) => pen._move(ev(p.x, p.y))); pen._up(ev(330, 256));
ok('글자 없는 곳의 획은 필기로 남음', pen.strokes.length === 1, `${pen.strokes.length}`);
pen.undo();
ok('undo', pen.strokes.length === 0);

// ---- 지우개 ----
pen._down(ev(100, 200)); line(100, 200, 140, 200, 5).slice(1).forEach((p) => pen._move(ev(p.x, p.y))); pen._up(ev(140, 200));
ok('지우개 전 1획', pen.strokes.length === 1);
pen.setErasing(true);
pen._down(ev(110, 200)); pen._up(ev(110, 200));
ok('지우개로 삭제', pen.strokes.length === 0);
pen.setErasing(false);

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
