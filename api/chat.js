
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
//   NOTION_DB_ID    = 会社マスターデータ(会社概要)DBのID
//   NOTION_KEY_PROP / NOTION_VAL_PROP = (任意) 会社概要DBの列名。既定「項目」「値」
//   NOTION_DBS      = その他の業務DB。JSON文字列 {"DB名":"DBのID", ...}
//                     例: {"取引先":"id1","商品":"id2","契約":"id3","従業員":"id4","売上注文":"id5"}
 
const SHOPIFY_API_VERSION = "2024-10";
const NOTION_VERSION = "2022-06-28";
const NOTION_KEY_PROP = process.env.NOTION_KEY_PROP || "項目";
const NOTION_VAL_PROP = process.env.NOTION_VAL_PROP || "値";
 
const COMMON_RULES = `
【共通ルール・最重要】
- マスターデータや確認済みの事実に無い情報（法人番号・登記情報・未取得の数値や固有名詞など）は推測で答えない。
- 分からない場合は「登録情報にないため分かりません」と正直に答える。数字・名称・日付を創作しない。
- 実際には行っていない情報源を主張しない。
- Notionへの書き込み（追加・更新）は、実行する前に必ず内容をユーザーに復唱して確認を取ってから実行する。誤った上書きを避ける。`;
 
// ===== Shopify =========================================================
const SHOPIFY_SALES_TOOL = {
  name: "get_shopify_sales",
  description: "Shopifyストアの売上を取得する。指定期間の注文を集計し、合計売上額と注文件数を返す。",
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
  const store = process.env.SHOPIFY_STORE, token = process.env.SHOPIFY_TOKEN;
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
  const out = { period: `${start_date} 〜 ${end_date}`, order_count: orders.length, total_sales: Math.round(total), currency: orders[0]?.currency || "JPY" };
  if (orders.length >= 250) out.note = "件数が250に達したため一部のみ集計(ページング未対応)";
  return out;
}
 
// ===== Notion 共通 =====================================================
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
function dbId(name) {
  try { return (JSON.parse(process.env.NOTION_DBS || "{}"))[name] || null; }
  catch (e) { return null; }
}
async function getSchema(id) {
  const data = await notionFetch(`/databases/${id}`, "GET");
  if (data.object === "error") return null;
  return data.properties || {};
}
// Notionの1プロパティ → 読みやすい値
function readProp(p) {
  if (!p) return "";
  switch (p.type) {
    case "title": return (p.title || []).map((t) => t.plain_text).join("");
    case "rich_text": return (p.rich_text || []).map((t) => t.plain_text).join("");
    case "number": return p.number;
    case "select": return p.select ? p.select.name : "";
    case "status": return p.status ? p.status.name : "";
    case "multi_select": return (p.multi_select || []).map((s) => s.name).join(", ");
    case "date": return p.date ? p.date.start : "";
    case "checkbox": return p.checkbox;
    case "email": return p.email || "";
    case "phone_number": return p.phone_number || "";
    case "url": return p.url || "";
    case "formula": return p.formula ? (p.formula.string ?? p.formula.number ?? "") : "";
    case "people": return (p.people || []).map((x) => x.name || "").join(", ");
    case "relation": return `${(p.relation || []).length}件の関連`;
    default: return "";
  }
}
// 入力値 → Notionプロパティ形式（列の型に合わせて変換）
function coerceProp(def, value) {
  switch (def.type) {
    case "title": return { title: [{ text: { content: String(value) } }] };
    case "rich_text": return { rich_text: [{ text: { content: String(value) } }] };
    case "number": return { number: value === "" || value == null ? null : Number(value) };
    case "select": return { select: value ? { name: String(value) } : null };
    case "status": return { status: value ? { name: String(value) } : null };
    case "multi_select": {
      const arr = Array.isArray(value) ? value : String(value).split(/[,、]/).map((s) => s.trim()).filter(Boolean);
      return { multi_select: arr.map((name) => ({ name })) };
    }
    case "date": return { date: value ? { start: String(value) } : null };
    case "checkbox": return { checkbox: value === true || value === "true" || value === "はい" };
    case "email": return { email: String(value) };
    case "phone_number": return { phone_number: String(value) };
    case "url": return { url: String(value) };
    default: return null; // people/relation/files等は未対応
  }
}
function buildProps(schema, fields) {
  const props = {}, skipped = [];
  for (const [k, v] of Object.entries(fields || {})) {
    const def = schema[k];
    if (!def) { skipped.push(`${k}(列なし)`); continue; }
    const built = coerceProp(def, v);
    if (built === null) { skipped.push(`${k}(${def.type}は未対応)`); continue; }
    props[k] = built;
  }
  return { props, skipped };
}
function titlePropName(schema) {
  return Object.keys(schema).find((k) => schema[k].type === "title");
}
 
