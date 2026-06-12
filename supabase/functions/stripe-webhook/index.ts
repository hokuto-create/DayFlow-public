// Stripe webhook。署名検証のうえ、契約イベントを subscriptions テーブルに反映する。
// 対応イベント: checkout.session.completed / customer.subscription.updated /
//               customer.subscription.deleted
//
// ※ Stripe からの呼び出しには Supabase の JWT が付かないため、
//    `supabase functions deploy stripe-webhook --no-verify-jwt` でデプロイすること。
import { adminClient } from "../_shared/auth.ts";
import { planFromPrice, stripe, Stripe } from "../_shared/stripe.ts";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

// Stripe API バージョンによって current_period_end が subscription 直下から
// items 側へ移動しているため、両方を見る。
function periodEndOf(sub: Stripe.Subscription): string | null {
  // deno-lint-ignore no-explicit-any
  const s = sub as any;
  const sec = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return typeof sec === "number" ? new Date(sec * 1000).toISOString() : null;
}

async function upsertSubscription(sub: Stripe.Subscription, knownUserId?: string | null) {
  const admin = adminClient();
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  // ユーザーの特定: Checkout 作成時に metadata へ入れた user_id を最優先し、
  // 無ければ既存行の stripe_customer_id から逆引きする。
  let userId = knownUserId || sub.metadata?.user_id || null;
  if (!userId) {
    const { data } = await admin
      .from("subscriptions")
      .select("user_id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    userId = data?.user_id ?? null;
  }
  if (!userId) {
    // 紐付け不能なイベントは再送されても解決しないため、ログだけ残して 200 を返す
    console.error("user_id not found for subscription", sub.id, customerId);
    return;
  }

  const plan = planFromPrice(sub.items?.data?.[0]?.price?.id);
  const record: Record<string, unknown> = {
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    status: sub.status, // active / trialing / past_due / canceled など Stripe の値をそのまま保存
    current_period_end: periodEndOf(sub),
    updated_at: new Date().toISOString(),
  };
  // Price ID が env と一致しない（テスト用 Price 等）の場合は既存の plan を保持する
  if (plan) record.plan = plan;

  const { error } = await admin.from("subscriptions").upsert(record, { onConflict: "user_id" });
  if (error) throw new Error(`subscriptions upsert failed: ${error.message}`);
}

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature ?? "",
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
      undefined,
      cryptoProvider,
    );
  } catch (e) {
    console.error("webhook signature verification failed", e);
    return new Response("invalid signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.subscription) {
          const subId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          await upsertSubscription(sub, session.client_reference_id || session.metadata?.user_id);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        // deleted のときも status が "canceled" になった subscription が届くので同じ処理でよい
        await upsertSubscription(event.data.object as Stripe.Subscription);
        break;
      default:
        break; // 購読していないイベントは無視
    }
  } catch (e) {
    console.error("webhook handling failed", event.type, e);
    return new Response("handler error", { status: 500 }); // 500 を返すと Stripe が再送する
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
