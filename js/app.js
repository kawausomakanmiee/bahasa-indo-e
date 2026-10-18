(function () {
  'use strict';

  /* =========================================================
   * 定数・状態
   * ========================================================= */
  var STORAGE_KEY = 'idE_taisaku_v1';
  var DATA_URL = 'data/questions.json';
  var WEAK_MIN_ATTEMPTS = 5;   // この回答数に満たないカテゴリは「苦手」と判定しない
  var WEAK_RATE = 0.6;         // 正答率がこれ未満なら「苦手の可能性」
  var LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

  var app = document.getElementById('app');
  var DATA = { categories: [], questions: [], note: '' };
  var QMAP = new Map();
  var problems = [];           // 問題データの不備の記録
  var memoryOnly = false;      // localStorage が使えない場合 true
  var store = defaultStore();
  var quiz = null;             // 分野別・復習・やり直しの出題状態
  var exam = null;             // 模擬試験の状態
  var timerId = null;

  /* =========================================================
   * 小さなユーティリティ
   * ========================================================= */
  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(e, arguments[i]);
    return e;
  }
  function append(parent, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(parent, k); }); return; }
    parent.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  function mount() {
    stopTimer();
    var nodes = Array.prototype.slice.call(arguments);
    app.replaceChildren.apply(app, nodes);
    if (!noScroll) window.scrollTo(0, 0);
    noScroll = false;
    app.focus({ preventScroll: true });
  }
  var noScroll = false;
  function keepScroll(fn) { noScroll = true; fn(); }
  function shuffle(a) {
    var r = a.slice();
    for (var i = r.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = r[i]; r[i] = r[j]; r[j] = t;
    }
    return r;
  }
  function pct(r) { return r === null ? '—' : Math.round(r * 100) + '%'; }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function catName(id) {
    for (var i = 0; i < DATA.categories.length; i++) if (DATA.categories[i].id === id) return DATA.categories[i].name;
    return id || '未分類';
  }
  function bar(rate) {
    return h('div', { class: 'bar', role: 'presentation' },
      h('span', { style: 'width:' + Math.round((rate || 0) * 100) + '%' }));
  }

  /* =========================================================
   * 学習記録 (localStorage)
   * ========================================================= */
  function defaultStore() {
    return { v: 1, records: {}, settings: { examCount: 20, examMinutes: 20 }, exams: [], session: null };
  }
  function sanitizeRecord(r) {
    r = r && typeof r === 'object' ? r : {};
    var hist = Array.isArray(r.history) ? r.history.filter(function (x) { return x && typeof x.ok === 'boolean'; }).slice(-20) : [];
    return {
      attempts: Math.max(0, +r.attempts || 0),
      correct: Math.max(0, +r.correct || 0),
      wrong: Math.max(0, +r.wrong || 0),
      streak: Math.max(0, +r.streak || 0),
      lastAt: typeof r.lastAt === 'string' ? r.lastAt : null,
      lastCorrect: !!r.lastCorrect,
      review: !!r.review,
      fav: !!r.fav,
      history: hist
    };
  }
  function sanitizeStore(raw) {
    var s = defaultStore();
    if (!raw || typeof raw !== 'object') return s;
    if (raw.records && typeof raw.records === 'object') {
      Object.keys(raw.records).forEach(function (id) { s.records[id] = sanitizeRecord(raw.records[id]); });
    }
    if (raw.settings && typeof raw.settings === 'object') {
      var c = parseInt(raw.settings.examCount, 10), m = parseInt(raw.settings.examMinutes, 10);
      if (c > 0 && c <= 200) s.settings.examCount = c;
      if (m > 0 && m <= 300) s.settings.examMinutes = m;
    }
    if (Array.isArray(raw.exams)) s.exams = raw.exams.filter(function (x) { return x && typeof x === 'object'; }).slice(-30);
    if (raw.session && typeof raw.session === 'object' && Array.isArray(raw.session.ids)) s.session = raw.session;
    return s;
  }
  function loadStore() {
    try {
      var txt = window.localStorage.getItem(STORAGE_KEY);
      if (!txt) return defaultStore();
      return sanitizeStore(JSON.parse(txt));
    } catch (e) {
      console.warn('学習記録を読み込めませんでした。初期状態で開始します。', e);
      return defaultStore();
    }
  }
  function saveStore() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      memoryOnly = true;
    }
  }
  function recordAnswer(qid, ok) {
    var r = store.records[qid] || sanitizeRecord(null);
    var now = new Date().toISOString();
    r.attempts += 1;
    r.lastAt = now;
    r.lastCorrect = ok;
    if (ok) {
      r.correct += 1;
      r.streak += 1;
      if (r.review && r.streak >= 2) r.review = false; // 2回連続正解で「定着」(履歴は残す)
    } else {
      r.wrong += 1;
      r.streak = 0;
      r.review = true;
    }
    r.history.push({ t: now, ok: ok });
    r.history = r.history.slice(-20);
    store.records[qid] = r;
    saveStore();
  }
  function reviewStatus(r) {
    if (!r || !r.wrong) return null;
    if (r.review) return r.lastCorrect ? 'again' : 'need';
    return 'mastered';
  }
  var STATUS_LABEL = { need: '要復習', again: '再正解(あと1回で定着)', mastered: '定着(2回連続正解)' };

  /* =========================================================
   * 問題データの読み込みと検証
   * ========================================================= */
  function validateQuestions(raw) {
    var valid = [], seen = {}, probs = [];
    (Array.isArray(raw) ? raw : []).forEach(function (q, i) {
      var tag = '#' + (i + 1) + (q && q.id ? ' (' + q.id + ')' : '');
      if (!q || typeof q !== 'object') { probs.push(tag + ': 形式が不正'); return; }
      if (typeof q.id !== 'string' || !q.id) { probs.push(tag + ': id がありません'); return; }
      if (seen[q.id]) { probs.push(tag + ': id が重複しています'); return; }
      if (typeof q.question !== 'string' || !q.question) { probs.push(tag + ': question がありません'); return; }
      if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.some(function (c) { return typeof c !== 'string' || !c; })) {
        probs.push(tag + ': choices が不正'); return;
      }
      if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex >= q.choices.length) {
        probs.push(tag + ': answerIndex が範囲外'); return;
      }
      if (!Array.isArray(q.choiceExplanations) || q.choiceExplanations.length !== q.choices.length) {
        probs.push(tag + ': choiceExplanations の数が choices と一致しません(空で補完)');
        var fixed = [];
        for (var k = 0; k < q.choices.length; k++) fixed.push((q.choiceExplanations && q.choiceExplanations[k]) || '');
        q.choiceExplanations = fixed;
      }
      seen[q.id] = true;
      valid.push(q);
    });
    return { valid: valid, problems: probs };
  }
  function loadData() {
    return fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        var v = validateQuestions(json && json.questions);
        problems = v.problems;
        problems.forEach(function (p) { console.warn('問題データの不備:', p); });
        DATA.categories = Array.isArray(json.categories) ? json.categories : [];
        DATA.questions = v.valid;
        DATA.note = json.note || '';
        v.valid.forEach(function (q) { QMAP.set(q.id, q); });
        if (!DATA.questions.length) throw new Error('有効な問題がありません');
      });
  }

  /* =========================================================
   * 集計
   * ========================================================= */
  function qsOf(catId) {
    return catId === 'mixed' ? DATA.questions : DATA.questions.filter(function (q) { return q.category === catId; });
  }
  function catStats(catId) {
    var qs = qsOf(catId), s = { total: qs.length, answered: 0, attempts: 0, correct: 0, rate: null };
    qs.forEach(function (q) {
      var r = store.records[q.id];
      if (r && r.attempts) { s.answered++; s.attempts += r.attempts; s.correct += r.correct; }
    });
    s.rate = s.attempts ? s.correct / s.attempts : null;
    return s;
  }
  function realCategories() {
    return DATA.categories.filter(function (c) { return c.id !== 'mixed' && qsOf(c.id).length; });
  }
  function weakCategories() {
    return realCategories().map(function (c) { return { c: c, s: catStats(c.id) }; })
      .filter(function (x) { return x.s.attempts >= WEAK_MIN_ATTEMPTS && x.s.rate < WEAK_RATE; });
  }
  function reviewIds(includeMastered) {
    return DATA.questions.filter(function (q) {
      var st = reviewStatus(store.records[q.id]);
      return st && (includeMastered || st !== 'mastered');
    }).map(function (q) { return q.id; });
  }
  function overall() {
    var answered = 0, attempts = 0, correct = 0;
    DATA.questions.forEach(function (q) {
      var r = store.records[q.id];
      if (r && r.attempts) { answered++; attempts += r.attempts; correct += r.correct; }
    });
    return { total: DATA.questions.length, answered: answered, attempts: attempts, correct: correct, rate: attempts ? correct / attempts : null };
  }

  /* =========================================================
   * セッション(再開用)
   * ========================================================= */
  function saveSession(nextIdx) {
    if (!quiz) return;
    store.session = { mode: quiz.mode, label: quiz.label, ids: quiz.ids, idx: nextIdx, catId: quiz.catId, results: quiz.results };
    saveStore();
  }
  function clearSession() { store.session = null; saveStore(); }
  function resumeSession() {
    var s = store.session;
    if (!s) return;
    var ids = s.ids.filter(function (id) { return QMAP.has(id); });
    if (!ids.length || s.idx >= ids.length) { clearSession(); renderHome(); return; }
    quiz = { mode: s.mode, label: s.label, ids: ids, catId: s.catId || null, idx: Math.min(s.idx, ids.length - 1),
      answered: false, selected: null, results: Array.isArray(s.results) ? s.results : [] };
    renderQuiz();
  }

  /* =========================================================
   * ホーム
   * ========================================================= */
  function todayIds() {
    var un = DATA.questions.filter(function (q) { var r = store.records[q.id]; return !r || !r.attempts; });
    if (un.length) return shuffle(un).slice(0, 5).map(function (q) { return q.id; });
    var sorted = DATA.questions.slice().sort(function (a, b) {
      var ra = store.records[a.id], rb = store.records[b.id];
      return String(ra && ra.lastAt || '').localeCompare(String(rb && rb.lastAt || ''));
    });
    return sorted.slice(0, 5).map(function (q) { return q.id; });
  }

  function renderHome() {
    clearQuizState();
    var o = overall();
    var rv = reviewIds(false);
    var weak = weakCategories();
    var first = o.attempts === 0;
    var parts = [];

    parts.push(h('div', null,
      h('h1', { class: 'page-title', text: 'インドネシア語技能検定 E級対策' }),
      h('p', { class: 'lead', text: 'インドネシア語を基礎から学び、合格に向けて一歩ずつ進みましょう。' })));

    if (problems.length) {
      parts.push(h('div', { class: 'notice', role: 'status' },
        '問題データに不備があり ' + problems.length + ' 件を除外または補完しました。詳細はブラウザのコンソールで確認できます。'));
    }
    if (memoryOnly) {
      parts.push(h('div', { class: 'notice', role: 'status' }, 'このブラウザでは学習記録を保存できません。ページを閉じると記録が消えます。'));
    }

    // 今日の学習メニュー
    var menu = [];
    if (store.session) {
      var s = store.session;
      menu.push(h('button', { type: 'button', class: 'btn block', onclick: resumeSession },
        '学習を再開する(' + s.label + ' ' + Math.min(s.idx + 1, s.ids.length) + '/' + s.ids.length + ')'));
    }
    if (first) {
      menu.push(h('p', null, 'はじめての方は、まず「基本語彙」から始めましょう。1問ずつ解説を読みながら進められます。'));
      menu.push(h('button', { type: 'button', class: 'btn block', onclick: function () { startCategory('vocab'); } }, '基本語彙から始める'));
    } else {
      menu.push(h('button', { type: 'button', class: store.session ? 'btn secondary block' : 'btn block', onclick: function () {
        startSession('practice', '今日の5問', todayIds(), null);
      } }, '今日の5問に挑戦'));
    }
    if (rv.length) {
      menu.push(h('button', { type: 'button', class: 'btn secondary block', onclick: function () {
        startSession('review', '間違えた問題の復習', shuffle(reviewIds(false)), null);
      } }, '間違えた問題を復習する(' + rv.length + '問)'));
    }
    parts.push(h('section', { class: 'card stack', 'aria-labelledby': 'today-h' },
      h('h2', { id: 'today-h', class: 'red', text: '今日の学習メニュー' }), menu));

    // 入口
    parts.push(h('div', { class: 'menu-grid' },
      tile('分野別学習', '10カテゴリから選ぶ', renderCategories),
      tile('語彙学習', '単語の一覧とカード学習', function () {
        if (window.IdVocab) window.IdVocab.open();
        else window.alert('語彙学習を読み込めませんでした。ページを再読み込みしてください。');
      }),
      tile('復習', rv.length + '問が復習対象', renderReview),
      tile('模擬試験', '時間を計って挑戦', renderExamIntro),
      tile('学習記録', '進捗・苦手分野', renderStats, 'wide')));

    // 進捗
    parts.push(h('section', { class: 'card', 'aria-labelledby': 'prog-h' },
      h('h2', { id: 'prog-h', text: '学習進捗' }),
      bar(o.total ? o.answered / o.total : 0),
      h('div', { class: 'stats-row' },
        stat(o.answered + ' / ' + o.total, '解いた問題数'),
        stat(pct(o.rate), '正答率'),
        stat(String(o.attempts), '総回答数'))));

    // 苦手
    var weakBox = h('section', { class: 'card', 'aria-labelledby': 'weak-h' }, h('h2', { id: 'weak-h', text: '苦手分野' }));
    if (weak.length) {
      weak.forEach(function (x) {
        weakBox.appendChild(h('p', null, '・' + x.c.name + '(正答率 ' + pct(x.s.rate) + '、回答 ' + x.s.attempts + '回)'));
      });
      weakBox.appendChild(h('p', { class: 'small', text: '回答数が少ない分野は判定しません。目安に使ってください。' }));
    } else {
      weakBox.appendChild(h('p', { class: 'lead', text: o.attempts < WEAK_MIN_ATTEMPTS
        ? 'もう少し問題を解くと、苦手分野がわかるようになります。'
        : '今のところ、苦手と判定された分野はありません。' }));
    }
    parts.push(weakBox);

    parts.push(h('p', { class: 'small', text: DATA.note || '' }));
    mount.apply(null, [h('div', { class: 'stack' }, parts)]);
  }
  function tile(title, desc, fn, extraClass) {
    return h('button', { type: 'button', class: 'menu-tile' + (extraClass ? ' ' + extraClass : ''), onclick: fn },
      h('span', { class: 't', text: title }), h('span', { class: 'd', text: desc }));
  }
  function stat(n, l) {
    return h('div', { class: 'stat' }, h('div', { class: 'n', text: n }), h('div', { class: 'l', text: l }));
  }
  function clearQuizState() { quiz = null; exam = null; }

  /* =========================================================
   * 分野別学習
   * ========================================================= */
  function startCategory(catId) {
    var qs = qsOf(catId);
    var ids = qs.map(function (q) { return q.id; });
    if (catId === 'mixed') ids = shuffle(ids);
    startSession('practice', catName(catId), ids, catId);
  }
  function renderCategories() {
    clearQuizState();
    var list = h('div', { class: 'list' });
    DATA.categories.forEach(function (c) {
      var s = catStats(c.id);
      if (!s.total) return;
      list.appendChild(h('div', { class: 'card' },
        h('div', { class: 'item-head' },
          h('span', { class: 'item-title', text: c.name }),
          h('span', { class: 'small', text: s.answered + ' / ' + s.total + '問 解答済み・正答率 ' + pct(s.rate) })),
        h('p', { class: 'lead', text: c.desc || '' }),
        bar(s.total ? s.answered / s.total : 0),
        h('div', { class: 'actions', style: 'margin-top:12px' },
          h('button', { type: 'button', class: 'btn', onclick: function () { startCategory(c.id); } }, 'この分野を解く(' + s.total + '問)'))));
    });
    mount(h('div', { class: 'stack' },
      h('h1', { class: 'page-title', text: '分野別学習' }),
      h('p', { class: 'lead', text: '学びたい分野を選んでください。各問題の解説を読んでから次へ進みます。' }),
      list,
      backHome()));
  }
  function backHome() {
    return h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: renderHome }, 'ホームへ'));
  }

  /* =========================================================
   * 問題演習(分野別・復習)
   * ========================================================= */
  function startSession(mode, label, ids, catId) {
    ids = ids.filter(function (id) { return QMAP.has(id); });
    if (!ids.length) { window.alert('出題できる問題がありません。'); return; }
    exam = null;
    quiz = { mode: mode, label: label, ids: ids, catId: catId || null, idx: 0, answered: false, selected: null, results: [] };
    saveSession(0);
    renderQuiz();
  }
  function curQ() { return QMAP.get(quiz.ids[quiz.idx]); }

  function toggleFav(qid) {
    var r = store.records[qid] || sanitizeRecord(null);
    r.fav = !r.fav;
    store.records[qid] = r;
    saveStore();
  }
  function favButton(qid, rerender) {
    var on = !!(store.records[qid] && store.records[qid].fav);
    return h('button', { type: 'button', class: 'fav-btn', 'aria-pressed': on ? 'true' : 'false',
      onclick: function () { toggleFav(qid); rerender(); } }, on ? '★ お気に入り中' : '☆ お気に入り');
  }

  function questionBlock(q) {
    var out = [];
    if (q.passage) {
      out.push(h('div', { class: 'passage' }, h('span', { class: 'passage-label', text: '文章' }), q.passage));
    }
    out.push(h('p', { class: 'question', text: q.question }));
    return out;
  }

  function renderQuiz(focusFeedback) {
    var q = curQ();
    if (!q) { finishQuiz(); return; }
    var total = quiz.ids.length;
    var answered = quiz.answered;
    var items = [];

    items.push(h('div', { class: 'quiz-top' },
      h('span', { class: 'cat', text: quiz.label + '(' + catName(q.category) + ')' }),
      h('span', { class: 'num', text: '問題 ' + (quiz.idx + 1) + ' / ' + total })));
    items.push(h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(quiz.idx + (answered ? 1 : 0)) },
      h('span', { style: 'width:' + Math.round(((quiz.idx + (answered ? 1 : 0)) / total) * 100) + '%' })));

    var qcard = h('section', { class: 'card stack', 'aria-label': '問題' }, questionBlock(q));
    items.push(qcard);

    var list = h('ul', { class: 'choices', 'aria-label': '選択肢' });
    q.choices.forEach(function (c, i) {
      var isAns = i === q.answerIndex, isSel = i === quiz.selected;
      if (!answered) {
        list.appendChild(h('li', null, h('button', { type: 'button', class: 'choice', onclick: function () { onAnswer(i); } },
          h('span', { class: 'mark', 'aria-hidden': 'true', text: LABELS[i] || String(i + 1) }),
          h('span', { class: 'body' }, h('span', { class: 'ctext', text: c })))));
      } else {
        var cls = 'choice static' + (isAns ? ' correct' : (isSel ? ' wrong' : ''));
        var tag = isAns ? '✓ 正解' + (isSel ? '(あなたの回答)' : '') : (isSel ? '✕ あなたの回答(不正解)' : '');
        list.appendChild(h('li', null, h('div', { class: cls },
          h('span', { class: 'mark', 'aria-hidden': 'true', text: isAns ? '✓' : (isSel ? '✕' : (LABELS[i] || String(i + 1))) }),
          h('span', { class: 'body' },
            tag ? h('span', { class: 'tag', text: tag }) : null,
            h('span', { class: 'ctext', text: LABELS[i] + '. ' + c }),
            q.choiceExplanations[i] ? h('span', { class: 'cexp', text: q.choiceExplanations[i] }) : null))));
      }
    });
    items.push(list);

    var nextBtn = null;
    if (answered) {
      var ok = quiz.selected === q.answerIndex;
      var fb = h('section', { class: 'feedback ' + (ok ? 'ok' : 'ng'), id: 'feedback', tabindex: '-1', role: 'status' },
        h('p', { class: 'verdict', text: ok ? '✓ 正解です' : '✕ 不正解です(正解は ' + LABELS[q.answerIndex] + ' です)' }),
        h('p', { text: q.explanation || '' }));
      if (q.passageTranslation) {
        fb.appendChild(h('details', null, h('summary', { text: '文章の日本語訳を見る' }), h('p', { text: q.passageTranslation })));
      }
      var vocab = [].concat(q.relatedVocabulary || [], q.relatedGrammar || []).filter(Boolean);
      if (vocab.length) fb.appendChild(h('p', { class: 'vocab', text: '関連:' + vocab.join('、') }));
      items.push(fb);
      var last = quiz.idx + 1 >= total;
      nextBtn = h('button', { type: 'button', class: 'btn', id: 'next-btn', onclick: onNext }, last ? '結果を見る' : '次の問題へ');
    }

    items.push(h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: function () {
        if (!answered || quiz.idx + 1 < total) saveSession(answered ? quiz.idx + 1 : quiz.idx);
        renderHome();
      } }, '中断してホームへ'),
      favButton(q.id, function () { keepScroll(function () { renderQuiz(false); }); }),
      nextBtn));

    mount(h('div', { class: 'stack' }, items));
    if (answered) {
      var target = document.getElementById('next-btn');
      var fbEl = document.getElementById('feedback');
      if (fbEl && focusFeedback) { fbEl.scrollIntoView({ block: 'start' }); }
      if (target) target.focus({ preventScroll: true });
    }
  }

  function onAnswer(i) {
    if (!quiz || quiz.answered) return;      // 二重回答の防止
    quiz.answered = true;
    quiz.selected = i;
    var q = curQ();
    var ok = i === q.answerIndex;
    recordAnswer(q.id, ok);
    quiz.results.push({ id: q.id, ok: ok });
    saveSession(quiz.idx + 1);
    renderQuiz(true);
  }
  function onNext() {
    if (!quiz || !quiz.answered) return;
    if (quiz.idx + 1 >= quiz.ids.length) { finishQuiz(); return; }
    quiz.idx += 1;
    quiz.answered = false;
    quiz.selected = null;
    renderQuiz();
  }
  function finishQuiz() {
    clearSession();
    var res = quiz.results, ok = res.filter(function (r) { return r.ok; }).length;
    var wrongIds = res.filter(function (r) { return !r.ok; }).map(function (r) { return r.id; });
    var label = quiz.label;
    var wrongBox = null;
    if (wrongIds.length) {
      wrongBox = h('section', { class: 'card' }, h('h2', { text: '間違えた問題' }),
        wrongIds.map(function (id) { var q = QMAP.get(id); return h('p', { text: '・' + q.question.split('\n')[0] + '(正解:' + q.choices[q.answerIndex] + ')' }); }));
    }
    var items = [
      h('h1', { class: 'page-title', text: label + ' の結果' }),
      h('section', { class: 'card score' },
        h('div', { class: 'big', text: ok + ' / ' + res.length }),
        h('p', { text: '正答率 ' + pct(res.length ? ok / res.length : null) })),
      wrongBox,
      h('div', { class: 'actions' },
        wrongIds.length ? h('button', { type: 'button', class: 'btn', onclick: function () { startSession('review', '間違えた問題のやり直し', wrongIds, null); } }, '間違えた問題を解き直す') : null,
        h('button', { type: 'button', class: 'btn secondary', onclick: renderCategories }, '分野別学習へ'),
        h('button', { type: 'button', class: 'btn ghost', onclick: renderHome }, 'ホームへ'))
    ];
    quiz = null;
    mount(h('div', { class: 'stack' }, items));
  }

  /* =========================================================
   * 復習
   * ========================================================= */
  var reviewFilter = 'todo';
  function renderReview() {
    clearQuizState();
    var all = reviewIds(true);
    var favs = DATA.questions.filter(function (q) { return store.records[q.id] && store.records[q.id].fav; }).map(function (q) { return q.id; });
    var todo = reviewIds(false);
    var shown = reviewFilter === 'todo' ? todo : (reviewFilter === 'all' ? all : favs);

    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': '表示の切り替え' },
      segBtn('todo', '要復習 ' + todo.length), segBtn('all', '間違えた履歴 ' + all.length), segBtn('fav', 'お気に入り ' + favs.length));

    var list = h('div', { class: 'list' });
    if (!shown.length) {
      list.appendChild(h('div', { class: 'card' }, h('p', { class: 'lead', text: reviewFilter === 'fav'
        ? 'お気に入りの問題はまだありません。問題画面の「☆ お気に入り」から登録できます。'
        : '該当する問題はありません。' })));
    }
    shown.forEach(function (id) {
      var q = QMAP.get(id), r = store.records[id] || sanitizeRecord(null), st = reviewStatus(r);
      var dots = r.history.slice(-8).map(function (x) { return x.ok ? '○' : '×'; }).join(' ');
      list.appendChild(h('div', { class: 'card stack' },
        h('div', { class: 'item-head' },
          h('span', { class: 'small', text: catName(q.category) }),
          st ? h('span', { class: 'badge ' + st, text: STATUS_LABEL[st] }) : null),
        h('p', { class: 'question', text: q.question }),
        h('p', { class: 'small' }, '回答 ' + r.attempts + '回(正解 ' + r.correct + '回・不正解 ' + r.wrong + '回) 直近: ',
          h('span', { class: 'dots', text: dots || '—' })),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn secondary small-btn', onclick: function () { startSession('review', 'この問題を解き直す', [id], null); } }, '解き直す'),
          favButton(id, function () { keepScroll(renderReview); }))));
    });

    mount(h('div', { class: 'stack' },
      h('h1', { class: 'page-title', text: '復習' }),
      h('p', { class: 'lead', text: '間違えた問題は、2回連続で正解するまで「要復習」に残ります。定着した問題も履歴として確認できます。' }),
      seg,
      shown.length > 1 ? h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: function () { startSession('review', '復習', shuffle(shown), null); } }, 'この一覧を解く(' + shown.length + '問)')) : null,
      list,
      backHome()));
  }
  function segBtn(key, text) {
    return h('button', { type: 'button', 'aria-pressed': reviewFilter === key ? 'true' : 'false',
      onclick: function () { reviewFilter = key; renderReview(); } }, text);
  }

  /* =========================================================
   * 模擬試験(タイマーはここだけ)
   * ========================================================= */
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  function renderExamIntro() {
    clearQuizState();
    var maxQ = DATA.questions.length;
    var cnt = Math.min(store.settings.examCount, maxQ), min = store.settings.examMinutes;
    var cntIn = h('input', { type: 'number', id: 'ex-count', min: '1', max: String(maxQ), value: String(cnt), inputmode: 'numeric' });
    var minIn = h('input', { type: 'number', id: 'ex-min', min: '1', max: '180', value: String(min), inputmode: 'numeric' });
    mount(h('div', { class: 'stack' },
      h('h1', { class: 'page-title', text: '模擬試験' }),
      h('div', { class: 'notice' }, 'これは本アプリ独自の練習用模試です。公式の試験時間・問題数・出題形式ではありません。公式の最新情報は試験の実施団体でご確認ください。'),
      h('section', { class: 'card stack' },
        h('div', { class: 'fields' },
          h('div', { class: 'field' }, h('label', { for: 'ex-count', text: '問題数(1〜' + maxQ + ')' }), cntIn),
          h('div', { class: 'field' }, h('label', { for: 'ex-min', text: '制限時間(分)' }), minIn)),
        h('p', { class: 'small', text: '「開始」を押してからタイマーが動き始めます。問題は全分野からランダムに出題されます。時間切れになると回答は自動的に確定されます。' }),
        h('button', { type: 'button', class: 'btn block', onclick: function () {
          var c = parseInt(cntIn.value, 10), m = parseInt(minIn.value, 10);
          if (!(c >= 1 && c <= maxQ) || !(m >= 1 && m <= 180)) { window.alert('問題数は 1〜' + maxQ + '、時間は 1〜180 分で入力してください。'); return; }
          store.settings.examCount = c; store.settings.examMinutes = m; saveStore();
          startExam(c, m);
        } }, '開始する')),
      backHome()));
  }

  function startExam(count, minutes) {
    var ids = shuffle(DATA.questions.map(function (q) { return q.id; })).slice(0, count);
    var now = Date.now();
    exam = { ids: ids, answers: ids.map(function () { return null; }), idx: 0, startAt: now, endAt: now + minutes * 60000, minutes: minutes, done: false };
    quiz = null;
    renderExam();
  }

  function renderExam() {
    if (!exam || exam.done) return;
    var q = QMAP.get(exam.ids[exam.idx]);
    var n = exam.ids.length;
    noScroll = exam.rendered === exam.idx;   // 同じ問題の再描画ではスクロール位置を保つ
    exam.rendered = exam.idx;
    var answeredCount = exam.answers.filter(function (a) { return a !== null; }).length;

    var timerEl = h('span', { class: 'timer', id: 'timer', role: 'timer', 'aria-live': 'off', text: fmtTime((exam.endAt - Date.now()) / 1000) });
    var top = h('div', { class: 'quiz-top' },
      h('span', { class: 'num', text: '問題 ' + (exam.idx + 1) + ' / ' + n }),
      h('span', null, '残り時間 ', timerEl));

    var list = h('ul', { class: 'choices', 'aria-label': '選択肢' });
    q.choices.forEach(function (c, i) {
      var sel = exam.answers[exam.idx] === i;
      list.appendChild(h('li', null, h('button', { type: 'button', class: 'choice' + (sel ? ' selected' : ''), 'aria-pressed': sel ? 'true' : 'false',
        onclick: function () { if (exam.done) return; exam.answers[exam.idx] = i; renderExam(); } },
        h('span', { class: 'mark', 'aria-hidden': 'true', text: sel ? '●' : (LABELS[i] || String(i + 1)) }),
        h('span', { class: 'body' }, h('span', { class: 'ctext', text: LABELS[i] + '. ' + c })))));
    });

    var grid = h('div', { class: 'qgrid', role: 'group', 'aria-label': '問題一覧' });
    exam.ids.forEach(function (id, i) {
      var cls = (exam.answers[i] !== null ? 'done' : '') + (i === exam.idx ? ' current' : '');
      grid.appendChild(h('button', { type: 'button', class: cls.trim(), 'aria-label': '問題' + (i + 1) + (exam.answers[i] !== null ? '(回答済み)' : '(未回答)') + (i === exam.idx ? '(表示中)' : ''),
        onclick: function () { exam.idx = i; renderExam(); } }, String(i + 1)));
    });

    mount(h('div', { class: 'stack' },
      top,
      h('p', { class: 'small', text: '回答済み ' + answeredCount + ' / ' + n + '問(青=回答済み、白=未回答)。選択肢は何度でも変更できます。' }),
      h('section', { class: 'card stack' }, questionBlock(q)),
      list,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn secondary', disabled: exam.idx === 0, onclick: function () { exam.idx--; renderExam(); } }, '← 前の問題'),
        h('button', { type: 'button', class: 'btn secondary', disabled: exam.idx + 1 >= n, onclick: function () { exam.idx++; renderExam(); } }, '次の問題 →')),
      h('section', { class: 'card stack' }, h('h2', { text: '問題一覧' }), grid),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: function () {
          var un = exam.answers.filter(function (a) { return a === null; }).length;
          var msg = (un ? '未回答が ' + un + ' 問あります。' : '') + '試験を終了して採点しますか?';
          if (window.confirm(msg)) finishExam(false);
        } }, '試験を終了する'),
        h('button', { type: 'button', class: 'btn ghost', onclick: function () {
          if (window.confirm('試験を中止しますか?この試験の回答は記録されません。')) { stopTimer(); renderHome(); }
        } }, '中止してホームへ'))));

    // mount() はタイマーを止めるため、描画後に再開する
    startTimer();
  }

  function startTimer() {
    stopTimer();
    tick();
    timerId = setInterval(tick, 250);
  }
  function tick() {
    if (!exam || exam.done) { stopTimer(); return; }
    var left = (exam.endAt - Date.now()) / 1000;
    var el = document.getElementById('timer');
    if (el) {
      el.textContent = fmtTime(Math.ceil(left));
      el.className = 'timer' + (left <= 60 ? ' low' : '');
    }
    if (left <= 0) {
      stopTimer();
      window.alert('時間終了です。回答を確定して採点します。');
      finishExam(true);
    }
  }

  function finishExam(auto) {
    if (!exam || exam.done) return;
    exam.done = true;
    stopTimer();
    var spent = Math.min((Date.now() - exam.startAt) / 1000, exam.minutes * 60);
    var byCat = {}, correct = 0, answered = 0, rows = [];
    exam.ids.forEach(function (id, i) {
      var q = QMAP.get(id), a = exam.answers[i], ok = a !== null && a === q.answerIndex;
      byCat[q.category] = byCat[q.category] || { total: 0, correct: 0 };
      byCat[q.category].total++;
      if (a !== null) { answered++; recordAnswer(id, ok); }
      if (ok) { correct++; byCat[q.category].correct++; }
      rows.push({ id: id, a: a, ok: ok });
    });
    var total = exam.ids.length;
    store.exams.push({ at: new Date().toISOString(), total: total, correct: correct, answered: answered, seconds: Math.round(spent), minutes: exam.minutes, auto: !!auto });
    store.exams = store.exams.slice(-30);
    saveStore();
    renderExamResult({ total: total, correct: correct, answered: answered, spent: spent, byCat: byCat, rows: rows, auto: auto });
    exam = null;
  }

  function renderExamResult(r) {
    var wrongRows = r.rows.filter(function (x) { return !x.ok; });
    var catRows = Object.keys(r.byCat).map(function (cid) {
      var c = r.byCat[cid];
      return h('tr', null, h('td', { text: catName(cid) }), h('td', { text: c.correct + ' / ' + c.total }), h('td', { text: pct(c.total ? c.correct / c.total : null) }));
    });
    var detail = wrongRows.map(function (x) {
      var q = QMAP.get(x.id);
      return h('div', { class: 'card stack' },
        h('span', { class: 'badge ' + (x.a === null ? '' : 'need'), text: x.a === null ? '未回答' : '✕ 不正解' }),
        h('p', { class: 'question', text: q.question }),
        h('p', { text: '正解:' + LABELS[q.answerIndex] + '. ' + q.choices[q.answerIndex] + (x.a !== null ? '(あなたの回答:' + LABELS[x.a] + '. ' + q.choices[x.a] + ')' : '') }),
        h('p', { class: 'small', text: q.explanation || '' }));
    });
    mount(h('div', { class: 'stack' },
      h('h1', { class: 'page-title', text: '模擬試験の結果' }),
      r.auto ? h('div', { class: 'notice', role: 'status' }, '制限時間が終了したため、回答を自動で確定しました。') : null,
      h('section', { class: 'card score' },
        h('div', { class: 'big', text: r.correct + ' / ' + r.total }),
        h('p', { text: '正答率 ' + pct(r.total ? r.correct / r.total : null) }),
        h('p', { class: 'small', text: '所要時間 ' + fmtTime(r.spent) + ' ・ 回答 ' + r.answered + '問 ・ 未回答 ' + (r.total - r.answered) + '問' })),
      h('section', { class: 'card' }, h('h2', { text: 'カテゴリ別成績' }),
        h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: 'カテゴリ' }), h('th', { text: '正解' }), h('th', { text: '正答率' }))), h('tbody', null, catRows)),
        h('p', { class: 'small', text: '1カテゴリあたりの問題数が少ないため、傾向の目安としてご覧ください。' })),
      h('div', { class: 'actions' },
        wrongRows.length ? h('button', { type: 'button', class: 'btn', onclick: function () {
          startSession('review', '模試の間違い復習', wrongRows.map(function (x) { return x.id; }), null);
        } }, '間違い・未回答を解き直す(' + wrongRows.length + '問)') : null,
        h('button', { type: 'button', class: 'btn secondary', onclick: renderExamIntro }, 'もう一度模試を受ける'),
        h('button', { type: 'button', class: 'btn ghost', onclick: renderHome }, 'ホームへ')),
      wrongRows.length ? h('h2', { text: '間違い・未回答の問題' }) : null,
      detail));
  }

  /* =========================================================
   * 学習記録(結果分析・バックアップ)
   * ========================================================= */
  function renderStats() {
    clearQuizState();
    var o = overall();
    var rows = realCategories().map(function (c) {
      var s = catStats(c.id), verdict;
      if (s.attempts < WEAK_MIN_ATTEMPTS) verdict = '回答数が少ないため判定できません';
      else verdict = s.rate < WEAK_RATE ? '苦手の可能性あり' : '良好';
      return h('tr', null, h('td', { text: c.name }), h('td', { text: String(s.attempts) }), h('td', { text: pct(s.rate) }), h('td', { text: verdict }));
    });
    var missed = DATA.questions.filter(function (q) { var r = store.records[q.id]; return r && r.wrong > 0; })
      .sort(function (a, b) { return store.records[b.id].wrong - store.records[a.id].wrong; }).slice(0, 5);
    var missBox = h('section', { class: 'card' }, h('h2', { text: '間違いの多い問題 上位5件' }));
    if (!missed.length) missBox.appendChild(h('p', { class: 'lead', text: 'まだ間違えた問題はありません。' }));
    missed.forEach(function (q) {
      var r = store.records[q.id];
      missBox.appendChild(h('p', null, '・' + q.question.split('\n')[0] + '(不正解 ' + r.wrong + '回 / 回答 ' + r.attempts + '回)'));
    });

    var exams = store.exams.slice(-5).reverse().map(function (e) {
      var d = new Date(e.at);
      return h('tr', null, h('td', { text: isNaN(d) ? '—' : d.toLocaleDateString('ja-JP') }), h('td', { text: e.correct + ' / ' + e.total }), h('td', { text: pct(e.total ? e.correct / e.total : null) }), h('td', { text: fmtTime(e.seconds) }));
    });

    var fileIn = h('input', { type: 'file', accept: 'application/json,.json', id: 'import-file', style: 'display:none', onchange: onImport });

    mount(h('div', { class: 'stack' },
      h('h1', { class: 'page-title', text: '学習記録' }),
      h('section', { class: 'card' }, h('h2', { text: '全体' }), bar(o.total ? o.answered / o.total : 0),
        h('div', { class: 'stats-row' }, stat(o.answered + ' / ' + o.total, '解いた問題数'), stat(pct(o.rate), '正答率'), stat(String(reviewIds(false).length), '要復習'))),
      h('section', { class: 'card' }, h('h2', { text: 'カテゴリ別' }),
        h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: 'カテゴリ' }), h('th', { text: '回答数' }), h('th', { text: '正答率' }), h('th', { text: '判定' }))), h('tbody', null, rows)),
        h('p', { class: 'small', text: '回答数が ' + WEAK_MIN_ATTEMPTS + ' 回未満のカテゴリは、少数の結果で苦手と断定しないよう判定を行いません。' })),
      missBox,
      exams.length ? h('section', { class: 'card' }, h('h2', { text: '最近の模擬試験' }),
        h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: '日付' }), h('th', { text: '正解' }), h('th', { text: '正答率' }), h('th', { text: '所要' }))), h('tbody', null, exams))) : null,
      h('section', { class: 'card stack' }, h('h2', { text: 'バックアップ' }),
        h('p', { class: 'small', text: '学習記録はこのブラウザ内にだけ保存されます。端末の変更やブラウザデータの消去に備えて、書き出しておくと安心です。' }),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn secondary', onclick: onExport }, '記録を書き出す(JSON)'),
          h('button', { type: 'button', class: 'btn secondary', onclick: function () { fileIn.click(); } }, '記録を読み込む'),
          h('button', { type: 'button', class: 'btn ghost', onclick: onReset }, '記録を消去する')),
        fileIn),
      backHome()));
  }
  function onExport() {
    var payload = { app: 'indonesian-e-taisaku', v: 1, exportedAt: new Date().toISOString(), records: store.records, settings: store.settings, exams: store.exams,
      vocab: window.IdVocab ? window.IdVocab.exportData() : undefined };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'indonesian-e-records-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function onImport(ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var raw = JSON.parse(String(reader.result));
        if (!raw || typeof raw.records !== 'object' || raw.records === null) throw new Error('records がありません');
        var next = sanitizeStore(raw);
        var n = Object.keys(next.records).length;
        if (!window.confirm('読み込むと、現在の学習記録が置き換わります(' + n + '問分の記録)。続けますか?')) return;
        store = next; saveStore();
        if (raw.vocab && window.IdVocab) window.IdVocab.importData(raw.vocab);
        window.alert('学習記録を読み込みました。');
        renderStats();
      } catch (e) {
        window.alert('読み込めませんでした。このアプリで書き出した JSON ファイルを選んでください。');
      }
    };
    reader.onerror = function () { window.alert('ファイルを読み込めませんでした。'); };
    reader.readAsText(f);
  }
  function onReset() {
    if (!window.confirm('すべての学習記録を消去します。元に戻せません。よろしいですか?')) return;
    store = defaultStore(); saveStore();
    if (window.IdVocab) window.IdVocab.reset();
    renderStats();
  }

  /* =========================================================
   * 起動
   * ========================================================= */
  function init() {
    document.getElementById('brand-home').addEventListener('click', function () {
      if (exam && !exam.done && !window.confirm('試験を中止してホームへ戻りますか?この試験の回答は記録されません。')) return;
      renderHome();
    });
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (quiz && !exam) {
        var q = curQ();
        if (!q) return;
        if (!quiz.answered && /^[1-9]$/.test(e.key)) {
          var i = parseInt(e.key, 10) - 1;
          if (i < q.choices.length) onAnswer(i);
        } else if (quiz.answered && e.key === 'Enter' && tag !== 'BUTTON') {
          onNext();
        }
      }
    });

    store = loadStore();
    loadData().then(renderHome).catch(function (err) {
      console.error('問題データの読み込みに失敗しました。', err);
      mount(h('div', { class: 'error-box', role: 'alert' },
        h('h2', { text: '問題データを読み込めませんでした' }),
        h('p', { text: 'data/questions.json を取得できませんでした(' + err.message + ')。' }),
        h('p', null, 'index.html をファイルとして直接開いている場合は、ブラウザの制限で読み込めません。GitHub Pages に公開するか、ローカルサーバー(例: ', h('code', { text: 'python3 -m http.server' }), ')で開いてください。'),
        h('button', { type: 'button', class: 'btn', onclick: function () { window.location.reload(); } }, '再読み込み')));
    });
  }

  // 語彙学習(js/vocab.js)など、別ファイルの機能から使うための最小限の公開 API
  window.IdApp = { h: h, mount: mount, shuffle: shuffle, keepScroll: keepScroll, renderHome: renderHome };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
