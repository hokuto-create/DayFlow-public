// 解約・支払い方法変更用の Stripe Customer Portal セッションを作成して URL を返す。
// 入力: { returnUrl: string }
import { corsHeaders, json, sanitizeReturnUrl } from "../_shared/http.ts";
import { adminClient, getUserFromRequest } from "../_shared/auth.ts";
import { stripe } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getUserFromRequest(req);
    if (!user) return json(401, { error: "ログインが必要です", code: "unauthenticated" });

    const body = await req.json().catch(() => ({}));
    const base = sanitizeReturnUrl(body.returnUrl);
    if (!base) return json(400, { error: "returnUrl が正しくありません" });

    const { data: row } = await adminClient()
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!row?.stripe_customer_id) {
      return json(404, { error: "契約情報が見つかりません", code: "no_subscription" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: base,
    });
    return json(200, { url: session.url });
  } catch (e) {
    console.error("create-portal-session failed", e);
    return json(500, { error: "管理ページを開けませんでした。時間をおいて再度お試しください。" });
  }
});
