// 검색 · 오프라인 저장.
//
// 검색 전략: vault 전체(1,800여 md)를 다 받아오는 건 비현실적이라, **이미 기기에 캐시된 것**
// 안에서만 찾는다. 모의고사는 한 번 열면 캐시되므로 사실상 "내가 본 것 전부"가 대상이 된다.
// 과목을 오프라인 저장해두면 그 과목은 통째로 검색 범위에 들어온다.

import { listDir, getText } from './github.js';
import { cacheGet, cacheSet, kvGet, kvSet } from './db.js';
import { parseExamHtml, prettyExamName } from './parser.js';
import { resolveNotePath } from './wiki.js';

/** 캐시에 들어있는 경로 목록(= 검색 가능 범위). */
async function cachedPaths() {
  return (await kvGet('cached_paths')) || [];
}
async function addCachedPath(p) {
  const list = await cachedPaths();
  if (!list.includes(p)) { list.push(p); await kvSet('cached_paths', list); }
}
export async function noteCached(path) { await addCachedPath(path); }

/**
 * 과목 하나를 통째로 받아 캐시한다(모의고사 html + 짝 md + 연계노트).
 * @param {Function} onProgress (done, total, label)
 */
export async function cacheSubject(subject, onProgress = () => {}) {
  const files = (await listDir(`06_모의고사/${subject}`))
    .filter((f) => f.type === 'file' && (f.name.endsWith('.html') || f.name.endsWith('.md')));
  let done = 0;
  const notes = new Set();
  for (const f of files) {
    try {
      const text = await getText(f.path);
      await addCachedPath(f.path);
      if (f.name.endsWith('.md')) {
        const m = text.match(/연계노트:\s*"?\[\[([^\]]+)\]\]"?/);
        if (m) notes.add(m[1]);
      }
    } catch {}
    done++;
    onProgress(done, files.length + notes.size, f.name);
  }
  // 연계노트도 같이 받아둔다 — 위키 패널이 오프라인에서도 뜨게.
  // 경로는 wiki.js가 쓰는 것과 **같은 규칙**으로 찾는다. 따로 적어두면 한쪽만 고쳐져서
  // "앱에선 보이는데 오프라인으로는 안 받아지는" 노트가 생긴다(2026-10-12).
  for (const n of notes) {
    const p = await resolveNotePath(n);
    if (p) { try { await getText(p); await addCachedPath(p); } catch {} }
    done++;
    onProgress(done, files.length + notes.size, n);
  }
  return done;
}

/**
 * 찾을 말을 "맞는지 보는 함수"로 바꾼다.
 *
 * 평소엔 그냥 글자 비교지만, 정규식을 켜면 grep처럼 쓸 수 있다
 * (obsidian-another-quick-switcher의 custom search를 본뜬 것 — 2026-10-13 요청).
 * 한글은 NFC/NFD가 섞여 들어와 "분명히 있는데 안 찾아지는" 일이 잦아서 양쪽 다 맞춘다.
 */
/** 자소가 갈라진 글자를 모아 한 글자로. 찾기와 보여주기가 **같은 글**을 써야 자리가 안 어긋난다. */
const norm = (t) => String(t).normalize('NFC');

/** 한 파일에서 보여줄 최대 건수 — 한 노트가 결과를 다 먹지 않게. */
const PER_FILE = 8;

export function matcher(query, { regex = false, caseSensitive = false } = {}) {
  const q = String(query).normalize('NFC');
  if (regex) {
    let re;
    try { re = new RegExp(q, caseSensitive ? 'g' : 'gi'); } catch { return null; }
    return (text) => {
      re.lastIndex = 0;
      const m = re.exec(String(text).normalize('NFC'));
      return m ? { at: m.index, len: m[0].length || 1 } : null;
    };
  }
  const needle = caseSensitive ? q : q.toLowerCase();
  return (text) => {
    const hay = caseSensitive ? String(text).normalize('NFC')
      : String(text).normalize('NFC').toLowerCase();
    const i = hay.indexOf(needle);
    return i >= 0 ? { at: i, len: needle.length } : null;
  };
  // ⚠️ 돌려주는 자리(at)는 **NFC로 고친 글** 기준이다. 원본에 자소가 갈라진 글자가
  //    섞여 있으면 글자 수가 달라서, 원본을 그대로 잘라 보여주면 **엉뚱한 데가
  //    노랗게 칠해진다**(2026-10-14 신고: "화상센터"를 찾았는데 "센터 이송"이 칠해짐).
  //    그래서 잘라 보여줄 때도 반드시 norm()을 거친 글을 쓴다.
}

