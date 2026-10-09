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
nextResponse = resp(400, 'API key not valid. Please pass a valid API key.');
let err = null;
try { await G.ask({ term: 't' }); } catch (e) { err = e.message; }
ok('잘못된 키 → 안내 메시지', /키가 유효하지 않/.test(err || ''), err);

nextResponse = resp(429, 'quota');
err = null;
try { await G.ask({ term: 't' }); } catch (e) { err = e.message; }
ok('429 → 할당량 안내', /할당량|요청이 많/.test(err || ''), err);

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

// ---- verifyKey ----
nextResponse = resp(200, { candidates: [] });
ok('verifyKey 성공', (await G.verifyKey('k')).ok === true);
nextResponse = resp(400, 'API key not valid');
const v = await G.verifyKey('bad');
ok('verifyKey 실패 메시지', v.ok === false && /올바르지 않/.test(v.error), v.error);

console.log(`\n통과 ${pass}건`);
if (fail.length) { console.log(`실패 ${fail.length}건:`); fail.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ 전부 통과');
