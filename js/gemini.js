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

// 404(이 계정엔 없는 모델)와 503(지금 과부하)은 다르다.
//   · 404 → 영영 못 쓴다. 기억해뒀다가 **다시는 고르지 않는다.**
//   · 503 → 잠깐 붐빌 뿐이다. 몇 분 쉬었다가 다시 쓴다.
// 이걸 구분 안 해서 404난 모델을 재시도 때 또 골라 MODEL_404가 화면에 샜다(2026-10-10).
const deadModels = new Set();          // 404
const busyUntil = new Map();           // 모델 → 이 시각까지 쉰다(503)

export function markDead(model) { deadModels.add(model); kvSet('dead_models', [...deadModels]).catch(() => {}); }
export function markBusy(model, ms = 180000) { busyUntil.set(model, Date.now() + ms); }
export function isModelUsable(m) {
  return !deadModels.has(m) && !((busyUntil.get(m) || 0) > Date.now());
}
export function resetModels() {
  deadModels.clear();
  busyUntil.clear();
  // 기기에 저장해둔 것도 같이 지운다 — 안 그러면 다음에 앱을 켤 때 되살아난다
  kvSet('dead_models', []).catch(() => {});
}
/** 앱 시작 때 지난번에 죽은 모델을 불러온다. */
export async function loadDeadModels() {
  const saved = await kvGet('dead_models');
  if (Array.isArray(saved)) saved.forEach((m) => deadModels.add(m));
}

// ───────────── 400 INVALID_ARGUMENT (2026-10-12) ─────────────
//
// 증상: 사이드 패널에 날것 그대로 떴다 —
//   Gemini 오류 400 — {"error":{"code":400,"message":"Request contains an invalid
//   argument.","status":"INVALID_ARGUMENT"}}
//
// 원인: `thinkingConfig`는 **2.5 이후 세대에만 있는 필드**다. 2.0·1.5 계열에 보내면
// 구글이 필드 이름도 안 알려주고 저 한 줄로 거절한다. 그런데 modelFor()는 실측이
// 느리면 SPEED_ORDER를 타고 **gemini-2.0-flash-lite 같은 구세대로 내려간다** —
// 내려가는 순간 모든 호출이 400이 된다. 우리가 2.5에서 "생각 끄기"를 켜둔 대가다.
//
// 고치는 방법은 둘 다 쓴다:
//   ① 보내기 전에 — 모델 이름으로 thinkingConfig 지원 여부를 판단해 아예 안 넣는다.
//   ② 그래도 400이 오면 — 본문을 한 단계씩 깎아서 **자동으로 다시 보낸다**.
//      ①의 판단이 틀려도(구글이 또 바꿔도) 사용자는 오류를 안 본다.
// 그리고 배운 결과를 기기에 저장해 다음부터는 처음부터 맞는 본문을 보낸다.
//
//   tier 0 = systemInstruction + thinkingConfig   (2.5 이후)
//   tier 1 = systemInstruction만                  (2.0·1.5)
//   tier 2 = 아무 것도 없이, 시스템 지시를 사용자 글 앞에 붙여서 보낸다 (최후)

const MAX_TIER = 2;
const bodyTier = new Map();          // 모델 → 이 모델에 통하는 본문 등급

/** 이 모델이 thinkingConfig를 받아주나? 2.5 이후 세대와 -latest 별칭만. */
export function supportsThinking(model) {
  const m = String(model || '');
  return /gemini-(?:2\.5|[3-9](?:\.\d+)?)[-.]/.test(m) || /-latest$/.test(m);
}

/** 이 모델에 지금 쓸 본문 등급. 배운 값이 있으면 그걸, 없으면 이름으로 추측. */
export function tierFor(model) {
  const learnedTier = bodyTier.get(model);
  if (learnedTier != null) return learnedTier;
  return supportsThinking(model) ? 0 : 1;
}

/** 400을 맞았다 → 한 단계 깎아서 기억한다. 더 깎을 게 없으면 false. */
export function demoteTier(model) {
  const next = tierFor(model) + 1;
  if (next > MAX_TIER) return false;
  bodyTier.set(model, next);
  kvSet('body_tiers', [...bodyTier.entries()]).catch(() => {});
  return true;
}

