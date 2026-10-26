// 풀이 화면 — 기존 모의고사 HTML(06_모의고사/근골격계/0908_...html)의 렌더링·채점 로직을
// 그대로 옮기고, 아이패드용(이어풀기·이미지 지연로딩·틀린문제 재시도)만 더했다.

import { getBlobUrl } from './github.js';
import { imagePaths } from './parser.js';
import { saveSession, loadSession, clearSession, recordAttempt, markUnsure, markBookmark,
  examRun, bumpExamRun, allAttempts, attemptId, markExamFinished, unmarkExamFinished } from './db.js';
import { scheduleBackup } from './backup.js';
import { tokenize, tokenizeTree } from './pen.js';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];

/**
 * 정답이 여럿인 문항을 위한 판정.
 *
 * 학교 족보에는 "답 2개" 문항이 흔하다(응급_중환자만 116개). 하나만 정답으로 보면
 * 나머지를 고른 사람이 맞는데도 틀렸다고 나온다 — 오답노트까지 오염된다(2026-10-13).
 */
export function isAns(q, i) {
  if (!q || i === null || i === undefined) return false;
  return q.ansAll ? q.ansAll.includes(i) : i === q.ans;
}

/** 'multi' 문항인가 — 답을 **전부** 골라야 맞는 것(모두 고르시오). */
export const isMulti = (q) => !!q && q.type === 'multi';

/** 고른 것(배열)이 정답 묶음과 정확히 같은가 — 하나라도 빠지거나 더하면 틀리다. */
export function isMultiCorrect(q, picked) {
  if (!isMulti(q) || !Array.isArray(picked)) return false;
  const want = q.ansAll || [q.ans];
  if (picked.length !== want.length) return false;
  return want.every((i) => picked.includes(i));
}

/** "②" · "②④ (어느 것이든 정답)" · "②④ (모두 고르기)" */
function ansLabel_(q) {
  if (!q.ansAll) return CIRCLED[q.ans] || q.ans + 1;
  const nums = q.ansAll.map((i) => CIRCLED[i] || i + 1).join('');
  return `${nums} (${isMulti(q) ? '모두 고르기' : '어느 것이든 정답'})`;
}

/** 고른 것을 사람이 읽는 꼴로 — 'multi'는 배열이다. */
function pickLabel(q, picked) {
  if (picked === null || picked === undefined) return '—';
  if (Array.isArray(picked)) {
    return picked.length ? picked.map((i) => CIRCLED[i] || i + 1).join('') : '(고른 것 없음)';
  }
  if (q && q.type === 'ox') return picked === 0 ? 'O' : 'X';
  return CIRCLED[picked] || picked + 1;
}

export class Quiz {
  /**
   * @param {object} opts
   * @param {string} opts.examKey   이어풀기 저장 키(= vault 경로)
   * @param {Array}  opts.questions 문항 배열
   * @param {string} opts.title     화면 제목
   * @param {Function} opts.onFinish 결과 보기 눌렀을 때
   * @param {Function} opts.onExit   목록으로 나갈 때
   * @param {object} [opts.meta]     {subject, kind} — 풀이 이력을 과목 단위로 모으기 위해
   */
  constructor({ examKey, questions, title, onFinish, onExit, onRender, onCopy, meta }) {
    this.examKey = examKey;
    this.meta = meta || {};
    this.all = questions;
    this.order = questions.map((_, i) => i); // 재시도 모드에서 부분집합이 된다
    this.title = title;
    this.onFinish = onFinish;
    this.onExit = onExit;
    // 문항이 바뀔 때마다 알려준다 — 펜 레이어·위키 패널이 여기에 붙는다.
    this.onRender = onRender || (() => {});
    // 클립보드는 앱이 맡는다 — 이 모듈은 **글만** 만든다(브라우저 밖 검사에서도 돌게)
    this.onCopy = onCopy || (async () => false);

    this.cur = 0;
    this.answers = new Array(questions.length).fill(null);
    this.eliminated = questions.map(() => new Set());
    this.bookmarks = new Array(questions.length).fill(false);
    // 문항 전체보기(2026-10-12)의 색상 표시 — 0은 "표시 없음", 1~6은 COLOR_TAGS 인덱스.
    // 북마크(★)는 "다시 볼 것" 하나뿐이지만, 색상은 "헷갈림/암기 필요/시험에 나올 듯" 처럼
    // 사용자가 뜻을 정해 여러 갈래로 나눠 쓰라는 것이라 숫자로만 두고 뜻은 안 정한다.
    this.colors = new Array(questions.length).fill(0);
    this.memos = new Array(questions.length).fill('');
    // "찍어서 맞췄다" 표시 — 맞은 문항도 다시 볼 큐에 넣기 위한 것(2026-10-10)
    this.unsure = new Array(questions.length).fill(false);
    // 이번 화면에서 이력을 남긴 문항 — 이어풀기로 되살린 답을 끝낼 때 한 번만 쌓는다
    this._recorded = new Set();
    // 이 시험을 몇 번째 푸는가 — start()에서 저장소 값으로 채운다(2026-10-21 요청)
    this.run = 1;
    // 문항별 지난 풀이(attemptId → history 배열) — start()에서 채운다
    this._hist = new Map();
    // 모두 고르기에서 **아직 안 낸** 체크 — 답으로 낼 때 answers로 옮긴다
    this._draft = this.all.map(() => []);

    this.el = {
      screen: document.getElementById('quizScreen'),
      title: document.getElementById('quizTitle'),
      card: document.getElementById('qcard'),      // 낱말 깔기를 여기 통째로 건다
      qnum: document.getElementById('qnum'),
      qsource: document.getElementById('qsource'),
      qtext: document.getElementById('qtext'),
      qimg: document.getElementById('qimgContainer'),
      opts: document.getElementById('optsContainer'),
      ox: document.getElementById('ox-row'),
      explain: document.getElementById('explainBox'),
      expText: document.getElementById('expExplain'),
      memoBox: document.getElementById('memoBox'),
      memoInput: document.getElementById('memoInput'),
      score: document.getElementById('scoreBadge'),
      pos: document.getElementById('posLabel'),
      prev: document.getElementById('prevBtn'),
      next: document.getElementById('nextBtn'),
      bookmark: document.getElementById('bookmarkBtn'),
      memoBtn: document.getElementById('memoBtn'),
      resultBtn: document.getElementById('resultBtn'),
      back: document.getElementById('backToListBtn'),
    };
    this._bind();
  }

