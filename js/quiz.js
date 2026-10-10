// 풀이 화면 — 기존 모의고사 HTML(06_모의고사/근골격계/0908_...html)의 렌더링·채점 로직을
// 그대로 옮기고, 아이패드용(이어풀기·이미지 지연로딩·틀린문제 재시도)만 더했다.

import { getBlobUrl } from './github.js';
import { imagePaths } from './parser.js';
import { saveSession, loadSession, clearSession, recordAttempt, markUnsure } from './db.js';
import { scheduleBackup } from './backup.js';
import { tokenize, tokenizeTree } from './pen.js';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];

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
  constructor({ examKey, questions, title, onFinish, onExit, onRender, meta }) {
    this.examKey = examKey;
    this.meta = meta || {};
    this.all = questions;
    this.order = questions.map((_, i) => i); // 재시도 모드에서 부분집합이 된다
    this.title = title;
    this.onFinish = onFinish;
    this.onExit = onExit;
    // 문항이 바뀔 때마다 알려준다 — 펜 레이어·위키 패널이 여기에 붙는다.
    this.onRender = onRender || (() => {});

    this.cur = 0;
    this.answers = new Array(questions.length).fill(null);
    this.eliminated = questions.map(() => new Set());
    this.bookmarks = new Array(questions.length).fill(false);
    this.memos = new Array(questions.length).fill('');
    // "찍어서 맞췄다" 표시 — 맞은 문항도 다시 볼 큐에 넣기 위한 것(2026-10-10)
    this.unsure = new Array(questions.length).fill(false);
    // 이번 화면에서 이력을 남긴 문항 — 이어풀기로 되살린 답을 끝낼 때 한 번만 쌓는다
    this._recorded = new Set();
    this._imgCache = new Map();

    this.el = {
      screen: document.getElementById('quizScreen'),
      title: document.getElementById('quizTitle'),
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
    this.el.bookmark.onclick = () => {
      const i = this.order[this.cur];
      this.bookmarks[i] = !this.bookmarks[i];
      this.el.bookmark.classList.toggle('active', this.bookmarks[i]);
      this.el.bookmark.textContent = this.bookmarks[i] ? '★' : '☆';
      this.persist();
    };
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
    this.cur = Math.min(s.cur || 0, this.order.length - 1);
    return s.answers.some((a) => a !== null);
  }

  persist() {
    saveSession(this.examKey, {
      answers: this.answers,
      bookmarks: this.bookmarks,
      memos: this.memos,
      unsure: this.unsure,
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

  isCorrect(i) {
    const a = this.answers[i];
    return a !== null && a === this.all[i].ans;
  }

  start() {
    this.el.title.textContent = this.title;
    this.el.screen.classList.remove('hidden');
    this.render();
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

    if (q.type === 'mc') this._renderMC(q, idx);
    else this._renderOX(q, idx);

    const answered = this.answers[idx] !== null;
    if (answered) this._showExplain(q);
    this._updateScore();

    // 아직 안 푼 문항에서는 해설이 없어 "다음"이 멀리 떨어져 보인다 —
    // 카드 안쪽 끝에 이어서 넘길 수 있는 버튼을 둔다(2026-10-09 피드백).
    this._renderInlineNext(answered);

    window.scrollTo({ top: 0, behavior: 'instant' });
    this.onRender(q, idx, { answered });
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
      hint.textContent = '선지를 고르면 해설이 나옵니다';
      bar.appendChild(hint);
    }
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
        if (i === q.ans) row.classList.add('correct');
        else if (i === this.answers[idx]) row.classList.add('wrong');
      }
      this.el.opts.appendChild(row);
    });
  }

  _renderOX(q, idx) {
    this.el.opts.style.display = 'none';
    this.el.ox.classList.remove('hidden');
    const locked = this.answers[idx] !== null;
    this.el.ox.querySelectorAll('.ox-btn').forEach((b, i) => {
      b.classList.remove('correct', 'wrong');
      b.disabled = locked;
      if (locked) {
        if (i === q.ans) b.classList.add('correct');
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
        let url = this._imgCache.get(p);
        if (!url) { url = await getBlobUrl(p); this._imgCache.set(p, url); }
        urls.push(url);
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
    if (!q) return;
    this._recorded.add(idx);
    recordAttempt({
      // 모아 풀기에서는 문항마다 원래 시험이 다르다 — 이력은 원본 시험에 쌓아야 한다
      exam: q.__exam || this.examKey,
      num: q.num != null ? q.num : idx + 1,
      subject: q.__subject || this.meta.subject || '',
      kind: q.__kind || this.meta.kind || '',
      title: q.__title || this.title,
      picked: this.answers[idx],
      correct: this.isCorrect(idx),
      unsure: !!this.unsure[idx],
    }).catch(() => {});
  }

  /** "찍었음" 토글 — 맞았어도 다시 볼 큐에 넣는다. */
  toggleUnsure() {
    const idx = this.qIndex;
    if (this.answers[idx] === null) return;
    const q = this.all[idx];
    this.unsure[idx] = !this.unsure[idx];
    this.persist();
    markUnsure(q.__exam || this.examKey, q.num != null ? q.num : idx + 1, this.unsure[idx]).catch(() => {});
    this.render();
  }

  /** 이 문항만 답을 비운다 — 선지를 잘못 눌렀을 때. */
  resetOne() {
    const idx = this.qIndex;
    this.answers[idx] = null;
    this.eliminated[idx] = new Set();
    this.persist();
    this.render();
  }

  _showExplain(q) {
    const idx = this.qIndex;
    this.el.expText.innerHTML = '';
    const mk = (html) => { const d = document.createElement('div'); d.className = 'line'; d.innerHTML = html; return d; };

    const correct = this.answers[idx] === q.ans;
    const ansLabel = q.type === 'ox' ? (q.ans === 0 ? 'O' : 'X') : (CIRCLED[q.ans] || q.ans + 1);
    const head = mk(`${correct ? '✅ 정답' : '❌ 오답'} — 정답 <b class="opt-num">${ansLabel}</b>`);
    // 선지를 잘못 눌렀을 때 되돌릴 수 있게(실수로 탭하는 경우가 잦다)
    const retry = document.createElement('button');
    retry.className = 'retry-one';
    retry.textContent = '↺ 다시 풀기';
    retry.onclick = () => this.resetOne();
    head.appendChild(retry);

    // 찍어서 맞춘 문항이 "정답"으로만 남으면 약점이 숨는다 — 눌러서 다시 볼 큐에 넣는다.
    const unsure = document.createElement('button');
    unsure.className = 'unsure-btn' + (this.unsure[idx] ? ' on' : '');
    unsure.textContent = this.unsure[idx] ? '🎲 찍었음 ✓' : '🎲 찍었음';
    unsure.title = '확신 없이 골랐다면 눌러두세요 — 맞았어도 다시 볼 목록에 들어갑니다';
    unsure.onclick = () => this.toggleUnsure();
    head.appendChild(unsure);
    this.el.expText.appendChild(head);
    if (correct && this.unsure[idx]) {
      this.el.expText.appendChild(mk('<span class="muted">맞았지만 <b>다시 볼 목록</b>에 넣었습니다.</span>'));
    }
    if (q.explain) this.el.expText.appendChild(mk(`📌 ${escapeHtml(q.explain)}`));
    if (Array.isArray(q.opt) && q.opt.some(Boolean) && q.type !== 'mc') {
      this.el.expText.appendChild(mk('오답노트:\n' + q.opt.map((t, i) => (t ? `${CIRCLED[i]} ${t}` : '')).filter(Boolean).join('\n')));
    }
    // 해설도 밑줄로 긁어서 질문할 수 있게 토큰화한다(2026-10-09 요청)
    tokenizeTree(this.el.expText);
    this.el.explain.style.display = 'block';
  }

  _updateScore() {
    let correct = 0, answered = 0;
    this.order.forEach((i) => {
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
    }));
    const answered = items.filter((x) => x.picked !== null);
    const correct = answered.filter((x) => x.correct);
    return {
      total: this.order.length,
      answered: answered.length,
      correct: correct.length,
      wrong: answered.filter((x) => !x.correct),
      // 맞았지만 찍은 것 — 점수에는 안 들어가지만 다시 봐야 한다
      lucky: answered.filter((x) => x.correct && x.unsure),
      unanswered: items.filter((x) => x.picked === null),
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
    this.onFinish(this.results());
  }

  /**
   * 틀린 문제만 다시 풀기 — 답안을 비우고 그 문항들만 순회한다.
   * 찍어서 맞춘 문항도 같이 꺼낸다(점수만 맞고 모르는 채로 넘어가지 않게).
   */
  retryWrong() {
    const wrongIdx = this.order.filter(
      (i) => this.answers[i] !== null && (!this.isCorrect(i) || this.unsure[i]));
    if (!wrongIdx.length) return false;
    wrongIdx.forEach((i) => {
      this.answers[i] = null;
      this.unsure[i] = false;
      this.eliminated[i] = new Set();
      this._recorded.delete(i);          // 다시 풀면 새 시도로 센다
    });
    this.order = wrongIdx;
    this.cur = 0;
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
    clearSession(this.examKey).catch(() => {});
  }

  destroy() {
    this._imgCache.forEach((u) => URL.revokeObjectURL(u));
    this._imgCache.clear();
    this.el.screen.classList.add('hidden');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
