#!/bin/bash
# 전체 테스트. 실제 Chrome 검증까지 포함한다 — CSS 캐스케이드·레이아웃 버그는
# 손수 만든 DOM 스텁으로는 절대 안 잡힌다(2026-10-09에 두 번 데였다).
set -u
cd "$(dirname "$0")/.."
fail=0
for f in test/test_app.mjs test/test_gemini.mjs test/test_pen.mjs \
         test/test_phase3.mjs test/test_phase45.mjs test/test_dom.mjs test/test_match.mjs test/test_backup.mjs test/test_swcache.mjs \
         test/test_attempts.mjs test/test_css.mjs; do
  printf '%-22s ' "$(basename "$f")"
  out=$(node "$f" 2>&1) || fail=1
  echo "$out" | tail -1
  [ -n "${VERBOSE:-}" ] && echo "$out"
done

# 실제 Chrome — 로컬 서버를 띄워서 돈다
printf '%-22s ' 'test_browser.mjs'
python3 -m http.server 8777 >/dev/null 2>&1 &
srv=$!
sleep 1.2
out=$(node test/test_browser.mjs 2>&1) || fail=1
kill $srv 2>/dev/null
echo "$out" | tail -1
[ -n "${VERBOSE:-}" ] && echo "$out"

[ $fail -eq 0 ] && echo "✅ 전체 통과" || echo "❌ 실패 있음 (VERBOSE=1 로 상세 확인)"
exit $fail
