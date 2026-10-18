// 검사가 쓰는 바깥 꾸러미(puppeteer-core·jsdom)를 어디에 깔아놨든 찾아준다.
//
// 전엔 `/tmp/jsdomtest`만 봤다. /tmp가 청소되면서 그게 사라졌고, 세 검사(test_dom·
// test_swcache·test_browser)가 **말없이 빠진 채** "전부 통과"로 보였다(2026-10-18).
// 그래서 여기서 한 곳에 모으고, 못 찾으면 조용히 넘기지 않고 고치는 법을 알려준다.
import { createRequire } from 'module';

const WHERE = [
  `${process.env.HOME}/.cache/dalmo-test/package.json`,   // 여기가 집이다(/tmp는 청소된다)
  '/tmp/jsdomtest/package.json',                          // 옛 자리
];

export function dep(name) {
  for (const w of WHERE) {
    try { return createRequire(w)(name); } catch {}
  }
  return null;
}

/** 없으면 1로 죽는다 — run_all.sh가 빨갛게 되도록. */
export function needDep(name) {
  const m = dep(name);
  if (m) return m;
  console.log(`❌ ${name} 없음 — 이 검사를 돌릴 수 없습니다.`);
  console.log(`   고치려면:  mkdir -p ~/.cache/dalmo-test && cd ~/.cache/dalmo-test \\`);
  console.log(`              && echo '{"private":true}' > package.json \\`);
  console.log(`              && npm i ${name} --cache /tmp/npmcache`);
  process.exit(1);
}
