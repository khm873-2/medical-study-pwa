// Gemini API — 화면을 떠나지 않고 사이드에서 답변을 받기 위한 모듈.
//
// 왜 API를 쓰나: gemini.google.com은 X-Frame-Options: SAMEORIGIN이라 iframe으로 못 띄운다
// (브라우저가 강제하므로 우회 불가). "화면 안 넘어가고 옆에서 보기"를 하려면 API뿐이다.
//
// 키가 없으면 ask.js의 "앱으로 넘기기" 경로로 폴백한다 — 키 없이도 앱이 멈추지 않게.

import { kvGet, kvSet, kvDel } from './db.js';

const KEY = 'gemini_key';          // 구버전(단일 키) — 아래에서 자동 이관한다
const KEYS = 'gemini_keys';        // 현재 형식: 키 배열
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

// ───────────── 속도 (2026-10-10) ─────────────
//
// 느리다는 게 **한도(429)** 문제인지 **응답 속도** 문제인지는 전혀 다르다.
// 키를 더 넣으면 한도는 늘지만 한 번의 응답이 빨라지지는 않는다.
// 속도를 좌우하는 건 ① 어떤 모델을 쓰는가 ② 답을 얼마나 길게 받는가 둘뿐이다.
//
// 그래서 **실제 걸린 시간을 재서** 느린 모델을 피한다. 광고된 수치를 믿지 않고
// 이 기기·이 계정에서 실측한 값을 쓴다.

/** 가벼운 것부터 무거운 것 순. 뜯어보기처럼 형식이 정해진 변환은 가벼운 쪽이 맞다. */
const SPEED_ORDER = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
];

const SLOW_MS = 9000;          // 이보다 오래 걸리면 "느리다"고 본다
const latency = new Map();     // 모델 → 최근 소요시간(ms) 배열

export function recordLatency(model, ms) {
  if (!latency.has(model)) latency.set(model, []);
  const a = latency.get(model);
  a.push(ms);
  if (a.length > 8) a.shift();
}

/** 이 모델의 중앙값 소요시간(ms). 아직 안 써봤으면 null. */
export function medianLatency(model) {
  const a = latency.get(model);
  if (!a || !a.length) return null;
  const t = [...a].sort((x, y) => x - y);
  return t[Math.floor(t.length / 2)];
}

export function speedReport() {
  return [...latency.entries()].map(([model, a]) => ({
    model, n: a.length, median: medianLatency(model), slow: medianLatency(model) > SLOW_MS,
  })).sort((x, y) => (x.median || 0) - (y.median || 0));
}

export function resetSpeed() { latency.clear(); }

/**
 * 이 작업에 쓸 모델을 고른다.
 * `light`면 가벼운 모델부터, 아니면 사용자가 고른 모델을 쓰되
 * **그 모델이 실측으로 느리면 더 가벼운 쪽으로 내려간다.**
 */
export async function modelFor({ light = false } = {}) {
  const chosen = await getModel();
  const avail = (await kvGet('models_available')) || null;   // 마지막 ListModels 결과
  const canUse = (m) => !avail || avail.includes(`models/${m}`);

  if (light) {
    const fast = SPEED_ORDER.find((m) => canUse(m) && (medianLatency(m) === null || medianLatency(m) <= SLOW_MS));
    if (fast) return fast;
  }
  const mine = medianLatency(chosen);
  if (mine !== null && mine > SLOW_MS) {
    const lighter = SPEED_ORDER.find((m) => m !== chosen && canUse(m)
      && (medianLatency(m) === null || medianLatency(m) < mine));
    if (lighter) return lighter;
  }
  return chosen;
}

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
  const names = (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name); // "models/gemini-2.5-flash"
  kvSet('models_available', names).catch(() => {});
  return names;
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

// ───────────── 키 관리 (여러 개 · 자동 전환) ─────────────
// 무료 한도가 분당 10~15회라 돋보기(뜯어보기) 한 번에도 금방 걸린다.
// 키를 여러 개 넣어두고 **한도에 걸리면 다음 키로 넘어간다**(2026-10-10 요청).
// 키마다 호출 카운터를 따로 세므로 키 N개면 한도도 N배다.

