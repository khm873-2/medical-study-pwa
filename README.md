# 의학 모의고사 — 아이패드 PWA

`Medical_vault`의 모의고사를 아이패드에서 풀고, 결과를 vault에 자동으로 저장하는 웹앱.

> ⚠️ **이 저장소는 공개다. 의학 콘텐츠를 절대 커밋하지 않는다.**
> 문제·노트·이미지는 전부 비공개 `medical-vault`에 있고, 앱이 실행 중에 토큰으로 가져온다.
> (`.gitignore`가 1차 방어선이지만, 최종 책임은 커밋 전 확인이다.)

## 구조

```
index.html        앱 셸(화면 4개: 설정 / 목록 / 풀이 / 결과)
css/app.css       기존 모의고사 HTML의 디자인 토큰 + 아이패드 확장(큰 터치타깃·가로모드·다크모드)
js/
  auth.js         토큰 보관 — 이 모듈만 바꾸면 Worker 프록시로 전환 가능
  github.js       Contents API 읽기/쓰기 (vault에는 새 파일만 만든다 = append-only)
  db.js           IndexedDB (아웃박스 큐 · 이어풀기 · 캐시 · 설정)
  parser.js       모의고사 HTML에서 QUESTIONS 배열 추출
  quiz.js         풀이 화면 — 기존 HTML의 렌더링·채점 로직 이식
  app.js          화면 전환 · 목록 · 결과 저장 · 동기화
sw.js             Service Worker (앱 셸만 캐시, GitHub API는 가로채지 않음)
```

## 설치 (처음 한 번)

### 1. 이 저장소를 GitHub에 올리고 Pages 켜기

```bash
# GitHub에서 medical-study-pwa 라는 이름의 "공개" 저장소를 먼저 만든 뒤:
cd ~/Documents/medical-study-pwa
git remote add origin git@github.com:<내아이디>/medical-study-pwa.git
git push -u origin main
```

그다음 저장소 → Settings → Pages → Source를 `main` 브랜치 / `/ (root)`로 지정.
1~2분 뒤 `https://<내아이디>.github.io/medical-study-pwa/` 에서 열린다.

### 2. 토큰 발급

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate

- Repository access: **Only select repositories** → `medical-vault` **하나만**
- Permissions → Repository permissions → **Contents: Read and write**
- Expiration: **90 days** (캘린더에 갱신 리마인더를 걸어둘 것)

### 3. 아이패드에서 설치

1. Safari로 Pages 주소 접속
2. 공유 → **홈 화면에 추가**
3. 홈 화면 아이콘으로 실행 → 설정 화면에서 토큰 붙여넣기 → "연결 테스트 후 저장"

## 동작 방식

- **읽기**: `06_모의고사/{과목}/*.html`을 Contents API로 가져와 `QUESTIONS` 배열을 파싱한다.
  이미지는 `attachments/`에서 따로 가져와 blob URL로 띄운다.
- **쓰기**: 결과를 `00_Raw_Text/AI대화로그/{과목}_{yy-mm-dd}_{주제}_모의고사풀이.md`로 **새로** 만든다.
  이 폴더는 `CLAUDE.md`상 "읽기 전용 원본 소스이며 다음 `/lecture-integrate` 때 자동 반영 후보"라,
  맥에서 `git pull`만 하면 기존 파이프라인이 알아서 흡수한다.
- **충돌 없음**: 기존 파일을 고쳐 쓰지 않고 새 파일만 만들기 때문.
- **오프라인**: 열어본 시험은 IndexedDB에 캐시된다. 저장은 아웃박스 큐에 쌓였다가 네트워크가
  돌아오면 자동으로 보낸다(앱을 열었을 때/온라인 전환 시 — iOS는 백그라운드 동기화를 지원하지 않는다).

## 로컬에서 개발·테스트

```bash
cd ~/Documents/medical-study-pwa
python3 -m http.server 8765
# → http://localhost:8765
```

로직 테스트(브라우저 없이, 실제 vault 데이터로):

```bash
node test/test_app.mjs
```

## 다음 단계 (계획서 기준)

- Phase 3: 애플펜슬 레이어 · 동그라미→검색 · 문항별 위키 섹션 패널 · AI 왕복
- Phase 4: 누워서 읽기 모드(노트 렌더링 · Wake Lock · 플래시카드)
- Phase 5: 온보딩 · 선택적 오프라인 캐싱 · 검색 · TTS
