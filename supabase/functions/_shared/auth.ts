import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// service role クライアント（RLSをバイパスする。サーバー内でのみ使用）
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

// Authorization ヘッダーの JWT を検証してユーザーを返す（無効なら null）
export async function getUserFromRequest(req: Request): Promise<User | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const client = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export type PlanName = "free" | "standard" | "premium";

type SubscriptionRow = {
  plan: string;
  status: string;
  current_period_end: string | null;
} | null;

// subscriptions 行から現在有効なプランを判定する。
// クライアント側の resolvePlan と同じ規則（status と current_period_end を正とする）。
export function resolvePlan(row: SubscriptionRow): PlanName {
  if (!row) return "free";
  if (row.status !== "active" && row.status !== "trialing") return "free";
  if (row.current_period_end) {
    const end = new Date(row.current_period_end).getTime();
    // Stripe の更新webhookが遅延しても課金済みユーザーが弾かれないよう1日の猶予
    if (Number.isFinite(end) && end + 24 * 60 * 60 * 1000 < Date.now()) return "free";
  }
  return row.plan === "premium" ? "premium" : "standard";
}

// ユーザーの有効プランをDBから取得（Edge Function 側でのゲート再検証に使う）
export async function getPlan(userId: string): Promise<PlanName> {
  const { data, error } = await adminClient()
    .from("subscriptions")
    .select("plan,status,current_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("subscription lookup failed", error);
    return "free";
  }
  return resolvePlan(data as SubscriptionRow);
}