/** 키 목록. 구버전 단일 키가 있으면 한 번만 배열로 옮긴다. */
export async function getKeys() {
  const arr = await kvGet(KEYS);
  if (Array.isArray(arr)) return arr.filter(Boolean);
  const old = await kvGet(KEY);
  if (old) { await kvSet(KEYS, [old]); await kvDel(KEY); return [old]; }
  return [];
}
export async function setKeys(list) {
  const clean = [...new Set((list || []).map((k) => String(k || '').trim()).filter(Boolean))];
  await kvSet(KEYS, clean);
  return clean;
}
/** 키 하나 추가(중복이면 무시). */
export async function addKey(k) {
  const key = String(k || '').trim();
  if (!key) throw new Error('키가 비어 있습니다.');
  const cur = await getKeys();
  if (cur.includes(key)) return cur;
  return setKeys([...cur, key]);
}
export async function removeKey(k) {
  return setKeys((await getKeys()).filter((x) => x !== k));
}

/** 첫 번째 키(모델 탐색 등 "아무 키나" 필요할 때). */
export async function getKey() { return (await getKeys())[0] || null; }
export async function setKey(k) { return setKeys(k ? [k] : []); }
export async function clearKey() { await kvDel(KEY); return kvSet(KEYS, []); }
export async function hasKey() { return (await getKeys()).length > 0; }

/** 키를 가리는 표시용 — 설정 화면에 그대로 띄우지 않는다. */
export function maskKey(k) {
  const s = String(k || '');
  return s.length <= 10 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}
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
export async function ask({ term, question, noteText, subject, lecture, onProgress }, retried = false) {
  if (!(await hasKey())) throw new Error('NO_KEY');
  const model = await modelFor();          // 실측이 느리면 알아서 가벼운 쪽으로

  // 같은 걸 또 물으면 보내지 않는다(한도 절약)
  const cacheKey = `${term}|${question ? question.num : ''}`;
  if (!retried && answerCache.has(cacheKey)) return answerCache.get(cacheKey);

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

  return callGeminiStream({
    model, system: SYSTEM, text: parts.join('\n\n'), maxTokens: 900,
    onChunk: onProgress ? (_p, full) => onProgress(full) : null,
  })
    .then((text) => {
      answerCache.set(cacheKey, text);
      if (answerCache.size > 80) answerCache.delete(answerCache.keys().next().value);
      return text;
    })
    .catch(async (e) => {
      if (/^MODEL_404$/.test(e.message) && !retried) {
        const v = await verifyKey(await getKey());
        if (v.ok && v.model !== model) return ask({ term, question, noteText, subject, lecture, onProgress }, true);
        throw new Error(v.ok ? `모델 "${model}"을 쓸 수 없습니다(404).` : v.error);
      }
      throw e;
    });
}

/**
 * 실제 호출 — **키를 돌아가며** 시도한다.
 *
 * 키 하나가 한도에 걸려도 다른 키가 남아 있으면 그걸로 보낸다. 사용자는 "요청이 많습니다"를
 * 보지 않는다(2026-10-10 요청). 모든 키가 막혔을 때만 기다리라고 알린다.
 */
async function callGemini({ model, system, text: userText, maxTokens = 900, temperature = 0.3 }) {
  const keys = await usableKeys();
  if (!keys.length) {
    const rc = await rateCheck();
    if (rc.noKey) throw new Error('NO_KEY');
    throw new Error(`RATE_WAIT:${rc.waitSec}`);
  }

  let lastErr = null;
  for (const key of keys) {
    try {
      return await callOnce({ key, model, system, text: userText, maxTokens, temperature });
    } catch (e) {
      lastErr = e;
      // 이 키만의 문제면 다음 키로 — 내용·모델 문제면 키를 바꿔도 같으므로 바로 던진다
      if (e.message === 'KEY_RATE' || e.message === 'KEY_BAD') continue;
      throw e;
    }
  }
  // 전부 실패 — 남은 대기 시간을 알려준다
  if (lastErr && lastErr.message === 'KEY_BAD') throw new Error('넣어둔 키가 모두 유효하지 않습니다. 설정에서 확인해 주세요.');
  const rc = await rateCheck();
  throw new Error(`RATE_WAIT:${rc.waitSec || 30}`);
}

/**
 * **스트리밍** 호출 — 글자가 오는 대로 넘겨준다.
 *
 * 왜: 1600토큰을 다 받고 나서 한꺼번에 그리면 40초를 멍하니 기다리게 된다(2026-10-10).
 * 스트리밍이면 2초 안에 첫 줄이 뜨고 나머지가 채워진다. 총 시간은 같지만
 * **읽기 시작하는 시점**이 20배 빨라진다.
 */
