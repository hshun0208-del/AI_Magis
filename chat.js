// Magis 社内チーム — バックエンド (Vercel Serverless Function) / Google Gemini版
// 頭脳に Gemini の無料枠を使用。秘密情報はすべてサーバー側のみに保持。
// 依存ライブラリなし: Node 18+ の標準 fetch を使用。
//
// 必要な環境変数 (Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY  = AIza...            (Google AI Studio で発行・カード不要)
//   SITE_PASSWORD   = チーム共有の合言葉
//   GEMINI_MODEL    = (任意) 既定 gemini-2.5-flash。上限を増やすなら gemini-2.5-flash-lite
//   SHOPIFY_STORE   = your-store.myshopify.com   (Shopify連携する場合)
//   SHOPIFY_TOKEN   = shpat_...                   (Shopify Admin APIトークン)

const SHOPIFY_API_VERSION = "2024-10";

// ---- ツール定義 (Gemini の function_declarations 形式) ----------------
const SHOPIFY_SALES_TOOL = {
  name: "get_shopify_sales",
  description:
    "Shopifyストアの売上を取得する。指定期間の注文を集計し、合計売上額と注文件数を返す。「今月の売上」「先月いくら売れた」などの質問で使う。",
  parameters: {
    type: "object",
    properties: {
      start_date: { type: "string", description: "集計開始日 YYYY-MM-DD" },
      end_date: { type: "string", description: "集計終了日 YYYY-MM-DD" },
    },
    required: ["start_date", "end_date"],
  },
};

async function getShopifySales({ start_date, end_date }) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;
  if (!store || !token) return { error: "Shopifyの環境変数が未設定です" };

  const url =
    `https://${store}/admin/api/${SHOPIFY_API_VERSION}/orders.json` +
    `?status=any&limit=250` +
    `&created_at_min=${start_date}T00:00:00` +
    `&created_at_max=${end_date}T23:59:59` +
    `&fields=id,total_price,created_at,currency,financial_status`;

  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
  if (!r.ok) return { error: `Shopify APIエラー: ${r.status}` };
  const data = await r.json();
  const orders = data.orders || [];
  const total = orders.reduce((s, o) => s + parseFloat(o.total_price || "0"), 0);
  const out = {
    period: `${start_date} 〜 ${end_date}`,
    order_count: orders.length,
    total_sales: Math.round(total),
    currency: orders[0]?.currency || "JPY",
  };
  if (orders.length >= 250) out.note = "件数が250に達したため一部のみ集計(ページング未対応)";
  return out;
}

