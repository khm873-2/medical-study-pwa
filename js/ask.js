// 모르는 것 → 구독 중인 AI 앱으로 넘기고, 답변을 받아 vault에 저장.
//
// 왜 API 직접 호출이 아닌가: 사용자가 "새 API 키 발급 없이 이미 구독 중인 걸 그대로" 쓰기로
// 정했다. 그래서 질문을 클립보드에 넣고 ChatGPT/Claude 앱을 열어주고, 돌아와서 답변을
// 붙여넣으면 **그 질문이 어느 문항에 대한 것이었는지 앱이 기억했다가** 묶어서 저장한다.
//
// 솔직한 한계: 앱을 잠깐 떠나야 한다(완전 인라인 아님). 대신 "내 노트부터 보고(위키 패널),
// 그래도 모르면 AI"라는 2단 흐름이라 AI까지 가는 빈도 자체가 줄어든다.

const APPS = [
  // iOS에서 실제로 동작하는 진입점. 앱이 없으면 웹으로 떨어진다.
  { id: 'chatgpt', label: 'ChatGPT', scheme: 'chatgpt://', web: 'https://chat.openai.com/' },
  { id: 'claude', label: 'Claude', scheme: 'claude://', web: 'https://claude.ai/new' },
  { id: 'gemini', label: 'Gemini', scheme: 'googleapp://', web: 'https://gemini.google.com/app' },
];

/** 질문 문구를 만든다 — 시험 직전에 보기 좋은 짧은 답을 요구한다. */
export function buildPrompt({ term, question, subject, lecture }) {
  const lines = [];
  if (term) {
    lines.push(`"${term}"가 뭔지 의대생 수준으로 짧게 설명해줘.`);
  } else {
    lines.push('아래 문제에서 모르는 부분을 설명해줘.');
  }
  lines.push('');
  lines.push('형식: ①핵심 정의 2~3줄 ②감별점/헷갈리는 개념 1줄 ③시험에 나올 포인트 1줄. 개조식으로.');
  lines.push('');
  lines.push(`[맥락] ${subject || ''} ${lecture || ''}`.trim());
  if (question) {
    lines.push('[문제]');
    lines.push(question.q);
    if (Array.isArray(question.opts)) {
      lines.push(question.opts.map((o, i) => `${['①','②','③','④','⑤'][i] || i + 1} ${o}`).join(' '));
    }
  }
  return lines.join('\n');
}

export function appList() { return APPS; }

/** 클립보드에 넣고 해당 앱을 연다. 실패해도 클립보드엔 들어가 있게 한다. */
export async function sendTo(appId, prompt) {
  let copied = false;
  try { await navigator.clipboard.writeText(prompt); copied = true; } catch {}
  const app = APPS.find((a) => a.id === appId);
  if (app) {
    // 스킴으로 앱을 시도하고, 안 열리면 웹으로.
    const t = setTimeout(() => { window.open(app.web, '_blank'); }, 700);
    try {
      window.location.href = app.scheme;
      // 앱이 실제로 열리면 페이지가 백그라운드로 가면서 타이머가 늦게 돈다.
      document.addEventListener('visibilitychange', function once() {
        if (document.hidden) clearTimeout(t);
        document.removeEventListener('visibilitychange', once);
      });
    } catch {
      clearTimeout(t);
      window.open(app.web, '_blank');
    }
  }
  return copied;
}

/** 공유 시트(설치된 아무 앱으로나) — iOS에서 가장 범용적인 경로. */
export async function share(prompt) {
  if (navigator.share) {
    try { await navigator.share({ text: prompt }); return true; } catch { return false; }
  }
  try { await navigator.clipboard.writeText(prompt); return true; } catch { return false; }
}

/** 저장할 마크다운 — AI대화로그 형식에 맞춘다. */
export function buildQaMarkdown({ subject, lecture, examPath, items }) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(2);
  const date = `${yy}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;

  const L = [];
  L.push('---');
  L.push(`출처: 아이패드 모의고사 중 AI 질문 (${examPath})`);
  L.push(`과목: ${subject}`);
  L.push(`강의: ${lecture}`);
  L.push(`작성: 20${yy}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`);
  L.push('---');
  L.push('');
  L.push(`# ${lecture} — 풀면서 모르던 것 (${items.length}건)`);
  L.push('');
  L.push('> 아이패드에서 문제를 풀다가 동그라미 쳐서 물어본 내용. 다음 `/lecture-integrate` 때');
  L.push('> 노트에 반영할지 검토 대상이다.');
  L.push('');
  items.forEach((it, i) => {
    L.push(`## ${i + 1}. ${it.term || '(문항 전체)'}`);
    L.push('');
    L.push(`- **문항**: ${it.qnum}번 — ${String(it.qtext || '').slice(0, 80)}…`);
    if (it.answer) {
      L.push('');
      L.push(it.answer.trim());
    } else {
      L.push('- ⏸ 아직 답변을 못 받음(질문만 기록)');
    }
    L.push('');
  });
  const safe = String(lecture).replace(/[\/\\:*?"<>|]/g, '_');
  return {
    path: `00_Raw_Text/AI대화로그/${subject}_${date}_${safe}_질문.md`,
    content: L.join('\n'),
    message: `iPad 질문 기록: ${lecture} (${items.length}건)`,
  };
}
