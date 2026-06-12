// AI目次取り込み（プレミアム機能）。
// 目次ページの写真（base64 JPEG）を受け取り、Claude API の構造化出力で
// 「書名＋章→問題リスト」のJSONを生成して返す。
//
// セキュリティ:
// - JWT 検証 → subscriptions テーブルで premium をサーバー側で再検証
//   （クライアントのUIゲートは突破できる前提。直叩きは 403 になる）
// - ANTHROPIC_API_KEY は Supabase の secret のみに保持し、クライアントへは一切返さない
// - 日次の実行回数を ai_usage テーブルでカウントして制限（乱用対策）
import Anthropic from "npm:@anthropic-ai/sdk";
import { corsHeaders, json } from "../_shared/http.ts";
import { adminClient, getPlan, getUserFromRequest } from "../_shared/auth.ts";

// 精度優先のデフォルト。コスト優先なら secret AI_TOC_MODEL=claude-haiku-4-5 に切り替え。
const DEFAULT_MODEL = "claude-opus-4-8";
// クライアントは長辺~1568pxに縮小したJPEGを送るため、通常は数百KB。8MBは安全側の上限。
const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

// 構造化出力スキーマ: これに適合した valid JSON が返ることが保証される
const TOC_SCHEMA = {
  type: "object",
  properties: {
    bookTitle: { type: "string" },
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "items"],
        additionalProperties: false,
      },
    },
  },
  required: ["bookTitle", "chapters"],
  additionalProperties: false,
} as const;

const PROMPT = `この画像は参考書・問題集の「目次」ページの写真です。
目次から章タイトルと、各章に含まれる問題・例題番号の一覧を抽出してください。

ルール:
- 画像に写っている内容だけを抽出すること。画像に写っていない問題を推測で補完しないこと
- 問題番号が範囲表記の場合（例:「例題1〜34」）は1問ずつに展開すること（例題1, 例題2, …, 例題34）
- 各問題の text は「例題12」「問3-5」のように、種別＋番号がわかる短い表記にすること
- ページ番号は含めないこと
- 章タイトルは目次の表記のまま使うこと
- 書名が画像から読み取れない場合は bookTitle を空文字列にすること
- 目次以外の画像（表紙・本文など）で章構成が読み取れない場合は chapters を空配列にすること`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getUserFromRequest(req);
    if (!user) return json(401, { error: "ログインが必要です", code: "unauthenticated" });

    // プランのサーバー側再検証（UIゲートとは独立）
    const plan = await getPlan(user.id);
    if (plan !== "premium") {
      return json(403, { error: "AI目次取り込みはプレミアムプランの機能です", code: "premium_required" });
    }

    // 入力の検証（不正リクエストで利用回数を消費させないため、回数カウントより先に行う）
    const body = await req.json().catch(() => null);
    const image = body?.image;
    const mediaType = body?.mediaType || "image/jpeg";
    if (typeof image !== "string" || image.length === 0) {
      return json(400, { error: "画像データがありません" });
    }
    if (image.length > MAX_IMAGE_BASE64_LENGTH) {
      return json(413, { error: "画像が大きすぎます。撮り直してください。" });
    }
    if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
      return json(400, { error: "対応していない画像形式です" });
    }

    // 日次の実行回数制限（+1して上限以内かを原子的に判定）
    const limit = Number(Deno.env.get("AI_DAILY_LIMIT") || "20");
    const { data: withinLimit, error: usageError } = await adminClient()
      .rpc("increment_ai_usage", { p_user_id: user.id, p_limit: limit });
    if (usageError) {
      console.error("increment_ai_usage failed", usageError);
      return json(500, { error: "利用状況の確認に失敗しました。時間をおいて再度お試しください。" });
    }
    if (!withinLimit) {
      return json(429, {
        error: `本日の利用上限（${limit}回）に達しました。明日また利用できます。`,
        code: "rate_limited",
      });
    }

    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
    const response = await anthropic.messages.create({
      model: Deno.env.get("AI_TOC_MODEL") || DEFAULT_MODEL,
      max_tokens: 16000,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: image },
          },
          { type: "text", text: PROMPT },
        ],
      }],
      // 構造化出力: TOC_SCHEMA に適合した valid JSON が text ブロックで返る
      // deno-lint-ignore no-explicit-any
      output_config: { format: { type: "json_schema", schema: TOC_SCHEMA } } as any,
    });

    if (response.stop_reason === "refusal") {
      return json(422, {
        error: "この画像は解析できませんでした。書籍の目次ページを撮影してください。",
        code: "refusal",
      });
    }
    if (response.stop_reason === "max_tokens") {
      return json(422, {
        error: "目次が長すぎて最後まで解析できませんでした。ページを分けて撮影してください。",
        code: "max_tokens",
      });
    }

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") {
        text = block.text;
        break;
      }
    }
    if (!text) {
      return json(502, { error: "解析結果を取得できませんでした。もう一度お試しください。" });
    }
    return json(200, { result: JSON.parse(text) });
  } catch (e) {
    console.error("ai-toc-import failed", e);
    return json(500, { error: "解析に失敗しました。時間をおいて再度お試しください。" });
  }
});
