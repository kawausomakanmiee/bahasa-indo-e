# インドネシア語技能検定 E級対策アプリ

HTML / CSS / JavaScript だけで動く静的 Web アプリです。ビルド不要で、GitHub Pages にそのまま公開できます。

## ファイル構成

```
indonesian-e-app/
├─ index.html            画面の土台(ヘッダーと描画先のみ)
├─ css/style.css         デザイン(赤×白、スマホ優先のレスポンシブ)
├─ js/app.js             画面描画・出題・採点・学習記録・模試のロジック
├─ data/questions.json   問題データ(カテゴリ定義と問題)
├─ tools/check-questions.js  問題データの検査スクリプト(任意、Node.js)
└─ README.md
```

## 問題の追加・編集

`data/questions.json` の `questions` 配列に、次の形式のオブジェクトを追加します。コードの変更は不要です。

```json
{
  "id": "PRE-007",
  "category": "preposition",
  "subCategory": "direction",
  "level": "basic",
  "question": "問題文",
  "choices": ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
  "answerIndex": 1,
  "explanation": "正解の理由",
  "choiceExplanations": ["選択肢1の説明", "選択肢2の説明", "選択肢3の説明", "選択肢4の説明"],
  "relatedVocabulary": ["語彙"],
  "relatedGrammar": ["文法項目"],
  "sourceType": "original",
  "tags": ["タグ"]
}
```

- `id` は**一意**にし、一度付けたら変えないでください。学習記録は `id` に紐づくため、並び替えや追加をしても記録はずれません。
- `answerIndex` は 0 始まりです(0 = 1番目の選択肢)。
- `choiceExplanations` の数は `choices` と同じにします。
- `category` は `categories` の `id` を使います(`mixed` は全問題の総合練習用で、問題側には付けません)。
- 読解問題は `passage`(本文)と `passageTranslation`(日本語訳。回答後に表示)を追加できます。
- 追加後は `node tools/check-questions.js` で検査できます(id の重複、正解番号の範囲、説明の数など)。

## ローカルで確認する

`fetch` で JSON を読むため、`index.html` をダブルクリックで開くのではなく、簡易サーバーで開いてください。

```
cd indonesian-e-app
python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

## GitHub Pages への公開手順

1. GitHub で新しいリポジトリを作成します(例: `indonesian-e-app`)。
2. このフォルダの中身(`index.html`、`css`、`js`、`data` など)をリポジトリの直下に push します。
3. リポジトリの **Settings → Pages** を開きます。
4. **Build and deployment** の Source を **Deploy from a branch** にし、Branch を `main`、フォルダを `/ (root)` にして Save します。
5. 数分後、`https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます。

パスはすべて相対パスなので、リポジトリ名のサブパス配下でも動作します。

## 学習記録について

- 記録は `localStorage` に保存されます(キー: `idE_taisaku_v1`)。ブラウザごと・端末ごとに別々です。
- 「学習記録」画面から JSON の書き出し・読み込みができます。端末の変更前にバックアップしてください。
- 記録が壊れていた場合は、アプリが停止せず初期状態で起動します。

## 復習の仕様

間違えた問題は「要復習」になり、**2回連続で正解**すると「定着」に変わります。定着しても履歴は残り、「復習 → 間違えた履歴」でいつでも確認できます。

## 注意

- 問題はすべて本アプリ用の**独自の練習問題**です。公式の過去問ではなく、出題比率・傾向を分析したものでもありません。
- 模擬試験の問題数・制限時間は**独自の設定**で、公式仕様ではありません。最新の試験概要は実施団体の公式案内でご確認ください。
- 公開前に、インドネシア語に詳しい方による内容確認を推奨します。
