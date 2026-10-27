/*
 * 語彙学習機能
 *  - 単語データは data/vocabulary.json から読み込みます(このファイルを編集する必要はありません)。
 *  - 画面の描画には app.js が公開している window.IdApp を使います。
 *  - 学習記録(覚えた単語)は、問題演習の記録とは別のキー idE_vocab_v1 に保存します。
 */
(function () {
  'use strict';

  var A = window.IdApp;
  if (!A) { console.error('vocab.js: app.js が先に読み込まれていません。index.html の script の順番を確認してください。'); return; }
  var h = A.h, mount = A.mount;

  var DATA_URL = 'data/vocabulary.json';
  var STORE_KEY = 'idE_vocab_v1';
  var STARS = { 3: '★★★', 2: '★★☆', 1: '★☆☆' };
  var IMP_LABEL = { 3: '必須', 2: '重要', 1: '余裕があれば' };

  var state = { status: 'loading', words: [], byKey: {}, cats: [], poss: [], note: '', problems: [], error: null };
  var vs = loadStore();                       // 学習記録 { v, words: { key: {known, seen, last} } }
  var flt = { q: '', cat: '', pos: '', imp: '', unknownOnly: false };
  var test = null;
  var testDir = 'id2ja';
  var testMemoryOnly = false;
  var study = null;                           // カード学習の状態
  var loadPromise = null;
  var ui = {};                                // 一覧画面で更新する要素への参照

  /* =========================================================
   * 学習記録(localStorage)
   * ========================================================= */
  function defaultStore() { return { v: 1, words: {}, tests: { id2ja: {}, ja2id: {} } }; }
  function sanitizeStore(raw) {
    var s = defaultStore();
    if (!raw || typeof raw !== 'object' || !raw.words || typeof raw.words !== 'object') return s;
    Object.keys(raw.words).forEach(function (k) {
      var r = raw.words[k];
      if (!r || typeof r !== 'object') return;
      s.words[k] = { known: r.known === true, seen: Math.max(0, parseInt(r.seen, 10) || 0), last: typeof r.last === 'string' ? r.last : null };
    });
    ['id2ja', 'ja2id'].forEach(function (dir) {
      var records = raw.tests && raw.tests[dir];
      if (!records || typeof records !== 'object') return;
      Object.keys(records).forEach(function (key) {
        var r = records[key];
        if (!r || typeof r !== 'object') return;
        var attempts = Math.max(0, Math.floor(Number(r.attempts) || 0));
        var correct = Math.min(attempts, Math.max(0, Math.floor(Number(r.correct) || 0)));
        if (!Number.isFinite(attempts) || !Number.isFinite(correct)) return;
        s.tests[dir][key] = { attempts: attempts, correct: correct, review: r.review === true,
          last: typeof r.last === 'string' ? r.last : null };
      });
    });
    return s;
  }
  function loadStore() {
    try {
      var t = window.localStorage.getItem(STORE_KEY);
      return t ? sanitizeStore(JSON.parse(t)) : defaultStore();
    } catch (e) {
      console.warn('語彙の学習記録を読み込めませんでした。初期状態で開始します。', e);
      return defaultStore();
    }
  }
  function saveStore() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(vs)); } catch (e) { testMemoryOnly = true; }
  }
  function isKnown(key) { return !!(vs.words[key] && vs.words[key].known); }
  function setKnown(key, known) {
    var r = vs.words[key] || { known: false, seen: 0, last: null };
    r.known = known;
    r.last = new Date().toISOString();
    vs.words[key] = r;
    saveStore();
  }
  function countSeen(key) {
    var r = vs.words[key] || { known: false, seen: 0, last: null };
    r.seen += 1;
    vs.words[key] = r;
  }
  function knownCount() { return state.words.filter(function (w) { return isKnown(w.key); }).length; }

  /* =========================================================
   * 語彙データの読み込みと検証
   * ========================================================= */
  function str(v) { return typeof v === 'string' ? v.trim() : ''; }
  function loadError(msg) { var e = new Error(msg); e.userMessage = msg; return e; }
  function whereIs(text, e) {
    var m = /line (\d+)/.exec(e.message), line = null;
    if (m) line = +m[1];
    else {
      m = /position (\d+)/.exec(e.message);
      if (m) line = text.slice(0, +m[1]).split('\n').length;
    }
    return line ? '約 ' + line + ' 行目の付近です。' : '';
  }

  function build(json) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.words)) {
      throw loadError('語彙データに "words"(単語の一覧)が見つかりません。data/vocabulary.json の形式を確認してください。');
    }
    var probs = [];
    function idNameList(arr) {
      return (Array.isArray(arr) ? arr : []).filter(function (c) { return c && str(c.id) && str(c.name); })
        .map(function (c) { return { id: str(c.id), name: str(c.name) }; });
    }
    var cats = idNameList(json.categories), poss = idNameList(json.partsOfSpeech);
    var catName = {}, posName = {};
    cats.forEach(function (c) { catName[c.id] = c.name; });
    poss.forEach(function (c) { posName[c.id] = c.name; });

    var words = [], byKey = {}, extraCats = {}, extraPoss = {};
    json.words.forEach(function (w, i) {
      var tag = (i + 1) + '番目の単語' + (w && typeof w.indonesian === 'string' && w.indonesian ? '「' + w.indonesian + '」' : '');
      if (!w || typeof w !== 'object' || Array.isArray(w)) { probs.push(tag + ': 形式が正しくないため除外しました。'); return; }
      var id = str(w.indonesian), ja = str(w.japanese);
      if (!id) { probs.push(tag + ': "indonesian"(インドネシア語)が空のため除外しました。'); return; }
      if (!ja) { probs.push(tag + ': "japanese"(日本語訳)が空のため除外しました。'); return; }
      var key = str(w.id) || id.toLowerCase();
      if (byKey[key]) { probs.push(tag + ': 同じ単語がすでに登録されているため除外しました。つづりが同じで意味が違う語は "id" を付けて区別してください。'); return; }

      var cat = str(w.category), pos = str(w.pos), imp = w.importance;
      if (!cat) probs.push(tag + ': "category" がないため「未分類」として表示します。');
      else if (!catName[cat] && !extraCats[cat]) { extraCats[cat] = true; probs.push(tag + ': カテゴリ "' + cat + '" は categories に未登録です(そのまま表示します)。'); }
      if (!pos) probs.push(tag + ': "pos"(品詞)がないため「未設定」として表示します。');
      else if (!posName[pos] && !extraPoss[pos]) { extraPoss[pos] = true; probs.push(tag + ': 品詞 "' + pos + '" は partsOfSpeech に未登録です(そのまま表示します)。'); }
      if (imp !== 1 && imp !== 2 && imp !== 3) { probs.push(tag + ': "importance"(重要度)は 1・2・3 のどれかにしてください。2 として扱います。'); imp = 2; }

      var word = { key: key, id: id, ja: ja, cat: cat, pos: pos, imp: imp,
        example: str(w.example), exampleJa: str(w.exampleJa), note: str(w.note) };
      words.push(word);
      byKey[key] = word;
    });
    Object.keys(extraCats).forEach(function (c) { cats.push({ id: c, name: c }); });
    Object.keys(extraPoss).forEach(function (c) { poss.push({ id: c, name: c }); });
    if (words.some(function (w) { return !w.cat; })) cats.push({ id: '', name: '未分類' });
    if (!words.length) throw loadError('語彙データに有効な単語がありません。data/vocabulary.json の "words" を確認してください。');

    state.words = words; state.byKey = byKey; state.cats = cats; state.poss = poss;
    state.note = str(json.note); state.problems = probs;
    probs.forEach(function (p) { console.warn('語彙データの注意:', p); });
  }

  function load() {
    state.status = 'loading'; state.error = null;
    loadPromise = fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw loadError('語彙データ(data/vocabulary.json)を取得できませんでした(HTTP ' + res.status + ')。ファイルが data フォルダにあるか、ファイル名が合っているかを確認してください。');
        return res.text();
      })
      .then(function (text) {
        var json;
        try { json = JSON.parse(text); }
        catch (e) {
          throw loadError('語彙データの書き方に誤りがあり、読み込めませんでした。' + whereIs(text, e) +
            'よくある原因は、行末のカンマ(,)の付け忘れ・付けすぎ、引用符(")の閉じ忘れです。');
        }
        build(json);
        state.status = 'ready';
      })
      .catch(function (e) {
        state.status = 'error';
        state.error = e && e.userMessage ? e.userMessage :
          '語彙データを読み込めませんでした(' + (e && e.message ? e.message : e) + ')。インターネット接続を確認するか、index.html を直接開いている場合は簡易サーバー経由で開いてください。';
        console.error('語彙データの読み込みに失敗しました。', e);
      });
    return loadPromise;
  }

  /* =========================================================
   * 表示用ヘルパー
   * ========================================================= */
  function nameOf(list, id, fallback) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name;
    return fallback;
  }
  function catLabel(w) { return nameOf(state.cats, w.cat, '未分類'); }
  function posLabel(w) { return w.pos ? nameOf(state.poss, w.pos, w.pos) : '未設定'; }
  function badge(text) { return h('span', { class: 'badge', text: text }); }
  function impText(w) { return '重要度 ' + STARS[w.imp] + '(' + IMP_LABEL[w.imp] + ')'; }

  function field(id, label, control, full) {
    return h('div', { class: 'field' + (full ? ' full' : '') }, h('label', { for: id, text: label }), control);
  }
  function selectEl(id, options, value, onchange) {
    var s = h('select', { id: id });
    options.forEach(function (o) {
      var opt = h('option', { value: o[0], text: o[1] });
      if (o[0] === value) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener('change', function () { onchange(s.value); });
    return s;
  }

  /* =========================================================
   * 画面:入口・エラー
   * ========================================================= */
  function open() {
    study = null;
    if (state.status === 'loading') {
      mount(h('p', { class: 'loading', id: 'vocab-loading', text: '語彙データを読み込み中…' }));
      loadPromise.then(function () { if (document.getElementById('vocab-loading')) renderMain(); });
      return;
    }
    renderMain();
  }

  function renderError() {
    mount(h('div', { class: 'stack' },
      h('h1', { class: 'page-title', text: '語彙学習' }),
      h('div', { class: 'error-box', role: 'alert' },
        h('h2', { text: '語彙データを読み込めませんでした' }),
        h('p', { text: state.error }),
        h('p', { class: 'small', text: '問題演習・模擬試験など、ほかの学習機能はそのままお使いいただけます。' })),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: function () {
          mount(h('p', { class: 'loading', id: 'vocab-loading', text: '語彙データを読み込み中…' }));
          load().then(function () { if (document.getElementById('vocab-loading')) renderMain(); });
        } }, 'もう一度読み込む'),
        h('button', { type: 'button', class: 'btn ghost', onclick: A.renderHome }, 'ホームへ'))));
  }

  /* =========================================================
   * 画面:語彙一覧
   * ========================================================= */
  function filtered() {
    var q = flt.q.trim().toLowerCase();
    return state.words.filter(function (w) {
      if (flt.cat !== '' && (w.cat || '__none') !== flt.cat) return false;
      if (flt.pos !== '' && w.pos !== flt.pos) return false;
      if (flt.imp !== '' && String(w.imp) !== flt.imp) return false;
      if (flt.unknownOnly && isKnown(w.key)) return false;
      if (q && w.id.toLowerCase().indexOf(q) < 0 && w.ja.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function updateSummary() {
    var total = state.words.length, k = knownCount();
    if (ui.summary) ui.summary.textContent = '覚えた単語 ' + k + ' / ' + total + '語';
    if (ui.bar) ui.bar.firstChild.style.width = Math.round(total ? (k / total) * 100 : 0) + '%';
  }

  function refresh() {
    var list = filtered();
    ui.count.textContent = list.length + ' / ' + state.words.length + '語を表示';
    ui.studyBtn.textContent = 'この絞り込みでカード学習(' + list.length + '語)';
    ui.studyBtn.disabled = !list.length;
    var kids = list.map(wordCard);
    if (!list.length) kids.push(h('div', { class: 'card' }, h('p', { class: 'lead', text: '条件に合う単語がありません。検索語や絞り込みを変えてみてください。' })));
    ui.list.replaceChildren.apply(ui.list, kids);
  }

  function wordCard(w) {
    var btn = h('button', { type: 'button', class: 'known-btn', 'aria-pressed': isKnown(w.key) ? 'true' : 'false' });
    function paint() {
      var on = isKnown(w.key);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? '✓ 覚えた' : '覚えた';
    }
    paint();
    btn.addEventListener('click', function () { setKnown(w.key, !isKnown(w.key)); paint(); updateSummary(); });
    return h('div', { class: 'card vcard' },
      h('div', { class: 'vhead' },
        h('span', { class: 'vid', lang: 'id', text: w.id }),
        h('span', { class: 'vja', text: w.ja })),
      h('div', { class: 'vmeta' }, badge(catLabel(w)), badge(posLabel(w)), badge(impText(w))),
      w.example ? h('p', { class: 'vex' }, h('span', { lang: 'id', text: w.example }), w.exampleJa ? h('br') : null, w.exampleJa) : null,
      w.note ? h('p', { class: 'small', text: '補足:' + w.note }) : null,
      h('div', { class: 'actions' }, btn));
  }

  function renderMain() {
    if (state.status === 'error') { renderError(); return; }
    // category が空の単語は「未分類」として、内部値 __none で絞り込む
    var catOpts = [['', 'すべて']].concat(state.cats.map(function (c) { return [c.id === '' ? '__none' : c.id, c.name]; }));
    var posOpts = [['', 'すべて']].concat(state.poss.map(function (c) { return [c.id, c.name]; }));
    var impOpts = [['', 'すべて'], ['3', '★★★ 必須'], ['2', '★★☆ 重要'], ['1', '★☆☆ 余裕があれば']];

    var searchIn = h('input', { type: 'search', id: 'v-q', value: flt.q, placeholder: '例: rumah / 家', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    searchIn.addEventListener('input', function () { flt.q = searchIn.value; refresh(); });
    var chk = h('input', { type: 'checkbox', id: 'v-unk' });
    chk.checked = flt.unknownOnly;
    chk.addEventListener('change', function () { flt.unknownOnly = chk.checked; refresh(); });

    ui.summary = h('p', { class: 'item-title' });
    ui.bar = h('div', { class: 'bar', role: 'presentation' }, h('span'));
    ui.count = h('p', { class: 'small', 'aria-live': 'polite' });
    ui.studyBtn = h('button', { type: 'button', class: 'btn block', onclick: function () {
      var keys = filtered().map(function (w) { return w.key; });
      if (keys.length) startStudy(keys);
    } });
    ui.list = h('div', { class: 'list' });

    var probBox = null;
    if (state.problems.length) {
      probBox = h('details', { class: 'notice' },
        h('summary', { text: '語彙データに ' + state.problems.length + ' 件の注意があります(タップして確認)' }),
        h('ul', null, state.problems.map(function (p) { return h('li', { text: p }); })));
    }

    mount(h('div', { class: 'stack' },
      h('div', null,
        h('h1', { class: 'page-title', text: '語彙学習' }),
        h('p', { class: 'lead', text: '単語を検索・絞り込みして、一覧で確認したり、カードで覚えたりできます。' })),
      probBox,
      h('button', { type: 'button', class: 'btn block', onclick: openTest }, '単語の4択テスト'),
      h('section', { class: 'card stack', 'aria-label': '学習状況' }, ui.summary, ui.bar),
      h('section', { class: 'card stack', 'aria-label': '検索と絞り込み' },
        h('div', { class: 'vfilters' },
          field('v-q', '検索(インドネシア語・日本語)', searchIn, true),
          field('v-cat', 'カテゴリ', selectEl('v-cat', catOpts, flt.cat, function (v) { flt.cat = v; refresh(); })),
          field('v-pos', '品詞', selectEl('v-pos', posOpts, flt.pos, function (v) { flt.pos = v; refresh(); })),
          field('v-imp', '重要度', selectEl('v-imp', impOpts, flt.imp, function (v) { flt.imp = v; refresh(); }), true)),
        h('label', { class: 'check', for: 'v-unk' }, chk, '覚えていない単語だけ表示'),
        ui.count, ui.studyBtn),
      ui.list,
      helperBox(),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: A.renderHome }, 'ホームへ'))));
    updateSummary();
    refresh();
  }

  /* =========================================================
   * 画面:カード学習
   * ========================================================= */
  function startStudy(keys) {
    study = { keys: A.shuffle(keys), idx: 0, shown: false, dir: (study && study.dir) || 'id2ja', known: 0, againKeys: [] };
    renderCard();
  }

  function renderCard() {
    var w = state.byKey[study.keys[study.idx]];
    var n = study.keys.length, id2ja = study.dir === 'id2ja';
    var front = id2ja ? w.id : w.ja, back = id2ja ? w.ja : w.id;
    var frontLang = id2ja ? 'id' : 'ja', backLang = id2ja ? 'ja' : 'id';

    var card = h('section', { class: 'card flash', 'aria-label': '単語カード' },
      h('p', { class: 'side', text: id2ja ? 'インドネシア語' : '日本語' }),
      h('p', { class: 'big-word', lang: frontLang, text: front }));
    if (study.shown) {
      card.appendChild(h('div', { class: 'answer', role: 'status' },
        h('p', { class: 'side', text: id2ja ? '日本語' : 'インドネシア語' }),
        h('p', { class: 'big-word', lang: backLang, text: back }),
        h('div', { class: 'vmeta center' }, badge(catLabel(w)), badge(posLabel(w))),
        w.example ? h('p', { class: 'vex' }, h('span', { lang: 'id', text: w.example }), w.exampleJa ? h('br') : null, w.exampleJa) : null,
        w.note ? h('p', { class: 'small', text: '補足:' + w.note }) : null));
    }

    var main;
    if (!study.shown) {
      main = h('button', { type: 'button', class: 'btn block', id: 'v-main', onclick: function () { study.shown = true; renderCard(); } }, '答えを見る');
    } else {
      main = h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn secondary', onclick: function () { answer(false); } }, 'もう一度(まだ)'),
        h('button', { type: 'button', class: 'btn', id: 'v-main', onclick: function () { answer(true); } }, '覚えた'));
    }

    function dirBtn(key, text) {
      return h('button', { type: 'button', 'aria-pressed': study.dir === key ? 'true' : 'false',
        onclick: function () { study.dir = key; A.keepScroll(renderCard); } }, text);
    }

    mount(h('div', { class: 'stack' },
      h('div', { class: 'quiz-top' },
        h('span', { class: 'cat', text: 'カード学習' }),
        h('span', { class: 'num', text: (study.idx + 1) + ' / ' + n + '語' })),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(n), 'aria-valuenow': String(study.idx) },
        h('span', { style: 'width:' + Math.round((study.idx / n) * 100) + '%' })),
      card,
      main,
      h('div', { class: 'segmented', role: 'group', 'aria-label': '出題の向き' },
        dirBtn('id2ja', 'インドネシア語 → 日本語'), dirBtn('ja2id', '日本語 → インドネシア語')),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: open }, '中断して語彙一覧へ'))));
    var m = document.getElementById('v-main');
    if (m) m.focus({ preventScroll: true });
  }

  function answer(known) {
    var key = study.keys[study.idx];
    countSeen(key);
    setKnown(key, known);
    if (known) study.known++; else study.againKeys.push(key);
    study.idx++; study.shown = false;
    if (study.idx >= study.keys.length) renderSummary(); else renderCard();
  }

  function renderSummary() {
    var n = study.keys.length, again = study.againKeys.slice();
    mount(h('div', { class: 'stack' },
      h('h1', { class: 'page-title', text: 'カード学習の結果' }),
      h('section', { class: 'card score' },
        h('div', { class: 'big', text: study.known + ' / ' + n }),
        h('p', { text: '「覚えた」にした単語' }),
        h('p', { class: 'small', text: 'まだの単語は ' + again.length + ' 語です。' })),
      h('div', { class: 'actions' },
        again.length ? h('button', { type: 'button', class: 'btn', onclick: function () { startStudy(again); } }, 'まだの単語をもう一度(' + again.length + '語)') : null,
        h('button', { type: 'button', class: 'btn secondary', onclick: open }, '語彙一覧へ'),
        h('button', { type: 'button', class: 'btn ghost', onclick: A.renderHome }, 'ホームへ'))));
  }

  /* 単語4択テスト: カードの「覚えた」と独立した、方向別の回答記録 */
  function openTest() {
    test = null;
    if (state.status === 'loading') {
      mount(h('p', { class: 'loading', id: 'vocab-test-loading', text: '語彙データを読み込み中…' }));
      loadPromise.then(function () { if (document.getElementById('vocab-test-loading')) openTest(); });
      return;
    }
    if (state.status === 'error') { renderError(); return; }
    renderTestMenu();
  }
  function reviewWords() {
    return state.words.filter(function (w) { return vs.tests[testDir][w.key] && vs.tests[testDir][w.key].review; });
  }
  function directionName() { return testDir === 'id2ja' ? 'インドネシア語 → 日本語' : '日本語 → インドネシア語'; }
  function renderTestMenu() {
    var records = vs.tests[testDir], attempts = 0, correct = 0, wrong = reviewWords();
    state.words.forEach(function (w) { var r = records[w.key]; if (r) { attempts += r.attempts; correct += r.correct; } });
    mount(h('div', { class: 'stack' },
      h('h1', { class: 'page-title', text: '単語の4択テスト' }),
      h('p', { class: 'lead', text: '全' + state.words.length + '語から、重複なしでランダムに10問出題します。' }),
      field('vt-direction', '出題の向き', selectEl('vt-direction', [['id2ja', 'インドネシア語 → 日本語'], ['ja2id', '日本語 → インドネシア語']], testDir,
        function (dir) { testDir = dir; renderTestMenu(); })),
      h('section', { class: 'card stack' },
        h('h2', { text: 'この向きの学習記録' }),
        h('p', { text: '回答 ' + attempts + '問 / 正解 ' + correct + '問 / 正答率 ' + (attempts ? Math.round(correct / attempts * 100) : 0) + '%' }),
        h('p', { text: '要復習 ' + wrong.length + '語' }),
        h('p', { class: 'small', text: '回答ごとに記録を保存します。復習で正解すると、その単語は復習対象から外れます。' })),
      h('button', { type: 'button', class: 'btn block', onclick: function () { startTest(state.words); } }, '10問テストを始める'),
      h('button', { type: 'button', class: 'btn secondary block', disabled: !wrong.length,
        onclick: function () { startTest(wrong); } }, '間違えた単語だけ復習(' + Math.min(10, wrong.length) + '問)'),
      h('p', { class: 'small', text: '復習は最大10問です。対象が10語未満なら、その語数を出題します。' }),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: open }, '語彙一覧へ'),
        h('button', { type: 'button', class: 'btn ghost', onclick: A.renderHome }, 'ホームへ'))));
  }
  // 出題用の表示だけ補足を除く。元データと記録に使うキーは変更しない。
  function testText(text) {
    var previous;
    do {
      previous = text;
      text = text.replace(/[（(][^()（）]*[)）]/g, '');
    } while (text !== previous);
    return text.replace(/\s+/g, ' ').trim();
  }
  function startTest(words) {
    var promptField = testDir === 'id2ja' ? 'id' : 'ja', answerField = testDir === 'id2ja' ? 'ja' : 'id';
    var questions = A.shuffle(words).slice(0, 10).map(function (w) {
      // 同じ訳・同じつづりを持つ語を誤答にしない。選択肢の表示も重複させない。
      var seen = new Set([testText(w[answerField])]);
      var distractors = A.shuffle(state.words).filter(function (other) {
        var answer = testText(other[answerField]);
        if (!answer || testText(other[promptField]) === testText(w[promptField]) || seen.has(answer)) return false;
        seen.add(answer); return true;
      }).slice(0, 3).map(function (other) { return testText(other[answerField]); });
      return { word: w, prompt: testText(w[promptField]), answer: testText(w[answerField]), choices: A.shuffle([testText(w[answerField])].concat(distractors)), selected: null };
    });
    if (!questions.length || questions.some(function (q) { return q.choices.length !== 4; })) {
      mount(h('div', { class: 'stack' }, h('p', { role: 'alert', text: '4択に必要な単語が足りません。語彙データを確認してください。' }),
        h('button', { type: 'button', class: 'btn', onclick: openTest }, 'テストのメニューへ')));
      return;
    }
    test = { questions: questions, idx: 0, correct: 0 };
    renderTestQuestion();
  }
  function renderTestQuestion() {
    var q = test.questions[test.idx], answered = q.selected !== null;
    var ok = answered && q.choices[q.selected] === q.answer;
    mount(h('div', { class: 'stack' },
      h('h1', { class: 'page-title', text: '単語の4択テスト' }),
      h('div', { class: 'quiz-top' }, h('span', { class: 'cat', text: directionName() }),
        h('span', { class: 'num', text: (test.idx + 1) + ' / ' + test.questions.length + '問' })),
      h('section', { class: 'card' }, h('h2', { class: 'big-word', lang: testDir === 'id2ja' ? 'id' : 'ja', text: q.prompt })),
      h('ul', { class: 'choices', 'aria-label': '回答の選択肢' }, q.choices.map(function (choice, i) {
        return h('li', null, h('button', { type: 'button', class: 'choice' + (answered && choice === q.answer ? ' correct' : answered && i === q.selected ? ' wrong' : ''),
          disabled: answered, lang: testDir === 'id2ja' ? 'ja' : 'id', onclick: function () { answerTest(i); } },
          h('span', { class: 'mark', text: String(i + 1) }), h('span', { class: 'body' }, h('span', { class: 'ctext', text: choice }),
            answered && choice === q.answer ? h('span', { class: 'tag', text: '正解' }) : answered && i === q.selected ? h('span', { class: 'tag', text: '選んだ答え・不正解' }) : null)));
      })),
      answered ? h('div', { class: 'feedback ' + (ok ? 'ok' : 'ng'), role: 'status', tabindex: '-1', id: 'vt-feedback' },
        h('p', { class: 'verdict', text: ok ? '正解！' : '不正解' }), h('p', { text: q.word.id + ' → ' + q.word.ja })) : null,
      testMemoryOnly ? h('p', { role: 'alert', text: '記録を端末に保存できません。この画面を閉じると記録が失われる場合があります。' }) : null,
      answered ? h('button', { type: 'button', class: 'btn block', onclick: function () {
        test.idx++; if (test.idx === test.questions.length) renderTestResult(); else renderTestQuestion();
      } }, test.idx + 1 === test.questions.length ? '結果を見る' : '次の問題へ') : null,
      h('button', { type: 'button', class: 'btn ghost', onclick: openTest }, '中断してテストのメニューへ')));
    if (answered) document.getElementById('vt-feedback').focus({ preventScroll: true });
  }
  function answerTest(i) {
    var q = test.questions[test.idx];
    if (q.selected !== null) return;
    q.selected = i;
    var ok = q.choices[i] === q.answer;
    var records = vs.tests[testDir], r = records[q.word.key] || { attempts: 0, correct: 0, review: false, last: null };
    r.attempts++; if (ok) { r.correct++; test.correct++; }
    r.review = !ok; r.last = new Date().toISOString(); records[q.word.key] = r;
    saveStore(); renderTestQuestion();
  }
  function renderTestResult() {
    var wrong = test.questions.filter(function (q) { return q.choices[q.selected] !== q.answer; });
    mount(h('div', { class: 'stack' }, h('h1', { class: 'page-title', text: '単語テストの結果' }),
      h('section', { class: 'card score' }, h('div', { class: 'big', text: test.correct + ' / ' + test.questions.length }),
        h('p', { text: '正解数 / 出題数' })),
      wrong.length ? h('section', { class: 'card' }, h('h2', { text: '間違えた単語' }),
        h('ul', null, wrong.map(function (q) { return h('li', { text: q.word.id + ' → ' + q.word.ja }); }))) : h('p', { text: '全問正解です！' }),
      wrong.length ? h('button', { type: 'button', class: 'btn block', onclick: function () { startTest(wrong.map(function (q) { return q.word; })); } }, '今回間違えた単語を復習') : null,
      h('button', { type: 'button', class: 'btn secondary block', onclick: openTest }, 'テストのメニューへ'),
      h('button', { type: 'button', class: 'btn ghost', onclick: A.renderHome }, 'ホームへ')));
  }

  /* =========================================================
   * 単語追加ヘルパー(JSON の1行を作ってコピーするだけ)
   * ========================================================= */
  function jsonLine(o) {
    return '{' + Object.keys(o).map(function (k) { return JSON.stringify(k) + ': ' + JSON.stringify(o[k]); }).join(', ') + '},';
  }

  function helperBox() {
    var catList = state.cats.filter(function (c) { return c.id !== ''; });
    var inId = h('input', { type: 'text', id: 'hp-id', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '例: rumah' });
    var inJa = h('input', { type: 'text', id: 'hp-ja', autocomplete: 'off', placeholder: '例: 家' });
    var selCat = selectEl('hp-cat', catList.map(function (c) { return [c.id, c.name]; }), catList.length ? catList[0].id : '', function () {});
    var selPos = selectEl('hp-pos', state.poss.map(function (c) { return [c.id, c.name]; }), state.poss.length ? state.poss[0].id : '', function () {});
    var selImp = selectEl('hp-imp', [['3', '★★★ 必須'], ['2', '★★☆ 重要'], ['1', '★☆☆ 余裕があれば']], '2', function () {});
    var inEx = h('input', { type: 'text', id: 'hp-ex', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '(任意)例: Saya tinggal di rumah.' });
    var inExJa = h('input', { type: 'text', id: 'hp-exja', autocomplete: 'off', placeholder: '(任意)例: 私は家に住んでいます。' });
    var out = h('textarea', { id: 'hp-out', readonly: true, rows: '4', class: 'vout', 'aria-label': '作成された1行' });
    var msg = h('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
    var copyBtn = h('button', { type: 'button', class: 'btn secondary', disabled: true }, 'コピーする');

    var makeBtn = h('button', { type: 'button', class: 'btn', onclick: function () {
      var id = inId.value.trim(), ja = inJa.value.trim();
      copyBtn.disabled = true; out.value = '';
      if (!id || !ja) { msg.textContent = 'インドネシア語と日本語訳の両方を入力してください。'; return; }
      var key = id.toLowerCase();
      if (state.byKey[key]) { msg.textContent = '「' + id + '」はすでに登録されています(日本語訳: ' + state.byKey[key].ja + ')。意味が違う別の語なら、コピー後に "id" を付けて区別してください。'; }
      else msg.textContent = '1行ができました。コピーして、手順3の場所に貼り付けてください。';
      var o = { indonesian: id, japanese: ja };
      if (selCat.value) o.category = selCat.value;
      if (selPos.value) o.pos = selPos.value;
      o.importance = parseInt(selImp.value, 10);
      if (inEx.value.trim()) { o.example = inEx.value.trim(); if (inExJa.value.trim()) o.exampleJa = inExJa.value.trim(); }
      if (state.byKey[key]) o.id = key + '-2';
      out.value = jsonLine(o);
      copyBtn.disabled = false;
    } }, '追加用の1行を作る');

    copyBtn.addEventListener('click', function () {
      var done = function () { msg.textContent = 'コピーしました。次は GitHub で data/vocabulary.json を開いて貼り付けます。'; };
      var fallback = function () { out.focus(); out.select(); try { if (document.execCommand('copy')) { done(); return; } } catch (e) { /* 下の案内へ */ } msg.textContent = '自動コピーできませんでした。枠の文字を長押し(または選択)して、手動でコピーしてください。'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(out.value).then(done, fallback); else fallback();
    });

    return h('details', { class: 'card helper' },
      h('summary', { text: '単語を追加するには(1行を作ってコピーするだけ)' }),
      h('div', { class: 'stack', style: 'margin-top:12px' },
        h('p', { class: 'small', text: '手順1: 下のフォームに入力して「追加用の1行を作る」を押します。' }),
        h('div', { class: 'vfilters' },
          field('hp-id', 'インドネシア語', inId), field('hp-ja', '日本語訳', inJa),
          field('hp-cat', 'カテゴリ', selCat), field('hp-pos', '品詞', selPos),
          field('hp-imp', '重要度', selImp, true), field('hp-ex', '例文', inEx, true), field('hp-exja', '例文の日本語訳', inExJa, true)),
        makeBtn, out, copyBtn, msg,
        h('p', { class: 'small', text: '手順2: 「コピーする」を押します。' }),
        h('ol', { class: 'small steps' },
          h('li', { text: '手順3: GitHub のリポジトリで data フォルダ → vocabulary.json を開き、右上の鉛筆アイコン(Edit)を押します。' }),
          h('li', { text: '"words": [ と書かれた行の「次の行」にカーソルを置き、貼り付けます(行末のカンマも一緒に)。' }),
          h('li', { text: '右上の「Commit changes」→「Commit changes」を押します。1〜2分後、このページを再読み込みすると反映されます。' })),
        h('p', { class: 'small', text: '※ このアプリの画面から直接データを書き換えることはできません。必ず GitHub 側で貼り付けます。' })));
  }

  /* =========================================================
   * app.js から呼ばれる入口
   * ========================================================= */
  window.IdVocab = {
    open: open,
    openTest: openTest,
    exportData: function () { return vs; },
    importData: function (raw) { vs = sanitizeStore(raw); saveStore(); },
    reset: function () { vs = defaultStore(); saveStore(); }
  };

  load();   // 起動時に先読み(失敗しても他の機能には影響しません)
})();