// ----- 会社概要(マスターデータ) 専用：項目/値の単純DB -----
const NOTION_GET_TOOL = {
  name: "get_company_info",
  description: "会社の基本情報(マスターデータ)をNotionから取得する。会社名・代表者・住所・取引銀行など『会社の◯◯は？』に必ず使う。",
};
const NOTION_UPDATE_TOOL = {
  name: "update_company_info",
  description: "会社の基本情報をNotionに保存/更新する。『住所を〇〇に変更して』など会社情報の変更指示で使う。",
  parameters: {
    type: "object",
    properties: { key: { type: "string", description: "項目名(例: 代表者, 納税地)" }, value: { type: "string", description: "新しい値" } },
    required: ["key", "value"],
  },
};
async function getCompanyInfo() {
  const db = process.env.NOTION_DB_ID;
  if (!process.env.NOTION_TOKEN || !db) return { error: "Notionの環境変数が未設定です" };
  const data = await notionFetch(`/databases/${db}/query`, "POST", { page_size: 100 });
  if (data.object === "error") return { error: data.message };
  const items = (data.results || [])
    .map((pg) => ({ key: readProp(pg.properties[NOTION_KEY_PROP]), value: readProp(pg.properties[NOTION_VAL_PROP]) }))
    .filter((x) => x.key);
  return { items };
}
async function updateCompanyInfo({ key, value }) {
  const db = process.env.NOTION_DB_ID;
  if (!process.env.NOTION_TOKEN || !db) return { error: "Notionの環境変数が未設定です" };
  const q = await notionFetch(`/databases/${db}/query`, "POST", { filter: { property: NOTION_KEY_PROP, title: { equals: key } }, page_size: 1 });
  if (q.object === "error") return { error: q.message };
  const valProps = { [NOTION_VAL_PROP]: { rich_text: [{ text: { content: String(value) } }] } };
  if (q.results && q.results.length) {
    const upd = await notionFetch(`/pages/${q.results[0].id}`, "PATCH", { properties: valProps });
    if (upd.object === "error") return { error: upd.message };
    return { updated: true, key, value };
  }
  const created = await notionFetch(`/pages`, "POST", { parent: { database_id: db }, properties: { [NOTION_KEY_PROP]: { title: [{ text: { content: key } }] }, ...valProps } });
  if (created.object === "error") return { error: created.message };
  return { created: true, key, value };
}
 
