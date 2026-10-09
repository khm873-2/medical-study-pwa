// 서비스워커 캐시 우회 검증.
//
// 왜 있나: 배포했는데 아이패드에서 앱이 안 바뀌었다(2026-10-10). sw.js는 "네트워크 우선"
// 이었지만 GitHub Pages가 max-age=600을 주는 탓에 **브라우저 HTTP 캐시가 옛 파일을
// 돌려줘서** 네트워크에 가지도 않았다. 소스에 'no-cache'가 적혀 있는지 보는 것만으로는
// 이게 진짜 효과가 있는지 알 수 없어서, max-age를 주는 서버를 세우고 실제로 비교한다.
//
// 실행: node test/test_swcache.mjs
import http from 'http';
import { createRequire } from 'module';
const pup = createRequire('/tmp/jsdomtest/package.json')('puppeteer-core');

let payload = 'VERSION_OLD';
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/data')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'max-age=600' });
    res.end(payload);
  } else {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'max-age=600' });
    res.end('<!doctype html><title>t</title><body>ok');
  }
});
await new Promise((r) => srv.listen(8791, r));

const b = await pup.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:'shell', args:['--no-sandbox'] });
const p = await b.newPage();
await p.goto('http://localhost:8791/', { waitUntil: 'networkidle0' });

const get = (opts) => p.evaluate(async (o) => (await fetch('/data', o)).text(), opts);

const first = await get({});                 // 캐시에 들어간다
payload = 'VERSION_NEW';                     // 서버 파일이 바뀜
const plain = await get({});                 // 평범한 fetch — HTTP 캐시에서 옛 것
const noCache = await get({ cache: 'no-cache' });  // 서버에 재검증

console.log(`  처음 받은 값          : ${first}`);
console.log(`  서버 변경 후 fetch()  : ${plain}   ${plain === 'VERSION_OLD' ? '← 옛 파일(이게 버그였다)' : ''}`);
console.log(`  no-cache fetch()      : ${noCache} ${noCache === 'VERSION_NEW' ? '← 새 파일 ✅' : '← ❌'}`);

const pass = first === 'VERSION_OLD' && plain === 'VERSION_OLD' && noCache === 'VERSION_NEW';
// sw.js가 실제로 그 옵션을 쓰고 있는지도 같이 본다
const { readFileSync } = await import('fs');
const sw = readFileSync('/Users/hyunminkang/Documents/medical-study-pwa/sw.js', 'utf8');
const used = /fetch\(e\.request,\s*\{\s*cache:\s*'no-cache'\s*\}\)/.test(sw);
console.log(`  sw.js가 no-cache를 쓰는가: ${used ? '✅' : '❌'}`);

const ok = pass && used;
console.log(ok ? '\n✅ 전부 통과' : '\n❌ 실패');
await b.close(); srv.close();
process.exit(ok ? 0 : 1);