async function callGeminiStream({ model, system, text: userText, maxTokens = 900, temperature = 0.3, onChunk }) {
  const keys = await usableKeys();
  if (!keys.length) {
    const rc = await rateCheck();
    if (rc.noKey) throw new Error('NO_KEY');
    throw new Error(`RATE_WAIT:${rc.waitSec}`);
  }
  let lastErr = null;
  for (const key of keys) {
    try {
      return await streamOnce({ key, model, system, text: userText, maxTokens, temperature, onChunk });
    } catch (e) {
      lastErr = e;
      if (e.message === 'KEY_RATE' || e.message === 'KEY_BAD') continue;
      throw e;
    }
  }
  if (lastErr && lastErr.message === 'KEY_BAD') throw new Error('넣어둔 키가 모두 유효하지 않습니다. 설정에서 확인해 주세요.');
  const rc = await rateCheck();
  throw new Error(`RATE_WAIT:${rc.waitSec || 30}`);
}

async function streamOnce({ key, model, system, text: userText, maxTokens, temperature, onChunk }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
  };
  logOf(key).push(Date.now());
  const t0 = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }
  );
  if (!res.ok) { handleHttpError(res.status, await res.text().catch(() => ''), key); }
  if (!res.body) {                       // 스트림을 못 쓰면 평소 방식으로
    return callOnce({ key, model, system, text: userText, maxTokens, temperature });
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let finish = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // SSE: "data: {...}\n\n" 단위
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      const cand = j?.candidates?.[0];
      const piece = cand?.content?.parts?.map((x) => x.text || '').join('') || '';
      if (cand?.finishReason) finish = cand.finishReason;
      if (piece) { full += piece; if (onChunk) onChunk(piece, full); }
    }
  }
  recordLatency(model, Date.now() - t0);
  if (!full) throw new Error(finish ? `답변을 받지 못했습니다(${finish}).` : '빈 응답을 받았습니다.');
  if (finish === 'MAX_TOKENS') { const e = new Error('TRUNCATED'); e.partial = full.trim(); throw e; }
  return full.trim();
}

/** HTTP 오류를 키 단위 오류로 바꾼다(두 호출 경로가 같은 규칙을 쓰게). */
function handleHttpError(status, text, key) {
  if (status === 400 && /API key not valid/i.test(text)) {
    coolUntil.set(key, Date.now() + 3600000);
    throw new Error('KEY_BAD');
  }
  if (status === 429 || status === 403) {
    const m = text.match(/"retryDelay"\s*:\s*"(\d+)s"/);
    const sec = m ? Number(m[1]) : 30;
    coolUntil.set(key, Date.now() + sec * 1000);
    const arr = logOf(key);
    while (arr.length < RPM_LIMIT) arr.push(Date.now());
    throw new Error('KEY_RATE');
  }
  if (status === 404) throw new Error('MODEL_404');
  throw new Error(`Gemini 오류 ${status}${text ? ' — ' + text.slice(0, 120) : ''}`);
}

/** 키 하나로 한 번 호출. 이 키만의 문제는 KEY_RATE/KEY_BAD로 알린다. */
async function callOnce({ key, model, system, text: userText, maxTokens, temperature }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      // ★ 2.5 계열은 "생각" 토큰이 maxOutputTokens를 같이 먹는다. 끄지 않으면 예산을
      //   거의 다 생각에 쓰고 **답이 한 줄 쓰다 잘린다**(2026-10-10 실제 버그).
      //   우리 작업은 형식이 정해진 짧은 변환이라 생각이 필요 없다.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  logOf(key).push(Date.now());
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) handleHttpError(res.status, await res.text().catch(() => ''), key);
  const json = await res.json();
  const cand = json?.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    const reason = cand?.finishReason;
    throw new Error(reason ? `답변을 받지 못했습니다(${reason}).` : '빈 응답을 받았습니다.');
  }
  // 잘렸으면 조용히 넘기지 않는다 — 한 줄만 나오고 끝나는 걸 버그로 오인하게 된다
  if (cand?.finishReason === 'MAX_TOKENS') {
    const e = new Error('TRUNCATED');
    e.partial = text.trim();
    throw e;
  }
  return text.trim();
}


