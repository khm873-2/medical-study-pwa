// pen.js 테스트 — 캔버스/DOM을 스텁으로 두고 팜 리젝션·올가미 판정·스트로크 관리를 검증.
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

// ---- DOM/Canvas 스텁 ----
function rect(l, t, w, h) { return { left: l, top: t, width: w, height: h, right: l + w, bottom: t + h }; }
function mkEl(cls = '', text = '', box = rect(0, 0, 10, 10)) {
  const el = {
    className: cls, textContent: text, style: {}, dataset: {}, _children: [], _cls: new Set(cls.split(' ').filter(Boolean)),
    classList: { add: (...c) => c.forEach(x => el._cls.add(x)), remove: (...c) => c.forEach(x => el._cls.delete(x)),
                 toggle: (c, f) => { f === undefined ? (el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c)) : (f ? el._cls.add(c) : el._cls.delete(c)); },
                 contains: c => el._cls.has(c) },
    appendChild(c) { el._children.push(c); return c; },
    remove() {}, addEventListener(t, fn) { (el._ev ||= {})[t] = fn; },
    setPointerCapture() {}, getBoundingClientRect: () => box,
    querySelectorAll: (sel) => el._query ? el._query(sel) : [],
    querySelector: (sel) => (el._query ? el._query(sel)[0] : undefined),
    getContext: () => ctxStub(),
    toDataURL: () => 'data:image/png;base64,FAKE',
    set innerHTML(v) { el._html = v; el._children = []; }, get innerHTML() { return el._html || ''; },
  };
  return el;
}
function ctxStub() {
  return { setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {},
           lineTo() {}, stroke() {}, setLineDash() {}, strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '' };
}
global.ResizeObserver = class { observe() {} disconnect() {} };
global.window = { devicePixelRatio: 2 };
global.requestAnimationFrame = (f) => f();
const createdEls = [];
global.document = {
  createElement: (t) => { const e = mkEl(); e.tag = t; createdEls.push(e); return e; },
  createDocumentFragment: () => { const f = mkEl(); f.isFrag = true; return f; },
  createTextNode: (t) => ({ text: t }),
};

const { PenLayer, tokenize } = await import(pathToFileURL(`${PWA}/js/pen.js`).href);

// ---- tokenize ----
const el = mkEl();
tokenize(el, '급성 심근경색 환자');
const toks = el._children[0]._children.filter((c) => c.className === 'tok');
ok('tokenize: 단어 수', toks.length === 3, `${toks.length}`);
ok('tokenize: 내용 보존', toks.map((t) => t.textContent).join(' ') === '급성 심근경색 환자');

// ---- PenLayer 기본 ----
const host = mkEl('card', '', rect(0, 0, 400, 300));
let lassoResult = 'NONE';
const pen = new PenLayer(host, { onLasso: (t) => { lassoResult = t; }, onChange: () => {} });

ok('기본 모드는 터치', pen.mode === 'touch');
ok('터치 모드: 캔버스가 이벤트 안 받음', pen.canvas.style.pointerEvents === 'none');
pen.setMode('pen');
ok('펜 모드: 캔버스가 이벤트 받음', pen.canvas.style.pointerEvents === 'auto');
ok('펜 모드: touch-action none', pen.canvas.style.touchAction === 'none');

// ---- 팜 리젝션 ----
const ev = (type, x, y, pointerType) => ({
  pointerType, clientX: x, clientY: y, pressure: 0.5, pointerId: 1,
  preventDefault() {}, getCoalescedEvents: null,
});
pen.setMode('pen');
pen._down(ev('down', 10, 10, 'touch'));    // 손바닥
pen._move(ev('move', 50, 50, 'touch'));
pen._up(ev('up', 50, 50, 'touch'));
ok('팜 리젝션: 손가락은 안 그려짐', pen.strokes.length === 0, `${pen.strokes.length}획`);

