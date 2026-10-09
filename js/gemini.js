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

// 404의 흔한 원인: 모델 이름이 계정/프로젝트에서 안 열려 있는 경우. 구글이 모델을 자주
// 갈아치우고(1.5 계열은 신규 프로젝트에서 막힘) 계정마다 접근 권한이 달라서, 이름을
// 하드코딩하지 않고 **ListModels로 실제 쓸 수 있는 걸 찾아 쓴다**.
const PREFERRED = [
  /^models\/gemini-2\.5-flash$/,
  /^models\/gemini-flash-latest$/,
  /^models\/gemini-2\.5-flash-lite$/,
  /^models\/gemini-2\.0-flash$/,
  /^models\/gemini-2\.5-pro$/,
  /^models\/gemini-pro-latest$/,
];

/** 이 키로 generateContent가 가능한 모델 목록. */
export async function listModels(key) {
  const k = key || (await getKey());
  if (!k) throw new Error('NO_KEY');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': k },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`모델 목록을 못 받았습니다 (${res.status})${t ? ' — ' + t.slice(0, 120) : ''}`);
  }
  const json = await res.json();
  return (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name); // "models/gemini-2.5-flash"
}

/** 쓸 수 있는 모델 중 가장 선호하는 걸 고른다(없으면 첫 번째). */
export async function pickModel(key) {
  const names = await listModels(key);
  if (!names.length) throw new Error('이 키로 쓸 수 있는 모델이 없습니다.');
  for (const re of PREFERRED) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit.replace(/^models\//, '');
  }
  // 임베딩 전용 등을 피하려고 flash/pro가 들어간 것 우선
  const fallback = names.find((n) => /gemini.*(flash|pro)/.test(n)) || names[0];
  return fallback.replace(/^models\//, '');
}

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
export async function ask({ term, question, noteText, subject, lecture }, retried = false) {
  const key = await getKey();
  if (!key) throw new Error('NO_KEY');
  const model = await getModel();

  // 같은 걸 또 물으면 보내지 않는다(한도 절약)
  const cacheKey = `${term}|${question ? question.num : ''}`;
  if (!retried && answerCache.has(cacheKey)) return answerCache.get(cacheKey);

  if (!retried) {
    const rc = rateCheck();
    if (!rc.ok) throw new Error(`RATE_WAIT:${rc.waitSec}`);
  }

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

  recentCalls.push(Date.now());
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
    if (res.status === 429) {
      // 구글이 알려주는 재시도 시간을 그대로 쓴다
      const m = t.match(/"retryDelay"\s*:\s*"(\d+)s"/);
      const sec = m ? Number(m[1]) : 30;
      // 한도에 걸렸으니 로컬 카운터도 꽉 찬 것으로 본다
      while (recentCalls.length < RPM_LIMIT) recentCalls.push(Date.now());
      throw new Error(`RATE_WAIT:${sec}`);
    }
    if (res.status === 404 && !retried) {
      // "no longer available" 등 — 실제로 되는 모델을 찾아 한 번만 다시 시도한다.
      const v = await verifyKey(key);
      if (v.ok && v.model !== model) {
        return ask({ term, question, noteText, subject, lecture }, true);
      }
      throw new Error(v.ok ? `모델 "${model}"을 쓸 수 없습니다(404).` : v.error);
    }
    throw new Error(`Gemini 오류 ${res.status}${t ? ' — ' + t.slice(0, 120) : ''}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    const reason = json?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `답변을 받지 못했습니다(${reason}).` : '빈 응답을 받았습니다.');
  }
  const out = text.trim();
  answerCache.set(cacheKey, out);
  if (answerCache.size > 80) answerCache.delete(answerCache.keys().next().value);
  return out;
}

// ───────────── 호출 제한 ─────────────
// 무료 한도가 분당 10~15회라 금방 소진된다. 그래서:
//   · 같은 질문은 캐시해서 다시 안 보낸다(되묻기·실수로 두 번 그었을 때)
//   · 분당 호출 수를 자체적으로 제한해 429가 나기 전에 막는다
//   · 429가 나면 재시도까지 남은 시간을 알려준다
const RPM_LIMIT = 8;             // 여유를 두고 보수적으로
const recentCalls = [];          // 최근 호출 시각
const answerCache = new Map();   // 질문 → 답변

function pruneCalls() {
  const cut = Date.now() - 60000;
  while (recentCalls.length && recentCalls[0] < cut) recentCalls.shift();
}
/** 지금 호출하면 한도를 넘는가? 넘으면 몇 초 뒤에 가능한지 돌려준다. */
export function rateCheck() {
  pruneCalls();
  if (recentCalls.length < RPM_LIMIT) return { ok: true };
  const waitMs = 60000 - (Date.now() - recentCalls[0]);
  return { ok: false, waitSec: Math.max(1, Math.ceil(waitMs / 1000)) };
}
export function callsLeft() {
  pruneCalls();
  return Math.max(0, RPM_LIMIT - recentCalls.length);
}
/** 테스트·수동 초기화용 — 호출 카운터와 답변 캐시를 비운다. */
export function resetLimiter() {
  recentCalls.length = 0;
  answerCache.clear();
}

/** 모델 하나를 실제로 호출해본다. {ok} 또는 {ok:false, status, text} */
async function probe(key, model) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }),
      }
    );
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, text: await res.text().catch(() => '') };
  } catch (e) {
    return { ok: false, status: 0, text: e.message };
  }
}

/**
 * 설정 화면의 "연결 테스트".
 *
 * ListModels가 "쓸 수 있다"고 한 모델이 실제 호출에선 "no longer available" 404를 내는
 * 경우가 있다(실제로 겪음 — 목록과 가용성이 어긋난다). 그래서 목록을 믿지 않고
 * **후보를 하나씩 실제로 호출해서 되는 걸 고른다.**
 */
export async function verifyKey(key) {
  let candidates = [];
  try {
    const names = (await listModels(key)).map((n) => n.replace(/^models\//, ''));
    // 선호 순서대로 앞에 오게 정렬
    const score = (n) => {
      const i = PREFERRED.findIndex((re) => re.test(`models/${n}`));
      return i < 0 ? 99 : i;
    };
    candidates = names
      .filter((n) => /gemini/.test(n) && !/embedding|aqa|imagen|veo|tts|native-audio|image/.test(n))
      .sort((a, b) => score(a) - score(b));
  } catch (e) {
    if (/401|403|API key not valid|400/.test(e.message)) return { ok: false, error: '키가 올바르지 않습니다.' };
    return { ok: false, error: e.message };
  }
  if (!candidates.length) return { ok: false, error: '이 키로 쓸 수 있는 생성 모델이 없습니다.' };

  const tried = [];
  for (const model of candidates.slice(0, 8)) {   // 과한 호출 방지
    const r = await probe(key, model);
    if (r.ok) {
      await setModel(model);
      return { ok: true, model, tried };
    }
    tried.push({ model, status: r.status, msg: shortMsg(r.text) });
    if (r.status === 400 && /API key not valid/i.test(r.text)) {
      return { ok: false, error: '키가 올바르지 않습니다.' };
    }
    // 404/403은 다음 후보로 넘어간다. 429는 더 시도해봐야 소용없다.
    if (r.status === 429) {
      return { ok: false, error: '할당량 초과(429) — 잠시 후 다시 시도하세요.', tried };
    }
  }
  const detail = tried.map((t) => `${t.model}: ${t.status} ${t.msg}`).join(' / ');
  return { ok: false, error: `쓸 수 있는 모델을 찾지 못했습니다. ${detail}`, tried };
}

function shortMsg(text) {
  try {
    const j = JSON.parse(text);
    return (j?.error?.message || '').slice(0, 80);
  } catch {
    return String(text).slice(0, 80);
  }
}
