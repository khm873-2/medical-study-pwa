// gemini.js 테스트 — 네트워크를 가짜로 두고 요청 조립·에러 처리·키 관리를 검증.
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';

const PWA = '/Users/hyunminkang/Documents/medical-study-pwa';
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) pass++; else fail.push(`${n}${d ? ' — ' + d : ''}`); };

// db.js를 메모리 KV로 치환
const src = readFileSync(`${PWA}/js/gemini.js`, 'utf8').replace(
  "import { kvGet, kvSet, kvDel } from './db.js';",
  'const _kv={};const kvGet=async(k)=>_kv[k],kvSet=async(k,v)=>{_kv[k]=v;},kvDel=async(k)=>{delete _kv[k];};'
);
const shim = `${PWA}/js/__t_gem.mjs`;
writeFileSync(shim, src);
let G;
try { G = await import(pathToFileURL(shim).href); } finally { rmSync(shim, { force: true }); }

// fetch 가로채기
let lastCall = null;
let nextResponse = null;
global.fetch = async (url, opts) => {
  lastCall = { url, opts, body: JSON.parse(opts.body) };
  return nextResponse;
};
const resp = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// ---- 키 관리 ----
ok('처음엔 키 없음', !(await G.hasKey()));
await G.setKey('  AIzaTEST  ');
ok('키 저장(공백 제거)', (await G.getKey()) === 'AIzaTEST');
ok('hasKey', await G.hasKey());
ok('기본 모델', (await G.getModel()).startsWith('gemini-'), await G.getModel());

// ---- 정상 응답 ----
nextResponse = resp(200, { candidates: [{ content: { parts: [{ text: '  **핵심**: 설명  ' }] } }] });
const answer = await G.ask({
  term: 'Torsade de Pointes',
  question: { q: '65세 남자가…', opts: ['가', '나', '다'] },
  noteText: '노트 내용',
  subject: '응급_중환자', lecture: 'ACLS',
});
ok('답변 반환(trim됨)', answer === '**핵심**: 설명', `"${answer}"`);
ok('API 키를 헤더로 전달', lastCall.opts.headers['x-goog-api-key'] === 'AIzaTEST');
ok('키가 URL에 노출 안 됨', !lastCall.url.includes('AIzaTEST'));
ok('POST', lastCall.opts.method === 'POST');
const prompt = lastCall.body.contents[0].parts[0].text;
ok('프롬프트에 용어', prompt.includes('Torsade de Pointes'));
ok('프롬프트에 문제 지문', prompt.includes('65세 남자가'));
ok('프롬프트에 선지', prompt.includes('① 가'));
ok('프롬프트에 노트 맥락', prompt.includes('노트 내용'));
ok('시스템 지시 포함', lastCall.body.systemInstruction.parts[0].text.includes('의대생'));
ok('형식 강제(핵심/감별/시험)', /핵심[\s\S]*감별[\s\S]*시험/.test(lastCall.body.systemInstruction.parts[0].text));

// 노트가 너무 길면 자르는지
nextResponse = resp(200, { candidates: [{ content: { parts: [{ text: 'x' }] } }] });
await G.ask({ term: 't', noteText: 'A'.repeat(5000) });
const sent = lastCall.body.contents[0].parts.map((p) => p.text).join('');
ok('긴 노트는 잘라서 보냄', sent.length < 3000, `${sent.length}자`);

// ---- 에러 처리 ----
G.resetLimiter();
nextResponse = resp(400, 'API key not valid. Please pass a valid API key.');
let err = null;
try { await G.ask({ term: 't' }); } catch (e) { err = e.message; }
ok('잘못된 키 → 안내 메시지', /키가 유효하지 않/.test(err || ''), err);

// 429는 RATE_WAIT:초 형태로 올라와 UI가 카운트다운할 수 있게 한다
nextResponse = resp(429, JSON.stringify({ error: { details: [{ retryDelay: '17s' }] } }));
err = null;
try { await G.ask({ term: 't429' }); } catch (e) { err = e.message; }
ok('429 → RATE_WAIT + 구글이 준 대기시간', err === 'RATE_WAIT:17', err);
ok('429 뒤엔 로컬 카운터도 꽉 참', G.callsLeft() === 0, `${G.callsLeft()}`);

