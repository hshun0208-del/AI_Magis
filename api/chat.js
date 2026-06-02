// Magis 社内チーム — バックエンド (Vercel Serverless Function) / Google Gemini版
// 秘密情報はすべてサーバー側のみに保持。依存ライブラリなし(Node 18+ の fetch)。
//
// 必要な環境変数 (Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY  = AIza...
//   GEMINI_MODEL    = (任意) 既定 gemini-2.5-flash
//   USERS           = ログイン。JSON文字列 {"名前":"パスワード", ...}
//   SITE_PASSWORD   = (任意) USERS未設定時の共通合言葉（移行用）
//   SHOPIFY_STORE / SHOPIFY_TOKEN = Shopify連携する場合
//   NOTION_TOKEN    = secret_...   (Notion連携する場合)
//   NOTION_DB_ID    = 会社マスターデータDBのID(32文字)
//   NOTION_KEY_PROP = (任意) 項目名カラム名。既定「項目」(title型)
//   NOTION_VAL_PROP = (任意) 値カラム名。既定「値」(rich_text型)

const SHOPIFY_API_VERSION = "2024-10";
const NOTION_VERSION = "2022-06-28";
const NOTION_KEY_PROP = process.env.NOTION_KEY_PROP || "項目";
const NOTION_VAL_PROP = process.env.NOTION_VAL_PROP || "値";

// 全部署に共通で効く「ハルシネーション防止」ルール
const COMMON_RULES = `
【共通ルール・最重要】
- マスターデータや確認済みの事実に無い情報（法人番号・登記情報・未取得の数値や固有名詞など）は推測で答えない。
- 分からない場合は「登録情報にないため分かりません」と正直に答える。数字・名称・日付を創作しない。
- 実際には行っていない情報源（「データベースから取得した」等）を主張しない。`;

// ===== Shopify =========================================================
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
    `?status=any&limit=250&created_at_min=${start_date}T00:00:00&created_at_max=${end_date}T23:59:59` +
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

// ===== Notion（会社マスターデータの読み書き）===========================
const NOTION_GET_TOOL = {
  name: "get_company_info",
  description:
    "会社の重要情報（マスターデータ）をNotionから取得する。住所・代表者・取引銀行・取引先など『会社の◯◯は？』に答えるときに必ず使う。",
};
const NOTION_UPDATE_TOOL = {
  name: "update_company_info",
  description:
    "会社の重要情報をNotionに保存/更新する。『住所を〇〇に変更して』『取引先に△△を追加』など会社情報の変更指示があったときに使う。既存項目は上書き、無ければ新規作成。",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "項目名（例: 代表者住所, 納税地, 取引銀行, 主な取引先）" },
      value: { type: "string", description: "新しい値（全文）" },
    },
    required: ["key", "value"],
  },
};

