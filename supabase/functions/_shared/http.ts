// CORS とレスポンス整形の共通ヘルパー。
// ALLOWED_ORIGIN secret を設定するとそのオリジンのみ許可（未設定は "*"）。
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

export const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Checkout / Customer Portal の戻り先URL。http(s) のみ許可し、
// ALLOWED_ORIGIN を絞っている場合はそのオリジン以外を拒否する
// （クライアントから渡される値なのでオープンリダイレクト対策）。
export function sanitizeReturnUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (ALLOWED_ORIGIN !== "*" && url.origin !== ALLOWED_ORIGIN) return null;
  return url.origin + url.pathname;
}
