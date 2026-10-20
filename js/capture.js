// 화면 영역 캡처 — 펜으로 네모 친 부분을 이미지로 떠서 클립보드에 넣는다.
//
// 왜 필요한가: 글자 긁기는 표·그림·수식에서 의미가 깨진다. 그런 건 "보이는 그대로"
// 들고 가야 다른 앱(노트·AI)에 붙여넣어 쓸 수 있다(2026-10-10 요청).
//
// 어떻게: 브라우저에는 "이 DOM 영역을 그려줘"라는 API가 없다. 대신 영역 안의 요소를
// SVG <foreignObject>에 넣어 이미지로 굽는다. 외부 리소스는 못 들어가므로
//   · 스타일은 계산된 값을 인라인으로 복사하고
//   · 이미지는 미리 data: URL로 바꿔 넣는다.

/** 이 속성들만 베껴도 화면과 거의 같게 나온다(전부 복사하면 너무 느리고 무겁다). */
const COPY_PROPS = [
  'color', 'background-color', 'background-image', 'font', 'font-family', 'font-size',
  'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align',
  'text-decoration', 'white-space', 'word-break', 'overflow-wrap', 'direction',
  'padding', 'margin', 'border', 'border-radius', 'box-shadow', 'opacity',
  'display', 'flex-direction', 'align-items', 'justify-content', 'gap', 'flex',
  'width', 'height', 'min-height', 'max-width', 'box-sizing', 'vertical-align',
  'list-style', 'table-layout', 'border-collapse', 'position', 'top', 'left',
];

function inlineStyles(src, dst) {
  const cs = getComputedStyle(src);
  let css = '';
  for (const p of COPY_PROPS) {
    const v = cs.getPropertyValue(p);
    if (v) css += `${p}:${v};`;
  }
  dst.setAttribute('style', css);
  const sk = src.children, dk = dst.children;
  for (let i = 0; i < sk.length && i < dk.length; i++) inlineStyles(sk[i], dk[i]);
  // ⚠️ 자식을 **다 훑은 뒤에** 민다. 먼저 감싸면 아래 재귀가 짝을 잃는다
  //    (복제본 자식이 감싼 것 하나로 바뀌므로).
  carryScroll(src, dst);
}

/**
 * 안에서 스크롤된 칸의 **스크롤 위치를 복제본에 옮긴다**.
 *
 * ⚠️ `cloneNode`는 scrollTop을 안 가져온다. 게다가 SVG로 넘길 때 스크롤 위치는
 *    적어 보낼 수가 없다 — 그래서 옆칸처럼 **안에서 스크롤되는 곳**을 캡처하면
 *    복제본이 맨 위부터 그려져서, 내가 고른 데가 아니라 **한참 위의 글**이 떠졌다
 *    (2026-10-20 신고: 고른 범위와 복사된 범위가 다름).
 * 스크롤 대신 **속엣것을 그만큼 밀어 올린다** — 보이는 결과는 같고, 이건 적어 보낼 수 있다.
 */
function carryScroll(src, dst) {
  const top = src.scrollTop || 0;
  const left = src.scrollLeft || 0;
  if (!top && !left) return;
  const shift = document.createElement('div');
  shift.setAttribute('style',
    `transform:translate(${-left}px,${-top}px);will-change:transform;`);
  while (dst.firstChild) shift.appendChild(dst.firstChild);
  dst.appendChild(shift);
}

// 자리만 차지하고 아무것도 안 그리는 1x1 투명 그림
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * 그림은 **SVG 안에 넣지 않는다** — 캔버스에 직접 그린다.
 *
 * 왜(2026-10-16 신고: "왜 캡쳐하면 그림은 안들어감?"): `<foreignObject>` 안의 `<img>`는
 * 그려지지 않는다. data: URL로 바꿔 넣어도 마찬가지다(크롬에서도 재현 — 그림 자리가
 * 흰색으로 남는다). 보안 제약이라 우회할 길이 없다.
 *
 * 그래서 **글과 그림을 따로 굽는다**: 복제본에서는 그림을 투명한 자리지기로 바꿔
 * 레이아웃만 지키게 하고(빼버리면 글이 밀린다), 글을 다 그린 뒤 **살아 있는 그림을
 * 캔버스에 그대로 올린다**. 화면에 보이는 그 픽셀이 그대로 들어간다.
 *
 * @returns {Array<{el:HTMLImageElement, box:DOMRect}>} 나중에 캔버스에 올릴 그림들
 */
function stubImages(host, clone, rect) {
  const live = [...host.querySelectorAll('img')];
  const copy = [...clone.querySelectorAll('img')];
  const draw = [];
  live.forEach((im, i) => {
    const c = copy[i];
    const b = im.getBoundingClientRect();
    const seen = b.width > 0 && b.height > 0
      && b.right > rect.left && b.left < rect.left + rect.width
      && b.bottom > rect.top && b.top < rect.top + rect.height;
    if (c) {
      // 자리는 그대로 두고 그림만 비운다 — 빼면 글이 밀려 보이는 것과 달라진다
      c.src = BLANK;
      c.style.width = `${b.width}px`;
      c.style.height = `${b.height}px`;
      c.style.objectFit = 'fill';
    }
    if (seen && im.complete && im.naturalWidth) draw.push({ el: im, box: b });
  });
  return draw;
}