  _bind() {
    if (this._bound) return;
    this._bound = true;
    this.el.prev.onclick = () => this.go(-1);
    this.el.next.onclick = () => this.go(1);
    this.el.resultBtn.onclick = () => this.finish();
    this.el.back.onclick = () => { this.persist(); this.onExit(); };
    this.el.bookmark.onclick = () => this.toggleBookmark();
    this.el.memoBtn.onclick = () => {
      const show = this.el.memoBox.style.display !== 'block';
      this.el.memoBox.style.display = show ? 'block' : 'none';
      if (show) this.el.memoInput.focus();
    };
    this.el.memoInput.oninput = () => {
      this.memos[this.order[this.cur]] = this.el.memoInput.value;
      this._debouncePersist();
    };
    this.el.ox.querySelectorAll('.ox-btn').forEach((b) => {
      b.onclick = () => this.select(Number(b.dataset.ox));
    });
  }

  /** 저장된 이어풀기 상태가 있으면 복원. 반환값: 복원했는지 여부 */
  async restore() {
    const s = await loadSession(this.examKey);
    if (!s || !Array.isArray(s.answers) || s.answers.length !== this.all.length) return false;
    this.answers = s.answers;
    this.bookmarks = s.bookmarks || this.bookmarks;
    this.memos = s.memos || this.memos;
    if (Array.isArray(s.unsure) && s.unsure.length === this.all.length) this.unsure = s.unsure;
    if (Array.isArray(s.colors) && s.colors.length === this.all.length) this.colors = s.colors;
    this.cur = Math.min(s.cur || 0, this.order.length - 1);
    return s.answers.some((a) => a !== null);
  }

  persist() {
    saveSession(this.examKey, {
      answers: this.answers,
      bookmarks: this.bookmarks,
      memos: this.memos,
      unsure: this.unsure,
      colors: this.colors,
      cur: this.cur,
      title: this.title,
      total: this.all.length,
    }).catch(() => {});
    scheduleBackup();   // 이어풀기 상태도 재설치 때 되살릴 수 있게
  }
  _debouncePersist() {
    clearTimeout(this._pt);
    this._pt = setTimeout(() => this.persist(), 600);
  }

  get q() { return this.all[this.order[this.cur]]; }
  get qIndex() { return this.order[this.cur]; }

  /** 채점 대상인가 — 'open'(서술형 복원)은 정답이 없어 점수에 넣지 않는다. */
  isGraded(i) { return this.all[i] && this.all[i].type !== 'open'; }

  isCorrect(i) {
    if (!this.isGraded(i)) return false;
    const q = this.all[i];
    const a = this.answers[i];
    if (a === null) return false;
    // 모두 고르시오는 **빠짐없이 그리고 더함없이** 골라야 맞다
    if (isMulti(q)) return isMultiCorrect(q, a);
    return isAns(q, a);
  }

  start() {
    this.el.title.textContent = this.title;
    this.el.screen.classList.remove('hidden');
    // 몇 회차인지·지난번에 뭘 골랐는지는 저장소에만 있다 — 못 읽어도 풀이는 막지 않는다
    examRun(this.examKey).then((r) => { this.run = r; }).catch(() => {});
    allAttempts().then((list) => {
      this._hist = new Map(list.filter((a) => a && a.history && a.history.length)
        .map((a) => [a.id, a.history]));
      if (this.el.explain.style.display === 'block') this.render();
    }).catch(() => {});
    this.render();
  }