// ───────────── 호출 제한 (키마다 따로) ─────────────
// 무료 한도가 분당 10~15회라 돋보기 한 번에도 금방 걸린다. 그래서:
//   · 같은 질문은 캐시해서 다시 안 보낸다(되묻기·실수로 두 번 그었을 때)
//   · **키마다** 분당 호출 수를 세고, 꽉 찬 키는 건너뛴다
//   · 429가 오면 그 키를 잠시 쉬게 하고 다음 키로 넘어간다
//   · 모든 키가 막혔을 때만 "기다려라"라고 알린다
const RPM_LIMIT = 8;             // 키 하나당. 여유를 두고 보수적으로
const callLog = new Map();       // 키 → 최근 호출 시각[]
const coolUntil = new Map();     // 키 → 이 시각까지 쉰다(429를 맞은 키)
const answerCache = new Map();   // 질문 → 답변

function logOf(key) {
  if (!callLog.has(key)) callLog.set(key, []);
  const arr = callLog.get(key);
  const cut = Date.now() - 60000;
  while (arr.length && arr[0] < cut) arr.shift();
  return arr;
}

/** 이 키를 지금 쓸 수 있나? 못 쓰면 몇 초 뒤에 되는지. */
function keyReady(key) {
  const cool = coolUntil.get(key) || 0;
  if (cool > Date.now()) return { ok: false, waitSec: Math.ceil((cool - Date.now()) / 1000) };
  const arr = logOf(key);
  if (arr.length < RPM_LIMIT) return { ok: true };
  return { ok: false, waitSec: Math.max(1, Math.ceil((60000 - (Date.now() - arr[0])) / 1000)) };
}

/** 지금 쓸 수 있는 키들(한도가 덜 찬 순서). 전부 막혔으면 빈 배열. */
export async function usableKeys() {
  const keys = await getKeys();
  return keys
    .map((k) => ({ key: k, ready: keyReady(k), used: logOf(k).length }))
    .filter((x) => x.ready.ok)
    .sort((a, b) => a.used - b.used)
    .map((x) => x.key);
}

/** 전체적으로 지금 호출이 가능한가? 아니면 가장 빨리 풀리는 키까지 몇 초인가. */
export async function rateCheck() {
  const keys = await getKeys();
  if (!keys.length) return { ok: false, waitSec: 0, noKey: true };
  if ((await usableKeys()).length) return { ok: true };
  const waits = keys.map((k) => keyReady(k).waitSec || 1);
  return { ok: false, waitSec: Math.min(...waits) };
}

/** 남은 호출 수(모든 키 합). 설정 화면 표시용. */
export async function callsLeft() {
  const keys = await getKeys();
  return keys.reduce((n, k) => n + ((coolUntil.get(k) || 0) > Date.now() ? 0 : Math.max(0, RPM_LIMIT - logOf(k).length)), 0);
}

/** 키별 상태 — 설정 화면에서 어느 키가 쉬는 중인지 보여준다. */
export async function keyStatus() {
  const keys = await getKeys();
  return keys.map((k) => {
    const r = keyReady(k);
    return { key: k, masked: maskKey(k), ok: r.ok, waitSec: r.waitSec || 0, used: logOf(k).length, limit: RPM_LIMIT };
  });
}

