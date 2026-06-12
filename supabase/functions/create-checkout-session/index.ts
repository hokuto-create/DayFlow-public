// ログイン済みユーザーの JWT を検証し、Stripe Checkout（subscription モード）の
// セッションを作成して URL を返す。
// 入力: { plan: "standard"|"premium", interval: "monthly"|"yearly", returnUrl: string }
import { corsHeaders, json, sanitizeReturnUrl } from "../_shared/http.ts";
import { adminClient, getUserFromRequest, resolvePlan } from "../_shared/auth.ts";
import { PRICE_IDS, stripe } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getUserFromRequest(req);
    if (!user) return json(401, { error: "ログインが必要です", code: "unauthenticated" });

    const body = await req.json().catch(() => ({}));
    const plan = body.plan as "standard" | "premium";
    const interval = body.interval as "monthly" | "yearly";
    const priceId = (plan === "standard" || plan === "premium") &&
        (interval === "monthly" || interval === "yearly")
      ? PRICE_IDS[plan][interval]
      : undefined;
    if (!priceId) return json(400, { error: "プランの指定が正しくありません" });

    const base = sanitizeReturnUrl(body.returnUrl);
    if (!base) return json(400, { error: "returnUrl が正しくありません" });

    // 既存の Stripe 顧客がいれば再利用する（解約→再加入で顧客が増殖しないように）
    const { data: existing } = await adminClient()
      .from("subscriptions")
      .select("stripe_customer_id, plan, status, current_period_end")
      .eq("user_id", user.id)
      .maybeSingle();

    // 既に有効な契約がある場合、Checkout で二重契約を作らせない
    // （プラン変更・解約は Customer Portal 側で行う）
    if (resolvePlan(existing) !== "free") {
      return json(409, {
        error: "すでに有効なプランがあります。変更は「プランを管理」から行ってください。",
        code: "already_subscribed",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      ...(existing?.stripe_customer_id
        ? { customer: existing.stripe_customer_id }
        : { customer_email: user.email ?? undefined }),
      // webhook 側でどのユーザーの契約かを特定するための紐付け
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id } },
      success_url: `${base}?checkout=success`,
      cancel_url: `${base}?checkout=cancel`,
    });

    return json(200, { url: session.url });
  } catch (e) {
    console.error("create-checkout-session failed", e);
    return json(500, { error: "決済ページを開けませんでした。時間をおいて再度お試しください。" });
  }
});