async function notionFetch(path, method, body) {
  const r = await fetch("https://api.notion.com/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.NOTION_TOKEN,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.json();
}
function notionPlain(prop) {
  if (!prop) return "";
  if (prop.title) return prop.title.map((t) => t.plain_text).join("");
  if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join("");
  return "";
}
async function getCompanyInfo() {
  const db = process.env.NOTION_DB_ID;
  if (!process.env.NOTION_TOKEN || !db) return { error: "Notionの環境変数が未設定です" };
  const data = await notionFetch(`/databases/${db}/query`, "POST", { page_size: 100 });
  if (data.object === "error") return { error: data.message };
  const items = (data.results || [])
    .map((pg) => ({ key: notionPlain(pg.properties[NOTION_KEY_PROP]), value: notionPlain(pg.properties[NOTION_VAL_PROP]) }))
    .filter((x) => x.key);
  return { items };
}
async function updateCompanyInfo({ key, value }) {
  const db = process.env.NOTION_DB_ID;
  if (!process.env.NOTION_TOKEN || !db) return { error: "Notionの環境変数が未設定です" };
  const q = await notionFetch(`/databases/${db}/query`, "POST", {
    filter: { property: NOTION_KEY_PROP, title: { equals: key } },
    page_size: 1,
  });
  if (q.object === "error") return { error: q.message };
  const valProps = { [NOTION_VAL_PROP]: { rich_text: [{ text: { content: String(value) } }] } };
  if (q.results && q.results.length) {
    const upd = await notionFetch(`/pages/${q.results[0].id}`, "PATCH", { properties: valProps });
    if (upd.object === "error") return { error: upd.message };
    return { updated: true, key, value };
  }
  const created = await notionFetch(`/pages`, "POST", {
    parent: { database_id: db },
    properties: { [NOTION_KEY_PROP]: { title: [{ text: { content: key } }] }, ...valProps },
  });
  if (created.object === "error") return { error: created.message };
  return { created: true, key, value };
}

// ===== 部署ごとの人格とツール ==========================================
const DEPARTMENTS = {
  hisho: {
    tools: [],
    system: `あなたはMagis株式会社の秘書です。代表サポート(Shuntaro)や社内を補佐します。
担当: スケジュール調整、メール/チャットの下書き、リマインド整理、議事録、タスクの優先順位付け。
ふるまい: 結論から、テンポよく、敬語で簡潔に。不明点は推測せず確認する。日付は曜日も添える(例:6/3(火))。`,
  },

  soumu: {
    tools: [NOTION_GET_TOOL, NOTION_UPDATE_TOOL],
    system: `あなたはMagis株式会社の総務部です。社内の“なんでも屋”として会社全般を把握している頼れる窓口役で、会社の重要情報(マスターデータ)の管理者です。
担当: 社内規程・備品・庶務、各種手続きの案内、会社マスターデータ(商号・代表者・住所・納税地・取引銀行・取引先など)の参照と更新。
重要:
- 会社情報を聞かれたら、記憶や推測ではなく必ず get_company_info ツールでNotionから最新を取得して答える。
- 「住所を変更して」「取引先を追加して」など変更指示があれば update_company_info ツールでNotionに保存する。保存後は変更内容を復唱して確認する。
- ツールで見つからない項目は「登録情報にないため分かりません」と答える。
ふるまい: 親切で頼れる窓口。専門領域(経理/法務/労務等)は担当部署へ案内する。`,
  },

  keiri: {
    tools: [SHOPIFY_SALES_TOOL, NOTION_GET_TOOL],
    system: `あなたはMagis株式会社の経理担当です。請求書・売上表・入金まわりを扱います。
前提知識:
- 品目名は原則「SNSコンサル費」
- 全金額は税込。税抜は ÷1.1 で逆算し、税抜・消費税(10%)・税込を必ず明示する
- 請求書番号は INV-YYYYMMDD 形式
- 発行名義は案件により「Grove」(屋号) か「Magis株式会社」を使い分ける
- 振込先・会社住所など会社情報が必要なときは get_company_info ツールでNotionから取得する
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
- 法律相談: 論点を整理して一般的な見解を示す
- 契約法務: 契約書のドラフト作成、先方フォーマットのリスク確認、法的書類の作成サポート
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
担当: 顧客からの問い合わせ・クレームへの返信文づくり、顧客満足度を高める言い回しの提案。
ふるまい: あたたかく丁寧で落ち着いた口調。相手の気持ちに寄り添いつつ要点は明確に。
クレーム対応は「傾聴と謝意 → 事実確認 → 具体的な解決策」の順で組み立てる。`,
  },

  joho: {
    tools: [],
    system: `あなたはMagis株式会社の情報システム担当です。社内システムの導入・保守・ヘルプデスクを担います。
担当: 社内業務の効率化(ツール選定・自動化の提案)、既存システムの保守(Time Recorder・在庫管理アプリ・この社内チームアプリ等)、社内ヘルプデスク。
ふるまい: 専門用語は噛み砕いて説明。手順は番号付きで具体的に。「再現手順 → 原因の切り分け → 対処」の順で進める。`,
  },
};

// ===== ツール実行のディスパッチ ========================================
async function runTool(name, args) {
  try {
    if (name === "get_shopify_sales") return await getShopifySales(args);
    if (name === "get_company_info") return await getCompanyInfo();
    if (name === "update_company_info") return await updateCompanyInfo(args);
    return { error: `未知のツール: ${name}` };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ===== ログイン確認 ====================================================
function checkAuth(user, password) {
  const usersJson = process.env.USERS;
  if (usersJson) {
    try {
      const users = JSON.parse(usersJson);
      return Boolean(users[user]) && users[user] === password;
    } catch (e) {
      return false;
    }
  }
  if (process.env.SITE_PASSWORD) return password === process.env.SITE_PASSWORD;
  return true;
}

// ===== Gemini 呼び出し =================================================
async function callGemini({ system, contents, tools }) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: system + "\n" + COMMON_RULES }] },
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

// ===== メインハンドラ ==================================================
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ対応" });

  const user = req.headers["x-app-user"] || "";
  const password = req.headers["x-app-password"] || "";
  if (!checkAuth(user, password)) {
    return res.status(401).json({ error: "名前または合言葉が違います" });
  }

  if (req.body && req.body.check) {
    return res.status(200).json({ ok: true, user });
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