/** 테스트·수동 초기화용 — 호출 카운터와 답변 캐시를 비운다. */
export function resetLimiter() {
  callLog.clear();
  coolUntil.clear();
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

// ───────────── 문제 뜯어보기 ─────────────
// 시험장에서 이 문제를 **어떻게 읽고 어떻게 선지를 쳐내는지**를 훈련한다.
// 정답만 알려주는 해설과 다르다 — 단서 → 인상 → 선지 제거 기준의 순서를 보여준다.

const BREAK_SYSTEM = `당신은 의대생에게 임상 vignette 푸는 법을 훈련시키는 튜터다.
시험장에서 이 문제를 읽으며 **머릿속에서 일어나야 할 일**을 순서대로 재현해라.

아래 세 블록을 **이 순서로, 이 형식 그대로만** 출력한다. 머리말·인사·총평 금지.

[단서]
원문조각 || 이걸 보면 떠올려야 할 것
(4~7줄. 원문조각은 지문에 **그대로 있는 연속 문자열**이어야 한다. 요약·변형 금지.
 정상 수치도 왜 적혀 있는지 밝혀라 — 출제자가 괜히 넣은 값은 없다.)

[인상]
한 줄. 지문을 다 읽은 순간 가져야 할 판단. "무엇을 묻고 있고, 머릿속 1순위는 무엇인가".

[선지]
선지번호 || O 또는 X || 남기거나 쳐내는 **기준** 한 줄
(모든 선지에 대해 한 줄씩. 정답은 O, 나머지는 X.
 "왜 틀렸나"가 아니라 **"무엇을 보고 쳐냈나"**를 적어라.
 예: "저혈압 지속 → 수축력 더 떨어뜨리는 약은 이 시점에 금기")

규칙:
- 각 줄 60자 이내. 의학용어는 한글(영문) 병기.
- 설명을 길게 늘이지 말고 판단 기준만 압축한다.`;

/**
 * 지문을 단서·인상·선지 기준으로 뜯는다.
 * @returns {Promise<{clues:Array, impression:string, options:Array}>}
 */
export async function breakdown(question, retried = false, onProgress = null) {
  if (!(await hasKey())) throw new Error('NO_KEY');
  // 형식이 정해진 변환이라 큰 모델이 필요 없다 — 가벼운 쪽이 몇 배 빠르다
  const model = await modelFor({ light: true });

  const cacheKey = `BD2|${question.q.slice(0, 80)}`;
  if (!retried && answerCache.has(cacheKey)) {
    const cached = parseBreakdown(answerCache.get(cacheKey), question);
    if (onProgress) onProgress(cached);
    return cached;
  }

  const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];
  const opts = (question.opts || []).map((o, i) => `${CIRCLED[i] || i + 1} ${o}`).join('\n');

  try {
    // 스트리밍 — 줄이 완성되는 대로 바로 보여준다(다 기다리면 40초가 걸린다)
    const text = await callGeminiStream({
      model, system: BREAK_SYSTEM, maxTokens: 1100, temperature: 0.2,
      text: `[지문]\n${question.q}\n\n[선지]\n${opts}`,
      onChunk: onProgress ? (_piece, full) => onProgress(parseBreakdown(full, question)) : null,
    });
    answerCache.set(cacheKey, text);
    if (answerCache.size > 80) answerCache.delete(answerCache.keys().next().value);
    return parseBreakdown(text, question);
  } catch (e) {
    if (e.message === 'MODEL_404' && !retried) {
      const v = await verifyKey(await getKey());
      if (v.ok && v.model !== model) return breakdown(question, true, onProgress);
      throw new Error(v.ok ? `모델 "${model}"을 쓸 수 없습니다(404).` : v.error);
    }
    // 잘렸어도 거기까지는 보여준다 — 아무것도 없는 것보다 낫다
    if (e.message === 'TRUNCATED' && e.partial) {
      const r = parseBreakdown(e.partial, question);
      r.truncated = true;
      return r;
    }
    throw e;
  }
}

/**
 * 세 블록을 파싱한다.
 * 조각이 지문에 실제로 있는지 확인해 **지어낸 조각은 버린다** —
 * 없는 문장에 밑줄을 그으면 오히려 헷갈린다.
 */
export function parseBreakdown(text, question) {
  const hay = String(question?.q || '');
  const nOpts = (question?.opts || []).length;
  const clues = [];
  let impression = '';
  const options = [];
  let section = '';

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const sec = line.match(/^\[?\s*(단서|인상|선지)\s*\]?$/);
    if (sec) { section = sec[1]; continue; }

    if (section === '인상') { if (!impression) impression = line.replace(/^[\-*•\s]+/, ''); continue; }

    const body = line.replace(/^[\-*•\s]+/, '');
    if (!body.includes('||')) continue;
    const parts = body.split('||').map((x) => x.trim());

    if (section === '선지' || parts.length === 3) {
      const idx = optIndex(parts[0]);
      if (idx < 0 || idx >= nOpts) continue;
      const verdictRaw = (parts[1] || '').toUpperCase();
      const keep = /O|◯|○|정답|KEEP/.test(verdictRaw) && !/X|✕|×/.test(verdictRaw);
      options.push({ idx, keep, why: parts[2] || parts[1] || '' });
      continue;
    }

    const frag = parts[0].replace(/^["'`]|["'`]$/g, '');
    const note = parts.slice(1).join(' || ').trim();
    if (!note) continue;
    if (!hay.includes(frag)) continue;      // 지문에 없는 조각은 버린다
    clues.push({ frag, note });
  }
  options.sort((a, b) => a.idx - b.idx);
  return { clues, impression, options, truncated: false };
}

/** "①" "1" "1번" → 0-indexed */
function optIndex(s) {
  const t = String(s).trim();
  const circ = '①②③④⑤⑥'.indexOf(t[0]);
  if (circ >= 0) return circ;
  const m = t.match(/\d+/);
  return m ? Number(m[0]) - 1 : -1;
}
