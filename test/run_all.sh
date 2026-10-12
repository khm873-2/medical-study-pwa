#!/bin/bash
# 전체 테스트. 실제 Chrome 검증까지 포함한다 — CSS 캐스케이드·레이아웃 버그는
# 손수 만든 DOM 스텁으로는 절대 안 잡힌다(2026-10-09에 두 번 데였다).
set -u
cd "$(dirname "$0")/.."
fail=0

# ── 사전 점검: 결과 요약이 파일 **맨 끝**에 있는가 ──
# 요약(`통과 N건` + process.exit)을 파일 중간에 두면, 그 뒤에 붙인 검사는 돌긴 하는데
# 결과가 집계되지도 보고되지도 않는다. 실제로 그렇게 묻혀 있던 검사가 둘 있었고
# 그중 하나는 **실패 7건을 숨기고 있었다**(2026-10-12). 기계로 막는다.
for f in test/test_*.mjs; do
  n=$(grep -n '통과 \${pass}건' "$f" | head -1 | cut -d: -f1)
  [ -z "$n" ] && continue
  rest=$(awk -v n="$n" 'NR>n' "$f" | grep -c "ok(")
  if [ "$rest" -gt 0 ]; then
    echo "❌ $(basename "$f"): 결과 요약 뒤에 검사 ${rest}개가 있다 — 요약을 맨 끝으로 옮길 것"
    fail=1
  fi
done
for f in test/test_app.mjs test/test_gemini.mjs test/test_pen.mjs test/test_jokbo.mjs \
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