/** `object-fit: contain`으로 줄인 실제 그림 자리. 그 밖의 값은 상자를 그대로 쓴다. */
function fitBox(im, box) {
  const fit = getComputedStyle(im).objectFit;
  const nw = im.naturalWidth;
  const nh = im.naturalHeight;
  if (fit !== 'contain' || !nw || !nh) return box;
  const k = Math.min(box.width / nw, box.height / nh);
  const w = nw * k;
  const h = nh * k;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2,
    width: w, height: h };
}

/**
 * 뷰포트 좌표 사각형을 캔버스로 그린다.
 * @param {{left:number,top:number,width:number,height:number}} rect  뷰포트 기준
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function captureRect(rect) {
  const scale = Math.min(window.devicePixelRatio || 1, 3);
  const W = Math.max(1, Math.round(rect.width));
  const H = Math.max(1, Math.round(rect.height));

  // 영역을 덮는 가장 가까운 공통 조상 하나만 복제한다(문서 전체를 뜨면 너무 느리다)
  const mid = document.elementFromPoint(
    Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2)),
    Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2))
  );
  let host = mid || document.body;
  while (host && host !== document.body) {
    const b = host.getBoundingClientRect();
    if (b.left <= rect.left + 1 && b.top <= rect.top + 1 &&
        b.right >= rect.left + rect.width - 1 && b.bottom >= rect.top + rect.height - 1) break;
    host = host.parentElement;
  }
  host = host || document.body;
  const hb = host.getBoundingClientRect();

  const clone = host.cloneNode(true);
  inlineStyles(host, clone);
  // ⚠️ 그림 짝짓기는 **지우기 전에** 한다 — 원본과 복제본을 차례로 맞춰 보는데,
  //    복제본에서 먼저 뭔가를 들어내면 그 안에 그림이 있었을 때 차례가 어긋난다.
  const pictures = stubImages(host, clone, rect);
  clone.querySelectorAll('canvas, .penlayer, #selPop, .toc-scrim, script').forEach((n) => n.remove());

  // 잘라낼 위치만큼 밀어 넣는다
  const wrap = document.createElement('div');
  wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrap.style.cssText =
    `position:relative;overflow:hidden;width:${W}px;height:${H}px;` +
    `background:${getComputedStyle(document.body).backgroundColor || '#fff'};`;
  clone.style.position = 'absolute';
  clone.style.left = `${hb.left - rect.left}px`;
  clone.style.top = `${hb.top - rect.top}px`;
  clone.style.width = `${hb.width}px`;
  clone.style.margin = '0';
  wrap.appendChild(clone);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrap)}</foreignObject></svg>`;

  const img = new Image();
  img.decoding = 'sync';
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('캡처 이미지를 만들지 못했습니다.'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });

  const cv = document.createElement('canvas');
  cv.width = Math.round(W * scale);
  cv.height = Math.round(H * scale);
  const cx = cv.getContext('2d');
  cx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff';
  cx.fillRect(0, 0, cv.width, cv.height);
  cx.setTransform(scale, 0, 0, scale, 0, 0);
  cx.drawImage(img, 0, 0);

  // 글을 다 그린 뒤 **그림을 그 위에 올린다**(위 stubImages 참고).
  // 화면 좌표를 자른 자리 기준으로 옮겨서, 보이는 그대로의 위치·크기로 들어간다.
  for (const { el, box } of pictures) {
    const f = fitBox(el, box);
    try {
      cx.drawImage(el, f.left - rect.left, f.top - rect.top, f.width, f.height);
    } catch { /* 한 장이 안 그려져도 나머지는 살린다 */ }
  }
  return cv;
}

export function canvasToBlob(cv) {
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

/**
 * 클립보드에 이미지를 넣는다.
 * iOS Safari는 **사용자 제스처 안에서 즉시** write를 불러야 허용하므로,
 * 비동기로 이미지를 만드는 동안 권한이 날아간다 → ClipboardItem에 Promise를 넘겨
 * "지금 쓰겠다"고 먼저 선언하는 방식을 쓴다.
 */
/**
 * 그림을 클립보드에 넣는다.
 *
 * ⚠️ 사파리는 "사용자가 방금 누른 그 순간"에만 클립보드 쓰기를 허용한다. 그런데 캡처는
 *    SVG를 굽느라 수백 ms가 걸려서, **다 만든 뒤에 쓰면 이미 권한이 식어 있다**
 *    ("캡처했지만 복사 권한이 없습니다" — 2026-10-14). 그래서 blob을 기다리지 말고
 *    **아직 안 끝난 Promise 그대로** 넘긴다. ClipboardItem이 Promise를 받는 이유가 이것이다.
 * @param {Promise<Blob>} blobPromise  await 하지 말고 그대로 넘길 것
 */
export async function copyBlobToClipboard(blobPromise) {
  if (!navigator.clipboard || !window.ClipboardItem) throw new Error('이 브라우저는 이미지 복사를 지원하지 않습니다.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
}
