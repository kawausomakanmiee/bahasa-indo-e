// 使い方: node tools/check-vocabulary.js
// data/vocabulary.json の書き間違い(カンマ忘れ・重複・未登録のカテゴリなど)を調べます。
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'vocabulary.json');
const text = fs.readFileSync(file, 'utf8');
let data;
try {
  data = JSON.parse(text);
} catch (e) {
  const m = /position (\d+)/.exec(e.message) || /line (\d+)/.exec(e.message);
  let where = '';
  if (m) where = /position/.test(m[0]) ? `(約 ${text.slice(0, +m[1]).split('\n').length} 行目付近)` : `(${m[0]})`;
  console.error('書き方の誤りで読み込めません ' + where + ': ' + e.message);
  console.error('よくある原因: 行末のカンマ(,)の付け忘れ・付けすぎ、引用符(")の閉じ忘れ');
  process.exit(1);
}

const cats = new Set((data.categories || []).map((c) => c.id));
const poss = new Set((data.partsOfSpeech || []).map((c) => c.id));
const errors = [];
const warnings = [];
const seen = new Set();
const perCat = {};

if (!Array.isArray(data.words)) {
  console.error('"words" の一覧が見つかりません。');
  process.exit(1);
}

data.words.forEach((w, i) => {
  const tag = `${i + 1}番目 ${w && w.indonesian ? '「' + w.indonesian + '」' : ''}`;
  if (!w || typeof w !== 'object') { errors.push(`${tag}: 形式が不正です`); return; }
  const id = typeof w.indonesian === 'string' ? w.indonesian.trim() : '';
  const ja = typeof w.japanese === 'string' ? w.japanese.trim() : '';
  if (!id) { errors.push(`${tag}: indonesian が空です`); return; }
  if (!ja) { errors.push(`${tag}: japanese が空です`); return; }
  const key = (typeof w.id === 'string' && w.id.trim()) || id.toLowerCase();
  if (seen.has(key)) errors.push(`${tag}: 重複しています(同じつづりで別の意味なら "id" を付けて区別)`);
  seen.add(key);
  if (!w.category) warnings.push(`${tag}: category がありません`);
  else if (!cats.has(w.category)) warnings.push(`${tag}: カテゴリ "${w.category}" が categories にありません`);
  if (!w.pos) warnings.push(`${tag}: pos がありません`);
  else if (!poss.has(w.pos)) warnings.push(`${tag}: 品詞 "${w.pos}" が partsOfSpeech にありません`);
  if (![1, 2, 3].includes(w.importance)) warnings.push(`${tag}: importance は 1・2・3 のどれかにしてください`);
  perCat[w.category || '(未分類)'] = (perCat[w.category || '(未分類)'] || 0) + 1;
});

console.log(`単語数: ${data.words.length}`);
console.log('カテゴリ別:', perCat);
if (warnings.length) {
  console.log(`\n注意 ${warnings.length} 件(アプリは動きますが、直すことをおすすめします):`);
  warnings.forEach((m) => console.log(' - ' + m));
}
if (errors.length) {
  console.error(`\nエラー ${errors.length} 件(アプリでは除外されます):`);
  errors.forEach((m) => console.error(' - ' + m));
  process.exit(1);
}
console.log(warnings.length ? '\nエラーはありません(注意のみ)。' : '\nOK: 語彙データに問題は見つかりませんでした。');
