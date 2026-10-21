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
   * @param {Function} opts.onCapture (box) => void         캡처 모드에서 네모를 쳤을 때
   * @param {Function} opts.onCard    (box) => void         카드 모드에서 네모를 쳤을 때
   */
  constructor(host, { onSelect, onTap, onChange, onCapture, onCard } = {}) {
    this.host = host;
    this.onSelect = onSelect || (() => {});
    this.onTap = onTap || (() => false);
    this.onChange = onChange || (() => {});
    this.onCapture = onCapture || (() => {});
    this.onCard = onCard || (() => {});

    // 지금 펜이 할 일 — 하나만 켜진다(setTool 참고)
    this.tool = 'select';
    this.erasing = false;
    this.capturing = false;
    this.carding = false;
    this.writing = false;
    this.color = '#2563eb';
    this.width = 2.6;
    this.strokes = [];
    this._cur = null;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'penlayer';
    this.ctx = this.canvas.getContext('2d');
    // ⚠️ 캔버스는 `position:absolute; inset:0`이라 **자리를 가진 가장 가까운 조상**을
    //    기준으로 깔린다. host가 static이면 엉뚱한 조상에 붙어 자리가 어긋난다 —
    //    재어 보니 퀴즈 화면에서 host는 60~974인데 캔버스는 0~914였다. 그만큼
    //    아래쪽이 캔버스 밖이라 거기서는 네모가 안 그려졌다(2026-10-20 신고).
    // (브라우저 밖 검사 환경에는 getComputedStyle이 없다 — 있을 때만 본다)
    try {
      if (typeof getComputedStyle === 'function'
        && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    } catch { /* 스타일을 못 읽으면 그냥 둔다 */ }
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
      if (!stylus) return;
      // ★ UI 위(팝업 버튼·네비·리사이저)에서는 막지 않는다.
      //   여기서 preventDefault 하면 그 뒤 click 이벤트가 죽어서 "펜으로는 버튼이
      //   안 눌리는" 증상이 된다 — _down에서 막는 것만으로는 부족했다(2026-10-09).
      const t = e.touches[0];
      if (isUiTarget(e.target) || this._overUi({ clientX: t.clientX, clientY: t.clientY })) return;
      if (this._nearTouch(e)) e.preventDefault();
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

  /**
   * 그 좌표에 UI(팝업·버튼)가 있는가? — 캔버스 밖 요소까지 좌표로 확인한다.
   *
   * ⚠️ **내 뒤에 깔린 것은 세지 않는다.** `elementsFromPoint`는 앞에서 뒤로 **전부**
   *    돌려주므로, 그림 크게 보기처럼 화면을 덮고 뜬 것 위에서 그으면 그 **뒤에 깔린
   *    읽기 화면 목차**가 UI로 잡혀 펜이 손을 뗐다 — 왼쪽 목차 폭만큼(약 1/5) 펜이
   *    안 먹었다(2026-10-20 신고). 내 host·canvas를 만나는 순간 멈춘다. 그 뒤는
   *    내가 덮고 있으니 사람 손이 닿을 수 없는 것들이다.
   */
  _overUi(e) {
    if (!document.elementsFromPoint) {
      const el = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
      return isUiTarget(el);
    }
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      // 내 캔버스·host를 만나면 멈춘다. host를 **품고 있는** 것(바깥 틀)도 마찬가지 —
      // 그 뒤로는 전부 내 밑이다. (contains가 없는 것도 올 수 있다 — 그냥 넘긴다)
      if (el === this.canvas || el === this.host) break;
      if (typeof el.contains === 'function' && el.contains(this.host)) break;
      if (isUiTarget(el)) return true;
    }
    return false;
  }

  /**
   * 획이 놓인 **패널(칼럼)**의 가로 범위. 문제 카드와 사이드 패널이 나란히 있을 때
   * 한쪽에 그은 선택이 반대쪽까지 번지지 않게 한다.
   */
  _paneAt(box) {
    const cr = this.canvas.getBoundingClientRect();
    const cx = (box.l + box.r) / 2;
    // ⚠️ **새 칸을 여기 빠뜨리면 그 칸에서 긁기가 깨진다.** 어느 칸인지 모르면 아래
    //    `_textInBox`가 가로 범위로 거르지 못해 **옆 칸 글까지 함께** 딸려온다
    //    (2026-10-20 신고: 두 번째 노트에서 긁으면 "잔뜩 깨짐").
    const panes = this.host.querySelectorAll(
      '#qcard, #wikiPanel, #wikiPanel2, #aiPanel, #readCard, .card');
    let best = null;
    panes.forEach((el) => {
      const b = el.getBoundingClientRect();
      if (!b.width) return;
      const l = b.left - cr.left, r = b.right - cr.left;
      if (cx < l - 8 || cx > r + 8) return;
      // 가장 안쪽(작은) 패널을 고른다 — .card 가 바깥을 겹쳐 잡는 걸 피한다
      if (!best || r - l < best.r - best.l) best = { l, r };
    });
    return best;
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
    // 일반 모드 — 펜을 손가락처럼 쓴다. 긁지도, 그리지도 않는다.
    // 모드를 한 바퀴 돌려 "아무것도 안 하는 상태"로 가려는 길이 없었다(2026-10-14 지적).
    if (this.tool === 'off') return;
    if (!this._isPen(e)) return;          // 손가락은 통과 → 평소대로 스크롤·탭
    // UI 위(팝업·버튼)에서는 펜도 평범한 포인터로 동작해야 한다.
    // 펜으로 네모를 그려 띄운 팝업을 손으로만 눌러야 하는 건 말이 안 된다(2026-10-09).
    //
    // 주의: 캔버스가 pointer-events:none 이라 e.target은 그 아래 요소가 잡히지만,
    // 팝업처럼 캔버스 **바깥**(body 직속)에 있는 요소는 좌표로도 확인해야 한다.
    if (isUiTarget(e.target) || this._overUi(e)) return;
    // 이 레이어가 담당하는 영역 근처에서 시작한 것만 받는다(여러 화면이 동시에 떠 있을 때 혼선 방지).
    // 바깥 여백에서 시작하는 경우가 흔하므로 넉넉히 본다.
    //
    // ⚠️ **영역 복사는 경계를 안 둔다**(2026-10-20 요청: "캡쳐는 그냥 어디든 다 돼야
    //    하지 않겠어? 경계 없이"). 보이는 그대로를 뜨는 일이라 "어느 칸 안인가"를
    //    따질 까닭이 없다. 다만 도구막대·팝업 위는 위에서 이미 걸렀다 — 거기서 시작하면
    //    모드를 바꾸려다 네모가 그려진다.
    if (!this.capturing && !this._nearHost(e, 160)) return;
    e.preventDefault();
    e.stopPropagation();
    // 포인터를 캔버스에 묶어둔다 — 이게 있어야 손이 카드 밖으로 나가도 move가 계속 온다.
    // (문서 레벨로 받으므로 host가 아니라 canvas에 건다)
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    this._activeId = e.pointerId;
    const pt = this._pos(e);
    this._start = { x: e.clientX, y: e.clientY };
    if (this.erasing) { this._eraseAt(pt); this._isErasing = true; return; }
    // 글자 위치는 획 하나 동안만 캐시한다 — 스크롤하거나 창을 바꾸면 달라지므로
    // 획을 시작할 때마다 버린다(2026-10-13).
    this._tokCache = null;
    this._emphCache = null;
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
    // ⚠️ 여기서 redraw()를 바로 부르면 **한 번 움직일 때마다 화면을 두 번 그린다**
    //    (여기서 한 번, 아래 rAF에서 또 한 번). 애플펜슬은 1초에 120번 넘게 좌표를
    //    보내므로 그리는 내내 캔버스를 240번씩 다시 칠하게 되고, 그래서 네모가
    //    툭툭 끊겼다(2026-10-14 신고). **화면 한 장에 한 번만** 그린다.
    this._livePreview();

    // 안전장치: pointerup이 영영 안 오는 경우가 있다(펜을 화면 밖으로 빼거나 OS가 삼킴).
    // 그러면 _cur가 남아 파란 선이 지워지지 않는다 — 2026-10-09 실제 버그.
    clearTimeout(this._stuck);
    this._stuck = setTimeout(() => {
      if (this._cur) this._up({ pointerId: this._activeId }, true);
    }, 2500);
  }

  /**
   * @param {boolean} cancelled pointercancel로 들어온 경우 — OS가 제스처로 가로챈 것이다.
   *        예전엔 여기서 획을 버렸는데, 그게 "1cm도 못 긋는" 증상의 일부였다.
   *        이제는 지금까지 그은 만큼을 **그대로 확정**한다.
   */
  _up(e, cancelled = false) {
    this._activeId = null;
    // 아직 안 그려진 다시 그리기가 남아 있으면 지금 취소한다 — 손을 뗀 뒤에 돌면
    // `_cur`가 없는 채로 다시 재서 확정값을 덮는다
    if (this._liveRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._liveRaf);
    this._liveRaf = 0;
    if (this._isErasing) { this._isErasing = false; this.onChange(); return; }
    if (!this._cur) return;
    const stroke = this._cur;
    // ⚠️ 낱말 범위는 시작점·끝점으로 정해진다. 미리보기(rAF)가 안 도는 환경에서는
    //    그동안 한 번도 안 재어 둘 수 있다 — **손을 뗄 때 여기서 확실히 잡는다**.
    if (stroke && stroke.pts.length) {
      const a0 = stroke.pts[0];
      const z0 = stroke.pts[stroke.pts.length - 1];
      const keepA = (this._pending && this._pending.length && this._span) ? this._span.a : a0;
      this._span = { a: keepA, z: z0 };
      this._lastSpan = this._span;
      this._pathPts = this._allPts();
      // ★ **손을 떼기 직전의 범위를 여기서 확정한다**(2026-10-14 신고: "뗄 때 네모가
      //   팍 튀면서 범위가 달라진다"). 화면은 한 프레임에 한 번만 그리므로 마지막
      //   몇 번의 움직임은 아직 반영되지 않았을 수 있고, 그 상태로 확정하면 보던 것과
      //   다른 범위가 잡힌다. `_cur`가 **아직 살아 있는 지금** 다시 재면 정확히 맞는다.
      if (!this.erasing && !this.writing) this._refreshPreview();
    }
    this._cur = null;

    clearTimeout(this._stuck);

    if (cancelled && stroke.pts.length > 2) {
      // 취소돼도 이미 충분히 그었으면 선택 후보로 넘긴다
      this._pending = this._pending || [];
      this._pending.push(stroke);
      this._refreshPreview();
      clearTimeout(this._settle);
      this._settle = setTimeout(() => this._commit(), SETTLE_MS);
      return;
    }

    // ⚠️ **필기 중에는 콕 찍은 것도 점이다.** 전에는 짧은 획을 전부 'tap'으로 보고
    //    버려서, 가는 펜으로 마침표나 점을 찍으면 그대로 사라졌다(2026-10-21 신고:
    //    "펜 그릴 때 점이 지워지는 문제, 0.8 이런 거 쓸 때").
    //    탭으로 넘기는 건 **글을 고르거나 네모 치는 중**일 때만이다.
    if (!this.writing && classify(stroke.pts) === 'tap') {
      this.redraw();
      const el = document.elementFromPoint(this._start.x, this._start.y);
      this.onTap(el, e);
      return;
    }

    // 끊어 그은 획들을 하나의 선택으로 모은다 — 잠깐 기다렸다가 확정.
    //
    // ⚠️ 여기서 _showPendingBox()를 부르면 안 된다. `_cur`가 이미 비었으므로
    //    _liveBounds가 **획 전체**를 다시 재서, 되돌린 것이 되살아난다 —
    //    화면엔 줄어든 게 보이는데 잡히는 건 줄 전체였다(2026-10-13).
    //    끌던 동안 갱신해둔 _lastLive / _lastRetreating 를 그대로 쓴다.
    this._pending = this._pending || [];
    this._pending.push(stroke);

    clearTimeout(this._settle);
    this._settle = setTimeout(() => this._commit(), SETTLE_MS);
  }

  /**
   * 무엇이 잡힐지 미리 보여준다.
   * 그은 궤적이 아니라 **실제로 가져갈 줄 전체**를 네모로 그린다 — 줄 끝까지 가져가므로
   * 궤적만 보여주면 "어디까지 복사되는지" 알 수 없다.
   */
  _showPendingBox() {
    const raw = this._liveBounds();
    if (!raw) { this._previewBox = null; this._coveredLines = null; this.redraw(); return; }
    this._textInBox(raw);                       // _coveredBox / _coveredLines 를 갱신한다
    const box = this._coveredBox || raw;
    this._previewKind = 'text';
    this._previewBox = (box.r - box.l) * (box.b - box.t) > 0 ? box : null;
    this._lastLive = raw;                           // 확정 때 이 범위를 그대로 쓴다
    this.redraw();
  }

  /**
   * 캡처·카드 모드의 미리보기 — 그은 그대로의 네모.
   *
   * 글 선택과 달리 줄 끝까지 늘이지 않는다. 가져가는 게 **화면의 그 네모**라서,
   * 보이는 것과 잘리는 것이 어긋나면 안 된다.
   */
  _showCropBox() {
    // ⚠️ 손을 뗀 뒤 **늦게 도착한 다시 그리기**가 확정값을 덮으면 안 된다.
    //    `_cur`가 없으면 모서리 자(누른 자리↔지금 자리)를 쓸 수 없어 자취 전체로
    //    되돌아가는데, 그 값이 _lastLive를 덮으면 확정될 때 네모가 **팍 튄다**
    //    (2026-10-16: 보여준 건 100px인데 잘린 건 250px이었다).
    if (!this._cur && this._lastLive) { this.redraw(); return; }
    // ⚠️ 글 고르기와 **다른 자를 써야 한다**.
    //    고르기는 "시작점↔현재점"으로 재야 되돌리기가 되는데, 네모 치기는 그러면
    //    손으로 한 바퀴 둘러 그릴 때 끝점이 시작점으로 돌아와 상자가 사그라든다.
    //    그리고 빠르게 그으면 마지막 몇 점이 아직 안 그려진 채로 손을 떼서,
    //    확정될 때 네모가 **팍 튀었다**(2026-10-14 신고).
    //    여기서는 **지나온 자취 전체**를 감싼다 — 그으면 커지기만 하므로 튈 일이 없다.
    const parts = [...(this._pending || [])];
    if (this._cur) parts.push(this._cur);
    const all = boundsOf(parts);
    // ⚠️ 자취 전체를 감싸면 **커지기만 하고 줄지 않는다** — 한 번 크게 벌렸다가 다시
    //    좁히면 네모가 안 따라온다(2026-10-16 신고: "한번 커진다음에 작은 방향으로
    //    움직이면 캡쳐범위가 잘 안따라옴"). 네모 치기는 모서리를 잡아 끄는 손짓이라
    //    **누른 자리↔지금 자리**로 재는 게 맞다. 둘러 그린 획(끝이 시작으로 돌아온 것)
    //    일 때만 자취 전체를 쓴다 — 그때는 시작↔끝이 0에 가까워 상자가 사그라든다.
    const raw = this._cornerBox(all) || all || this._liveBounds();
    this._previewKind = this.capturing ? 'crop' : 'card';
    this._previewBox = raw && (raw.r - raw.l) > 0 && (raw.b - raw.t) > 0 ? raw : null;
    this._lastLive = raw;
    // 카드 모드에서는 **무엇이 빈칸이 될지**를 미리 보여준다(2026-10-14 요청:
    // "어디까지 카드 범위가 되는지 팝업 띄우기 전에 보조 표시선으로").
    // 네모만 보면 그 안의 어느 말이 가려질지 알 수가 없어서 매번 쳐보고 확인해야 했다.
    this._coveredLines = (this.carding && this._previewBox)
      ? this._emphasisIn(this._previewBox) : null;
    this.redraw();
  }

  /**
   * 모서리를 잡아 끄는 네모 — **누른 자리↔지금 자리**.
   *
   * 둘러 그린 획이면 null을 돌려준다(그때는 부른 쪽이 자취 전체를 쓴다).
   *
   * 가르는 기준은 "끝이 시작 가까이 왔나"가 **아니다**. 크게 벌렸다가 많이 되돌리면
   * 그것도 시작 가까이 오기 때문이다 — 그래서 되돌리기가 안 먹었다(2026-10-16).
   * 대신 **자취가 a→z 선에서 얼마나 벗어났나**를 본다. 모서리를 끄는 손짓은
   * 지나치든 되돌리든 그 선 위를 오가고, 둘러 그린 획은 선에서 크게 벗어난다.
   */
  _cornerBox(all) {
    const cur = this._cur;
    // 끊어 그은 뒤라면(손을 뗐다 다시) 자취 전체가 맞다 — 이어 그리는 중이다
    if (!cur || cur.pts.length < 2 || (this._pending && this._pending.length)) return null;
    const a = cur.pts[0];
    const z = cur.pts[cur.pts.length - 1];
    const dx = z.x - a.x;
    const dy = z.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) return null;                       // 제자리로 돌아왔다 = 둘러 그린 것
    const diag = all ? Math.hypot(all.r - all.l, all.b - all.t) : len;
    let perp = 0;
    for (const q of cur.pts) {
      perp = Math.max(perp, Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / len);
    }
    if (perp > Math.max(24, diag * 0.25)) return null;   // 선에서 크게 벗어났다 = 둘러 그린 것
    const box = { l: Math.min(a.x, z.x), r: Math.max(a.x, z.x),
      t: Math.min(a.y, z.y), b: Math.max(a.y, z.y) };
    return (box.r - box.l) > 2 && (box.b - box.t) > 2 ? box : null;
  }

  /** 네모에 걸린 **강조된 말**의 자리. 획 하나 동안 캐시한다(토큰과 같은 이유). */
  _emphasisIn(b) {
    if (!this._emphCache) {
      const r = this.canvas.getBoundingClientRect();
      this._emphCache = [];
      this.host.querySelectorAll('.ask, mark, strong, b, em, i').forEach((el) => {
        const q = el.getBoundingClientRect();
        if (!q.width || !q.height) return;
        // 강조 안에 또 강조가 있으면 바깥 것만 — 같은 자리를 두 번 칠하지 않는다
        if (el.parentElement && el.parentElement.closest('.ask, mark, strong, b, em, i')) return;
        this._emphCache.push({ l: q.left - r.left, t: q.top - r.top,
          r: q.right - r.left, b: q.bottom - r.top });
      });
    }
    return this._emphCache.filter((q) =>
      q.r >= b.l && q.l <= b.r && q.b >= b.t && q.t <= b.b);
  }

  /**
   * 지금 그리는 획의 범위.
   *
   * ⚠️ 그냥 `boundsOf`(모든 점을 감싸는 사각형)를 쓰면 **되돌릴 수가 없다** — 펜을
   *    왼쪽으로 끌어올려도 이미 지나간 오른쪽 끝 점이 남아 상자가 줄지 않는다
   *    (2026-10-13: "하이라이트된 부분이 펜을 올려도 취소가 안 된다").
   *
   *    그래서 **지금 그리는 획만** 시작점 ↔ 현재점으로 본다. 되돌아오면 그만큼
   *    줄어들어 하이라이트가 풀린다. 끊어 그은 이전 획들(_pending)은 그대로 더한다 —
   *    그건 이미 확정한 선택이라 유지하는 게 맞다.
   */
  _liveBounds() {
    const parts = [...(this._pending || [])];
    const box = boundsOf(parts);
    const cur = this._cur;
    if (!cur || cur.pts.length < 2) { this._retreating = false; return box; }
    const a = cur.pts[0];
    const z = cur.pts[cur.pts.length - 1];
    // 낱말 범위를 고르려면 네모가 아니라 **시작점과 끝점**이 필요하다(2026-10-14).
    // 끊어 그어도 "처음 짚은 낱말"이 기준이어야 하므로 첫 획의 시작점은 유지한다.
    const keepA = (this._pending && this._pending.length && this._span) ? this._span.a : a;
    this._span = { a: keepA, z };
    this._lastSpan = this._span;
    this._pathPts = this._allPts();
    // 가장 멀리 갔던 지점보다 **눈에 띄게 돌아왔으면** 되돌리는 중이다.
    // 손 떨림(몇 px)으로는 켜지지 않게 여유를 둔다.
    const far = cur.pts.reduce((m, pt) =>
      Math.abs(pt.x - a.x) > Math.abs(m.x - a.x) ? pt : m, a);
    this._retreating = Math.abs(far.x - a.x) - Math.abs(z.x - a.x) > 24;
    this._lastRetreating = this._retreating;        // 손을 뗀 뒤 _commit이 쓴다
    // 보통은 **시작점↔현재점**만 본다(되돌리기가 되려면 그래야 한다).
    // 다만 **네모를 치듯 둘러싼 획**은 끝이 시작으로 돌아오므로 이 자가 0에 가까워져
    // "너무 작다 → 필기"로 빠져버렸다 — 둘러싼 게 확실하면 획 전체를 범위로 쓴다.
    const curBox = boundsOf([cur]);
    const live = (curBox && isLoop(a, z, curBox, cur.pts)) ? curBox : {
      l: Math.min(a.x, z.x), r: Math.max(a.x, z.x),
      t: Math.min(a.y, z.y), b: Math.max(a.y, z.y),
    };
    if (!box) return live;
    return {
      l: Math.min(box.l, live.l), r: Math.max(box.r, live.r),
      t: Math.min(box.t, live.t), b: Math.max(box.b, live.b),
    };
  }

  /**
   * 그으는 **동안** 미리보기를 갱신한다 (2026-10-13 요청).
   *
   * 전에는 손을 떼야 네모가 떴다 — 그으면서는 파란 선만 보여서 "허공에 긁는" 느낌이고,
   * 어디까지 잡히는지 알 수 없었다. 이제 잡히는 줄이 그때그때 밝아진다.
   * 한 프레임에 한 번만 다시 그린다(포인터는 그보다 훨씬 자주 온다).
   */
  /**
   * 그리는 동안의 화면 갱신 — **화면 한 장에 한 번만** 그린다.
   *
   * 포인터 좌표는 한 프레임에 여러 번 온다(애플펜슬은 120Hz 넘는다). 올 때마다 그리면
   * 같은 프레임을 여러 번 칠하느라 오히려 밀려서 끊겨 보인다(2026-10-14 신고:
   * "네모가 매끄럽게 안 그려지고 툭툭 끊김"). rAF로 묶어 한 번만 그린다.
   */
  _livePreview() {
    if (this._liveRaf) return;
    // rAF가 없는 환경(노드 테스트 하네스)에서는 그릴 화면도 없으므로 바로 그린다
    if (typeof requestAnimationFrame !== 'function') { this._paintLive(); return; }
    this._liveRaf = requestAnimationFrame(() => {
      this._liveRaf = 0;
      this._paintLive();
    });
  }

  _paintLive() {
    if (!this._cur && !this._pending) return;
    // 필기·지우개는 그은 궤적 자체가 결과다 — 미리보기 계산 없이 그대로 그린다
    if (this.erasing || this.writing) { this.redraw(); return; }
    // 캡처·카드는 자르는 틀을, 고르기는 잡히는 낱말을 보여준다(각자 안에서 redraw 한다)
    this._refreshPreview();
  }

  /** 지금 모드에 맞는 미리보기를 그린다 — 글은 줄 하이라이트, 캡처·카드는 자르는 틀. */
  _refreshPreview() {
    if (this.capturing || this.carding) this._showCropBox();
    else this._showPendingBox();
  }

  /** 모아둔 획을 하나의 선택으로 확정한다. */
  _commit() {
    const pend = this._pending || [];
    // ⚠️ 여기서 _liveBounds()를 다시 부르면 안 된다 — 손을 뗀 뒤라 `_cur`가 이미
    //    비어 있어서 "되돌리는 중"이라는 사실을 잃는다. **미리보기에 쓴 값을 그대로**
    //    쓴다(2026-10-13: 화면엔 줄어든 게 보이는데 잡히는 건 줄 전체였다).
    const live = this._lastLive || this._liveBounds();
    this._retreating = this._lastRetreating || false;
    this._pending = null;
    this._previewBox = null;
    this._previewKind = null;
    this._coveredLines = null;
    this._tokCache = null;
    this._emphCache = null;
    this._lastLive = null;
    this._lastRetreating = false;
    this._span = this._lastSpan;        // 손을 뗀 뒤에도 마지막 범위로 확정한다
    this._pathPts = this._lastPath;
    if (this._liveRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._liveRaf);
    this._liveRaf = 0;
    if (!pend.length) return;

    const box = live || boundsOf(pend);
    if (!box) return;
    const w = box.r - box.l, h = box.b - box.t;

    // 캡처 모드 — 네모 친 영역을 **이미지로** 넘긴다(글자 추출이 아니라).
    // 표·그림·수식처럼 텍스트로 긁어봐야 의미가 깨지는 걸 그대로 들고 가려는 용도.
    if (this.capturing) {
      this.redraw();
      if (Math.max(w, h) >= BOX_MIN) this.onCapture(box);
      return;
    }

    // 카드 모드 — 네모 안의 **강조된 말**을 가려 플래시카드로 만든다.
    if (this.carding) {
      this.redraw();
      if (Math.max(w, h) >= BOX_MIN) this.onCard(box);
      return;
    }

    // 필기 모드 — 그은 것을 **무조건** 손글씨로 남긴다. 글을 잡지도, 팝업을 띄우지도 않는다.
    // 전에는 "작게 그으면 필기, 크게 그으면 선택"이라 메모를 쓰다 말고 팝업이 떴다.
    if (this.writing) {
      // 점 하나짜리도 남긴다 — 콕 찍은 점이 사라지면 안 된다(2026-10-21)
      pend.forEach((st) => { if (st.pts.length) this.strokes.push(st); });
      this.onChange();
      this.redraw();
      return;
    }

    // 너무 작으면 선택 의도가 아니다 → 필기로 남긴다
    if (Math.max(w, h) < BOX_MIN) {
      pend.forEach((s) => { if (s.pts.length) this.strokes.push(s); });
      this.onChange();
      this.redraw();
      return;
    }

    const text = this._textInBox(box);
    this.redraw();     // 선택 궤적은 남기지 않는다
    if (text) { this.onSelect(text, { box }); return; }

    // 글자를 못 잡았을 때 — 패널 **안**이면 선택 의도였다고 보고 궤적을 지운다.
    // (AI 답변처럼 토큰화되지 않은 영역에 그으면 파란 선만 남아 지저분했다, 2026-10-09)
    // 여백·빈 곳이면 필기로 남긴다.
    if (this._paneAt(box)) { this.redraw(); return; }
    pend.forEach((s) => { if (s.pts.length) this.strokes.push(s); });
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
   * **걸린 줄은 무조건 끝까지** 가져온다(2026-10-09 변경).
   * 줄을 중간까지만 긋는 일은 실제로 거의 없고, 가로 범위까지 따지면 문장이 잘려서
   * 오히려 다시 긋게 된다. 세로로 어느 줄에 걸쳤는지만 보고 그 줄 전체를 준다.
   */
  /**
   * 글자 위치를 재둔다. 그으는 **동안 매번** 미리보기를 갱신하는데(2026-10-13),
   * 섹션 하나에 토큰이 수백 개라 매 move마다 재면 손이 밀린다. 획 하나가 끝날
   * 때까지 캐시한다 — 그동안 글은 움직이지 않는다.
   */
  _tokens() {
    if (this._tokCache) return this._tokCache;
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
    this._tokCache = toks;
    return toks;
  }

  /**
   * 그은 자리에 걸린 **낱말 범위**를 가져온다 — 시작 낱말부터 끝 낱말까지.
   *
   * 전에는 "획이 세로로 걸친 줄은 통째로" 방식이었다. 짧게 그어도 문장이 다 잡혀 편했지만,
   * **한 줄만 긋고 싶을 때 그게 안 됐다**(2026-10-14 지적). 줄 단위로 들고 가고 싶으면
   * 영역 복사를 쓰면 되니, 여기서는 글자를 다루는 쪽을 택한다.
   *
   * 이제 글에서 마우스로 긁는 것과 같다: 시작점에 가장 가까운 낱말부터, 끝점에 가장
   * 가까운 낱말까지 **문서 순서대로** 전부. 그래서
   *   · 한 줄 안에서 그으면 그 줄의 그만큼만,
   *   · 여러 줄에 걸쳐 그으면 중간 줄은 통째로 (문서 순서라 자연히 그렇게 된다),
   *   · 끌었다 되돌리면 끝점이 앞으로 와서 범위가 줄어든다 — 따로 다룰 필요가 없다.
   * 낱말은 공백으로 끊으므로 "평가한다." 처럼 **마침표가 함께** 온다.
   */
  _textInBox(box) {
    const toks = this._tokens();              // DOM 순서 = 읽는 순서
    if (!toks.length) { this._coveredLines = null; this._coveredBox = null; return ''; }

    // 획이 시작된 **패널 안에서만** 고른다. 그러지 않으면 문제 카드에 그었는데 오른쪽
    // 노트 패널의 같은 높이 글까지 딸려온다(2026-10-09 지적).
    const pane = this._paneAt(box);
    const inPane = pane
      ? toks.filter((t) => t.l >= pane.l - 2 && t.r <= pane.r + 2)
      : toks;
    if (!inPane.length) { this._coveredBox = null; this._coveredLines = null; return ''; }

    // 시작점·끝점. 그리는 중이면 지금 획에서, 손을 뗐으면 마지막으로 본 값에서.
    const span = this._span;
    const a = span ? span.a : { x: box.l, y: box.t };
    const z = span ? span.z : { x: box.r, y: box.b };

    // ★ 무슨 수를 쓰든 결과는 **이어진 한 덩어리**여야 한다.
    //   전에는 둘러싼 경우에 상자 안에 든 것만 걸러냈는데(filter), 걸러내기는 중간을
    //   건너뛰므로 **군데군데 끊긴 하이라이트**가 나왔다(2026-10-15 신고 스크린샷:
    //   한 줄의 오른쪽 토막 + 다음 줄의 왼쪽 토막만 칠해짐). 글을 긁는 건 언제나
    //   "여기서부터 저기까지"이므로, 어느 길로 오든 **첫 낱말과 끝 낱말만** 정하고
    //   그 사이를 통째로 가져온다.
    let i0;
    let i1;
    if (isLoop(a, z, box, this._pathPts)) {
      // **둘러싼 경우** — 네모를 치듯 돌아와 제자리에서 끝났다. 시작·끝 낱말이 같아져
      // 한 낱말만 잡히는데 그건 뜻한 바가 아니다. 상자에 걸린 것의 처음~끝을 쓴다.
      const inside = [];
      inPane.forEach((t, i) => {
        if (t.cy >= box.t - 2 && t.cy <= box.b + 2 && t.r >= box.l - 6 && t.l <= box.r + 6) inside.push(i);
      });
      if (!inside.length) { this._coveredBox = null; this._coveredLines = null; return ''; }
      i0 = inside[0];
      i1 = inside[inside.length - 1];
    } else {
      i0 = nearestTok(inPane, a);
      i1 = nearestTok(inPane, z);
    }
    if (i0 < 0 || i1 < 0) { this._coveredBox = null; this._coveredLines = null; return ''; }
    const picked = inPane.slice(Math.min(i0, i1), Math.max(i0, i1) + 1);
    if (!picked.length) { this._coveredBox = null; this._coveredLines = null; return ''; }

    // 미리보기 — 줄마다 한 덩어리로 칠한다(한 낱말씩 칠하면 띄어쓰기가 뚫려 지저분하다)
    const covered = [];
    let run = null;
    for (const t of picked) {
      if (run && Math.abs(t.cy - run.cy) <= 6) {
        run.l = Math.min(run.l, t.l); run.r = Math.max(run.r, t.r);
        run.t = Math.min(run.t, t.t); run.b = Math.max(run.b, t.b);
      } else {
        run = { l: t.l, r: t.r, t: t.t, b: t.b, cy: t.cy };
        covered.push(run);
      }
    }
    this._coveredLines = covered;
    this._coveredBox = {
      l: Math.min(...covered.map((c) => c.l)),
      r: Math.max(...covered.map((c) => c.r)),
      t: Math.min(...covered.map((c) => c.t)),
      b: Math.max(...covered.map((c) => c.b)),
    };
    return pickedText(picked);
  }

  /**
   * 지금까지 그은 점들. 둘러싼 획인지 가리는 데 쓴다 — 양끝만 보면 **위아래로
   * 오락가락한 획**이 "제자리로 돌아온 네모"로 읽힌다(2026-10-15).
   * 점이 수백 개라 전부 보지 않고 성기게 훑는다.
   */
  _allPts() {
    const all = [];
    for (const s of [...(this._pending || []), ...(this._cur ? [this._cur] : [])]) {
      const step = Math.max(1, Math.floor(s.pts.length / 40));
      for (let i = 0; i < s.pts.length; i += step) all.push(s.pts[i]);
    }
    this._lastPath = all;
    return all;
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
    // 고를 범위가 잡혔으면 **궤적 대신 하이라이트만** 보여준다(2026-10-13).
    // 둘을 겹쳐 그리면 밑줄이 하이라이트를 가로질러 지저분하다 — 어차피 확정되면
    // 궤적은 지워지므로, 잡힌 순간부터는 "무엇이 잡혔나"만 보이는 게 맞다.
    const picking = !!this._previewBox;
    if (!picking) {
      const all = [...this.strokes, ...(this._pending || [])];
      if (this._cur) all.push(this._cur);
      for (const s of all) this._drawStroke(s);
    } else {
      for (const s of this.strokes) this._drawStroke(s);     // 이미 남긴 필기는 그대로
      if (this._previewKind === 'crop' || this._previewKind === 'card') {
        this._drawCrop(this._previewBox, this._previewKind);
      } else {
        this._drawBox(this._previewBox);
      }
    }
  }

  /**
   * 지금 잡히는 범위를 보여준다.
   * **줄마다** 옅게 칠하고(어느 글자까지 가는지 바로 보인다), 전체를 점선으로 묶는다.
   * 네모 하나로만 칠하면 줄 사이 여백까지 덮여서 "이만큼 다 잡히나?" 싶어진다.
   */
  _drawBox(b) {
    const { ctx } = this;
    const lines = this._coveredLines;
    ctx.save();
    // ① 잡히는 줄 — 형광펜처럼
    ctx.fillStyle = 'rgba(245,158,11,.22)';
    for (const c of (lines && lines.length ? lines : [b])) {
      const x = c.l - 2, y = c.t - 1, w = c.r - c.l + 4, h = c.b - c.t + 2;
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill(); }
      else ctx.fillRect(x, y, w, h);
    }
    // ② 바깥 점선은 뺐다(2026-10-14).
    //    줄 단위로 잡던 시절에는 "여기서 여기까지"를 알려주는 쓸모가 있었지만, 이제는
    //    **낱말 단위**라 점선이 줄 전체를 두르면서 실제보다 많이 잡힌 것처럼 보인다.
    //    칠한 자리가 곧 잡힌 자리다 — 그게 더 정확하고, 글에서 긁는 모습과도 같다.
    ctx.restore();
  }

  /**
   * 자를 범위를 보여준다 — 사진 앱의 자르기 틀처럼.
   *
   * 글 선택(형광펜 느낌)과 **달라 보여야** 한다. 같은 펜질인데 결과가 전혀 다르기
   * 때문이다: 이쪽은 그림으로 뜬다. 그래서 색을 달리하고 모서리 꺾쇠를 둔다.
   * 크기도 적어준다 — "어느 정도 범위인지"를 손 떼기 전에 알 수 있게(2026-10-13 요청).
   */
  _drawCrop(b, kind) {
    const { ctx } = this;
    const color = kind === 'card' ? '#a78bfa' : '#34a07a';   // 파스텔 보라 · 파스텔 녹색
    const w = b.r - b.l, h = b.b - b.t;
    const tooSmall = Math.max(w, h) < BOX_MIN;
    ctx.save();
    // ① 안쪽을 옅게 — 어디가 잡히는지 면으로 보인다
    ctx.fillStyle = kind === 'card' ? 'rgba(167,139,250,.13)' : 'rgba(110,205,170,.20)';
    ctx.fillRect(b.l, b.t, w, h);
    // ①-2 카드 모드 — **빈칸이 될 말**을 진하게 짚어준다. 네모만 보면 그 안의 어느
    //     말이 가려질지 알 수가 없어서, 쳐보고 나서야 알았다(2026-10-14).
    if (kind === 'card' && this._coveredLines && this._coveredLines.length) {
      ctx.fillStyle = 'rgba(139,92,246,.30)';
      for (const q of this._coveredLines) {
        const x = q.l - 1, y = q.t - 1, qw = q.r - q.l + 2, qh = q.b - q.t + 2;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, qw, qh, 3); ctx.fill(); }
        else ctx.fillRect(x, y, qw, qh);
      }
    }
    // ② 테두리 — 너무 작아 아무 일도 안 일어날 때는 점선으로 "아직 아니다"를 말한다
    ctx.strokeStyle = tooSmall ? 'rgba(120,120,130,.8)' : color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(tooSmall ? [4, 4] : []);
    ctx.strokeRect(b.l, b.t, w, h);
    // ③ 모서리 꺾쇠 — 자르는 틀이라는 걸 그림만으로 알 수 있게
    if (!tooSmall) {
      const c = Math.max(8, Math.min(18, Math.min(w, h) / 3));
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (const [x, y, dx, dy] of [
        [b.l, b.t, 1, 1], [b.r, b.t, -1, 1], [b.l, b.b, 1, -1], [b.r, b.b, -1, -1],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x + dx * c, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + dy * c);
        ctx.stroke();
      }
    }
    // ④ 크기 — 틀 위쪽에 작은 칩으로. 위가 좁으면 안쪽에 넣는다.
    const n = kind === 'card' && this._coveredLines ? this._coveredLines.length : 0;
    const label = tooSmall ? '조금 더 크게'
      : (kind === 'card'
        ? (n ? `빈칸 ${n}개` : '강조된 말이 없습니다')
        : `${Math.round(w)} × ${Math.round(h)}`);
    ctx.setLineDash([]);
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = ctx.measureText(label).width;
    const bx = Math.max(2, b.l), by = b.t > 20 ? b.t - 18 : b.t + 4;
    ctx.fillStyle = tooSmall ? 'rgba(90,90,100,.9)' : color;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, tw + 12, 16, 8); ctx.fill(); }
    else ctx.fillRect(bx, by, tw + 12, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, bx + 6, by + 12);
    ctx.restore();
  }

  _drawStroke(s) {
    const { ctx } = this;
    if (!s.pts.length) return;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // ⚠️ **점 하나짜리 획도 그린다.** 전에는 `pts.length < 2`면 그냥 돌아섰는데,
    //    가는 펜으로 콕 찍으면(0.8 같은 굵기) 좌표가 하나뿐이라 **점이 사라졌다**
    //    (2026-10-21 신고). 선 긋기로는 길이 0이라 아무것도 안 나오므로 동그라미로 찍는다.
    if (s.pts.length === 1) {
      const p = s.pts[0];
      const r = Math.max(0.5, s.width * (0.6 + p.p * 0.9) / 2);
      ctx.fillStyle = s.color;
      if (typeof ctx.arc === 'function') {         // 브라우저 밖 검사에는 arc가 없다
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (typeof ctx.fillRect === 'function') {
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.restore();
      return;
    }
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

  /** 모드는 하나만 켜진다 — 지우개·캡처·카드가 겹치면 뭐가 일어날지 알 수 없다. */
  /**
   * 펜으로 무엇을 할지 — **하나만** 켜진다.
   *
   *   off     펜이 아무것도 안 한다 — **평범한 손가락처럼**. 스크롤·버튼 누르기·
   *           브라우저 기본 글자 선택이 그대로 된다(2026-10-14 요청).
   *   select  긁으면 글이 잡힌다
   *   write   그리면 필기로 남는다
   *   erase   지나가면 지워진다
   *   card    네모 치면 그 범위로 카드
   *   shot    네모 치면 그림으로 복사
   *
   * 전에는 erasing·capturing·carding 세 깃발을 따로 두고, 켜는 함수마다 나머지를
   * 껐다. 그래서 `setErasing(false)` 한 번에 **카드 모드가 조용히 꺼졌고**, 버튼은
   * 켜진 채라 "카드 만들기를 켰는데 선택 팝업이 뜬다"가 됐다(2026-10-14 지적).
   * 이제 상태가 하나다 — 끌 때 다른 게 같이 꺼질 길이 없다.
   */
  setTool(tool) {
    this.tool = ['off', 'select', 'write', 'erase', 'card', 'shot'].includes(tool) ? tool : 'select';
    this.erasing = this.tool === 'erase';
    this.capturing = this.tool === 'shot';
    this.carding = this.tool === 'card';
    this.writing = this.tool === 'write';
    // 모드를 바꾸면 그리다 만 것은 버린다 — 전 모드의 획이 새 모드로 확정되면 안 된다
    clearTimeout(this._settle);
    this._cur = null;
    this._pending = null;
    this._previewBox = null;
    this._previewKind = null;
    this._coveredLines = null;
    this.redraw();
  }
  _setMode(which) { this.setTool(which === 'capture' ? 'shot' : (which || 'select')); }
  setErasing(on) { this.setTool(on ? 'erase' : 'select'); }
  setCapturing(on) { this.setTool(on ? 'shot' : 'select'); }
  setCarding(on) { this.setTool(on ? 'card' : 'select'); }
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

/** 펜이 건드리면 안 되는 UI 요소인가? */
/**
 * 고른 낱말들을 **원문 그대로** 떠온다.
 *
 * 전에는 `picked.map(t => t.el.textContent).join(' ')` 였다. 그런데 낱말 조각(.tok)은
 * **굵게·괄호 같은 서식 경계에서도 갈라진다** — `"**제일** …`은 `"` 와 `제일`이 다른
 * 조각이고, `…기준**으로`는 `기준`과 `으로`가 다른 조각이다. 거기에 ' '를 끼우면
 * 원문에 없던 틈이 생긴다(2026-10-15 지적: "다 띄어쓰기가 되어서 나와야 될 까닭은 뭐임" —
 * `" 제일`, `기준 으로`, `있어서 ,`). 그 글이 그대로 카드 본문이 되니 더 티가 났다.
 *
 * 첫 조각 앞부터 끝 조각 뒤까지를 Range로 떠오면 **사이의 공백도 원문 그대로**다.
 */
function pickedText(picked) {
  const join = () => picked.map((t) => t.el.textContent).join(' ');
  let raw;
  if (typeof document.createRange === 'function') {
    try {
      const r = document.createRange();
      r.setStartBefore(picked[0].el);
      r.setEndAfter(picked[picked.length - 1].el);
      raw = r.toString();
    } catch { raw = join(); }
  } else {
    raw = join();                     // Range가 없는 환경(테스트 하네스)
  }
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function isUiTarget(el) {
  if (!el || !el.closest) return false;
  return !!el.closest(
    '.pen-passthrough, button, summary, input, textarea, select, a, label, ' +
    '.sel-btn, .navbar, .quiz-head, .col-resizer, .pane-resizer, .sheet, ' +
    '.read-toc, .toc-link, .toc-scrim, .ask-float'
  );
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
/**
 * 그 점에 가장 가까운 낱말의 번호. 안에 들어 있으면 그것, 아니면 거리가 가장 짧은 것.
 * 세로로 어긋난 것은 크게 깎는다 — 줄 끝 여백에서 멈췄을 때 아랫줄로 건너뛰지 않게.
 */
/**
 * 둘러싼 획인가 — 끝이 시작 자리로 돌아왔고, 감싼 넓이가 한 줄보다 크다.
 * 네모를 치듯 그은 경우를 "낱말 하나"로 잘못 읽지 않기 위한 것이다(2026-10-14).
 */
function isLoop(a, z, box, pts) {
  const w = box.r - box.l;
  const h = box.b - box.t;
  if (h < 26 || w < 26) return false;                 // 한 줄짜리 밑줄은 아니다
  const back = Math.hypot(z.x - a.x, z.y - a.y);
  // 제자리 근처에서 끝났다. 대충 친 ㄷ자(닫히지 않은 네모)까지 받아주려고 넉넉히 본다 —
  // 줄을 가로지르는 **대각선 끌기**는 이동 거리가 상자 크기만큼 되므로 여기 안 걸린다.
  if (back >= Math.max(w, h) * 0.45) return false;
  // ⚠️ 이것만으로는 **위아래로 오락가락한 획**까지 "네모"로 읽힌다(2026-10-15 신고:
  //    "쭉 긋지 않고 위아래로 움직였을 때 하이라이트가 이상하게 된다"). 지그재그는
  //    제자리로 돌아오면서도 **한 번도 멀리 가지 않는다** — 진짜로 둘러쌌다면 도중에
  //    시작점에서 대각선만큼 멀어진 적이 있어야 한다.
  if (!pts || pts.length < 3) return false;
  const diag = Math.hypot(w, h);
  let far = 0;
  for (const q of pts) far = Math.max(far, Math.hypot(q.x - a.x, q.y - a.y));
  return far > diag * 0.45;
}

function nearestTok(toks, pt) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const dx = Math.max(t.l - pt.x, 0, pt.x - t.r);
    const dy = Math.max(t.t - pt.y, 0, pt.y - t.b);
    const d = dx + dy * 4;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

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

/**
 * 낱말 단위로 긁는 선택 — **직접 칠해서** 어디까지 잡혔는지 보여준다.
 *
 * 왜 따로 만들었나(2026-10-15 신고: "AI 설명에서 글을 긁으려고 하니까 어디까지
 * 선택된 게 안 나옴"): 떠다니는 창 안에서는 브라우저 기본 선택의 파란 칠이
 * 제대로 안 보인다. 게다가 기본 선택은 글자 단위라 손가락으로는 낱말 경계를
 * 맞추기가 거의 불가능하다. 노트 쪽 펜 "긁기"는 이미 낱말 단위인데 창 안에서는
 * 펜이 없어서, 그 느낌을 그대로 옮겨 온다.
 *
 * 손가락과 마우스를 다르게 받는다:
 *   · 손가락·펜 — **꾹 누르면**(LONG) 시작한다. 바로 시작하면 창을 스크롤할 수가 없다.
 *   · 마우스 — 누르는 순간 시작한다(스크롤은 휠로 하니까).
 * 긁는 중에는 스크롤을 막고, 떼면 고른 채로 남는다. 아무 데나 톡 치면 풀린다.
 *
 * @param {HTMLElement} host  `.tok`이 들어 있는 상자(tokenizeTree를 먼저 돌려둘 것)
 * @param {Function} onChange 고른 글이 바뀔 때마다 (글, {from,to}) 로 불린다
 * @returns {{text:()=>string, clear:()=>void, destroy:()=>void}}
 */
const PICK_LONG = 260;    // 꾹 누름으로 치는 시간(ms)
const PICK_SLOP = 10;     // 이만큼 움직이면 "스크롤하려는 것"으로 본다(px)

export function wordPick(host, onChange = () => {}) {
  let toks = [];
  let from = -1;
  let to = -1;
  let anchor = -1;
  let timer = null;
  let active = false;
  let down = null;

  const measure = () => {
    toks = [];
    host.querySelectorAll('.tok').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width && b.height) toks.push({ el, l: b.left, t: b.top, r: b.right, b: b.bottom });
    });
  };

  /** 그 점에 걸린 낱말. 낱말 사이 빈 곳이면 가장 가까운 것 — 줄이 건너뛰지 않게 세로를 크게 깎는다. */
  const at = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    const tk = hit && hit.closest ? hit.closest('.tok') : null;
    if (tk) {
      for (let i = 0; i < toks.length; i++) if (toks[i].el === tk) return i;
    }
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const dx = Math.max(t.l - x, 0, x - t.r);
      const dy = Math.max(t.t - y, 0, y - t.b);
      const d = dx + dy * 4;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  /** 고른 글. 낱말을 이어 붙이지 않고 **원래 사이 간격 그대로** 떠온다. */
  const text = () => {
    if (from < 0 || !toks[from] || !toks[to]) return '';
    const r = document.createRange();
    r.setStartBefore(toks[from].el);
    r.setEndAfter(toks[to].el);
    return r.toString().replace(/\s+/g, ' ').trim();
  };

  const paint = () => {
    for (let i = 0; i < toks.length; i++) {
      toks[i].el.classList.toggle('tok-pick', from >= 0 && i >= from && i <= to);
    }
    onChange(text(), { from, to });
  };

  const clear = () => {
    const had = from >= 0;
    host.querySelectorAll('.tok-pick').forEach((el) => el.classList.remove('tok-pick'));
    from = -1; to = -1; anchor = -1;
    if (had) onChange('', { from: -1, to: -1 });
  };

  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const start = (i, ev) => {
    active = true;
    anchor = i; from = i; to = i;
    host.classList.add('picking');
    try { host.setPointerCapture(ev.pointerId); } catch { /* 캡처가 안 되는 기기도 있다 */ }
    paint();
  };

  const onDown = (e) => {
    if (e.button > 0) return;
    measure();
    if (!toks.length) return;
    down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    const i = at(e.clientX, e.clientY);
    if (i < 0) return;
    if (e.pointerType === 'mouse') { clear(); start(i, e); e.preventDefault(); }
    else { timer = setTimeout(() => { timer = null; clear(); start(i, e); }, PICK_LONG); }
  };

  const onMove = (e) => {
    if (!down || e.pointerId !== down.id) return;
    if (!active) {
      // 아직 꾹 누름이 안 찼는데 움직였다 = 스크롤하려는 것. 선택은 포기한다.
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > PICK_SLOP) stopTimer();
      return;
    }
    const i = at(e.clientX, e.clientY);
    if (i < 0) return;
    from = Math.min(anchor, i); to = Math.max(anchor, i);
    e.preventDefault();          // 긁는 동안은 창이 따라 움직이지 않게
    paint();
  };

  const onUp = (e) => {
    stopTimer();
    const wasActive = active;
    const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
    active = false;
    host.classList.remove('picking');
    try { host.releasePointerCapture(e.pointerId); } catch { /* 이미 풀렸을 수 있다 */ }
    down = null;
    // 긁지 않고 톡 친 것 — 고른 게 있으면 푼다(어디를 쳤든 "그만"이라는 뜻이다)
    if (!wasActive && moved <= PICK_SLOP && from >= 0) clear();
  };

  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove, { passive: false });
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);

  return {
    text,
    clear,
    /** 글이 통째로 바뀌었을 때(새 답변) — 칠을 지우고 위치를 다시 잰다. */
    reset() { clear(); measure(); },
    destroy() {
      stopTimer();
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
      clear();
    },
  };
}
