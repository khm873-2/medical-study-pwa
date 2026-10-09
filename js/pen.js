// 애플펜슬 필기 레이어 + 올가미(동그라미) 선택.
//
// 핵심 결정:
//  - **팜 리젝션**: 펜 모드일 때 `pointerType !== 'pen'` 이벤트를 전부 무시한다. 손바닥은
//    touch로 들어오므로, 하드웨어 팜 감지 없이 이 필터만으로 사실상 해결된다.
//  - **터치 모드**: 캔버스를 `pointer-events:none`으로 꺼서 터치가 그대로 아래 UI(선지
//    선택·스크롤)로 전달되게 한다. 두 모드를 문항마다 자유롭게 토글한다.
//  - **올가미**: 그린 궤적의 점들로 폴리곤을 만들고, 지문·선지 단어 span의 중심이 그 안에
//    들어가는지 판정(ray casting)한다. 완전히 닫힌 원이 아니어도 동작한다.
//  - 스트로크는 벡터(좌표+압력)로 들고 있다가 저장할 때만 PNG로 굽는다.

export class PenLayer {
  /**
   * @param {HTMLElement} host  캔버스를 덮을 대상(문제 카드)
   * @param {object} opts
   * @param {Function} opts.onLasso  (text, rect) => void  올가미로 글자를 긁었을 때
   * @param {Function} opts.onChange ()=>void              획이 바뀔 때마다(저장 표시용)
   */
  constructor(host, { onLasso, onChange } = {}) {
    this.host = host;
    this.onLasso = onLasso || (() => {});
    this.onChange = onChange || (() => {});

    this.mode = 'touch';          // 'touch' | 'pen' | 'lasso' | 'erase'
    this.color = '#2563eb';
    this.width = 2.6;
    this.strokes = [];            // [{color,width,pts:[{x,y,p}]}]
    this._cur = null;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'penlayer';
    this.ctx = this.canvas.getContext('2d');
    host.appendChild(this.canvas);

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(host);
    this.resize();

    this.canvas.addEventListener('pointerdown', (e) => this._down(e));
    this.canvas.addEventListener('pointermove', (e) => this._move(e));
    this.canvas.addEventListener('pointerup', (e) => this._up(e));
    this.canvas.addEventListener('pointercancel', (e) => this._up(e));
    this.canvas.addEventListener('pointerleave', (e) => this._up(e));

    this.setMode('touch');
  }

  setMode(m) {
    this.mode = m;
    const drawing = m !== 'touch';
    // 터치 모드에선 캔버스가 이벤트를 아예 안 받게 해서 아래 UI가 정상 동작하게 한다.
    this.canvas.style.pointerEvents = drawing ? 'auto' : 'none';
    this.canvas.style.touchAction = drawing ? 'none' : 'auto';
    this.canvas.classList.toggle('lasso-mode', m === 'lasso');
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

  /** 펜 모드에선 펜만 받는다 = 팜 리젝션. */
  _accepts(e) {
    if (this.mode === 'touch') return false;
    // 애플펜슬은 'pen'. 마우스는 개발용으로 허용.
    return e.pointerType === 'pen' || e.pointerType === 'mouse';
  }

  _down(e) {
    if (!this._accepts(e)) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const pt = this._pos(e);
    if (this.mode === 'erase') { this._eraseAt(pt); this._erasing = true; return; }
    this._cur = {
      color: this.mode === 'lasso' ? '#f59e0b' : this.color,
      width: this.mode === 'lasso' ? 2 : this.width,
      lasso: this.mode === 'lasso',
      pts: [pt],
    };
  }

  _move(e) {
    if (!this._accepts(e)) return;
    if (this._erasing) { this._eraseAt(this._pos(e)); return; }
    if (!this._cur) return;
    e.preventDefault();
    // 고주파 좌표를 받을 수 있으면 받아서 선을 매끄럽게 한다(미지원 시 그냥 현재 점).
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) this._cur.pts.push(this._pos(ev));
    this.redraw();
  }

  _up(e) {
    if (this._erasing) { this._erasing = false; this.onChange(); return; }
    if (!this._cur) return;
    const done = this._cur;
    this._cur = null;
    if (done.lasso) {
      this.redraw();                 // 올가미 궤적은 남기지 않는다
      this._finishLasso(done.pts);
      return;
    }
    if (done.pts.length > 1) { this.strokes.push(done); this.onChange(); }
    this.redraw();
  }

  _eraseAt(pt) {
    const R = 14;
    const before = this.strokes.length;
    this.strokes = this.strokes.filter(
      (s) => !s.pts.some((q) => Math.hypot(q.x - pt.x, q.y - pt.y) < R)
    );
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
    if (s.lasso) ctx.setLineDash([6, 5]);
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1], b = s.pts[i];
      ctx.beginPath();
      ctx.lineWidth = s.width * (0.6 + b.p * 0.9); // 필압
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 올가미 안에 들어온 단어 span들을 모아 문자열로 돌려준다. */
  _finishLasso(pts) {
    if (pts.length < 4) return;
    const r = this.canvas.getBoundingClientRect();
    const poly = pts.map((p) => [p.x, p.y]);
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const box = { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };

    const picked = [];
    this.host.querySelectorAll('.tok').forEach((el) => {
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2 - r.left;
      const cy = b.top + b.height / 2 - r.top;
      if (cx < box.l || cx > box.r || cy < box.t || cy > box.b) return;
      if (pointInPoly(cx, cy, poly)) picked.push({ el, cx, cy });
    });

    if (!picked.length) {
      // 글자를 못 잡았으면 이미지 위를 그린 것일 수 있다 → 영역 좌표를 그대로 넘긴다.
      const img = this.host.querySelector('#qimgContainer img');
      if (img) {
        const ib = img.getBoundingClientRect();
        const ov = overlapRatio(box, { l: ib.left - r.left, t: ib.top - r.top, r: ib.right - r.left, b: ib.bottom - r.top });
        if (ov > 0.05) { this.onLasso('', { ...box, image: img }); return; }
      }
      this.onLasso('', null);
      return;
    }

    // 문서 순서대로 정렬해서 자연스러운 문장이 되게
    picked.sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
    const text = picked.map((p) => p.el.textContent).join(' ').replace(/\s+/g, ' ').trim();
    this.onLasso(text, box);
  }

  clear() { this.strokes = []; this.redraw(); this.onChange(); }
  undo() { this.strokes.pop(); this.redraw(); this.onChange(); }
  get isEmpty() { return this.strokes.length === 0; }

  /** 저장용 — 투명 배경 PNG dataURL. 획이 없으면 null. */
  toPNG() {
    if (!this.strokes.length) return null;
    return this.canvas.toDataURL('image/png');
  }

  serialize() { return { strokes: this.strokes }; }
  load(data) {
    this.strokes = (data && data.strokes) || [];
    this.redraw();
  }

  destroy() { this._ro.disconnect(); this.canvas.remove(); }
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function overlapRatio(a, b) {
  const w = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l));
  const h = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const area = (a.r - a.l) * (a.b - a.t);
  return area > 0 ? (w * h) / area : 0;
}

/** 지문/선지를 단어 단위 <span class="tok">으로 감싼다(올가미 hit-test 대상). */
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
