# Magis 社内チーム（Web版 / Vercel）

チームみんながURLで使える、4部署のAIチャット。秘密情報はすべてサーバー側に隠し、
経理部・営業部は質問に応じてShopifyの売上を自動取得します。

```
ブラウザ(index.html) → /api/chat(秘密を保管) → Gemini(無料枠) ＋ Shopify Admin API
```

## 構成
```
magis-team-web/
├─ index.html      … 画面（合言葉ゲート＋部署タブ＋チャット）
├─ api/
│   └─ chat.js     … バックエンド。Gemini呼び出し＋ツール実行＋認証
├─ .gitignore
└─ README.md
```
ビルド不要・依存ライブラリなし。Vercelに置くだけで動きます。

---

## デプロイ手順

### 1. Vercelに上げる
- このフォルダをGitリポジトリにして GitHub に push
- https://vercel.com → 「Add New → Project」→ そのリポジトリを Import → Deploy
- （CLI派なら `npm i -g vercel` → フォルダで `vercel` でもOK）

### 2. 環境変数を設定（Vercel → Settings → Environment Variables）
| 変数名 | 値 | 用途 |
|---|---|---|
| `GEMINI_API_KEY` | `AIza...` | Gemini（必須・無料枠でOK） |
| `SITE_PASSWORD` | 好きな合言葉 | チームのアクセス制限（必須） |
| `GEMINI_MODEL` | （任意）`gemini-2.5-flash` | 上限を増やすなら `gemini-2.5-flash-lite` |
| `SHOPIFY_STORE` | `your-store.myshopify.com` | Shopify連携する場合 |
| `SHOPIFY_TOKEN` | `shpat_...` | 同上 |

設定後に **Redeploy**（環境変数は再デプロイで反映）。

### 2.5 Gemini APIキーの取り方（無料・カード不要）
1. https://aistudio.google.com/apikey を開く（Googleアカウントでログイン）
2. 「Create API key」→ キー（`AIza...`）をコピー → `GEMINI_API_KEY` に設定
3. 無料枠の目安：Flash系で 約10リクエスト/分・1,500リクエスト/日・100万トークン文脈
4. 注意：無料枠では送信内容がGoogleのモデル学習に使われる場合があります

### 3. Shopifyトークンの取り方
1. Shopify管理画面 → 設定 → アプリと販売チャネル → **アプリ開発**（カスタムアプリ）
2. アプリを作成 → **Admin API 統合** → スコープに `read_orders`（必要なら `read_products`）を許可
3. インストール → **Admin API アクセストークン**（`shpat_...`）をコピー → `SHOPIFY_TOKEN` に設定
4. ストアのドメイン（`◯◯.myshopify.com`）を `SHOPIFY_STORE` に設定

### 4. 使う
- 発行されたURLを開く → 合言葉を入力 → 部署を選んで相談
- 例）経理部に「今月1日から今日までの売上を教えて」→ GeminiがShopifyを取得して回答

---

## カスタマイズ
- **人格・どの部署にどのツールを持たせるか** → `api/chat.js` の `DEPARTMENTS`
- **モデル** → 環境変数 `GEMINI_MODEL`（既定 `gemini-2.5-flash` / 上限重視なら `gemini-2.5-flash-lite`）
- **見た目・部署** → `index.html` の `DEPARTMENTS` 配列

## これから足せるもの（次の段）
- **Supabase（Time Recorder・在庫管理）**：Supabase REST(`/rest/v1/...`)を叩く `get_inventory` 等のツールを `api/chat.js` に追加。`SUPABASE_URL` と `SUPABASE_KEY` を環境変数に入れる
- **Googleスプレッドシート**：Sheets API or 公開CSV出力URLを読むツールを追加
- **Googleドライブ / カレンダー**：Google OAuthを設定し、同じ要領でツールを追加
  ※ いずれも今ある `get_shopify_sales` と同じ「ツール1個追加」の作りで増やせます

## 注意
- `SITE_PASSWORD` は簡易ロックです。本格運用やユーザー別管理が必要なら、Time Recorderのログインに差し替え推奨
- `.env` やトークンは絶対にGitに上げない（`.gitignore` 済み。秘密はVercelの環境変数へ）
- Shopify集計は1回250件まで（大量注文ならページング対応を追加）
