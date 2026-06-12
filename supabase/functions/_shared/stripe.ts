// stripe@17 を使用（v18以降は API バージョンの変更で subscription オブジェクトの
// 形が変わるため、上げる場合は stripe-webhook の periodEndOf も確認すること）。
import Stripe from "npm:stripe@17";

export { Stripe };

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  // Deno (Edge Functions) では fetch ベースの HTTP クライアントを使う
  httpClient: Stripe.createFetchHttpClient(),
});

// 環境変数で渡される Price ID とプラン/請求間隔の対応
export const PRICE_IDS: Record<"standard" | "premium", Record<"monthly" | "yearly", string | undefined>> = {
  standard: {
    monthly: Deno.env.get("STRIPE_PRICE_STANDARD_MONTHLY"),
    yearly: Deno.env.get("STRIPE_PRICE_STANDARD_YEARLY"),
  },
  premium: {
    monthly: Deno.env.get("STRIPE_PRICE_PREMIUM_MONTHLY"),
    yearly: Deno.env.get("STRIPE_PRICE_PREMIUM_YEARLY"),
  },
};

// Price ID からプラン名を逆引きする（webhook で契約内容を判定するため）
export function planFromPrice(priceId: string | undefined): "standard" | "premium" | null {
  if (!priceId) return null;
  for (const plan of ["standard", "premium"] as const) {
    if (priceId === PRICE_IDS[plan].monthly || priceId === PRICE_IDS[plan].yearly) return plan;
  }
  return null;
}
