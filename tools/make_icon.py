#!/usr/bin/env python3
"""'달모' 앱 아이콘 — 달리는 지하철에서 푸는 의학문제.

홈화면의 작은 크기(60~120px)에서도 읽혀야 하므로 색 면적을 크게 잡고
디테일은 최소로 뒀다. 앞코는 둥근 사각형 하나로 만들어 실루엣이 매끈하게.
"""
from PIL import Image, ImageDraw

BG1, BG2 = (92, 140, 255), (128, 96, 255)      # 파랑 → 보라
TRAIN = (255, 255, 255)
WIN = (33, 43, 76)
ACCENT = (255, 206, 92)                        # 전조등·속도선
MINT = (82, 225, 188)                          # 정답 체크
DIM = (168, 182, 220)                          # 안 고른 선지


def draw(size, maskable=False):
    S = 1024                                   # 크게 그리고 줄인다(안티앨리어싱)
    im = Image.new('RGB', (S, S), BG1)
    d = ImageDraw.Draw(im)

    for i in range(S):                         # 세로 그라데이션
        t = i / S
        d.line([(0, i), (S, i)], fill=tuple(
            int(BG1[k] + (BG2[k] - BG1[k]) * t) for k in range(3)))

    # maskable은 바깥 테두리가 잘릴 수 있어 안쪽으로 모은다
    pad = 0.19 if maskable else 0.11
    L, R = S * pad, S * (1 - pad)
    W = R - L
    cy = S * 0.5

    # ── 속도선: 왼쪽으로 흐르는 잔상 ──
    for yy, ln in ((-0.20, 0.30), (-0.02, 0.44), (0.16, 0.24)):
        y = cy + W * yy
        x2 = L + W * 0.06
        d.rounded_rectangle([x2 - W * ln, y - W * 0.024, x2, y + W * 0.024],
                            radius=W * 0.024, fill=ACCENT)

    # ── 지하철 몸통 — 앞(왼쪽)이 더 둥근 한 덩어리 ──
    bx0, bx1 = L + W * 0.21, R
    by0, by1 = cy - W * 0.285, cy + W * 0.255
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=W * 0.155, fill=TRAIN)
    # 앞코를 한 번 더 겹쳐 둥글게 (반지름을 키운 같은 높이의 사각형)
    d.rounded_rectangle([bx0, by0, bx0 + W * 0.40, by1], radius=W * 0.26, fill=TRAIN)

    # ── 창문: 여기에 문제가 떠 있다 ──
    wx0, wy0 = bx0 + W * 0.115, by0 + W * 0.085
    wx1, wy1 = bx1 - W * 0.075, by1 - W * 0.155
    d.rounded_rectangle([wx0, wy0, wx1, wy1], radius=W * 0.062, fill=WIN)

    # 객관식 선지처럼 보이는 막대 3줄 — 마지막이 정답(민트)
    lx = wx0 + W * 0.052
    lw = (wx1 - wx0) - W * 0.155          # 체크 자리를 비워둔다
    th = W * 0.038
    ty = wy0 + W * 0.052
    for frac, col in ((1.00, DIM), (0.70, DIM), (0.88, MINT)):
        d.rounded_rectangle([lx, ty, lx + lw * frac, ty + th], radius=th / 2, fill=col)
        ty += W * 0.063

    # 정답 체크 ✓ — 세 번째 줄 오른쪽
    cxx = wx1 - W * 0.062
    cyy = wy0 + W * 0.052 + W * 0.126 + th / 2
    s = W * 0.042
    d.line([(cxx - s, cyy), (cxx - s * 0.2, cyy + s * 0.68), (cxx + s * 0.95, cyy - s * 0.8)],
           fill=MINT, width=int(W * 0.030), joint='curve')

    # ── 전조등: 앞코 아래쪽에 또렷하게 ──
    hx, hy = bx0 + W * 0.055, cy + W * 0.125
    hr = W * 0.047
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=ACCENT)

    # ── 바퀴: 몸통 아래로 살짝만 내려온다 ──
    for fx in (0.34, 0.70):
        wx = bx0 + (bx1 - bx0) * fx
        wr = W * 0.058
        d.ellipse([wx - wr, by1 - wr * 0.55, wx + wr, by1 + wr * 1.45], fill=WIN)

    # ── 레일 ──
    ry = by1 + W * 0.125
    d.rounded_rectangle([L - W * 0.03, ry, R + W * 0.01, ry + W * 0.036],
                        radius=W * 0.018, fill=TRAIN)

    return im.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    out = '/Users/hyunminkang/Documents/medical-study-pwa/icons'
    for size, name in ((180, 'icon-180.png'), (192, 'icon-192.png'), (512, 'icon-512.png')):
        draw(size).save(f'{out}/{name}')
    draw(512, maskable=True).save(f'{out}/icon-512-maskable.png')
    sc = '/private/tmp/claude-501/-Users-hyunminkang-Library-CloudStorage-OneDrive----------2026-2---02------/3270478b-5b2a-4510-b26b-9f0c31f3b3df/scratchpad'
    draw(512).save(f'{sc}/preview.png')
    # 홈화면 실제 크기로도 확인 (아이패드 아이콘은 대략 120~152px)
    big = Image.new('RGB', (560, 190), (242, 243, 247))
    for i, s in enumerate((120, 96, 76, 60)):
        ic = draw(s)
        big.paste(ic, (40 + i * 130, (190 - s) // 2))
    big.save(f'{sc}/preview_small.png')
    print('생성 완료')