// ----- 汎用：複数業務DB(取引先/商品/契約/従業員/売上 等)の読み書き -----
const DB_LIST_TOOL = {
  name: "list_databases",
  description: "参照・編集できる業務データベース(取引先・商品・契約・従業員・売上注文など)の一覧を返す。どのDBを見るべきか分からないとき最初に使う。",
};
const DB_QUERY_TOOL = {
  name: "query_database",
  description: "指定した業務DBの行データを読む。取引先や商品、従業員などを調べるときに使う。keywordを渡すと名称で絞り込む。",
  parameters: {
    type: "object",
    properties: {
      db_name: { type: "string", description: "list_databasesで得たDB名" },
      keyword: { type: "string", description: "タイトル列で絞り込む語(任意)" },
    },
    required: ["db_name"],
  },
};
const DB_CREATE_TOOL = {
  name: "create_record",
  description: "業務DBに新しい行(レコード)を追加する。実行前にユーザーへ内容確認すること。",
  parameters: {
    type: "object",
    properties: {
      db_name: { type: "string", description: "対象DB名" },
      fields_json: { type: "string", description: '列名→値のJSON文字列。例: {"取引先名":"〇〇株式会社","担当":"田中","電話":"03-..."}' },
    },
    required: ["db_name", "fields_json"],
  },
};
const DB_UPDATE_TOOL = {
  name: "update_record",
  description: "業務DBの既存の行を更新する。matchでタイトル列の値が一致する行を探して更新。実行前にユーザーへ内容確認すること。",
  parameters: {
    type: "object",
    properties: {
      db_name: { type: "string", description: "対象DB名" },
      match: { type: "string", description: "更新対象を特定するタイトル列の値" },
      fields_json: { type: "string", description: "更新する列名→値のJSON文字列" },
    },
    required: ["db_name", "match", "fields_json"],
  },
};
function listDatabases() {
  try { return { databases: Object.keys(JSON.parse(process.env.NOTION_DBS || "{}")) }; }
  catch (e) { return { error: "NOTION_DBSのJSONが壊れています" }; }
}
async function queryDatabase({ db_name, keyword }) {
  const id = dbId(db_name);
  if (!id) return { error: `DB「${db_name}」は未登録です。list_databasesで名称を確認してください` };
  const schema = await getSchema(id);
  if (!schema) return { error: "DBのスキーマ取得に失敗(コネクト接続を確認)" };
  const tProp = titlePropName(schema);
  const body = { page_size: 50 };
  if (keyword && tProp) body.filter = { property: tProp, title: { contains: keyword } };
  const data = await notionFetch(`/databases/${id}/query`, "POST", body);
  if (data.object === "error") return { error: data.message };
  const rows = (data.results || []).map((pg) => {
    const o = { _page_id: pg.id };
    for (const [k, v] of Object.entries(pg.properties)) o[k] = readProp(v);
    return o;
  });
  return { db: db_name, count: rows.length, rows };
}
 
// ----- ページ本文(ノート)の読み取り・追記 -----
const PAGE_GET_TOOL = {
  name: "get_page_content",
  description: "Notionページ(DBの各行)の本文テキストを読む。行に書かれた口座情報・メモ・経緯などを見るときに使う。page_idはquery_databaseの結果の_page_idを使う。",
  parameters: {
    type: "object",
    properties: { page_id: { type: "string", description: "対象ページのID(query_databaseの_page_id)" } },
    required: ["page_id"],
  },
};
const PAGE_APPEND_TOOL = {
  name: "append_page_content",
  description: "Notionページの本文末尾にテキストを追記する(既存は消さない)。口座情報やメモの追記に使う。実行前にユーザーへ内容確認すること。",
  parameters: {
    type: "object",
    properties: {
      page_id: { type: "string", description: "対象ページのID(query_databaseの_page_id)" },
      text: { type: "string", description: "追記する本文。改行で複数行可" },
    },
    required: ["page_id", "text"],
  },
};
// ブロック → テキスト（主要な型のみ）
function blockText(b) {
  const rich = (b[b.type] && b[b.type].rich_text) || [];
  const t = rich.map((r) => r.plain_text).join("");
  if (b.type === "to_do") return (b.to_do.checked ? "[x] " : "[ ] ") + t;
  if (b.type.startsWith("heading")) return "# " + t;
  if (b.type === "bulleted_list_item" || b.type === "numbered_list_item") return "・" + t;
  return t;
}
async function getPageContent({ page_id }) {
  if (!process.env.NOTION_TOKEN) return { error: "Notionの環境変数が未設定です" };
  const data = await notionFetch(`/blocks/${page_id}/children?page_size=100`, "GET");
  if (data.object === "error") return { error: data.message };
  const lines = (data.results || []).map(blockText).filter((s) => s !== "");
  return { page_id, content: lines.join("\n") || "(本文は空です)" };
}
async function appendPageContent({ page_id, text }) {
  if (!process.env.NOTION_TOKEN) return { error: "Notionの環境変数が未設定です" };
  const children = String(text).split("\n").map((line) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: line ? [{ text: { content: line } }] : [] },
  }));
  const r = await notionFetch(`/blocks/${page_id}/children`, "PATCH", { children });
  if (r.object === "error") return { error: r.message };
  return { appended: true, page_id, lines: children.length };
}
function parseFields(fields_json) {
  try { return { ok: JSON.parse(fields_json) }; }
  catch (e) { return { err: "fields_jsonがJSONとして読めません" }; }
}
async function createRecord({ db_name, fields_json }) {
  const id = dbId(db_name);
  if (!id) return { error: `DB「${db_name}」は未登録です` };
  const f = parseFields(fields_json); if (f.err) return { error: f.err };
  const schema = await getSchema(id);
  if (!schema) return { error: "DBのスキーマ取得に失敗" };
  const { props, skipped } = buildProps(schema, f.ok);
  const created = await notionFetch(`/pages`, "POST", { parent: { database_id: id }, properties: props });
  if (created.object === "error") return { error: created.message };
  return { created: true, db: db_name, skipped: skipped.length ? skipped : undefined };
}
async function updateRecord({ db_name, match, fields_json }) {
  const id = dbId(db_name);
  if (!id) return { error: `DB「${db_name}」は未登録です` };
  const f = parseFields(fields_json); if (f.err) return { error: f.err };
  const schema = await getSchema(id);
  if (!schema) return { error: "DBのスキーマ取得に失敗" };
  const tProp = titlePropName(schema);
  const q = await notionFetch(`/databases/${id}/query`, "POST", { filter: { property: tProp, title: { equals: match } }, page_size: 1 });
  if (q.object === "error") return { error: q.message };
  if (!q.results || !q.results.length) return { error: `「${match}」に一致する行が見つかりません` };
  const { props, skipped } = buildProps(schema, f.ok);
  const upd = await notionFetch(`/pages/${q.results[0].id}`, "PATCH", { properties: props });
  if (upd.object === "error") return { error: upd.message };
  return { updated: true, db: db_name, match, skipped: skipped.length ? skipped : undefined };
}
 
