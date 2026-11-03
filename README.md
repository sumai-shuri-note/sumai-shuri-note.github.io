# 住まいの修理ノート — サイトの箱

「自分でやるなら、この道具／頼むなら、ここ」の二択で書くノートの、静的サイトです。
Markdown の原稿を `dist/` の HTML にします。お金のかかる物は使いません。

- 著者：現場のプロ編集部（配管・内装・害獣駆除の現場で働く人たち）
- 書き方の決まり：`docs/staff/sumai_shuri_note_rules.md`（このリポジトリの中）
- 置き場：GitHub Pages（まだ出していません。「公開する時」を見てください）

## 動かし方

Node 22 以上が要ります。

```sh
cd media/sumai-shuri-note
npm ci          # 必要な物を入れる（marked と gray-matter の2つだけ）
npm test        # 検査（ビルドも含む）
npm run build   # dist/ を作る
```

手元で見る時は、サイトの URL を localhost にしてビルドし直します。

```sh
SITE_URL=http://localhost:8787/ npm run build
npm run serve   # http://localhost:8787/
```

`SITE_URL` を付けない時は `https://sumai-shuri-note.pages.dev/` になります。
ページの中のリンク・canonical・sitemap はこの URL で書き出します。

## フォルダ

```
build.mjs                 ビルド（原稿 → dist/）
test.mjs                  検査（npm test）
serve.mjs                 手元で見るためのサーバー
site.config.json          サイト名・著者・広告表記・価格の注意書き・計測の設定
links.json                記事の中の商品・業者リンクの札（下を見る）
lib/forbidden.mjs         出してはならない語（伏せ字で持つ）
src/assets/style.css      見た目（10KB 以下・外部の物を読まない）
src/content/articles/     記事（1本 = 1ファイル）
src/content/pages/        固定ページ（index.md = トップ、about.md = 編集部、404.md）
deploy/                   GitHub Pages に出す時の手順の例（まだ使わない）
dist/                     ビルドの出力（リポジトリに入れない）
```

## 記事の足し方

`src/content/articles/` に `英小文字-と-ハイフン.md` を1つ作ります。ファイル名がそのまま URL（`/articles/ファイル名/`）になります。

```markdown
---
title: 記事の題（H1 になる）
description: 検索結果と一覧に出る1〜2文
date: 2026-11-01          # 公開日
updated: 2026-11-01       # 最終更新日（直した時に変える。無ければ date と同じ）
cluster: 窓と断熱          # 台帳（docs/staff/affiliate_keywords_v1.csv）の cluster と同じ言葉
keywords:                 # 狙う検索語（台帳から）
  - 内窓 diy
faq:                      # 3問ちょうど。ページにも出て、FAQPage の構造化データにもなる
  - q: 質問
    a: 答え
  - q: 質問
    a: 答え
  - q: 質問
    a: 答え
draft: false              # true にすると出さない（省略可）
---

最初の見出しの前に書いた文が、リード（導入）になります。

## 自分でやるなら、この道具

- [[link:uchimado-kit]]：道具の説明。
- [[link:convex]]：道具の説明。

手順の要点を番号で書きます。

## 頼むなら、ここ

業者に頼んだ方がよい場合と、頼み方。最後に紹介先の札を置きます。

頼み先：[[link:mado-reform-gyosha]]

## 現場の一言

現場で働く人が実際に見てきた事を、短く、事実だけ。
```

決まり:

- 見出しは `## 自分でやるなら、この道具` → `## 頼むなら、ここ` → `## 現場の一言` の3つが、この順で必ず要ります。無い・順が違う・`#`（H1）を本文に書く、のどれかがあるとビルドが止まります。
- 「価格は記事作成時点のものです」の注意書きは、ビルドが全記事に自動で入れます。本文に価格を書く時は「目安」「記事作成時点」と添えて、断定しません。
- FAQ は3問ちょうど。2問でも4問でもビルドが止まります。
- 分からない事は「（要確認）」と書きます。会社名は書きません（下の「出してはならない語」）。
- 長さは本文 1,200〜2,000 文字（検査で見ます）。

### 札（本文に書ける印）

| 札 | 何になるか |
|---|---|
| `[[link:札の名前]]` | `links.json` のリンク。URL が空なら「道具の名前（リンク準備中）」の文字 |
| `[[photo:説明]]` | 写真の枠（準備中）。検収で写真を選ぶ場所の目印 |
| `[[photo:説明\|assets/img/x.jpg]]` | `src/assets/img/x.jpg` の写真。説明は alt と添え書きになる |
| `[[site:articles/xxx/]]` | サイト内のリンク先。`[文]([[site:articles/xxx/]])` のように書く |

## links.json の仕組み

記事には商品や業者の URL を直接書きません。`links.json` の札を書き、URL は `links.json` に1か所で持ちます。
提携が通る前でも記事を出せて、通ったら `links.json` を直すだけで全記事のリンクが変わります。

```json
{
  "uchimado-kit": {
    "label": "内窓キット（樹脂フレームと中空ポリカ板のセット）",
    "kind": "物販",
    "url": "",
    "note": "ASP の提携が通ったら、計測つきリンクを url に入れる"
  }
}
```

- `label`：本文に出る文字。
- `kind`：`物販` か `業者紹介`。
- `url`：空なら「（リンク準備中）」の文字になり、リンクにはなりません。入れると `rel="sponsored nofollow noopener"` の広告リンクになります。
- `note`：メモ。ページには出ません。
- 札の名前は英小文字・数字・ハイフンだけ。記事に書いた札が `links.json` に無いと、ビルドが止まります。

## 全ページに自動で入る物

- 最上部の「本ページにはプロモーション（広告）が含まれています」
- 著者欄（編集部ページへのリンク）と最終更新日
- FAQ（3問）と、その構造化データ（FAQPage）。記事には Article とパンくずの構造化データも
- canonical、OGP、RSS（`feed.xml`）、`sitemap.xml`、`robots.txt`、`404.html`

## 出してはならない語

運営会社と関係する会社の名前は、ページにも原稿にも出しません。語は `lib/forbidden.mjs` に伏せ字（base64）で持ち、
ビルドと検査の両方で見ます。見つかるとビルドが止まり、ページは作られません。
このフォルダをそのまま公開用のリポジトリに写しても、平文の会社名が残らないようにしています。

## 計測（任意）

`site.config.json` の2つは、空なら何も出しません。

- `searchConsoleVerification`：Search Console の HTML タグ方式の値。
- `ga4MeasurementId`：GA4 の測定 ID（`G-` で始まる物）。入れると gtag の読み込みが全ページに入ります。

## 公開する時（GitHub Pages・まだやらない）

今はまだ出していません。組織もリポジトリも作っていません。見回り（AI）が本当の URL を後で入れます。

1. 担当者の票（`aff.box.github`）で GitHub の組織 `sumai-shuri-note` を作る（無料）。
2. その組織にリポジトリ `sumai-shuri-note.github.io` を作り、このフォルダの中身（`node_modules/` と `dist/` を除く）を置く。
3. `deploy/github-pages.yml.example` を、そのリポジトリの `.github/workflows/pages.yml` に写す。
4. リポジトリの Settings → Pages の Source を「GitHub Actions」にする。Variables に `SITE_URL` を置く。
5. `main` に push すると、検査 → ビルド → 公開が動く。
6. 公開されたら、`site.config.json` の `searchConsoleVerification` を入れて Search Console に登録する。

独自ドメインは、最初の確定報酬が入ってから（行動書 4章 G1）。その時は `SITE_URL` を新しい URL に変えるだけです。
