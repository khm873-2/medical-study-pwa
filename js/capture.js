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
}

/** <img>를 data: URL로 바꾼다 — 외부 주소는 SVG 안에서 못 불러온다. */
async function inlineImages(root) {
  const imgs = [...root.querySelectorAll('img')];
  await Promise.all(imgs.map(async (im) => {
    if (im.src.startsWith('data:')) return;
    try {
      const blob = await fetch(im.src).then((r) => r.blob());
      im.src = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
    } catch { im.remove(); }      // 못 가져오면 빼고 나머지라도 살린다
  }));
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
  clone.querySelectorAll('canvas, .penlayer, #selPop, .toc-scrim, script').forEach((n) => n.remove());
  inlineStyles(host, clone);
  await inlineImages(clone);

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
export async function copyBlobToClipboard(blobPromise) {
  if (!navigator.clipboard || !window.ClipboardItem) throw new Error('이 브라우저는 이미지 복사를 지원하지 않습니다.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
}