// 業務DB共通ツール一式
const DB_TOOLS = [DB_LIST_TOOL, DB_QUERY_TOOL, DB_CREATE_TOOL, DB_UPDATE_TOOL, PAGE_GET_TOOL, PAGE_APPEND_TOOL];
const DB_NOTE = `
業務データ(取引先・商品・契約・従業員・売上注文など)は list_databases で一覧を確認し、query_database で読む。追加は create_record、更新は update_record。
各行の本文(ノート: 口座情報・メモ・経緯など)は get_page_content で読み、append_page_content で末尾に追記できる(page_idは query_database 結果の _page_id を使う)。
書き込み(追加・更新・追記)の前は、内容をユーザーへ復唱して確認すること。`;
 
// ===== 部署ごとの人格とツール ==========================================
const DEPARTMENTS = {
  hisho: { tools: [], system: `あなたはMagis株式会社の秘書です。代表サポート(Shuntaro)や社内を補佐します。
担当: スケジュール調整、メール/チャットの下書き、リマインド整理、議事録、タスクの優先順位付け。
ふるまい: 結論から、テンポよく、敬語で簡潔に。不明点は推測せず確認する。日付は曜日も添える(例:6/3(火))。` },
 
  soumu: { tools: [NOTION_GET_TOOL, NOTION_UPDATE_TOOL, ...DB_TOOLS], system: `あなたはMagis株式会社の総務部です。会社全般を把握する“なんでも屋”で、会社情報と各種データの管理者です。
重要:
- 会社の基本情報は get_company_info で取得、変更は update_company_info で保存する。
- その他の業務データは下記ツールで扱う。${DB_NOTE}
- ツールで見つからない項目は「登録情報にないため分かりません」と答える。
ふるまい: 親切で頼れる窓口。専門領域は担当部署へ案内する。` },
 
  keiri: { tools: [SHOPIFY_SALES_TOOL, NOTION_GET_TOOL, ...DB_TOOLS], system: `あなたはMagis株式会社の経理担当です。請求書・売上表・入金まわりを扱います。
前提知識:
- 品目名は原則「SNSコンサル費」。全金額は税込、税抜は÷1.1で逆算し税抜・消費税(10%)・税込を明示。
- 請求書番号は INV-YYYYMMDD。発行名義は案件により「Grove」か「Magis株式会社」。
- 会社の振込先・住所は get_company_info で取得。売上実数は get_shopify_sales で取得。${DB_NOTE}
ルール: 金額は必ず検算する。不確かな数値は確定前に質問する。` },
 
  roumu: { tools: [...DB_TOOLS], system: `あなたはMagis株式会社の人事労務担当です。人事(採用・入退社・評価・社員対応)と労務(勤怠・割増賃金・給与)を扱います。
前提知識(割増率): 時間外25%以上(月60h超は50%)、深夜(22-5時)25%以上、法定休日35%以上。勤怠は自社Time Recorder前提。
従業員データは下記ツールで参照・更新できる。${DB_NOTE}
ルール: 計算は途中式を見せて検算。法令の数値は要確認と添える。最終確認は社労士へ。` },
 
  houmu: { tools: [...DB_TOOLS], system: `あなたはMagis株式会社の法務担当です。法律相談・契約法務・紛争対応をサポートします。
担当: 契約書ドラフト作成、先方フォーマットのリスク確認、法的書類の作成サポート、論点整理。
契約データは下記ツールで参照・更新できる。${DB_NOTE}
ふるまい: 「結論→理由→リスク→推奨アクション」の順。条文・判例は要確認と明記。
重要: 回答は一般情報であり、最終判断・正式書面は必ず顧問弁護士の確認を得るよう毎回案内する。` },
 
  eigyo: { tools: [SHOPIFY_SALES_TOOL, ...DB_TOOLS], system: `あなたはMagis株式会社(屋号Grove)の営業・SNSコンサル担当です。
担当: PASSPORT・ROYAL FLASH向け提案、SNS運用の企画・施策・簡易分析、営業メールや資料の下書き。
取引先・売上などのデータは下記ツールで参照・更新できる。売上実数は get_shopify_sales。${DB_NOTE}
ふるまい: 提案は「課題→施策→期待効果→次アクション」で具体策と数値目標を入れる。` },
 
  cs: { tools: [], system: `あなたはMagis株式会社のCS(カスタマーサポート)担当です。優しく丁寧な“お姉さん”のような対応役です。
担当: 顧客からの問い合わせ・クレームへの返信文づくり、満足度を高める言い回しの提案。
ふるまい: あたたかく丁寧。「傾聴と謝意→事実確認→具体的な解決策」の順で組み立てる。` },
 
  joho: { tools: [], system: `あなたはMagis株式会社の情報システム担当です。社内システムの導入・保守・ヘルプデスクを担います。
担当: 効率化提案、自社アプリ(Time Recorder・在庫管理・この社内チームアプリ)の保守、社内ヘルプデスク。
ふるまい: 専門用語は噛み砕く。手順は番号付き。「再現手順→原因の切り分け→対処」の順で。` },
};
 