  /** 이 문항의 지난 풀이들 — 모아 풀기에서는 문항마다 원래 시험이 다르다. */
  historyOf(idx) {
    const q = this.all[idx];
    if (!q) return [];
    const id = attemptId(q.__exam || this.examKey, q.num != null ? q.num : idx + 1, q.id || null);
    return this._hist.get(id) || [];
  }

  render() {
    const q = this.q;
    const idx = this.qIndex;

    this.el.qnum.textContent = `문제 ${q.num}${q.type === 'ox' ? ' (O/X)' : ''}`;

    const src = q.source || q.srcTag;
    if (src) { this.el.qsource.textContent = `📚 ${src}`; this.el.qsource.style.display = 'inline-block'; }
    else { this.el.qsource.style.display = 'none'; }

    // 단어 단위 span으로 깔아둔다 — 올가미(동그라미)가 이걸 hit-test 한다.
    tokenize(this.el.qtext, q.q);
    this._renderImages(q);

    this.el.pos.textContent = `${this.cur + 1}/${this.order.length}`;
    this.el.explain.style.display = 'none';
    this.el.memoBox.style.display = 'none';
    this.el.memoInput.value = this.memos[idx] || '';
    this.el.bookmark.classList.toggle('active', this.bookmarks[idx]);
    this.el.bookmark.textContent = this.bookmarks[idx] ? '★' : '☆';
    this.el.prev.disabled = this.cur === 0;
    this.el.next.disabled = this.cur === this.order.length - 1;

    if (q.type === 'open') this._renderOpen(q, idx);
    else if (q.type === 'multi') this._renderMulti(q, idx);
    else if (q.type === 'mc') this._renderMC(q, idx);
    else this._renderOX(q, idx);

    const answered = this.answers[idx] !== null;
    if (answered) this._showExplain(q);
    this._updateScore();

    // 아직 안 푼 문항에서는 해설이 없어 "다음"이 멀리 떨어져 보인다 —
    // 카드 안쪽 끝에 이어서 넘길 수 있는 버튼을 둔다(2026-10-09 피드백).
    this._renderInlineNext(answered);

    // ⚠️ **한 곳에서 통째로** 낱말을 깐다. 전에는 글을 찍는 자리마다 따로 불렀는데,
    //    선지별 해설(.opt-explain)에서 빠뜨려서 거기만 한 줄씩 통째로 잡혔다
    //    (2026-10-19 신고: "정답쪽 내용 긁기로 하니까 아직도 한 줄 하이라이트").
    //    새 글자를 어디에 더해도 저절로 따라오게 여기 하나만 둔다.
    //    tokenizeTree는 이미 깐 자리를 건너뛰므로 두 번 불러도 안전하다.
    //    퀴즈와 모의고사는 이 엔진 하나를 같이 쓰므로 여기서 둘 다 낫는다.
    tokenizeTree(this.el.card);
    window.scrollTo({ top: 0, behavior: 'instant' });
    this.onRender(q, idx, { answered });
  }

  /**
   * 이 문항을 **글로 떠낸다** — 문제·선지·정답·해설까지(2026-10-21 요청).
   *
   * 다른 데 물어보거나 메모에 옮길 때 쓴다. 화면을 긁어 모으면 번호와 줄바꿈이
   * 깨지므로 데이터에서 바로 만든다. 아직 안 푼 문항은 **정답을 안 붙인다** —
   * 복사했다가 답을 먼저 보게 되면 푸는 뜻이 없다.
   */
  copyText() {
    const q = this.q;
    const idx = this.qIndex;
    const out = [`문제 ${q.num}. ${q.q}`.trim()];
    if (Array.isArray(q.opts) && q.opts.length) {
      q.opts.forEach((o, i) => out.push(`${CIRCLED[i] || i + 1} ${o}`));
    } else if (q.type === 'ox') {
      out.push('O / X');
    }
    if (this.answers[idx] !== null) {          // 푼 뒤에만 답과 해설을 붙인다
      out.push('');
      out.push(`정답: ${q.type === 'ox' ? (isAns(q, 0) ? 'O' : 'X') : ansLabel_(q)}`);
      if (q.summary) out.push(`요약: ${q.summary}`);
      if (q.explain) out.push(`해설: ${q.explain}`);
      if (Array.isArray(q.opt) && q.opt.some(Boolean)) {
        out.push('선지별 해설:');
        q.opt.forEach((t, i) => { if (t) out.push(`  ${CIRCLED[i] || i + 1} ${t}`); });
      }
    }
    const src = q.source || q.srcTag;
    if (src) out.push(`[${src}]`);
    out.push(`— ${this.title}`);
    return out.join('\n');
  }

