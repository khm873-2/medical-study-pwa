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
  pen.js          애플펜슬 필기 레이어 + 올가미(동그라미) 단어 추출
  wiki.js         문항 ↔ 노트 섹션 연결(wikiRefs 또는 연계노트 자동 매칭)
  markdown.js     Obsidian 문법 렌더러(콜아웃·하이라이트·임베드·위키링크)
  ask.js          AI 앱으로 질문 넘기기 + 답변을 AI대화로그로 저장
  app.js          화면 전환 · 목록 · 결과 저장 · 동기화 · 펜/위키/질문 연결
sw.js             Service Worker (앱 셸만 캐시, GitHub API는 가로채지 않음)
test/             브라우저 없이 실제 vault 데이터로 돌리는 테스트(260건)
```

## 쓰는 법 (풀이 화면)

상단 도구막대:

| 버튼 | 하는 일 |
|---|---|
| 👆 | 터치 모드 — 손가락으로 선지 선택·스크롤 (기본값) |
| 🖊 | 펜 모드 — 애플펜슬로 필기. 손바닥이 닿아도 안 그려진다 |
| 🔍 | 올가미 — 모르는 단어를 **동그라미 치면** 질문 시트가 뜬다 |
| 🧽 | 지우개 |
| ↶ 🗑 | 되돌리기 · 전부 지우기 |
| 📖 | 이 문항과 관련된 노트 섹션 보기 |

**동그라미 → 질문**: 단어를 둘러싸면 질문이 자동으로 만들어져 클립보드에 들어가고
ChatGPT/Claude 앱이 열린다. 답변을 복사해 돌아와 붙여넣으면, 앱이 **어느 문항에 대한
질문이었는지 기억했다가** 묶어서 vault에 저장한다.

**관련 노트(📖)**: 정답을 고르기 전에는 내용이 잠겨 있다 — 노트에 같은 문제가 정답과 함께
실려 있는 경우가 흔하기 때문. 매칭이 어긋나면 ‹ › 로 다른 섹션을 넘겨볼 수 있다.

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

로직 테스트(브라우저 없이, 실제 vault 데이터로) — 총 284건:

```bash
node test/test_app.mjs     # 205건: 50개 시험·392문항 파싱, 풀이·채점·재시도
node test/test_pen.mjs     #  22건: 팜 리젝션, 올가미 hit-test, 지우개
node test/test_phase3.mjs  #  33건: 마크다운 렌더, 섹션 매칭, 질문 프롬프트
node test/test_phase45.mjs #  24건: 카드 추출, Leitner SRS, 검색
```

## 세 가지 모드

목록 화면 상단 탭으로 전환합니다.

### 1. 모의고사
vault의 `06_모의고사` 50개를 풀고 채점합니다. 이어풀기·틀린문제 재시도·북마크·메모 지원.

### 2. 노트 읽기 (누워서 쓰는 용도)
`98_예습노트_보관`·`02_Wiki`·`01_임종평_전범위` 390개 노트를 섹션 단위로 넘겨 읽습니다.

| 버튼 | 하는 일 |
|---|---|
| ☀ | 화면이 안 꺼지게(Wake Lock) — 누워서 읽을 때 |
| 🔊 | 읽어주기(TTS) |
| 🖊 | 펜 필기 |
| ❓ | 드래그로 선택한 내용을 AI에게 질문 |

### 3. 플래시카드
노트에 이미 깔려 있는 `⭐ ==하이라이트==`(818개)를 그대로 카드로 씁니다 — **별도 작업 없이
725장**이 바로 나옵니다. 정답 자리를 `____`로 가리고 같은 줄을 문맥으로 보여줍니다.
Leitner 5상자(0·1·3·7·21일)로 복습 주기를 관리하며, 틀리면 처음으로 돌아갑니다.

> Obsidian의 Spaced Repetition 플러그인이 설치는 돼 있는데 비활성 상태라, 같은 문법을 읽어
> 이 앱이 대신 돌립니다.

## 검색 · 오프라인

- 목록 화면의 🔍 로 문항·노트를 검색합니다(매치 부분이 하이라이트되고, 누르면 바로 이동).
- 검색은 **기기에 저장된 범위**에서 돕니다. 한 번 열어본 자료는 자동 저장되고,
  설정 → 오프라인 저장에서 과목을 통째로 미리 받아두면 그 과목 전체가 검색·오프라인 대상이 됩니다.
- 비행기모드·지하철에서도 저장해둔 과목은 그대로 풀립니다.

### 앞으로 만들 문항에 `wikiRefs` 붙이기(선택)

지금은 연계노트에서 **자동 매칭**으로 동작한다(소급 작업 없이 160문항 전부 커버). 더 정확히
하려면 `.claude/commands/mock-exam.md` 절차에 "이 문항이 노트의 어느 섹션인지 기록" 단계를
넣고 스키마에 아래를 추가하면 된다 — 있으면 자동 매칭보다 우선한다:

```json
"wikiRefs": [{"note": "1015_응급중환자_전문심장소생술ACLS", "heading": "3. 빈맥 알고리즘 — PSVT와 안정형 VT"}]
```
