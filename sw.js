// Service Worker — 앱 셸만 precache 한다.
//
// 의학 콘텐츠(시험 HTML·노트·이미지)는 여기서 캐시하지 않는다: vault가 1.5GB(첨부만 377MB)라
// 통째 캐시가 비현실적이고, iOS Safari는 저장공간 압박 시 origin 캐시를 통째로 축출한다.
// 콘텐츠 캐시는 IndexedDB(js/db.js)에서 "열어본 것만" 따로 관리한다.
//
// 또한 api.github.com 요청은 절대 가로채지 않는다 — 인증 헤더가 붙은 요청을 캐시하면
// 토큰이 섞인 응답이 남을 수 있어서다.

const VERSION = 'v24';
const SHELL = `shell-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/auth.js',
  './js/db.js',
  './js/github.js',
  './js/parser.js',
  './js/quiz.js',
  './js/pen.js',
  './js/wiki.js',
  './js/markdown.js',
  './js/ask.js',
  './js/reader.js',
  './js/search.js',
  './js/gemini.js',
  './js/backup.js',
  './js/capture.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // GitHub API는 통과시킨다(인증 응답을 캐시하지 않기 위해)
  if (url.hostname !== self.location.hostname) return;
  if (e.request.method !== 'GET') return;

  // 앱 셸: 네트워크 우선, 실패 시 캐시(오프라인에서도 앱이 열리게)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
