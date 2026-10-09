// 애플펜슬 상호작용 — 모드 전환 없이, 그린 모양으로 의도를 판단한다.
//
// 설계가 바뀐 이유(2026-10-09 사용자 피드백):
//   - 모드 토글(터치/펜/올가미)이 번거로웠다. Apple Pencil 사이드버튼은 WebKit이 웹에
//     노출하지 않아(UIPencilInteraction은 네이티브 전용) 그걸로 전환할 수도 없다.
//   - 동그라미로 "단어 하나"를 집는 건 쓸모가 적었다. 실제로는 문장·구절을 통째로
//     긁어서 질문하고 싶어 한다.
//
// 그래서 이렇게 바꿨다:
//   · 펜으로 **선지 번호(①②…)를 탭** → 답 선택
//   · 펜으로 **밑줄 긋듯 쓱** → 그 줄(들)의 텍스트를 통째로 선택
//   · 펜으로 **둥글게 둘러싸기** → 그 영역에 걸린 줄들을 선택(올가미도 남겨둠)
//   · **손가락은 항상** 스크롤·탭 — 펜과 동시에 쓸 수 있어 모드 개념이 사라진다
//
// 구분 기준: 획의 가로폭 ÷ 세로높이(aspect). 3 이상이면 밑줄, 아니면 올가미.
// 아주 짧은 획은 탭으로 본다.

const TAP_MAX_DIST = 10;     // 이 이하로 움직이면 탭
const UNDERLINE_ASPECT = 3;  // 가로가 세로의 3배 이상이면 밑줄로 간주
const LINE_TOL = 14;         // 같은 줄로 묶는 세로 허용 오차(px)

export class PenLayer {
  /**
   * @param {HTMLElement} host  캔버스를 덮을 영역
   * @param {object} opts
   * @param {Function} opts.onSelect (text, info) => void  텍스트를 긁었을 때
   * @param {Function} opts.onTap    (el, e) => boolean    펜으로 탭했을 때(true면 소비)
   * @param {Function} opts.onChange ()=>void              획 변화(저장용)
   */
  constructor(host, { onSelect, onTap, onChange } = {}) {
    this.host = host;
    this.onSelect = onSelect || (() => {});
    this.onTap = onTap || (() => false);
    this.onChange = onChange || (() => {});

    this.erasing = false;        // 지우개 버튼을 켠 상태
    this.color = '#2563eb';
    this.width = 2.6;
    this.strokes = [];
    this._cur = null;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'penlayer';
    this.ctx = this.canvas.getContext('2d');
    host.appendChild(this.canvas);

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(host);
    this.resize();

    // 캔버스는 **펜 이벤트만** 받는다. 손가락은 아래 UI로 그대로 통과시킨다
    // (CSS: .penlayer { pointer-events: none } + 아래 host 리스너로 펜만 가로챔).
    host.addEventListener('pointerdown', (e) => this._down(e), { passive: false });
    host.addEventListener('pointermove', (e) => this._move(e), { passive: false });
    host.addEventListener('pointerup', (e) => this._up(e));
    host.addEventListener('pointercancel', (e) => this._up(e));
  }