  /** 문제 카드 하단의 "다음 문제" — 흐름이 끊기지 않게. */
  _renderInlineNext(answered) {
    let bar = document.getElementById('inlineNext');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'inlineNext';
      bar.className = 'inline-next';
      this.el.memoBox.parentNode.appendChild(bar);
    }
    bar.innerHTML = '';
    const last = this.cur === this.order.length - 1;

    if (!answered) {
      const hint = document.createElement('span');
      hint.className = 'muted';
      hint.textContent = this.q.type === 'open'
        ? '선지가 없는 복원 문항입니다 — 해설만 읽고 넘어가세요'
        : '선지를 고르면 해설이 나옵니다';
      bar.appendChild(hint);
    }
    // 복사 — "다음 문제" **왼쪽**에 붙인다(2026-10-21 요청). 거기로 손이 이미 가 있다.
    const copy = document.createElement('button');
    copy.className = 'btn q-copy';
    copy.textContent = '📋 복사';
    copy.title = answered ? '문제·선지·해설을 글로 복사합니다' : '문제와 선지를 글로 복사합니다';
    copy.onclick = async () => {
      const ok = await this.onCopy(this.copyText());
      copy.textContent = ok ? '✓ 복사함' : '복사 실패';
      setTimeout(() => { copy.textContent = '📋 복사'; }, 1400);
    };
    bar.appendChild(copy);