/** 앱 시작 때 지난번에 배운 본문 등급을 불러온다. */
export async function loadBodyTiers() {
  const saved = await kvGet('body_tiers');
  if (Array.isArray(saved)) saved.forEach(([m, t]) => bodyTier.set(m, t));
}

export function resetTiers() { bodyTier.clear(); }

/** 요청 본문을 등급에 맞게 조립한다. 두 호출 경로가 같은 본문을 쓰게 한다. */
export function buildBody({ model, system, text, maxTokens, temperature }) {
  const tier = tierFor(model);
  const userText = tier >= 2 && system ? `${system}\n\n---\n\n${text}` : text;
  const body = {
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (tier < 2 && system) body.systemInstruction = { parts: [{ text: system }] };
  // ★ 2.5 계열은 "생각" 토큰이 maxOutputTokens를 같이 먹는다. 끄지 않으면 예산을
  //   거의 다 생각에 쓰고 **답이 한 줄 쓰다 잘린다**(2026-10-10 실제 버그).
  //   우리 작업은 형식이 정해진 짧은 변환이라 생각이 필요 없다.
  if (tier < 1) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return body;
}

export function recordLatency(model, ms) {
  if (!latency.has(model)) latency.set(model, []);
  const a = latency.get(model);
  a.push(ms);
  if (a.length > 8) a.shift();
}

/** 내부 오류 코드가 화면에 새지 않게. */
export function friendlyModelError(code, model) {
  if (code === 'MODEL_BUSY') {
    return 'Gemini가 지금 붐빕니다. 잠시 뒤 다시 눌러주세요 — 다른 모델로도 시도했습니다.';
  }
  if (code === 'BAD_REQUEST') {
    return `"${model}" 모델이 이 요청을 받지 않습니다. 다른 모델로도 시도했습니다 — `
      + '설정에서 "쓸 수 있는 모델 보기"로 바꿔주세요.';
  }
  return `이 계정에서 "${model}" 모델을 쓸 수 없습니다. 설정에서 "쓸 수 있는 모델 보기"로 바꿔주세요.`;
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
  const canUse = (m) => (!avail || avail.includes(`models/${m}`)) && isModelUsable(m);

  if (light) {
    const fast = SPEED_ORDER.find((m) => canUse(m) && (medianLatency(m) === null || medianLatency(m) <= SLOW_MS));
    if (fast) return fast;
  }
  if (canUse(chosen)) {
    const mine = medianLatency(chosen);
    if (mine !== null && mine > SLOW_MS) {
      const lighter = SPEED_ORDER.find((m) => m !== chosen && canUse(m)
        && (medianLatency(m) === null || medianLatency(m) < mine));
      if (lighter) return lighter;
    }
    return chosen;
  }
  // 고른 모델이 죽었거나 붐빈다 → 쓸 수 있는 것 중 아무거나
  return SPEED_ORDER.find(canUse) || chosen;
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

/** 시험 직전에 보기 좋은 짧은 답을 강제하는 시스템 지시(문제 풀 때). */
const SYSTEM = `당신은 의대생의 시험 공부를 돕는 튜터다. 한국어로 답한다.
반드시 아래 형식을 지켜라(군더더기 인사말 금지):

**핵심**: 2~3줄로 정의/기전
**감별**: 헷갈리는 개념과의 차이 1~2줄
**시험 포인트**: 출제될 만한 한 줄

의학 용어는 한글(영문) 병기. 확실하지 않으면 "확실하지 않다"고 말한다.
수식 표기(LaTeX)는 쓰지 않는다 — 이 앱은 수식을 그리지 않아서 "\$\\rightarrow\$" 같은 게
글자 그대로 보인다. 화살표는 →, 부등호는 ≤ ≥, 곱은 × 처럼 **기호를 직접** 쓴다.`;

/**
 * 노트를 읽다가 물을 때 쓰는 지시.
 *
 * 왜 따로 두나: 핵심/감별/시험 포인트 틀은 **한 개념**을 물을 때 좋은 형식이다.
 * 노트에서 문단을 통째로 긁어오면 개념이 여럿이라 그 틀에 욱여넣다가 정작
 * "이 대목이 무슨 말인지"를 설명하지 않는다(2026-10-12 지적).
 * 읽기 모드에서는 틀을 강요하지 않고 **긁은 내용 자체를 풀어 설명하게** 한다.
 */
const READ_SYSTEM = `당신은 의대생이 강의 노트를 읽다가 막힌 대목을 설명해주는 튜터다.
한국어로, 인사말 없이 바로 설명한다.

사용자가 노트에서 긁어온 대목을 **그대로 풀어서 설명**한다:
- 긴 문단이면 흐름을 따라가며 핵심 줄기를 짚고, 어려운 용어·숫자·약어가 왜 그런지 밝힌다.
- 짧은 구절·용어 하나면 정의와 기전을 설명하고, 헷갈리기 쉬운 것과의 차이를 덧붙인다.
- 노트에 이미 있는 말을 되풀이하지 말고, **노트가 생략한 연결고리**를 채워준다.

형식은 내용에 맞게 고른다 — 정해진 틀에 욱여넣지 않는다. 길면 소제목(**굵게**)으로
끊어주고, 나열이면 불릿을 쓴다. 의학 용어는 한글(영문) 병기.
확실하지 않으면 "확실하지 않다"고 말한다.
수식 표기(LaTeX)는 쓰지 않는다 — 이 앱은 수식을 그리지 않아서 "\$\\rightarrow\$" 같은 게
글자 그대로 보인다. 화살표는 →, 부등호는 ≤ ≥, 곱은 × 처럼 **기호를 직접** 쓴다.`;

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
export async function ask({ term, question, noteText, subject, lecture, onProgress,
  mode = 'exam', prior = [] }, retried = false) {
  if (!(await hasKey())) throw new Error('NO_KEY');
  const model = await modelFor();          // 실측이 느리면 알아서 가벼운 쪽으로
  const reading = mode === 'read';

  // 같은 걸 또 물으면 보내지 않는다(한도 절약).
  // ⚠️ 꼬리질문은 **앞 대화가 다르면 답도 달라야** 하므로 열쇠에 그 길이를 섞는다 —
  //    안 그러면 "그럼 반대는?"을 두 번째 실에서 물었을 때 첫 실의 답이 나온다(2026-10-15).
  const cacheKey = `${mode}|${term}|${question ? question.num : ''}|${prior.length}|${(prior[prior.length - 1] || {}).q || ''}`;
  if (!retried && answerCache.has(cacheKey)) return answerCache.get(cacheKey);

  const parts = [];
  parts.push(reading
    ? `[노트에서 긁어온 대목]\n${term}`
    : `[질문] 다음에 대해 설명해줘:\n"${term}"`);
  if (subject || lecture) parts.push(`[과목] ${subject || ''} ${lecture || ''}`.trim());
  if (question) {
    const opts = Array.isArray(question.opts)
      ? question.opts.map((o, i) => `${['①','②','③','④','⑤'][i] || i + 1} ${o}`).join(' ')
      : '';
    parts.push(`[이 문제를 푸는 중이다]\n${question.q}\n${opts}`);
  }
  // 앞서 주고받은 것 — 꼬리질문("그럼 반대는?")은 이게 없으면 말이 안 된다.
  // 길어지면 한도를 잡아먹으므로 **마지막 3턴**만, 답은 앞부분만 넘긴다.
  if (prior.length) {
    const tail = prior.slice(-3).map((x, i) =>
      `Q${i + 1}. ${x.q}\nA${i + 1}. ${String(x.a || '').slice(0, 700)}`).join('\n\n');
    parts.push(`[앞서 주고받은 것 — 이어지는 질문이다]\n${tail}`);
  }
  if (noteText) {
    parts.push(reading
      ? `[이 대목이 들어있는 섹션 — 맥락 참고용]\n${noteText.slice(0, 1500)}`
      : `[내 노트 발췌 — 이 맥락을 우선 반영]\n${noteText.slice(0, 1500)}`);
  }

  return callGeminiStream({
    model,
    system: reading ? READ_SYSTEM : SYSTEM,
    text: parts.join('\n\n'),
    // 문단을 통째로 긁으면 설명도 길어진다 — 읽기 모드만 예산을 넉넉히 준다
    maxTokens: reading ? 1600 : 900,
    onChunk: onProgress ? (_p, full) => onProgress(full) : null,
  })
    .then((text) => {
      answerCache.set(cacheKey, text);
      if (answerCache.size > 80) answerCache.delete(answerCache.keys().next().value);
      return text;
    })
    .catch(async (e) => {
      // 400(BAD_REQUEST)도 같이 다룬다 — 본문을 끝까지 깎아도 거절한 모델은 못 쓰는 모델이다.
      if (e.message === 'MODEL_404' || e.message === 'MODEL_BUSY' || e.message === 'BAD_REQUEST') {
        if (e.message === 'MODEL_BUSY') markBusy(model); else markDead(model);
        if (!retried) {
          const next = await modelFor();
          if (next !== model) return ask({ term, question, noteText, subject, lecture, onProgress, mode, prior }, true);
        }
        throw new Error(friendlyModelError(e.message, model));
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
async function callGeminiStream({ model, system, text: userText, maxTokens = 900, temperature = 0.3, onChunk, signal }) {
  const keys = await usableKeys();
  if (!keys.length) {
    const rc = await rateCheck();
    if (rc.noKey) throw new Error('NO_KEY');
    throw new Error(`RATE_WAIT:${rc.waitSec}`);
  }
  let lastErr = null;
  for (const key of keys) {
    try {
      return await streamOnce({ key, model, system, text: userText, maxTokens, temperature, onChunk, signal });
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

async function streamOnce({ key, model, system, text: userText, maxTokens, temperature, onChunk, signal }) {
  logOf(key).push(Date.now());
  const t0 = Date.now();
  const res = await sendWithFallback({
    key, model, system, text: userText, maxTokens, temperature, signal,
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
  });
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

/**
 * 한 번 보낸다 — **400이면 본문을 깎아서 스스로 다시 보낸다.**
 *
 * 구글의 400 INVALID_ARGUMENT는 어느 필드가 문제인지 안 알려준다(실측: 메시지가
 * "Request contains an invalid argument." 한 줄뿐). 그래서 추측으로 고치지 않고
 * **선택적인 필드부터 차례로 떼어내며 통하는 본문을 찾는다**(tier 0→1→2).
 * 통하면 그 등급을 기억해 다음부터는 한 번에 보낸다.
 */
async function sendWithFallback({ key, model, system, text, maxTokens, temperature, url, signal }) {
  for (;;) {
    const body = buildBody({ model, system, text, maxTokens, temperature });
    // signal — 사용자가 중간에 그만두면 **진짜로 끊는다**. 안 끊으면 할당량만 먹는다.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return res;
    const detail = await res.text().catch(() => '');
    // 400이고 키 문제가 아니라면 본문 문제다 — 한 단계 깎아서 즉시 다시 보낸다
    if (res.status === 400 && !/API key not valid/i.test(detail) && demoteTier(model)) continue;
    handleHttpError(res.status, detail, key);
  }
}

/** HTTP 오류를 키 단위 오류로 바꾼다(두 호출 경로가 같은 규칙을 쓰게). */
function handleHttpError(status, text, key) {
  if (status === 400 && /API key not valid/i.test(text)) {
    coolUntil.set(key, Date.now() + 3600000);
    throw new Error('KEY_BAD');
  }
  if (status === 429 || status === 403) {
    const m = text.match(/"retryDelay"\s*:\s*"(\d+)s"/);
    // 일일 한도(PerDay)는 내일까지 안 풀린다 — 분당 한도와 섞으면 쓸 수 있는 키를 버린다
    const perDay = /PerDay|per day|RequestsPerDay/i.test(text);
    const sec = perDay ? 6 * 3600 : (m ? Number(m[1]) : 20);
    coolUntil.set(key, Date.now() + sec * 1000);
    if (!perDay) {
      // 이 키의 분당 한도를 배운다 — 방금 통한 만큼이 실제 한도다
      const used = logOf(key).length;
      const cap = Math.max(3, used - 1);
      const prev = learned.get(key);
      learned.set(key, prev == null ? cap : Math.min(prev, cap));
    }
    throw new Error('KEY_RATE');
  }
  if (status === 404) throw new Error('MODEL_404');
  // 여기까지 온 400 = 본문을 끝까지 깎아도 거절당했다. 날것의 JSON을 화면에 흘리지 않는다.
  if (status === 400) { const e = new Error('BAD_REQUEST'); e.detail = shortMsg(text); throw e; }
  // 503/500/502 = 구글 쪽이 붐비는 것. 모델을 바꾸거나 잠깐 뒤 다시 하면 된다.
  if (status === 503 || status === 500 || status === 502) throw new Error('MODEL_BUSY');
  throw new Error(`Gemini 오류 ${status}${text ? ' — ' + text.slice(0, 120) : ''}`);
}

/** 키 하나로 한 번 호출. 이 키만의 문제는 KEY_RATE/KEY_BAD로 알린다. */
async function callOnce({ key, model, system, text: userText, maxTokens, temperature }) {
  logOf(key).push(Date.now());
  const res = await sendWithFallback({
    key, model, system, text: userText, maxTokens, temperature,
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
  });
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
// 한도는 모델·계정마다 다르고 구글이 공식 표를 내려서 알 수가 없다(2026-10-10 확인).
// **가정해서 지레 막으면** 아직 남은 할당량을 못 쓰고 "요청이 많습니다"만 보게 된다.
// 그래서 처음엔 막지 않고, 429를 맞으면 **그때 그 키의 한도를 배운다.**
const RPM_FALLBACK = 15;         // 배우기 전 표시용(설정 화면의 "남은 횟수")
const learned = new Map();       // 키 → 이 키에서 실제로 통한 분당 호출 수
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
  const cap = learned.get(key);
  if (cap == null) return { ok: true };          // 아직 한도를 모른다 → 일단 써본다
  const arr = logOf(key);
  if (arr.length < cap) return { ok: true };
  return { ok: false, waitSec: Math.max(1, Math.ceil((60000 - (Date.now() - arr[0])) / 1000)) };
}

/** 이 키의 분당 한도(아직 모르면 null). */
export function learnedLimit(key) { return learned.get(key) ?? null; }

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
  return keys.reduce((n, k) => {
    if ((coolUntil.get(k) || 0) > Date.now()) return n;
    const cap = learned.get(k) ?? RPM_FALLBACK;
    return n + Math.max(0, cap - logOf(k).length);
  }, 0);
}

/** 키별 상태 — 설정 화면에서 어느 키가 쉬는 중인지 보여준다. */
export async function keyStatus() {
  const keys = await getKeys();
  return keys.map((k) => {
    const r = keyReady(k);
    return {
      key: k, masked: maskKey(k), ok: r.ok, waitSec: r.waitSec || 0,
      used: logOf(k).length, limit: learned.get(k) ?? RPM_FALLBACK,
      known: learned.has(k),
    };
  });
}

/** 테스트·수동 초기화용 — 호출 카운터와 답변 캐시를 비운다. */
export function resetLimiter() {
  callLog.clear();
  coolUntil.clear();
  learned.clear();
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
export async function breakdown(question, retried = false, onProgress = null, signal = null) {
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
      signal,
    });
    answerCache.set(cacheKey, text);
    if (answerCache.size > 80) answerCache.delete(answerCache.keys().next().value);
    return parseBreakdown(text, question);
  } catch (e) {
    // 404: 이 모델은 이 계정에 없다 → 기억해두고 다른 모델로 다시
    // 503: 지금 붐빈다 → 잠깐 쉬게 하고 다른 모델로 다시
    const modelFault = e.message === 'MODEL_404' || e.message === 'MODEL_BUSY' || e.message === 'BAD_REQUEST';
    if (modelFault) {
      if (e.message === 'MODEL_BUSY') markBusy(model); else markDead(model);
      if (!retried) {
        const next = await modelFor({ light: true });
        if (next !== model) return breakdown(question, true, onProgress, signal);
      }
      throw new Error(friendlyModelError(e.message, model));
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
