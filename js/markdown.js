// vault 노트용 경량 마크다운 렌더러.
//
// 범용 라이브러리를 쓰지 않는 이유: 이 노트들이 쓰는 문법이 한정적이고(아래 목록),
// 대신 Obsidian 전용 문법(콜아웃·위키링크·임베드)을 반드시 처리해야 해서다.
// 외부 CDN을 쓰지 않는다는 기존 모의고사 HTML의 관례도 유지한다.
//
// 지원: 헤딩 · 콜아웃(> [!type]- 제목, 접힘) · {{직접 지정한 빈칸}} · ==하이라이트== · **굵게** · *기울임* ·
//       `코드` · 목록 · 표 · 인용 · 위키링크 [[...]] · 이미지 임베드 ![[...]] · 수평선

const CALLOUT_LABEL = {
  success: '✅', example: '📖', warning: '⚠️', info: 'ℹ️', tip: '💡',
  note: '📝', abstract: '📄', question: '❓', danger: '🚨', bug: '🐞',
  'image-needed': '🖼️',
};

// 그림의 본디 비율을 기억해둔다 — 한 번 본 그림은 **자리를 미리 잡아준다**.
// 이게 없으면 그림이 뜰 때마다 아래 글이 밀려 내려간다(2026-10-14: 나누기를 껐다 켤
// 때마다 "쭉쭉 밀리면서 몇 초간 못 읽는다"). 이름만 키로 쓰므로 가볍다.
const imgRatio = new Map();

/**
 * 임베드 그림 태그.
 *
 * ⚠️ 비율은 **여기서**(HTML을 만들 때) 박아야 한다. 나중에 JS로 붙이면 그 전에 이미
 *    한 번 배치가 끝나서, 결국 글이 밀린다(2026-10-14 실측: 879px 밀림).
 */
function imgTag(name) {
  const d = imgRatio.get(name);
  const img = `<img class="embed" data-embed="${escapeHtml(name)}" alt="${escapeHtml(name)}">`;
  if (!d) return img;
  // ⚠️ `<img>`에 width/height를 줘도 **src가 없으면 자리를 안 비운다** — 본디 크기가
  //    없어서다(2026-10-14 실측). 그래서 바깥에 평범한 상자를 하나 두고 거기에 비율을
  //    건다. 상자는 src와 무관하게 바로 높이가 잡히므로 그림이 뜰 때 글이 안 밀린다.
  return `<span class="embed-box" style="aspect-ratio:${d.w}/${d.h}">${img}</span>`;
}

// `>` 없이 줄 맨 앞에 와도 콜아웃으로 볼 종류들. 아무 `[!xxx]`나 받으면 글 속의
// 기호 언급까지 콜아웃이 되어버린다.
const KNOWN_CALLOUT = new RegExp(
  `^\\s*\\[!(${Object.keys(CALLOUT_LABEL).join('|')}|quote|summary|caution|failure|todo)\\][+-]?`, 'i');

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 마크다운 → HTML.
 * @param {string} md
 * @param {object} opts
 * @param {Function} opts.onImage  (파일명) => void — 임베드 이미지 발견 시 호출(지연 로딩용).
 *                                 img 태그에 data-embed="파일명"을 달아두고 나중에 src를 채운다.
 */