    const btn = document.createElement('button');
    btn.className = 'btn' + (answered ? ' primary' : '');
    btn.textContent = last ? '결과 보기 ›' : (answered ? '다음 문제 ›' : '건너뛰고 다음 ›');
    btn.onclick = () => (last ? this.finish() : this.go(1));
    bar.appendChild(btn);
  }

  _renderMC(q, idx) {
    this.el.ox.classList.add('hidden');
    this.el.opts.style.display = 'block';
    this.el.opts.innerHTML = '';
    const locked = this.answers[idx] !== null;

    q.opts.forEach((opt, i) => {
      const row = document.createElement('div');
      row.className = 'opt-row';
      if (this.eliminated[idx].has(i)) row.classList.add('strike');

      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = CIRCLED[i] || String(i + 1);

      const wrap = document.createElement('div');
      wrap.style.flex = '1';
      const txt = document.createElement('div');
      txt.className = 'opt-text';
      tokenize(txt, opt);   // 선지도 올가미 대상
      wrap.appendChild(txt);

      if (locked && Array.isArray(q.opt) && q.opt[i]) {
        const ex = document.createElement('div');
        ex.className = 'opt-explain';
        ex.textContent = q.opt[i];
        wrap.appendChild(ex);
      }

      row.appendChild(badge);
      row.appendChild(wrap);

      if (!locked) {
        const el = document.createElement('div');
        el.className = 'eliminate';
        el.textContent = '✕';
        el.onclick = (e) => { e.stopPropagation(); this._toggleEliminate(i); };
        row.appendChild(el);
        row.onclick = () => this.select(i);
      } else {
        row.classList.add('locked');
        if (isAns(q, i)) row.classList.add('correct');
        else if (i === this.answers[idx]) row.classList.add('wrong');
      }
      this.el.opts.appendChild(row);
    });
  }

  /**
   * "모두 고르시오" — 체크로 여럿 골라 한꺼번에 낸다(2026-10-21 요청).
   *
   * 전에는 이런 문항도 라디오처럼 하나만 고르게 해놓고 **정답 중 아무거나 하나**면
   * 맞다고 쳤다. 그러면 다섯 개 중 셋이 답인 문항을 하나만 찍고 넘어가면서도
   * 점수가 올라서, 정작 시험장에서 못 고른다. 전부 골라야 맞게 바꾼다.
   */
  _renderMulti(q, idx) {
    this.el.ox.classList.add('hidden');
    this.el.opts.style.display = 'block';
    this.el.opts.innerHTML = '';
    const locked = this.answers[idx] !== null;
    const draft = locked ? this.answers[idx] : (this._draft[idx] || []);

    const note = document.createElement('p');
    note.className = 'muted multi-note';
    if (locked) {
      note.textContent = `답을 ${(q.ansAll || []).length}개 모두 고르는 문항이었습니다.`;
    } else {
      note.innerHTML = `✅ 모두 고르는 문항입니다 — 해당하는 것을 <b>전부</b> 고르고 `
        + `"답 내기"를 누르세요.`;
    }
    this.el.opts.appendChild(note);

    q.opts.forEach((opt, i) => {
      const row = document.createElement('div');
      row.className = 'opt-row opt-check';
      const on = draft.includes(i);
      // ⚠️ 채점한 뒤에는 'picked'를 붙이지 않는다 — 고른 티(파랑)가 맞음/틀림 색을
      //    덮어써서 **틀리게 고른 것이 맞은 것과 똑같이 보였다**(2026-10-21 눈으로 확인).
      if (on && !locked) row.classList.add('picked');
      if (!locked && this.eliminated[idx].has(i)) row.classList.add('strike');

      const badge = document.createElement('div');
      badge.className = 'badge check';
      badge.textContent = on ? '✓' : (CIRCLED[i] || String(i + 1));

      const wrap = document.createElement('div');
      wrap.style.flex = '1';
      const txt = document.createElement('div');
      txt.className = 'opt-text';
      tokenize(txt, opt);
      wrap.appendChild(txt);
      if (locked && Array.isArray(q.opt) && q.opt[i]) {
        const ex = document.createElement('div');
        ex.className = 'opt-explain';
        ex.textContent = q.opt[i];
        wrap.appendChild(ex);
      }

      row.appendChild(badge);
      row.appendChild(wrap);
      if (!locked) {
        row.onclick = () => this.togglePick(i);
      } else {
        row.classList.add('locked');
        const want = isAns(q, i);
        const got = draft.includes(i);
        // 넷으로 갈린다: 맞게 골랐다 / 빠뜨렸다 / 잘못 골랐다 / 안 고른 게 맞다
        if (want && got) row.classList.add('correct');
        else if (want && !got) row.classList.add('missed');
        else if (!want && got) row.classList.add('wrong');
      }
      this.el.opts.appendChild(row);
    });

    if (!locked) {
      const b = document.createElement('button');
      b.className = 'btn primary full multi-go';
      b.textContent = draft.length ? `답 내기 (${draft.length}개 고름)` : '답 내기';
      b.disabled = !draft.length;
      b.onclick = () => this.submitPicks();
      this.el.opts.appendChild(b);
    }
  }

  /** 모두 고르기 — 체크를 켜고 끈다(아직 내는 건 아니다). */
  togglePick(i) {
    const idx = this.qIndex;
    if (this.answers[idx] !== null) return;
    const cur = this._draft[idx] || [];
    this._draft[idx] = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b);
    this.render();
  }

  /** 골라둔 것을 답으로 낸다. */
  submitPicks() {
    const idx = this.qIndex;
    const draft = this._draft[idx] || [];
    if (!draft.length || this.answers[idx] !== null) return;
    this.answers[idx] = draft;
    this.persist();
    this._record(idx);
    this.render();
  }

  /**
   * 채점할 수 없는 문항 — 족보에 "복원 x", "답이었던거같습니다"처럼 **서술로만** 남은 것들
   * (응급_중환자 658블록 중 180개). 버리면 실제 시험장 정보를 버리는 거라 살려두되,
   * 선지가 없으니 점수에서 빼고 "읽고 넘기는 카드"로 보여준다(2026-10-12).
   */
  _renderOpen(q, idx) {
    this.el.ox.classList.add('hidden');
    this.el.opts.style.display = 'block';
    this.el.opts.innerHTML = '';
    const seen = this.answers[idx] !== null;

    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = '선지 없이 서술로만 복원된 문항입니다 — 점수에 들어가지 않습니다.';
    this.el.opts.appendChild(note);

    if (!seen) {
      const b = document.createElement('button');
      b.className = 'btn primary full';
      b.textContent = '정답·해설 보기';
      b.onclick = () => this.select(0);
      this.el.opts.appendChild(b);
    }
  }

  _renderOX(q, idx) {
    this.el.opts.style.display = 'none';
    this.el.ox.classList.remove('hidden');
    const locked = this.answers[idx] !== null;
    this.el.ox.querySelectorAll('.ox-btn').forEach((b, i) => {
      b.classList.remove('correct', 'wrong');
      b.disabled = locked;
      if (locked) {
        if (isAns(q, i)) b.classList.add('correct');
        else if (i === this.answers[idx]) b.classList.add('wrong');
      }
    });
  }

  async _renderImages(q) {
    const paths = imagePaths(q);
    this.el.qimg.innerHTML = '';
    if (!paths.length) { this.el.qimg.style.display = 'none'; return; }
    this.el.qimg.style.display = 'block';

    const note = document.createElement('div');
    note.className = 'img-loading';
    note.textContent = '이미지 불러오는 중…';
    this.el.qimg.appendChild(note);

    const token = Symbol();
    this._imgToken = token;
    const urls = [];
    for (const p of paths) {
      try {
        // 캐시는 github.js(getBlobUrl)에만 둔다 — 여기 또 들고 있으면 저쪽 LRU가
        // 버린 **죽은 주소**를 여기가 계속 내준다(2026-10-22). 같은 그림을 동시에
        // 두 번 받지 않는 것도 저쪽이 이미 한다(blobWait).
        urls.push(await getBlobUrl(p));
      } catch (e) {
        urls.push(null);
      }
    }
    if (this._imgToken !== token) return; // 그 사이 문항이 바뀜
    this.el.qimg.innerHTML = '';
    urls.forEach((u, i) => {
      if (!u) {
        const err = document.createElement('div');
        err.className = 'img-loading';
        err.textContent = `이미지를 불러오지 못했습니다 (${paths[i]})`;
        this.el.qimg.appendChild(err);
        return;
      }
      const im = document.createElement('img');
      im.src = u;
      im.alt = '문제 이미지';
      this.el.qimg.appendChild(im);
    });
  }

  _toggleEliminate(i) {
    const s = this.eliminated[this.qIndex];
    if (s.has(i)) s.delete(i); else s.add(i);
    this.render();
  }

  select(i) {
    const idx = this.qIndex;
    if (this.answers[idx] !== null) return;
    this.answers[idx] = i;
    this.unsure[idx] = false;
    this.persist();
    this._record(idx);
    this.render();
  }

  /**
   * 이 문항의 풀이 결과를 이력에 남긴다 — 과목 전체에서 약한 문항을 모으기 위해.
   * 실패해도 풀이를 막지 않는다(저장소 문제로 시험을 못 보면 안 된다).
   */
  _record(idx) {
    const q = this.all[idx];
    if (!q || q.type === 'open') return;   // 채점할 수 없는 문항은 약점 통계를 오염시킨다
    this._recorded.add(idx);
    recordAttempt({
      // 모아 풀기에서는 문항마다 원래 시험이 다르다 — 이력은 원본 시험에 쌓아야 한다
      exam: q.__exam || this.examKey,
      num: q.num != null ? q.num : idx + 1,
      // 문항에 안정적 원본 ID(qid)가 있으면 그걸로 이력을 모은다 — 즉석 랜덤 모의고사에서
      // 같은 원본 문항이 다른 파일·다른 번호로 다시 뽑혀도 한 이력으로 이어진다(2026-10-26).
      // 없으면 attemptId가 알아서 exam#num으로 돌아간다(지금까지의 모든 문항이 이 경우다).
      qid: q.id || null,
      subject: q.__subject || this.meta.subject || '',
      kind: q.__kind || this.meta.kind || '',
      title: q.__title || this.title,
      picked: this.answers[idx],
      correct: this.isCorrect(idx),
      unsure: !!this.unsure[idx],
      run: this.run,
    }).catch(() => {});
  }

  /**
   * ★ 북마크를 켜고 끈다 — 툴바 버튼과 "문항 전체보기"의 별표가 같은 경로를 쓴다
   * (2026-10-26 — 전에는 각자 `bookmarks[i]`를 따로 건드려 한쪽만 고치면 다른 쪽이
   * 안 맞을 위험이 있었다). 과목 전체 모아보기에도 보이도록 attempts에도 남긴다 —
   * 아직 한 번도 안 푼 문항이면(이력이 없으면) markBookmark가 조용히 아무 일도 안 한다.
   */
  setBookmark(i, on) {
    this.bookmarks[i] = on;
    this.persist();
    if (this.qIndex === i) {
      this.el.bookmark.classList.toggle('active', on);
      this.el.bookmark.textContent = on ? '★' : '☆';
    }
    const q = this.all[i];
    markBookmark(q.__exam || this.examKey, q.num != null ? q.num : i + 1, on, q.id || null).catch(() => {});
  }

  toggleBookmark() {
    const i = this.qIndex;
    this.setBookmark(i, !this.bookmarks[i]);
  }

  /** "찍었음" 토글 — 맞았어도 다시 볼 큐에 넣는다. */
  toggleUnsure() {
    const idx = this.qIndex;
    if (this.answers[idx] === null) return;
    const q = this.all[idx];
    this.unsure[idx] = !this.unsure[idx];
    this.persist();
    markUnsure(q.__exam || this.examKey, q.num != null ? q.num : idx + 1, this.unsure[idx], q.id || null).catch(() => {});
    this.render();
  }

  /** 이 문항만 답을 비운다 — 선지를 잘못 눌렀을 때. */
  resetOne() {
    const idx = this.qIndex;
    this.answers[idx] = null;
    this.eliminated[idx] = new Set();
    this._draft[idx] = [];            // 모두 고르기는 체크도 같이 비운다
    this.persist();
    this.render();
  }

  _showExplain(q) {
    const idx = this.qIndex;
    this.el.expText.innerHTML = '';
    const mk = (html) => { const d = document.createElement('div'); d.className = 'line'; d.innerHTML = html; return d; };

    // 'open'은 맞고 틀림이 없다 — ❌로 띄우면 틀린 줄 안다
    const open = q.type === 'open';
    const correct = !open && this.isCorrect(idx);
    const ansLabel = q.type === 'ox' ? (q.ans === 0 ? 'O' : 'X') : ansLabel_(q);
    // 족보 원문에 번호가 없어 **가공하며 미뤄 짚은** 답이면 그렇다고 못 박는다.
    // 숨기면 학생이 추측을 정답으로 외운다(2026-10-22).
    const guessTag = q.guessed
      ? ' <span class="ans-guess" title="족보 원문에 정답 번호가 없어 해설·검증에서 미뤄 짚은 답입니다">추정</span>'
      : '';
    const head = mk(open
      ? '📖 족보 원문 — 정답은 아래 해설에 있습니다'
      : `${correct ? '✅ 정답' : '❌ 오답'} — 정답 <b class="opt-num">${ansLabel}</b>${guessTag}`);
    // 선지를 잘못 눌렀을 때 되돌릴 수 있게(실수로 탭하는 경우가 잦다)
    const retry = document.createElement('button');
    retry.className = 'retry-one';
    retry.textContent = '↺ 다시 풀기';
    retry.onclick = () => this.resetOne();
    head.appendChild(retry);

    // 찍어서 맞춘 문항이 "정답"으로만 남으면 약점이 숨는다 — 눌러서 다시 볼 큐에 넣는다.
    // 'open'에는 "찍었음"이 뜻이 없다. `hidden` 속성은 .unsure-btn의 display가
    // 덮어써버리므로(UA 스타일보다 클래스가 세다) 아예 붙이지 않는다.
    if (!open) {
      const unsure = document.createElement('button');
      unsure.className = 'unsure-btn' + (this.unsure[idx] ? ' on' : '');
      unsure.textContent = this.unsure[idx] ? '🎲 찍었음 ✓' : '🎲 찍었음';
      unsure.title = '확신 없이 골랐다면 눌러두세요 — 맞았어도 다시 볼 목록에 들어갑니다';
      unsure.onclick = () => this.toggleUnsure();
      head.appendChild(unsure);
    }
    this.el.expText.appendChild(head);
    if (correct && this.unsure[idx]) {
      this.el.expText.appendChild(mk('<span class="muted">맞았지만 <b>다시 볼 목록</b>에 넣었습니다.</span>'));
    }
    // 지난 회차에 뭘 골랐는지 — "또 같은 선지에 걸렸다"가 눈에 보여야 뜻이 있다
    // (2026-10-21 요청: "몇번째 문제 푸는지, 그 때 뭘 답으로 했는지 기억하게").
    // 지금 회차는 빼고 보여준다 — 바로 위에 정답/오답이 이미 떠 있다.
    const past = this.historyOf(idx).filter((h) => (h.run || 0) !== this.run);
    if (past.length) {
      const trail = past.map((h) => {
        const lbl = pickLabel(q, h.picked);
        return `${h.run ? `${h.run}회 ` : ''}${lbl}${h.correct ? '✓' : '✗'}${h.unsure ? '🎲' : ''}`;
      }).join(' · ');
      this.el.expText.appendChild(mk(`<span class="muted">지난 풀이 — ${escapeHtml(trail)}</span>`));
    }
    if (q.explain) this.el.expText.appendChild(mk(`📌 ${escapeHtml(q.explain)}`));
    if (Array.isArray(q.opt) && q.opt.some(Boolean) && q.type !== 'mc') {
      this.el.expText.appendChild(mk('오답노트:\n' + q.opt.map((t, i) => (t ? `${CIRCLED[i]} ${t}` : '')).filter(Boolean).join('\n')));
    }
    // 답을 고르면 선지별 해설(.opt-explain)이 새로 붙는다 — 문제 카드를 통째로 다시 깐다.
    // 해설 상자만 깔면 선지 밑에 붙은 글이 빠져 거기만 한 줄씩 잡혔다(2026-10-19).
    tokenizeTree(this.el.card);
    this.el.explain.style.display = 'block';
  }

  _updateScore() {
    let correct = 0, answered = 0;
    this.order.forEach((i) => {
      if (!this.isGraded(i)) return;
      if (this.answers[i] !== null) { answered++; if (this.isCorrect(i)) correct++; }
    });
    this.el.score.textContent = `${correct}/${answered}`;
  }

  go(d) {
    const n = this.cur + d;
    if (n < 0 || n >= this.order.length) return;
    this.cur = n;
    this.persist();
    this.render();
  }

  /** 전체보기에서 문항을 눌렀을 때 — 번호가 아니라 **원본 배열 인덱스**로 바로 건너뛴다. */
  goTo(i) {
    const pos = this.order.indexOf(i);
    if (pos < 0) return;
    this.cur = pos;
    this.persist();
    this.render();
  }

  /** 색상 표시를 순환시킨다. 같은 색을 다시 고르면 지운다. */
  setColor(i, color) {
    this.colors[i] = this.colors[i] === color ? 0 : color;
    this.persist();
  }

  /** 결과 집계 */
  results() {
    const items = this.order.map((i) => ({
      i,
      q: this.all[i],
      picked: this.answers[i],
      correct: this.isCorrect(i),
      memo: this.memos[i] || '',
      bookmarked: !!this.bookmarks[i],
      unsure: !!this.unsure[i],
      color: this.colors[i] || 0,
    }));
    const graded = items.filter((x) => this.isGraded(x.i));
    const answered = graded.filter((x) => x.picked !== null);
    const correct = answered.filter((x) => x.correct);
    return {
      total: graded.length,
      // 서술형 복원 문항은 점수에서 빼되, 몇 개를 읽었는지는 따로 보여준다
      read: items.filter((x) => !this.isGraded(x.i) && x.picked !== null).length,
      openTotal: items.length - graded.length,
      answered: answered.length,
      correct: correct.length,
      wrong: answered.filter((x) => !x.correct),
      // 맞았지만 찍은 것 — 점수에는 안 들어가지만 다시 봐야 한다
      lucky: answered.filter((x) => x.correct && x.unsure),   // 맞았지만 찍은 것
      unanswered: graded.filter((x) => x.picked === null),
      items,
    };
  }

  /**
   * 결과 보기 — 이어풀기로 되살린 답은 이력에 없으므로 여기서 메꾼다.
   *
   * 왜 필요한가: `select()`에서만 기록하면 **앱을 닫았다 다시 열어 이어 푼 문항**이
   * 전부 "다시 볼 문항"에서 빠진다. 이미 풀던 시험이 있는 상태로 이 기능이
   * 들어왔으니 더 그렇다(2026-10-10).
   */
  finish() {
    this.persist();
    this.order.forEach((i) => {
      if (this.answers[i] !== null && !this._recorded.has(i)) this._record(i);
    });
    // 목록 화면에서 "완료"로 색을 다르게 보여주는 데 쓴다 — 모든 문항을 안 풀고 여기서
    // 끝내도(2026-10-26 요청: "결과보기를 해서 끝내버린 경우는 완료로") session과
    // 무관하게 남는다.
    markExamFinished(this.examKey).catch(() => {});
    this.onFinish(this.results());
  }

  /**
   * 틀린 문제만 다시 풀기 — 답안을 비우고 그 문항들만 순회한다.
   * 찍어서 맞춘 문항도 같이 꺼낸다(점수만 맞고 모르는 채로 넘어가지 않게).
   */
  retryWrong() {
    const wrongIdx = this.order.filter(
      (i) => this.isGraded(i) && this.answers[i] !== null && (!this.isCorrect(i) || this.unsure[i]));
    if (!wrongIdx.length) return false;
    wrongIdx.forEach((i) => {
      this.answers[i] = null;
      this.unsure[i] = false;
      this.eliminated[i] = new Set();
      this._recorded.delete(i);          // 다시 풀면 새 시도로 센다
    });
    this.order = wrongIdx;
    this.cur = 0;
    bumpExamRun(this.examKey).then((r) => { this.run = r; }).catch(() => {});
    unmarkExamFinished(this.examKey).catch(() => {});   // 다시 들어갔으니 "완료"는 뗀다
    this.persist();
    return true;
  }

  restart() {
    this.order = this.all.map((_, i) => i);
    this.answers.fill(null);
    this.unsure.fill(false);
    this.eliminated = this.all.map(() => new Set());
    this._recorded.clear();              // 처음부터 다시 — 모두 새 시도로 센다
    this.cur = 0;
    // ⚠️ 여기서 지워지는 건 **이번에 고른 답**뿐이다. 무엇을 골랐었는지는
    // recordAttempt의 history에 회차별로 남아 있다(2026-10-21 요청: 다시 풀기는
    // 취소 단추처럼 안 푼 상태로 되돌리되, 푼 기록 자체는 없애지 않는다).
    bumpExamRun(this.examKey).then((r) => { this.run = r; }).catch(() => {});
    unmarkExamFinished(this.examKey).catch(() => {});   // 다시 들어갔으니 "완료"는 뗀다
    clearSession(this.examKey).catch(() => {});
  }

  destroy() {
    // ⚠️ **여기서 그림 주소를 버리면 안 된다.** 이 주소는 github.js(getBlobUrl)가
    //    주인이고 거기 LRU에 그대로 남아 있다. 여기서 revoke하면 github.js는
    //    **죽은 주소**를 계속 들고 있다가 다음에 그대로 내주고, 그러면 <img>는
    //    붙지만 아무것도 안 그려진다 — "족보 풀 때 보면 사진이 없음"(2026-10-22 신고).
    //    재어 보니 처음엔 2/2장이 보이고, 닫았다 다시 열면 0/2장이었다.
    //    주인은 하나여야 한다 — 버리는 일은 github.js의 releaseBlobs()에 맡긴다.
    this.el.screen.classList.add('hidden');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