// ===== ツール実行のディスパッチ ========================================
async function runTool(name, args) {
  try {
    if (name === "get_shopify_sales") return await getShopifySales(args);
    if (name === "get_company_info") return await getCompanyInfo();
    if (name === "update_company_info") return await updateCompanyInfo(args);
    if (name === "list_databases") return listDatabases();
    if (name === "query_database") return await queryDatabase(args);
    if (name === "create_record") return await createRecord(args);
    if (name === "update_record") return await updateRecord(args);
    if (name === "get_page_content") return await getPageContent(args);
    if (name === "append_page_content") return await appendPageContent(args);
    return { error: `未知のツール: ${name}` };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
 
// ===== ログイン確認 ====================================================
function checkAuth(user, password) {
  const usersJson = process.env.USERS;
  if (usersJson) {
    try { const users = JSON.parse(usersJson); return Boolean(users[user]) && users[user] === password; }
    catch (e) { return false; }
  }
  if (process.env.SITE_PASSWORD) return password === process.env.SITE_PASSWORD;
  return true;
}
 
// ===== Gemini 呼び出し =================================================
async function callGemini({ system, contents, tools }) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = { system_instruction: { parts: [{ text: system + "\n" + COMMON_RULES }] }, contents };
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
  if (!checkAuth(user, password)) return res.status(401).json({ error: "名前または合言葉が違います" });
 
  if (req.body && req.body.check) return res.status(200).json({ ok: true, user });
 
  const { deptId, messages } = req.body || {};
  const dept = DEPARTMENTS[deptId] || DEPARTMENTS.hisho;
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messagesが空です" });
 
  try {
    const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    let answer = "";
 
    for (let i = 0; i < 6; i++) {
      const data = await callGemini({ system: dept.system, contents, tools: dept.tools });
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
 
      const cand = data.candidates && data.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      const calls = parts.filter((p) => p.functionCall);
      const text = parts.filter((p) => p.text).map((p) => p.text).join("");
      if (text) answer = text; // 最後に得たテキストを保持
 
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
      break;
    }
 
    res.status(200).json({ answer: answer || "(応答が空でした。もう一度お試しください)" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