let taskSeq = 0;
const escapeAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function renderMarkdown(md, opts = {}) {
  taskSeq = 0;              // 이 글 안에서 체크 상자가 나온 순서(원본과 맞춰 센다)
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  // 앞머리(---로 감싼 YAML)는 화면에 보여줄 것이 아니다. 거기 적힌 메모가 본문처럼
  // 떠서 `[!example]-` 같은 기호가 글자로 샜다(2026-10-14 발견).
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }

  while (i < lines.length) {
    const line = lines[i];

    // --- 콜아웃: > [!type]- 제목 ---
    // 앞에 공백이 있어도 받는다 — 노트에 들여써서 적어둔 곳이 있다(2026-10-14 발견).
    //
    // `>` 가 없는 꼴도 받는다. 콜아웃 안에 콜아웃을 쓸 때 `> >` 대신 `>` 하나로 적어둔
    // 곳이 많은데, 바깥 콜아웃이 `> ` 를 한 겹 벗겨내면 `[!note] …` 만 남는다.
    // **아는 종류**일 때만 받으므로, 글 속에서 기호를 언급한 문장은 안 걸린다.
    const co = line.match(/^\s*>\s*\[!([\w-]+)\]([+-]?)\s*(.*)$/)
      || (KNOWN_CALLOUT.test(line) && line.match(/^\s*\[!([\w-]+)\]([+-]?)\s*(.*)$/));
    if (co) {
      const [, type, fold, title] = co;
      const body = [];
      i++;
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const icon = CALLOUT_LABEL[type.toLowerCase()] || '•';
      const cap = title.trim() || type;
      // '-' = 기본 접힘, '+' = 기본 펼침, 없으면 펼침
      const open = fold === '-' ? '' : ' open';
      out.push(
        `<details class="cal cal-${escapeHtml(type.toLowerCase())}"${open}>` +
        `<summary>${icon} ${inline(cap)}</summary>` +
        `<div class="cal-body">${renderMarkdown(body.join('\n'), opts)}</div>` +
        `</details>`
      );
      continue;
    }

    // --- 헤딩 ---
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = Math.min(h[1].length + 2, 6); // 노트의 ##를 화면에선 h4쯤으로
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // --- 수평선 ---
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // --- 표 ---
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = splitRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        '<div class="tablewrap"><table><thead><tr>' +
        head.map((c) => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>'
      );
      continue;
    }

    // --- 목록 (중첩 1단계까지) ---
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      const extras = [];            // 항목마다 딸린 **블록**(들여쓴 콜아웃·인용)
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        extras.push([]);
        i++;
        // 이어지는 들여쓴 줄은 같은 항목에 붙인다
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          // ⚠️ 들여쓴 `>` 는 **그 항목 안의 콜아웃**이다(퀴즈 밑에 접어둔 정답 등).
          //    글로 이어붙이면 `> [!success]- 정답 >` 이 그대로 글자로 샌다
          //    (2026-10-14 신고: "이렇게 깨져서 나오는 거"). 따로 모아 블록으로 그린다.
          if (/^\s*>/.test(lines[i])) {
            extras[extras.length - 1].push(lines[i].replace(/^\s+/, ''));
          } else {
            items[items.length - 1] += ' ' + lines[i].trim();
          }
          i++;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      // 체크 상자 — `- [ ] 채택 (안 1)`. 노트에서 **고르는 일**이 실제로 있어서
      // (암기법 후보 중 하나 채택 등) 눌러서 바꿀 수 있게 한다(2026-10-14 요청).
      const tail = (k) => (extras[k] && extras[k].length
        ? renderMarkdown(extras[k].join('\n'), opts) : '');
      out.push(`<${tag}>` + items.map((t, k) => {
        const m = t.match(/^\[([ xX])\]\s*(.*)$/);
        if (!m) return `<li>${inline(t)}${tail(k)}</li>`;
        const on = m[1] !== ' ';
        // ⚠️ 글만으로는 어느 줄인지 못 찾는다 — "채택 (안 1)"이 한 노트에 13번 나온다
        //    (2026-10-14: "같은 줄이 13개라 어느 것인지 알 수 없습니다"). **몇 번째 상자인지**를
        //    같이 적어둔다. 원본에서도 같은 순서로 세면 정확히 그 줄을 집는다.
        const idx = taskSeq++;
        return `<li class="task${on ? ' done' : ''}">`
          + `<button class="task-box" role="checkbox" aria-checked="${on}" `
          + `data-idx="${idx}" data-text="${escapeAttr(m[2])}">${on ? '☑' : '☐'}</button>`
          + `<span class="task-t">${inline(m[2])}</span>${tail(k)}</li>`;
      }).join('') + `</${tag}>`);
      continue;
    }

    // --- 인용 ---
    if (/^>/.test(line)) {
      const body = [];
      while (i < lines.length && /^>/.test(lines[i]) && !/^>\s*\[!/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), opts)}</blockquote>`);
      continue;
    }

    // --- 빈 줄 ---
    if (!line.trim()) { i++; continue; }

    // --- 문단 ---
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
    if (para.length) out.push(`<p>${inline(para.join('\n'))}</p>`);
    else i++;
  }
  return out.join('\n');
}

function isBlockStart(l) {
  return /^(#{1,6}\s|>|\s*([-*+]|\d+\.)\s|\s*\||\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(l);
}

function splitRow(l) {
  return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 인라인 문법 — 반드시 escape 먼저 하고 치환한다. */
// ───────────── MarginNote 슬라이드 링크 (2026-10-12) ─────────────
//
// 위키 노트에는 `[슬라이드 p.12]` 표기가 1,400개 넘게 이미 깔려 있다(/lecture-integrate가
// 붙인다). 이걸 눌러서 MarginNote의 그 페이지로 바로 넘어가게 한다.
//
// 스킴은 MarginNote 4가 실제로 등록·문서화한 것이다(앱 바이너리에서 확인, 2026-10-12):
//     marginnote4app://page/{md5}/p12     특정 문서 12쪽
//     marginnote4app://page/0/p12         **지금 열려 있는 문서**의 12쪽
//     marginnote4app://page/{md5}/p10-15  범위
//
// `{md5}`는 파일의 MD5가 아니라 MarginNote 내부 ID라 계산으로는 못 구한다.
// 맥에서 `.claude/scripts/export_marginnote_map.py`가 뽑아 vault에 넣어둔 걸 쓴다.
//
// ⚠️ **2026-10-12: 꺼둔다.** 저 `page/...` 포맷은 MarginNote 앱 바이너리에 분명히
//    적혀 있지만, 알고 보니 **MCP(AI 도구) 서버가 쓰는 ID 표기**이지 URL 스킴
//    핸들러의 라우트가 아니었다. 실제로 열어보면 앱만 뜨고 그 페이지로 가지 않는다
//    (맥에서 `open`으로 book/open/page 네 가지를 시험해 전부 방문 기록이 안 바뀜,
//     아이패드에서도 같은 증상). 스킴 자체는 등록돼 있어서 "열리긴 하는데 안 간다"는
//    가장 헷갈리는 모양이 된다 — 그래서 링크를 아예 안 만든다.
//
//    맞는 라우트를 알아내면 이 상수만 true로 돌리면 된다. 나머지(문서 ID 맵·PDF
//    이름 매칭·테스트)는 그대로 살아 있다.
const SLIDE_LINKS = false;

let slideDocMd5 = null;     // 지금 보고 있는 노트의 문서 ID(모르면 null)

/** 노트를 열 때 한 번 불러준다. */
export function setSlideDoc(md5) { slideDocMd5 = md5 || null; }

/** `p.12` · `p.10~15` · `p.4,7` 를 MarginNote가 받는 꼴로. */
function slidePages(raw) {
  const t = String(raw).replace(/\s/g, '');
  if (/^\d+$/.test(t)) return `p${t}`;
  const range = t.match(/^(\d+)[~\-–](\d+)$/);
  if (range) return `p${range[1]}-${range[2]}`;
  const list = t.split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
  return list.length ? `p${list.join(',')}` : null;
}

function inline(s) {
  let t = escapeHtml(s);

  // [슬라이드 p.12] → 링크. 지금은 **꺼져 있다**(아래 SLIDE_LINKS 주석 참고).
  if (SLIDE_LINKS) {
    t = t.replace(/\[슬라이드\s*p\.\s*([\d\s,~\-–]+)\]/g, (whole, pages) => {
      const p = slidePages(pages);
      if (!p) return whole;
      const doc = slideDocMd5 || '0';
      return `<a class="slide-link" href="marginnote4app://page/${doc}/${p}"`
        + ` title="MarginNote에서 열기">📄 ${escapeHtml(whole.slice(1, -1))}</a>`;
    });
  }

  // 이미지 임베드 ![[파일명]] — src는 나중에 채운다(지연 로딩)
  t = t.replace(/!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g, (_, f) =>
    imgTag(f.trim()));

  // 위키링크 [[노트]] 또는 [[노트|표시]]
  t = t.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, n, label) =>
    `<span class="wikilink" data-note="${escapeHtml(n.trim())}">${escapeHtml((label || n).trim())}</span>`);

  // 코드 — 다른 치환이 안 먹도록 먼저 뽑아두면 좋지만, 이 노트들엔 코드 안에 마크업이 거의
  // 없어서 단순 치환으로 충분하다.
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);

  // {{...}} — **직접 지정한 빈칸**. 자동 탐지가 빗나갈 때 노트에 이렇게 적으면 그대로 쓴다.
  // 옵시디언 Spaced Repetition 플러그인이 쓰는 문법과 같아서 그쪽과도 호환된다.
  t = t.replace(/\{\{([^{}]+)\}\}/g, '<span class="ask">$1</span>');
  // ⚠️ `[^=]+` 로 하면 **안쪽에 `=` 가 하나라도 있으면 통째로 안 걸린다** —
  //    "==우발적 저체온증(accidental hypothermia) = 심부체온이…==" 가 그래서 `==` 째로
  //    글자로 남았다(2026-10-14 신고). 닫는 `==` 가 아닌 `=` 는 안쪽에 허용한다.
  t = t.replace(/==((?:[^=]|=(?!=))+)==/g, '<mark>$1</mark>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 줄바꿈 처리 — 마크다운 표준대로 **한 줄 개행은 공백**으로 합친다.
  //
  // 예전엔 전부 <br>로 바꿨는데, 노트 원문이 "읽기 좋으라고" 넣어둔 개행까지 살아나서
  // 좁은 패널에선 문장이 중간에 끊기고 오른쪽에 큰 공백이 생겼다(2026-10-09 스크린샷).
  // 다만 "ㄱ. ~" "① ~" 처럼 **항목이 줄마다 나뉘는 경우**는 개행을 지켜야 읽힌다.
  t = t.replace(/\n/g, (m, off) => {
    const next = t.slice(off + 1, off + 14);
    if (/^\s*([ㄱ-ㅎ가-힣]\.|[①-⑳]|[0-9]+[.)]|[-*+]\s|[A-Z]\d*[.)])/.test(next)) return '<br>';
    // 한글과 한글 사이의 개행은 **붙인다**. 공백을 끼우면 "비자발적 / 으로"처럼
    // 낱말 한가운데가 벌어진다 — 노트 원문이 보기 좋으라고 줄을 나눠 적기 때문이다
    // (2026-10-14 신고). 영문은 띄어 써야 하므로 그대로 공백을 둔다.
    const prev = t.slice(Math.max(0, off - 1), off);
    return /[가-힣]/.test(prev) && /^[가-힣]/.test(next) ? '' : ' ';
  });
  return t;
}

/** 렌더 결과 안의 ![[...]] 임베드를 실제 이미지로 채운다. */
/**
 * `![[파일]]` 자리를 실제 그림으로 채운다.
 *
 * 자리는 이미 renderMarkdown이 잡아뒀다(아는 그림이면). 여기서는 **한꺼번에** 받는다 —
 * 하나씩 기다리면 장마다 한 번씩 밀린다.
 */
export async function hydrateEmbeds(root, resolve) {
  const imgs = [...root.querySelectorAll('img.embed[data-embed]')];
  await Promise.all(imgs.map(async (im) => {
    const name = im.dataset.embed;
    const known = imgRatio.get(name);
    try {
      const url = await resolve(name);
      if (!url) { im.replaceWith(note(`이미지 없음: ${name}`)); return; }
      if (!known) {
        im.addEventListener('load', () => {
          if (im.naturalWidth && im.naturalHeight) {
            imgRatio.set(name, { w: im.naturalWidth, h: im.naturalHeight });
          }
        }, { once: true });
      }
      im.src = url;
    } catch {
      im.replaceWith(note(`이미지를 불러오지 못했습니다: ${name}`));
    }
  }));
}

function note(text) {
  const d = document.createElement('div');
  d.className = 'img-loading';
  d.textContent = text;
  return d;
}
