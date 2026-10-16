#!/bin/bash
# vault 그림에서 글자를 뽑아 attachments/.ocr/ 에 적어둔다. 맥에서만 돈다.
set -u
VAULT="${VAULT:-$HOME/Documents/Medical_vault}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$VAULT/attachments"
OUT="$SRC/.ocr"
BIN="$HERE/ocr"

[ -d "$SRC" ] || { echo "그림 폴더가 없습니다: $SRC"; exit 1; }
# 처음이거나 소스가 더 새로우면 다시 빌드한다
if [ ! -x "$BIN" ] || [ "$HERE/ocr.swift" -nt "$BIN" ]; then
  echo "빌드 중…"
  swiftc -O "$HERE/ocr.swift" -o "$BIN" || exit 1
fi
mkdir -p "$OUT"

all=0; done_=0; skip=0; text=0
while IFS= read -r f; do
  all=$((all+1))
  name="$(basename "$f")"
  dst="$OUT/$name.json"
  if [ "${1:-}" != "--all" ] && [ -f "$dst" ] && [ "$dst" -nt "$f" ]; then
    skip=$((skip+1)); continue
  fi
  if "$BIN" "$f" > "$dst.tmp" 2>/dev/null && [ -s "$dst.tmp" ]; then
    mv "$dst.tmp" "$dst"
    done_=$((done_+1))
    grep -q '"conf":1' "$dst" && text=$((text+1))
  else
    rm -f "$dst.tmp"
  fi
  if [ $((all % 100)) -eq 0 ]; then echo "  …${all}장"; fi
done < <(find "$SRC" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \))

echo "그림 ${all}장 · 새로 읽음 ${done_} · 건너뜀 ${skip} · 글자가 나온 그림 ${text}"
echo "→ $OUT"
echo "vault에 커밋해야 아이패드에서도 보입니다."
