// 使い方: node tools/check-questions.js
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'questions.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const catIds = new Set((data.categories || []).map((c) => c.id));
const seen = new Set();
const errors = [];
const perCat = {};

(data.questions || []).forEach((q, i) => {
  const t = `#${i + 1} ${q.id || '(idなし)'}`;
  if (!q.id) errors.push(`${t}: id がありません`);
  if (seen.has(q.id)) errors.push(`${t}: id が重複しています`);
  seen.add(q.id);
  if (!catIds.has(q.category)) errors.push(`${t}: 未定義の category "${q.category}"`);
  perCat[q.category] = (perCat[q.category] || 0) + 1;
  if (!q.question) errors.push(`${t}: question が空です`);
  if (!Array.isArray(q.choices) || q.choices.length < 2) {
    errors.push(`${t}: choices が不正です`);
    return;
  }
  if (new Set(q.choices).size !== q.choices.length) errors.push(`${t}: 選択肢が重複しています`);
  if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex >= q.choices.length) {
    errors.push(`${t}: answerIndex が範囲外です`);
  }
  if (!Array.isArray(q.choiceExplanations) || q.choiceExplanations.length !== q.choices.length) {
    errors.push(`${t}: choiceExplanations の数が choices と一致しません`);
  }
  if (!q.explanation) errors.push(`${t}: explanation が空です`);
});

console.log(`問題数: ${(data.questions || []).length}`);
console.log('カテゴリ別:', perCat);
if (errors.length) {
  console.error(`\n問題が ${errors.length} 件あります:`);
  errors.forEach((e) => console.error(' - ' + e));
  process.exit(1);
}
console.log('OK: 問題データに不備は見つかりませんでした。');