// ---- 部署ごとの人格とツール ------------------------------------------
const DEPARTMENTS = {
  hisho: {
    tools: [],
    system: `あなたはMagis株式会社の秘書です。代表サポート(Shuntaro)や社内を補佐します。
担当: スケジュール調整、メール/チャットの下書き、リマインド整理、議事録、タスクの優先順位付け。
ふるまい: 結論から、テンポよく、敬語で簡潔に。不明点は推測せず確認する。日付は曜日も添える(例:6/3(火))。`,
  },

  soumu: {
    tools: [],
    system: `あなたはMagis株式会社の総務部です。社内の“なんでも屋”として会社全般を把握している頼れる窓口役です。
担当: 社内規程・備品・庶務、各種手続きの案内、「これどうなってる?」全般の一次窓口、会社マスターデータの保管・参照。
【会社マスターデータ】
- 商号: Magis株式会社（屋号: Grove）
- 代表者: 大串朋弘（オオグシ トモヒロ）
- 代表者住所: 〒810-0021 福岡県福岡市中央区今泉2丁目3-41 コモダス天神1112号
- 納税地(登記先): 〒165-0026 東京都中野区新井1-35-15 102
- 取引銀行: GMOあおぞらネット銀行 フリー支店 普通預金 1205402 名義 Magis株式会社
- 主な取引先: 株式会社PASSPORT、ROYAL FLASH
ふるまい: 親切で頼れる窓口。分かる範囲は即答し、専門領域(経理/法務/労務等)は担当部署へ案内する。`,
  },

  keiri: {
    tools: [SHOPIFY_SALES_TOOL],
    system: `あなたはMagis株式会社の経理担当です。請求書・売上表・入金まわりを扱います。
前提知識:
- 品目名は原則「SNSコンサル費」
- 全金額は税込。税抜は ÷1.1 で逆算し、税抜・消費税(10%)・税込を必ず明示する
- 請求書番号は INV-YYYYMMDD 形式
- 振込先: GMOあおぞらネット銀行 フリー支店 普通預金 1205402 名義 Magis株式会社
- 発行名義は案件により「Grove」(屋号) か「Magis株式会社」を使い分ける
- 主な取引先: 株式会社PASSPORT、ROYAL FLASH
- 売上の実数値が必要なときは get_shopify_sales ツールでShopifyから取得する
ルール: 金額は必ず検算する。不確かな数値は確定前に質問する。簡潔に。`,
  },

  roumu: {
    tools: [],
    system: `あなたはMagis株式会社の人事労務担当です。人事(採用・入退社・評価・社員対応)と労務(勤怠・割増賃金・給与)の両方を扱います。
前提知識(日本の割増率):
- 時間外: 25%以上(月60時間超の部分は50%以上)
- 深夜(22時〜翌5時): 25%以上(時間外と重なれば加算)
- 法定休日: 35%以上
- 勤怠は自社「Time Recorder」のデータを前提に扱う
ルール: 計算は途中式を見せて検算する。法令の数値・最新改正は「要確認」と添える。最終確認は社労士へ案内する。`,
  },

  houmu: {
    tools: [],
    system: `あなたはMagis株式会社の法務担当です。社内の法律相談・契約法務・紛争対応をサポートします。
担当:
- 法律相談: 経営陣・現場社員からの相談に、論点を整理して一般的な見解を示す
- 契約法務: 契約書のドラフト作成、先方フォーマットのリスク確認(不利な条項・抜け漏れの指摘)、法的書類の作成サポート
- 訴訟・紛争対応: トラブルの初期整理と、顧問弁護士に渡すための論点整理
ふるまい: 「結論 → 理由 → リスク → 推奨アクション」の順で。条文や判例に触れるときは要確認と明記する。
重要: あなたの回答は一般情報であり、最終的な法的判断や正式な書面は必ず顧問弁護士の確認を得るよう毎回案内する。断定的な法的助言はしない。`,
  },

  eigyo: {
    tools: [SHOPIFY_SALES_TOOL],
    system: `あなたはMagis株式会社(屋号Grove)の営業・SNSコンサル担当です。提案や分析を手伝います。
担当: 株式会社PASSPORT・ROYAL FLASH 向けの提案、SNS運用の企画・施策案・簡易分析、営業メールや資料の下書き。
ふるまい: 提案は「課題→施策→期待効果→次アクション」の順でロジカルに。具体策と数値目標を入れる。
- 売上データが必要なときは get_shopify_sales ツールでShopifyから取得する
ルール: 事例・数字は確認した範囲で書き、未確認は明記する。`,
  },

  cs: {
    tools: [],
    system: `あなたはMagis株式会社のCS(カスタマーサポート)担当です。優しく丁寧な“お姉さん”のような対応役です。
担当:
- 顧客からの問い合わせ・クレームへの返信文づくり
- 顧客満足度を高める言い回しの提案
- (将来) Gmailの問い合わせ通知の要約、顧客データからのリピーター分析
ふるまい: あたたかく丁寧で落ち着いた口調。相手の気持ちに寄り添いつつ要点は明確に。
クレーム対応は「傾聴と謝意 → 事実確認 → 具体的な解決策」の順で組み立てる。`,
  },

  joho: {
    tools: [],
    system: `あなたはMagis株式会社の情報システム担当です。社内システムの導入・保守・ヘルプデスクを担います。
担当:
- 社内業務の効率化(ツール選定・自動化の提案)
- 既存システムの保守(自社開発のTime Recorder・在庫管理アプリ・この社内チームアプリ等の管理)
- 社内ヘルプデスク(社員のシステム/PC/アカウントの困りごと対応)
ふるまい: 専門用語は噛み砕いて説明。手順は番号付きで具体的に。「再現手順 → 原因の切り分け → 対処」の順で進める。`,
  },
};

// ---- ツール実行のディスパッチ ----------------------------------------
async function runTool(name, args) {
  try {
    if (name === "get_shopify_sales") return await getShopifySales(args);
    return { error: `未知のツール: ${name}` };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ---- Gemini 呼び出し --------------------------------------------------
async function callGemini({ system, contents, tools }) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
  };
  if (tools && tools.length) body.tools = [{ function_declarations: tools }];

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---- メインハンドラ --------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ対応" });

  // 簡易パスワード認証
  if (process.env.SITE_PASSWORD && req.headers["x-app-password"] !== process.env.SITE_PASSWORD) {
    return res.status(401).json({ error: "合言葉が違います" });
  }

  const { deptId, messages } = req.body || {};
  const dept = DEPARTMENTS[deptId] || DEPARTMENTS.hisho;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messagesが空です" });
  }

  try {
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    let answer = "";

    for (let i = 0; i < 5; i++) {
      const data = await callGemini({ system: dept.system, contents, tools: dept.tools });
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      const cand = data.candidates && data.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      const calls = parts.filter((p) => p.functionCall);

      if (calls.length) {
        contents.push({ role: "model", parts });
        const responseParts = [];
        for (const c of calls) {
          const result = await runTool(c.functionCall.name, c.functionCall.args || {});
          responseParts.push({ functionResponse: { name: c.functionCall.name, response: result } });
        }
        contents.push({ role: "user", parts: responseParts });
        continue;
      }

      answer = parts.filter((p) => p.text).map((p) => p.text).join("");
      break;
    }

    res.status(200).json({ answer: answer || "(応答が空でした)" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
