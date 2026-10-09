// 검색 · 오프라인 저장.
//
// 검색 전략: vault 전체(1,800여 md)를 다 받아오는 건 비현실적이라, **이미 기기에 캐시된 것**
// 안에서만 찾는다. 모의고사는 한 번 열면 캐시되므로 사실상 "내가 본 것 전부"가 대상이 된다.
// 과목을 오프라인 저장해두면 그 과목은 통째로 검색 범위에 들어온다.

import { listDir, getText } from './github.js';
import { cacheGet, cacheSet, kvGet, kvSet } from './db.js';
import { parseExamHtml, prettyExamName } from './parser.js';

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
  // 연계노트도 같이 받아둔다 — 위키 패널이 오프라인에서도 뜨게
  const roots = ['98_예습노트_보관', '02_Wiki'];
  for (const n of notes) {
    for (const r of roots) {
      let found = false;
      try {
        const subs = await listDir(r);
        for (const s of subs.filter((e) => e.type === 'dir')) {
          const p = `${s.path}/${n}.md`;
          try { await getText(p); await addCachedPath(p); found = true; break; } catch {}
        }
      } catch {}
      if (found) break;
    }
    done++;
    onProgress(done, files.length + notes.size, n);
  }
  return done;
}

/** 캐시된 범위 안에서 검색. 문항과 노트 둘 다 뒤진다. */
export async function search(query, limit = 40) {
  const q = String(query).trim();
  if (q.length < 2) return [];
  const needle = q.toLowerCase();
  const paths = await cachedPaths();
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
        const hay = `${item.q} ${(item.opts || []).join(' ')} ${item.explain || ''}`;
        const i = hay.toLowerCase().indexOf(needle);
        if (i >= 0) {
          hits.push({
            kind: 'question',
            title: `${examName} — ${item.num}번`,
            snippet: snip(hay, i, q.length),
            path: p,
            qnum: item.num,
          });
          if (hits.length >= limit) break;
        }
      }
    } else if (p.endsWith('.md')) {
      const i = text.toLowerCase().indexOf(needle);
      if (i >= 0) {
        hits.push({
          kind: 'note',
          title: p.split('/').pop().replace(/\.md$/, ''),
          snippet: snip(text, i, q.length),
          path: p,
        });
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