pen._down(ev('down', 10, 10, 'pen'));      // 애플펜슬
pen._move(ev('move', 50, 50, 'pen'));
pen._up(ev('up', 50, 50, 'pen'));
ok('펜은 그려짐', pen.strokes.length === 1, `${pen.strokes.length}획`);

pen.setMode('touch');
pen._down(ev('down', 10, 10, 'pen'));
pen._up(ev('up', 10, 10, 'pen'));
ok('터치 모드에선 펜도 안 그려짐', pen.strokes.length === 1);

// ---- undo / clear / 직렬화 ----
pen.setMode('pen');
pen._down(ev('d', 0, 0, 'pen')); pen._move(ev('m', 20, 20, 'pen')); pen._up(ev('u', 20, 20, 'pen'));
ok('획 추가됨', pen.strokes.length === 2);
pen.undo();
ok('undo', pen.strokes.length === 1);
const ser = pen.serialize();
ok('serialize', Array.isArray(ser.strokes) && ser.strokes.length === 1);
ok('toPNG(획 있을 때)', typeof pen.toPNG() === 'string');
pen.clear();
ok('clear', pen.strokes.length === 0 && pen.isEmpty);
ok('toPNG(획 없을 때 null)', pen.toPNG() === null);
pen.load(ser);
ok('load 복원', pen.strokes.length === 1);

// ---- 올가미 hit-test ----
// 단어 3개를 가로로 배치: A(10~40), B(60~90), C(110~140), 모두 y=50~70
const words = [
  { ...mkEl('tok', 'Torsade', rect(10, 50, 30, 20)), _cls: new Set(['tok']) },
  { ...mkEl('tok', 'de', rect(60, 50, 30, 20)), _cls: new Set(['tok']) },
  { ...mkEl('tok', 'Pointes', rect(110, 50, 30, 20)), _cls: new Set(['tok']) },
];
words.forEach((w) => { w.getBoundingClientRect = ((b) => () => b)(w.getBoundingClientRect()); });
host._query = (sel) => (sel === '.tok' ? words : []);

// 앞 두 단어만 감싸는 사각 궤적 (x 0~100, y 40~80)
pen.setMode('lasso');
const loop = [[0,40],[100,40],[100,80],[0,80],[0,40]];
pen._down(ev('d', loop[0][0], loop[0][1], 'pen'));
loop.slice(1).forEach(([x,y]) => pen._move(ev('m', x, y, 'pen')));
pen._up(ev('u', 0, 40, 'pen'));
ok('올가미: 안쪽 단어만 추출', lassoResult === 'Torsade de', `"${lassoResult}"`);
ok('올가미 궤적은 획으로 안 남음', pen.strokes.length === 1, `${pen.strokes.length}`);

// 전부 감싸기
lassoResult = 'NONE';
pen._down(ev('d', 0, 40, 'pen'));
[[200,40],[200,80],[0,80],[0,40]].forEach(([x,y]) => pen._move(ev('m', x, y, 'pen')));
pen._up(ev('u', 0, 40, 'pen'));
ok('올가미: 전체 추출', lassoResult === 'Torsade de Pointes', `"${lassoResult}"`);

// 아무것도 안 걸림
lassoResult = 'NONE';
pen._down(ev('d', 300, 200, 'pen'));
[[340,200],[340,240],[300,240],[300,200]].forEach(([x,y]) => pen._move(ev('m', x, y, 'pen')));
pen._up(ev('u', 300, 200, 'pen'));
ok('올가미: 빈 영역이면 빈 문자열', lassoResult === '', `"${lassoResult}"`);

// ---- 지우개 ----
pen.setMode('pen');
pen.clear();
pen._down(ev('d', 100, 100, 'pen')); pen._move(ev('m', 120, 100, 'pen')); pen._up(ev('u', 120, 100, 'pen'));
ok('지우개 전 1획', pen.strokes.length === 1);
pen.setMode('erase');
pen._down(ev('d', 105, 100, 'pen'));
pen._up(ev('u', 105, 100, 'pen'));
ok('지우개: 근처 획 삭제', pen.strokes.length === 0, `${pen.strokes.length}`);

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