// retryDelay가 없으면 기본값
G.resetLimiter();
nextResponse = resp(429, 'quota exceeded');
err = null;
try { await G.ask({ term: 't429b' }); } catch (e) { err = e.message; }
ok('429 기본 대기시간', /^RATE_WAIT:\d+$/.test(err || ''), err);

G.resetLimiter();
nextResponse = resp(200, { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] });
err = null;
try { await G.ask({ term: 't' }); } catch (e) { err = e.message; }
ok('빈 응답 → 사유 포함', /SAFETY/.test(err || ''), err);

// 키 없이 호출
await G.clearKey();
ok('키 삭제됨', !(await G.hasKey()));
err = null;
try { await G.ask({ term: 't' }); } catch (e) { err = e.message; }
ok('키 없으면 NO_KEY (폴백 신호)', err === 'NO_KEY', err);

// ---- 모델 자동 선택 (404 대응) ----
G.resetLimiter();
// verifyKey는 ListModels → generateContent 순으로 두 번 호출한다.
const MODELS = {
  models: [
    { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
  ],
};
let queue = [];
global.fetch = async (url, opts) => {
  lastCall = { url, opts, body: opts.body ? JSON.parse(opts.body) : null };
  return queue.length ? queue.shift() : nextResponse;
};

// verifyKey는 ListModels 후 후보를 **실제로 호출해본다**(목록이 거짓말할 수 있어서).
queue = [resp(200, MODELS), resp(200, { candidates: [] })];
const v1 = await G.verifyKey('k');
ok('verifyKey 성공', v1.ok === true, JSON.stringify(v1));
ok('선호 모델 선택(2.5-flash)', v1.model === 'gemini-2.5-flash', v1.model);
ok('선택된 모델이 저장됨', (await G.getModel()) === 'gemini-2.5-flash');

// ★ 실제로 겪은 상황: 목록엔 있는데 호출하면 "no longer available" 404
const GONE = JSON.stringify({ error: { code: 404, message: 'This model models/gemini-2.5-flash is no longer available.' } });
queue = [
  resp(200, MODELS),      // 목록: 2.5-flash, 2.0-flash
  resp(404, GONE),        // 2.5-flash 호출 → 404
  resp(200, { candidates: [] }), // 2.0-flash 호출 → 성공
];
const v2 = await G.verifyKey('k');
ok('목록이 거짓이어도 다음 후보로 넘어감', v2.ok && v2.model === 'gemini-2.0-flash', JSON.stringify(v2));

// 전부 404면 어떤 모델이 왜 실패했는지 알려준다
queue = [resp(200, MODELS), resp(404, GONE), resp(404, GONE)];
const v3 = await G.verifyKey('k');
ok('전부 실패하면 실패', v3.ok === false);
ok('실패 모델·사유를 알려줌', /gemini-2\.5-flash.*404/.test(v3.error) && /no longer available/.test(v3.error), v3.error);

// 임베딩 전용만 있으면 실패
queue = [resp(200, { models: [{ name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] })];
const v4 = await G.verifyKey('k');
ok('생성 모델 없으면 실패', v4.ok === false && /생성 모델이 없/.test(v4.error), v4.error);

// 이미지·오디오 전용 모델은 후보에서 제외
queue = [
  resp(200, { models: [
    { name: 'models/imagen-3.0', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.0-flash-native-audio', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
  ] }),
  resp(200, { candidates: [] }),
];
const v5 = await G.verifyKey('k');
ok('이미지·오디오 모델 제외', v5.ok && v5.model === 'gemini-2.0-flash', v5.model);

// 429는 더 시도하지 않고 즉시 안내
queue = [resp(200, MODELS), resp(429, 'quota')];
const v6 = await G.verifyKey('k');
ok('429면 즉시 중단', v6.ok === false && /할당량/.test(v6.error), v6.error);

// ask()가 404를 만나면 다시 찾아 한 번 재시도
G.resetLimiter();
await G.setKey('AIzaTEST');
await G.setModel('gemini-ancient');
queue = [
  resp(404, GONE),                       // 첫 시도
  resp(200, MODELS),                     // verifyKey: ListModels
  resp(200, { candidates: [] }),         // verifyKey: probe 성공 → 2.5-flash
  resp(200, { candidates: [{ content: { parts: [{ text: '재시도 성공' }] } }] }),
];
const a2 = await G.ask({ term: 't' });
ok('404 → 모델 교체 후 재시도 성공', a2 === '재시도 성공', a2);
ok('교체된 모델이 저장됨', (await G.getModel()) === 'gemini-2.5-flash', await G.getModel());

// 재시도 경로에서도 전부 실패하면 에러(무한루프 없음)
G.resetLimiter();
await G.setModel('gemini-ancient');
queue = [resp(404, GONE), resp(200, MODELS), resp(404, GONE), resp(404, GONE)];
let e404 = null;
try { await G.ask({ term: 't' }); } catch (e) { e404 = e.message; }
ok('전부 실패하면 에러', /찾지 못했|404|쓸 수 없/.test(e404 || ''), e404);

queue = [resp(400, 'API key not valid')];
const v = await G.verifyKey('bad');
ok('잘못된 키 메시지', v.ok === false && /올바르지 않/.test(v.error), v.error);


// ───────────── 호출 제한 · 캐시 (무료 한도 분당 10~15회 대응) ─────────────
await G.setKey('AIzaTEST');
await G.setModel('gemini-2.5-flash');
const okResp = (t) => resp(200, { candidates: [{ content: { parts: [{ text: t }] } }] });
G.resetLimiter();

// 같은 질문은 두 번 보내지 않는다
queue = [okResp('첫 답변')];
const c1 = await G.ask({ term: '캐시테스트', question: { num: 1 } });
let calledAgain = false;
queue = [];
nextResponse = { ok: true, status: 200, json: async () => { calledAgain = true; return { candidates: [] }; }, text: async () => '' };
const c2 = await G.ask({ term: '캐시테스트', question: { num: 1 } });
ok('같은 질문은 캐시에서(네트워크 안 탐)', c2 === '첫 답변' && !calledAgain, `${c2}/${calledAgain}`);

// 다른 문항이면 새로 묻는다
queue = [okResp('다른 답변')];
const c3 = await G.ask({ term: '캐시테스트', question: { num: 2 } });
ok('문항이 다르면 새로 질문', c3 === '다른 답변');

// 분당 한도에 도달하면 보내기 전에 막는다
let n = 0;
while (G.callsLeft() > 0 && n < 20) {
  queue = [okResp(`답${n}`)];
  await G.ask({ term: `연속질문${n}` });
  n++;
}
ok('한도만큼 호출됨', G.callsLeft() === 0, `남은 ${G.callsLeft()}`);
let blocked = null;
try { await G.ask({ term: '한도초과질문' }); } catch (e) { blocked = e.message; }
ok('한도 넘으면 네트워크 전에 차단', /^RATE_WAIT:\d+$/.test(blocked || ''), blocked);
const waitSec = Number((blocked || '').split(':')[1]);
ok('대기 시간이 합리적(1~60초)', waitSec >= 1 && waitSec <= 60, `${waitSec}초`);

// rateCheck가 상태를 그대로 알려준다
const rc = G.rateCheck();
ok('rateCheck가 막힌 상태를 알림', rc.ok === false && rc.waitSec > 0, JSON.stringify(rc));


// ── 응답 잘림 (2026-10-10) ──
// gemini-2.5-flash는 "생각" 토큰이 maxOutputTokens를 같이 먹는다. 끄지 않으면
// 예산을 거의 다 생각에 쓰고 답이 한 줄 쓰다 잘린다 — 실제로 겪은 버그다.
{
  const src = readFileSync(`${PWA}/js/gemini.js`, 'utf8');
  ok('요청에 thinkingBudget: 0 을 넣는다', /thinkingConfig:\s*\{\s*thinkingBudget:\s*0\s*\}/.test(src));
  ok('잘린 응답(MAX_TOKENS)을 감지한다', /finishReason === 'MAX_TOKENS'/.test(src));
  ok('잘려도 거기까지는 보여준다', /e\.partial/.test(src));
  ok('뜯어보기 예산이 넉넉하다', /maxTokens:\s*1[2-9]\d\d/.test(src),
    (src.match(/maxTokens:\s*\d+/g) || []).join(' '));
}

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