/** 한 글 안에서 맞는 자리를 **전부** 찾는다(이 문서 안에서 찾을 때 쓴다). */
export function findAll(text, match, limit = 200) {
  const out = [];
  let from = 0;
  const src = String(text);
  while (out.length < limit && from < src.length) {
    const r = match(src.slice(from));
    if (!r) break;
    out.push({ at: from + r.at, len: r.len });
    from += r.at + Math.max(1, r.len);
  }
  return out;
}

export { snip };

/**
 * 캐시된 범위 안에서 검색. 문항과 노트 둘 다 뒤진다.
 * @param {object} [opt]
 * @param {string} [opt.dir]   이 경로로 시작하는 것만(폴더 한정)
 * @param {boolean} [opt.regex]
 * @param {boolean} [opt.caseSensitive]
 */
export async function search(query, limit = 40, opt = {}) {
  const q = String(query).trim();
  if (q.length < 2) return [];
  const match = matcher(q, opt);
  if (!match) return [];
  let paths = await cachedPaths();
  if (opt.dir) {
    const d = opt.dir.normalize('NFC');
    paths = paths.filter((p) => p.normalize('NFC').startsWith(d));
  }
  const hits = [];

  for (const p of paths) {
    if (hits.length >= limit) break;
    const entry = await cacheGet(p);
    if (!entry) continue;
    const text = entry.data;

    if (p.endsWith('.html') && p.startsWith('06_모의고사/')) {
      // 문항 단위로 찾는다
      let qs;
      try { qs = parseExamHtml(text).questions; } catch { continue; }
      const examName = prettyExamName(p.split('/').pop());
      for (const item of qs) {
        const hay = norm(`${item.q} ${(item.opts || []).join(' ')} ${item.explain || ''}`);
        const r = match(hay);
        if (r) {
          hits.push({
            kind: 'question',
            title: `${examName} — ${item.num}번`,
            snippet: snip(hay, r.at, r.len),
            path: p,
            qnum: item.num,
          });
          if (hits.length >= limit) break;
        }
      }
    } else if (p.endsWith('.md')) {
      // 한 노트에서 **하나만** 찾고 있었다 — 열 군데 나와도 1건으로 세어져서
      // "전체를 다 찾은 것 같지 않다"가 됐다(2026-10-14 신고). 전부 찾는다.
      const hay = norm(text);
      const name = p.split('/').pop().replace(/\.md$/, '');
      const spots = findAll(hay, match, PER_FILE);
      for (const sp of spots) {
        hits.push({
          kind: 'note',
          title: spots.length > 1 ? `${name}  (${spots.indexOf(sp) + 1}/${spots.length})` : name,
          snippet: snip(hay, sp.at, sp.len),
          path: p,
          at: sp.at,
        });
        if (hits.length >= limit) break;
      }
    }
  }
  return hits;
}

function snip(text, at, len) {
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + len + 70);
  const pre = start > 0 ? '…' : '';
  const post = end < text.length ? '…' : '';
  const raw = text.slice(start, end).replace(/\n+/g, ' ');
  const rel = at - start;
  return {
    before: pre + raw.slice(0, rel),
    match: raw.slice(rel, rel + len),
    after: raw.slice(rel + len) + post,
  };
}

/** 저장 공간 사용량. */
export async function storageInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    const paths = await cachedPaths();
    return {
      usageMB: est?.usage ? est.usage / 1024 / 1024 : null,
      quotaMB: est?.quota ? est.quota / 1024 / 1024 : null,
      files: paths.length,
    };
  } catch {
    return { usageMB: null, quotaMB: null, files: 0 };
  }
}

export async function clearCachedPaths() { await kvSet('cached_paths', []); }
