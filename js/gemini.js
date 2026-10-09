// Gemini API — 화면을 떠나지 않고 사이드에서 답변을 받기 위한 모듈.
//
// 왜 API를 쓰나: gemini.google.com은 X-Frame-Options: SAMEORIGIN이라 iframe으로 못 띄운다
// (브라우저가 강제하므로 우회 불가). "화면 안 넘어가고 옆에서 보기"를 하려면 API뿐이다.
//
// 키가 없으면 ask.js의 "앱으로 넘기기" 경로로 폴백한다 — 키 없이도 앱이 멈추지 않게.

import { kvGet, kvSet, kvDel } from './db.js';

const KEY = 'gemini_key';
const MODEL_KEY = 'gemini_model';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export async function getKey() { return (await kvGet(KEY)) || null; }
export async function setKey(k) { return kvSet(KEY, String(k || '').trim()); }
export async function clearKey() { return kvDel(KEY); }
export async function hasKey() { return !!(await getKey()); }
export async function getModel() { return (await kvGet(MODEL_KEY)) || DEFAULT_MODEL; }
export async function setModel(m) { return kvSet(MODEL_KEY, m || DEFAULT_MODEL); }

/** 시험 직전에 보기 좋은 짧은 답을 강제하는 시스템 지시. */
const SYSTEM = `당신은 의대생의 시험 공부를 돕는 튜터다. 한국어로 답한다.
반드시 아래 형식을 지켜라(군더더기 인사말 금지):

**핵심**: 2~3줄로 정의/기전
**감별**: 헷갈리는 개념과의 차이 1~2줄
**시험 포인트**: 출제될 만한 한 줄

의학 용어는 한글(영문) 병기. 확실하지 않으면 "확실하지 않다"고 말한다.`;

/**
 * 질문한다.
 * @param {object} p
 * @param {string} p.term      사용자가 긁은 텍스트
 * @param {object} [p.question] 문항(맥락용)
 * @param {string} [p.noteText] 관련 노트 본문(맥락용)
 * @param {string} [p.subject]
 * @param {string} [p.lecture]
 * @returns {Promise<string>} 답변 텍스트
 */
export async function ask({ term, question, noteText, subject, lecture }) {
  const key = await getKey();
  if (!key) throw new Error('NO_KEY');
  const model = await getModel();

  const parts = [];
  parts.push(`[질문] 다음에 대해 설명해줘:\n"${term}"`);
  if (subject || lecture) parts.push(`[과목] ${subject || ''} ${lecture || ''}`.trim());
  if (question) {
    const opts = Array.isArray(question.opts)
      ? question.opts.map((o, i) => `${['①','②','③','④','⑤'][i] || i + 1} ${o}`).join(' ')
      : '';
    parts.push(`[이 문제를 푸는 중이다]\n${question.q}\n${opts}`);
  }
  if (noteText) parts.push(`[내 노트 발췌 — 이 맥락을 우선 반영]\n${noteText.slice(0, 1500)}`);

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: parts.join('\n\n') }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 900 },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (res.status === 400 && /API key not valid/i.test(t)) throw new Error('키가 유효하지 않습니다. 설정에서 다시 넣어주세요.');
    if (res.status === 429) throw new Error('잠시 요청이 많습니다(할당량). 조금 뒤 다시 시도하거나 앱으로 물어보세요.');
    throw new Error(`Gemini 오류 ${res.status}${t ? ' — ' + t.slice(0, 120) : ''}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    const reason = json?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `답변을 받지 못했습니다(${reason}).` : '빈 응답을 받았습니다.');
  }
  return text.trim();
}

/** 설정 화면의 "연결 테스트". */
export async function verifyKey(key) {
  try {
    const model = await getModel();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }),
      }
    );
    if (res.ok) return { ok: true };
    const t = await res.text().catch(() => '');
    if (res.status === 400 && /API key not valid/i.test(t)) return { ok: false, error: '키가 올바르지 않습니다.' };
    return { ok: false, error: `응답 ${res.status}` };
  } catch (e) {
    return { ok: false, error: `연결 실패: ${e.message}` };
  }
}