  /** 펜인가? (마우스는 데스크톱 개발용으로 허용) */
  _isPen(e) {
    return e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.buttons === 1 && this.mouseDraws);
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.canvas.width = Math.round(r.width * this._dpr);
    this.canvas.height = Math.round(r.height * this._dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    this.redraw();
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure > 0 ? e.pressure : 0.5 };
  }

  _down(e) {
    if (!this._isPen(e)) return;          // 손가락은 통과 → 평소대로 스크롤·탭
    e.preventDefault();
    try { this.host.setPointerCapture(e.pointerId); } catch {}
    const pt = this._pos(e);
    this._start = { x: e.clientX, y: e.clientY };
    if (this.erasing) { this._eraseAt(pt); this._isErasing = true; return; }
    this._cur = { color: this.color, width: this.width, pts: [pt], t0: Date.now() };
  }

  _move(e) {
    if (!this._isPen(e)) return;
    if (this._isErasing) { this._eraseAt(this._pos(e)); return; }
    if (!this._cur) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) this._cur.pts.push(this._pos(ev));
    this.redraw();
  }

  _up(e) {
    if (this._isErasing) { this._isErasing = false; this.onChange(); return; }
    if (!this._cur) return;
    const stroke = this._cur;
    this._cur = null;

    const kind = classify(stroke.pts);

    if (kind === 'tap') {
      // 펜으로 탭 — 선지 선택 등. 획으로 남기지 않는다.
      this.redraw();
      const el = document.elementFromPoint(this._start.x, this._start.y);
      this.onTap(el, e);
      return;
    }

    if (kind === 'underline' || kind === 'lasso') {
      const text = this._textUnder(stroke.pts, kind);
      this.redraw();   // 선택 궤적은 남기지 않는다
      if (text) { this.onSelect(text, { kind }); return; }
      // 글자를 못 잡았으면 그냥 필기로 취급해서 남긴다
    }

    if (stroke.pts.length > 1) { this.strokes.push(stroke); this.onChange(); }
    this.redraw();
  }

  /**
   * 획이 지나간 자리의 텍스트를 뽑는다.
   * 밑줄이면 **걸린 줄 전체**를, 올가미면 영역에 걸린 줄들을 가져온다
   * — 단어 단위가 아니라 "줄 단위 가로 확장"이라는 게 핵심이다.
   */
  _textUnder(pts, kind) {
    const r = this.canvas.getBoundingClientRect();
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const box = { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };

    // 선택 대상 토큰 모으기(화면 좌표 기준)
    const toks = [];
    this.host.querySelectorAll('.tok').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return;
      toks.push({
        el,
        l: b.left - r.left, t: b.top - r.top,
        r: b.right - r.left, b: b.bottom - r.top,
        cy: b.top + b.height / 2 - r.top,
      });
    });
    if (!toks.length) return '';

    // 세로로 겹치는 줄 찾기 — 밑줄은 획이 글자 **아래**를 지나므로 위로도 넉넉히 본다
    const yTop = kind === 'underline' ? box.t - 26 : box.t;
    const yBot = box.b + 6;

    const lines = groupLines(toks);
    const picked = [];
    for (const line of lines) {
      const overlapY = line.cy >= yTop && line.cy <= yBot;
      if (!overlapY) continue;
      if (kind === 'underline') {
        // 그 줄에서 획의 가로 범위에 걸친 부분만 — 다만 거의 다 걸쳤으면 줄 전체
        const inRange = line.toks.filter((t) => t.r >= box.l - 4 && t.l <= box.r + 4);
        const use = inRange.length >= Math.max(1, line.toks.length * 0.8) ? line.toks : inRange;
        if (use.length) picked.push(use);
      } else {
        picked.push(line.toks);
      }
    }
    if (!picked.length) return '';
    return picked
      .map((line) => line.map((t) => t.el.textContent).join(' '))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _eraseAt(pt) {
    const R = 14;
    const before = this.strokes.length;
    this.strokes = this.strokes.filter((s) => !s.pts.some((q) => Math.hypot(q.x - pt.x, q.y - pt.y) < R));
    if (this.strokes.length !== before) this.redraw();
  }

  redraw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const all = this._cur ? [...this.strokes, this._cur] : this.strokes;
    for (const s of all) this._drawStroke(s);
  }

  _drawStroke(s) {
    const { ctx } = this;
    if (s.pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1], b = s.pts[i];
      ctx.beginPath();
      ctx.lineWidth = s.width * (0.6 + b.p * 0.9);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  setErasing(on) { this.erasing = !!on; }
  clear() { this.strokes = []; this.redraw(); this.onChange(); }
  undo() { this.strokes.pop(); this.redraw(); this.onChange(); }
  get isEmpty() { return this.strokes.length === 0; }
  toPNG() { return this.strokes.length ? this.canvas.toDataURL('image/png') : null; }
  serialize() { return { strokes: this.strokes }; }
  load(data) { this.strokes = (data && data.strokes) || []; this.redraw(); }
  destroy() { this._ro.disconnect(); this.canvas.remove(); }
}

/** 획의 모양으로 의도를 판단한다. */
export function classify(pts) {
  if (pts.length < 2) return 'tap';
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const diag = Math.hypot(w, h);
  if (diag < TAP_MAX_DIST) return 'tap';
  if (h < 1) return 'underline';
  if (w / h >= UNDERLINE_ASPECT) return 'underline';
  // 시작점과 끝점이 가까우면(닫힌 모양) 올가미
  const d = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  if (d < diag * 0.45) return 'lasso';
  return 'underline';   // 애매하면 밑줄 쪽이 덜 당황스럽다
}

/** 같은 y에 있는 토큰들을 한 줄로 묶는다. */
function groupLines(toks) {
  const sorted = [...toks].sort((a, b) => a.cy - b.cy || a.l - b.l);
  const lines = [];
  for (const t of sorted) {
    const line = lines.find((L) => Math.abs(L.cy - t.cy) <= LINE_TOL);
    if (line) { line.toks.push(t); line.cy = (line.cy * (line.toks.length - 1) + t.cy) / line.toks.length; }
    else lines.push({ cy: t.cy, toks: [t] });
  }
  lines.forEach((L) => L.toks.sort((a, b) => a.l - b.l));
  return lines;
}

/** 텍스트를 단어 단위 <span class="tok">으로 감싼다(선택 hit-test 대상). */
export function tokenize(el, text) {
  el.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
    const s = document.createElement('span');
    s.className = 'tok';
    s.textContent = part;
    frag.appendChild(s);
  }
  el.appendChild(frag);
}

/** 이미 렌더된 DOM(위키·해설 등)의 텍스트 노드를 뒤늦게 토큰화한다. */
export function tokenizeTree(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || p.classList.contains('tok')) return NodeFilter.FILTER_REJECT;
      if (/^(SCRIPT|STYLE|CODE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of node.nodeValue.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
      const s = document.createElement('span');
      s.className = 'tok';
      s.textContent = part;
      frag.appendChild(s);
    }
    node.parentNode.replaceChild(frag, node);
  }
}
