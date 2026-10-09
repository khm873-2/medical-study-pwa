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
const LINE_TOL = 14;         // 같은 줄로 묶는 세로 허용 오차(px)
const BOX_MIN = 18;          // 이보다 작은 영역은 필기로 본다
// 획을 다 그은 뒤 이만큼 기다렸다가 확정한다 — 여러 번 끊어 그어도 한 번으로 묶기 위함.
// (끊길 때마다 질문이 나가면 Gemini 무료 한도 분당 10~15회를 금방 소진한다)
const SETTLE_MS = 420;

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

    // ── 입력 처리 (2026-10-09 전면 수정) ───────────────────────────────────
    // 증상: 1cm도 못 긋고 획이 죽었다.
    // 원인: `touch-action: none`을 빼둔 탓에 iOS가 **펜 드래그를 스크롤로 가로채
    //       pointercancel**을 쏴버렸다. 손가락 스크롤을 살리려다 펜을 죽인 셈.
    // 해결: iPadOS는 `Touch.touchType === 'stylus'`로 펜을 확실히 구분할 수 있다.
    //       → 터치 이벤트 단계에서 **펜일 때만** preventDefault로 스크롤을 막고,
    //         손가락은 그대로 흘려보내 스크롤·탭을 유지한다.
    //       pointercancel도 더 이상 획을 버리지 않고 **그 자리에서 확정**한다.
    this._onDown = (e) => this._down(e);
    this._onMove = (e) => this._move(e);
    this._onUp = (e) => this._up(e);
    this._onCancel = (e) => this._up(e, true);
    document.addEventListener('pointerdown', this._onDown, { passive: false });
    document.addEventListener('pointermove', this._onMove, { passive: false });
    document.addEventListener('pointerup', this._onUp);
    document.addEventListener('pointercancel', this._onCancel);

    // 펜 터치만 스크롤에서 제외 — 이게 없으면 iOS가 획을 취소한다.
    this._onTouch = (e) => {
      if (!e.touches || !e.touches.length) return;
      const stylus = [...e.touches].some((t) => t.touchType === 'stylus');
      if (stylus && this._nearTouch(e)) e.preventDefault();
    };
    for (const t of ['touchstart', 'touchmove']) {
      document.addEventListener(t, this._onTouch, { passive: false });
    }
  }

  _nearTouch(e) {
    const t = e.touches[0];
    return t ? this._nearHost({ clientX: t.clientX, clientY: t.clientY }, 160) : false;
  }

  /** 펜인가? (마우스는 데스크톱 개발용으로 허용) */
  _isPen(e) {
    return e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.buttons === 1 && this.mouseDraws);
  }

  /** 이 레이어 영역에서 pad px 이내인가? (여백에서 시작하는 획을 허용하되 무관한 화면은 거른다) */
  _nearHost(e, pad = 120) {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return e.clientX >= r.left - pad && e.clientX <= r.right + pad &&
           e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
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
    // UI 위(팝업·버튼)에서는 펜도 평범한 포인터로 동작해야 한다 —
    // 그러지 않으면 "펜으로는 팝업 버튼이 안 눌린다"(2026-10-09 피드백).
    if (e.target && e.target.closest && e.target.closest('.pen-passthrough, button, summary, input, textarea, a, .sel-btn')) return;
    // 이 레이어가 담당하는 영역 근처에서 시작한 것만 받는다(여러 화면이 동시에 떠 있을 때 혼선 방지).
    // 바깥 여백에서 시작하는 경우가 흔하므로 넉넉히 본다.
    if (!this._nearHost(e, 160)) return;
    e.preventDefault();
    e.stopPropagation();
    // 포인터를 캔버스에 묶어둔다 — 이게 있어야 손이 카드 밖으로 나가도 move가 계속 온다.
    // (문서 레벨로 받으므로 host가 아니라 canvas에 건다)
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    this._activeId = e.pointerId;
    const pt = this._pos(e);
    this._start = { x: e.clientX, y: e.clientY };
    if (this.erasing) { this._eraseAt(pt); this._isErasing = true; return; }
    this._cur = { color: this.color, width: this.width, pts: [pt], t0: Date.now() };
  }

  _move(e) {
    if (!this._isPen(e)) return;
    if (this._isErasing) { this._eraseAt(this._pos(e)); return; }
    if (!this._cur) return;
    // 그리는 중에는 다른 포인터의 move를 섞지 않는다
    if (this._activeId != null && e.pointerId !== this._activeId) return;
    e.preventDefault();
    e.stopPropagation();
    let evs = [e];
    if (e.getCoalescedEvents) {
      try { const c = e.getCoalescedEvents(); if (c && c.length) evs = c; } catch {}
    }
    for (const ev of evs) this._cur.pts.push(this._pos(ev));
    this.redraw();
  }

  /**
   * @param {boolean} cancelled pointercancel로 들어온 경우 — OS가 제스처로 가로챈 것이다.
   *        예전엔 여기서 획을 버렸는데, 그게 "1cm도 못 긋는" 증상의 일부였다.
   *        이제는 지금까지 그은 만큼을 **그대로 확정**한다.
   */
  _up(e, cancelled = false) {
    this._activeId = null;
    if (this._isErasing) { this._isErasing = false; this.onChange(); return; }
    if (!this._cur) return;
    const stroke = this._cur;
    this._cur = null;

    if (cancelled && stroke.pts.length > 2) {
      // 취소돼도 이미 충분히 그었으면 선택 후보로 넘긴다
      this._pending = this._pending || [];
      this._pending.push(stroke);
      this._showPendingBox();
      clearTimeout(this._settle);
      this._settle = setTimeout(() => this._commit(), SETTLE_MS);
      return;
    }

    if (classify(stroke.pts) === 'tap') {
      this.redraw();
      const el = document.elementFromPoint(this._start.x, this._start.y);
      this.onTap(el, e);
      return;
    }

    // 끊어 그은 획들을 하나의 선택으로 모은다 — 잠깐 기다렸다가 확정.
    this._pending = this._pending || [];
    this._pending.push(stroke);
    this._showPendingBox();

    clearTimeout(this._settle);
    this._settle = setTimeout(() => this._commit(), SETTLE_MS);
  }

  /** 지금까지 그은 획들을 감싸는 네모를 미리 보여준다(무엇이 잡힐지 알 수 있게). */
  _showPendingBox() {
    const box = boundsOf(this._pending);
    this._previewBox = box && (box.r - box.l) * (box.b - box.t) > 0 ? box : null;
    this.redraw();
  }

  /** 모아둔 획을 하나의 선택으로 확정한다. */
  _commit() {
    const pend = this._pending || [];
    this._pending = null;
    this._previewBox = null;
    if (!pend.length) return;

    const box = boundsOf(pend);
    const w = box.r - box.l, h = box.b - box.t;

    // 너무 작으면 선택 의도가 아니다 → 필기로 남긴다
    if (Math.max(w, h) < BOX_MIN) {
      pend.forEach((s) => { if (s.pts.length > 1) this.strokes.push(s); });
      this.onChange();
      this.redraw();
      return;
    }

    const text = this._textInBox(box);
    this.redraw();     // 선택 궤적은 남기지 않는다
    if (text) { this.onSelect(text, { box }); return; }

    // 글자를 못 잡았으면 필기로 취급
    pend.forEach((s) => { if (s.pts.length > 1) this.strokes.push(s); });
    this.onChange();
    this.redraw();
  }

  /**
   * 네모(캡처하듯 둘러싼 영역) 안의 텍스트를 뽑는다.
   *
   * 밑줄 방식은 획이 자주 끊겨서(선이 조금만 떨어져도 다른 획으로 잡힘) 쓰기 불편했다.
   * 그래서 "획들을 감싸는 사각형"으로 바꿨다 — 대충 네모를 그리든, 밑줄을 긋든,
   * 몇 번에 나눠 긋든 결국 그 바운딩 박스에 걸린 글자를 가져온다.
   *
   * 줄 단위로 확장하는 건 유지한다: 박스에 **절반 이상 걸친 줄**은 그 줄에서
   * 가로로 걸친 부분을 통째로(거의 다 걸쳤으면 줄 전체) 가져온다.
   */
  _textInBox(box) {
    const r = this.canvas.getBoundingClientRect();
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

    // 아래로 밑줄 긋듯 그은 경우도 잡히도록 위쪽으로 한 줄 높이만큼 더 본다
    const yTop = box.t - 24;
    const yBot = box.b + 8;

    const picked = [];
    for (const line of groupLines(toks)) {
      if (line.cy < yTop || line.cy > yBot) continue;
      const inRange = line.toks.filter((t) => t.r >= box.l - 6 && t.l <= box.r + 6);
      if (!inRange.length) continue;
      // 그 줄을 거의 다 덮었으면 줄 전체를 준다(의도가 "이 줄"일 가능성이 높다)
      const use = inRange.length >= Math.max(1, line.toks.length * 0.8) ? line.toks : inRange;
      picked.push(use);
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
    const all = [...this.strokes, ...(this._pending || [])];
    if (this._cur) all.push(this._cur);
    for (const s of all) this._drawStroke(s);
    if (this._previewBox) this._drawBox(this._previewBox);
  }

  /** 지금 잡히는 범위를 네모로 미리 보여준다. */
  _drawBox(b) {
    const { ctx } = this;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.l - 4, b.t - 4, b.r - b.l + 8, b.b - b.t + 8);
    ctx.fillStyle = 'rgba(245,158,11,.10)';
    ctx.fillRect(b.l - 4, b.t - 4, b.r - b.l + 8, b.b - b.t + 8);
    ctx.restore();
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
  destroy() {
    this._ro.disconnect();
    clearTimeout(this._settle);
    document.removeEventListener('pointerdown', this._onDown);
    document.removeEventListener('pointermove', this._onMove);
    document.removeEventListener('pointerup', this._onUp);
    document.removeEventListener('pointercancel', this._onCancel);
    for (const t of ['touchstart', 'touchmove']) document.removeEventListener(t, this._onTouch);
    this.canvas.remove();
  }
}

/** 탭인지 선택/필기인지만 구분한다(모양별 분기는 네모 방식으로 통일되며 사라졌다). */
export function classify(pts) {
  if (pts.length < 2) return 'tap';
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return diag < TAP_MAX_DIST ? 'tap' : 'stroke';
}

/** 획 묶음을 감싸는 사각형. */
export function boundsOf(strokes) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const s of strokes) {
    for (const p of s.pts) {
      if (p.x < l) l = p.x;
      if (p.x > r) r = p.x;
      if (p.y < t) t = p.y;
      if (p.y > b) b = p.y;
    }
  }
  return Number.isFinite(l) ? { l, t, r, b } : null;
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
