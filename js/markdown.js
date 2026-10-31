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
 * mermaid 글 → 미리 그려둔 그림의 이름.
 *
 * ⚠️ 이 셈은 vault의 `.claude/scripts/render-mermaid.mjs`에 **똑같이** 들어 있다.
 *    한쪽만 고치면 그림을 영영 못 찾는다 — 달모 쪽 검사가 두 벌이 같은지 본다.
 * 글을 고치면 이름이 바뀌므로 그림도 다시 그려진다(옛 그림은 남아 있어도 안 쓴다).
 */
export function mermaidName(src) {
  const t = String(src).replace(/\r\n/g, '\n').trim();
  let h = 5381;
  for (let k = 0; k < t.length; k++) h = ((h * 33) ^ t.charCodeAt(k)) >>> 0;
  return `.mermaid/m${h.toString(36)}${t.length.toString(36)}.png`;
}

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

    // --- 코드 울타리(```) ---
    // 전에는 아예 안 다뤘다. 그래서 ```mermaid 흐름도가 글자 덩어리로 쏟아졌다
    // (2026-10-19 신고). mermaid는 **맥에서 미리 그려 둔 그림**으로 바꿔 넣는다 —
    // 앱은 그리지 않는다(라이브러리가 1MB가 넘는다). 그림이 없으면 코드를 그대로 보인다.
    const fence = line.match(/^\s*(?:```|~~~)\s*([\w-]*)\s*$/);
    if (fence) {
      const lang = (fence[1] || '').toLowerCase();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;                                      // 닫는 울타리
      const src = body.join('\n');
      if (lang === 'mermaid' && src.trim()) {
        const name = mermaidName(src);
        // 그림이 아직 없으면 코드가 보인다 — 그때 **왜 그런지**는 적어둔다.
        // 안 그러면 "왜 코드가 들어가 있냐"가 된다(2026-10-20 신고).
        out.push(
          `<div class="mmd">`
          + `<img class="embed mmd-img" data-embed="${escapeHtml(name)}" data-mmd="1" alt="흐름도">`
          + `<div class="mmd-why muted">흐름도 그림이 아직 없습니다 — 맥에서 `
          + `<code>node .claude/scripts/render-mermaid.mjs</code> 를 돌리면 그림으로 바뀝니다.</div>`
          + `<pre class="mmd-src"><code>${escapeHtml(src)}</code></pre>`
          + `</div>`
        );
      } else {
        out.push(`<pre><code>${escapeHtml(src)}</code></pre>`);
      }
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

/**
 * AI가 끼워 넣는 TeX 토막을 보통 글자로 바꾼다.
 *
 * 왜(2026-10-15 신고, 스크린샷): 답변에 `$\\rightarrow$`가 **글자 그대로** 떠 있었다.
 * 이 앱은 수식을 그릴 생각이 없고(KaTeX를 넣으면 오프라인 PWA가 수백 KB 무거워진다),
 * 의대 노트에 실제로 필요한 건 화살표·부등호·그리스 문자 정도다. 그 몇 개만 바꾼다.
 * 프롬프트로도 "쓰지 말라"고 일러두지만, **이미 저장된 답**은 이쪽에서 걷어내야 한다.
 */
const TEX = {
  rightarrow: '→', to: '→', Rightarrow: '⇒', longrightarrow: '⟶',
  leftarrow: '←', gets: '←', Leftarrow: '⇐', leftrightarrow: '↔',
  uparrow: '↑', downarrow: '↓', mapsto: '↦',
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '*',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', sim: '~', equiv: '≡', propto: '∝', infty: '∞',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε',
  kappa: 'κ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', Sigma: 'Σ',
  tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Omega: 'Ω', theta: 'θ',
  degree: '°', circ: '°', percent: '%', quad: ' ', qquad: '  ', ',': ' ', ';': ' ',
};
export function deTex(src) {
  let x = String(src);
  if (!/[\\$]/.test(x)) return x;                    // TeX 흔적이 없으면 손대지 않는다
  // ① 껍데기부터 벗긴다. 안쪽을 바꾸고 나면 "수식이었다"는 표가 사라져 못 알아본다.
  x = x.replace(/\\[()[\]]/g, '');
  // ⚠️ `$`는 **달러 기호이기도 하다**. "$5 달러고 $10도"가 통째로 수식으로 읽혀
  //    기호가 지워졌다 — 안쪽에 수식 티(역슬래시·위첨자·아래첨자·중괄호)가 있을 때만 벗긴다.
  x = x.replace(/\$\$?([^$\n]{1,200}?)\$\$?/g, (m, inner) => (/[\\^_{]/.test(inner) ? inner : m));
  // ② 그다음 알맹이를 보통 글자로
  x = x.replace(/\\(?:text|mathrm|mathbf|textbf|mathit|operatorname)\s*\{([^{}]*)\}/g, '$1');
  x = x.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2');
  x = x.replace(/\^\s*\\circ/g, '°').replace(/\^\{?°\}?/g, '°');
  x = x.replace(/\\([%_&#$])/g, '$1');               // 글자로 쓰려고 막아둔 것은 막음표만 뗀다
  x = x.replace(/\\([A-Za-z]+|,|;)/g, (m, k) => (k in TEX ? TEX[k] : m));
  return x.replace(/[ \t]{2,}/g, ' ');
}

// ───────────── 빨간 글씨(메디톡 강조) — <span style="color:red">...</span> ─────────────
//
// 노트 원문에 이 태그를 그대로 적어두면 Obsidian은 별도 처리 없이 바로 빨간 글씨로
// 렌더링한다(Obsidian은 inline HTML을 그대로 그린다). 하지만 이 앱의 renderMarkdown은
// escapeHtml로 모든 `<`를 무조건 글자로 바꿔버려서 똑같이 적어도 달모에서는
// "<span style=..." 가 그대로 글자로 보인다(2026-10-31 신고 — 메디톡 빨간 글씨를
// 두 군데서 똑같이 빨갛게 보이게 해달라는 요청). 그래서 이 한 가지 태그 모양만
// escapeHtml 전에 미리 뽑아 보호해두고, 나머지 인라인 치환이 끝난 뒤에 다시 끼워 넣는다
// — 임의의 HTML을 전부 허용하는 게 아니라 이 좁은 패턴 하나만 통과시킨다(안전).
const COLOR_SPAN = /<span\s+style="color:\s*(red|blue|orange|#[0-9a-fA-F]{3,6})\s*;?\s*">([\s\S]*?)<\/span>/gi;

function inline(s) {
  const colorSpans = [];
  const protected_ = String(s).replace(COLOR_SPAN, (_, color, innerText) => {
    const idx = colorSpans.length;
    colorSpans.push({ color, innerText });
    return ` CS${idx} `;
  });
  let t = escapeHtml(deTex(protected_));

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
    // 2026-10-14에 "비자발적 / 으로"가 벌어진다는 신고를 받고 **한글끼리는 붙이도록**
    // 바꿨었다. 그런데 그건 노트 원문이 낱말 한가운데서 줄을 끊어놓은 탓이었고,
    // 붙이기로 바꾸자 **제대로 띄어 쓴 4,238곳이 전부 들러붙었다**(02_Wiki 실측,
    // "파란색을 떠올렸다면" → "파란색을떠올렸다면"). 고칠 곳은 렌더가 아니라 원문이라
    // 2026-10-15에 되돌린다 — 원문 70여 곳은 그때 같이 이어 붙였다.
    return ' ';
  });

  // 보호해둔 빨간 글씨 span을 다시 끼워 넣는다 — 안쪽 글자도 **굵게/기울임 등 다른
  // 인라인 문법을 쓸 수 있게** 재귀로 한 번 더 처리한다(메디톡 빨간 글씨 안에
  // 볼드가 같이 있는 경우가 있음).
  t = t.replace(/\sCS(\d+)\s/g, (_, idx) => {
    const sp = colorSpans[Number(idx)];
    if (!sp) return '';
    return `<span style="color:${escapeAttr(sp.color)}">${inline(sp.innerText)}</span>`;
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
  // ⚠️ 둘째 인자는 **이름 → 주소 함수**다. 경로 문자열을 넘기면 아래 try가 그 실수를
  //    삼켜 "이미지를 불러오지 못했습니다"로 바꿔 보여준다 — 코드가 틀린 건데 자료가
  //    없는 것처럼 보인다(2026-10-16: 들러보기 창의 그림이 다 그렇게 됐다).
  //    조용히 잘못 그리느니 **여기서 크게 터뜨린다**.
  if (typeof resolve !== 'function') {
    throw new TypeError('hydrateEmbeds: 둘째 인자는 (이름) => 주소 함수여야 합니다');
  }
  const imgs = [...root.querySelectorAll('img.embed[data-embed]')];
  await Promise.all(imgs.map(async (im) => {
    const name = im.dataset.embed;
    const known = imgRatio.get(name);
    try {
      const url = await resolve(name);
      if (!url) {
        if (im.dataset.mmd) { im.remove(); return; }
        im.replaceWith(note(`이미지 없음: ${name}`)); return;
      }
      if (!known) {
        im.addEventListener('load', () => {
          if (im.naturalWidth && im.naturalHeight) {
            imgRatio.set(name, { w: im.naturalWidth, h: im.naturalHeight });
          }
        }, { once: true });
      }
      im.src = url;
    } catch {
      // 미리 그려둔 흐름도가 아직 없으면 **코드를 그대로 보여준다** — 못 읽었다는
      // 쪽지보다 낫다(맥에서 그리면 다음에 그림으로 바뀐다).
      if (im.dataset.mmd) { im.remove(); return; }
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
