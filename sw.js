// Service Worker — 앱 셸만 precache 한다.
//
// 의학 콘텐츠(시험 HTML·노트·이미지)는 여기서 캐시하지 않는다: vault가 1.5GB(첨부만 377MB)라
// 통째 캐시가 비현실적이고, iOS Safari는 저장공간 압박 시 origin 캐시를 통째로 축출한다.
// 콘텐츠 캐시는 IndexedDB(js/db.js)에서 "열어본 것만" 따로 관리한다.
//
// 또한 api.github.com 요청은 절대 가로채지 않는다 — 인증 헤더가 붙은 요청을 캐시하면
// 토큰이 섞인 응답이 남을 수 있어서다.

const VERSION = 'v30';
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
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting())
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
  //
  // ⚠️ cache:'no-cache'가 **반드시** 있어야 한다. GitHub Pages가 max-age=600을 주는데,
  //    그냥 fetch하면 브라우저 HTTP 캐시가 10분간 옛 파일을 돌려줘서 "네트워크 우선"이
  //    무력화된다 — 배포해도 아이패드에서 안 바뀌던 원인이다(2026-10-10).
  //    no-cache는 캐시를 안 쓰는 게 아니라 **매번 서버에 물어본다**(ETag 검증).
  //    안 바뀌었으면 304라서 데이터도 거의 안 쓴다.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});

// 앱이 "지금 당장 새 버전으로" 요청하면 기다리지 않고 교체한다.
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'VERSION') {
    const reply = { type: 'VERSION', version: VERSION };
    if (e.ports && e.ports[0]) e.ports[0].postMessage(reply);
    else if (e.source) e.source.postMessage(reply);
  }
});
