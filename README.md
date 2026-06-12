# DayFlow

学習計画・間隔反復・振り返りを1つにまとめた、ビルド不要のシングルファイル学習プランナーPWAです（`index.html` のみで動作）。

## プラン構成

| プラン | 価格 | 解放される機能 |
|---|---|---|
| 無料 | ¥0 | 全機能をローカル（端末内）のみで利用、定番教材テンプレート |
| スタンダード | ¥600/月・¥6,000/年 | クラウド同期（マルチデバイス）、学習統計 |
| プレミアム | ¥1,000/月・¥10,000/年 | スタンダードの全機能＋AI目次取り込み |

- 未課金でもログイン（認証）自体は可能ですが、同期は行われません。**ローカルデータは課金状態に関係なく失われません**（解約・期限切れ後も localStorage のデータをそのまま使えます）。
- プランの判定はサーバー側（`subscriptions` テーブルの `status` / `current_period_end`）が正です。クライアントのゲートはUX目的で、Edge Function 側でも再検証します（直叩きは 403）。

## セットアップ

### 1. Supabase（基本）

1. [Supabase](https://supabase.com) でプロジェクトを作成
2. SQL Editor に `supabase_setup.sql` の内容を貼り付けて実行
   - `dayflow_data` テーブルの作成、RLS有効化、「各ユーザーは自分のデータのみ読み書き可能」のポリシー設定が行われます
3. 続けて `supabase_billing_setup.sql` を実行
   - `subscriptions`（本人のみSELECT可・書き込みはservice roleのみ）、`ai_usage`（日次利用回数）、`increment_ai_usage` 関数が作成されます
4. Authentication > Sign In / Providers で **Email** を有効化
   - ログインはメールに届く6桁のOTPコードで行います（パスワード不要）
   - 不特定多数に公開する場合は、独自SMTPの設定を強く推奨します（Supabase標準のメール送信は時間あたりの送信数制限が厳しいため）
5. `index.html` 内の `SUPA_URL` / `SUPA_KEY` を自分のプロジェクトの Project URL / anon key に書き換え

### 2. Stripe（課金）

1. [Stripe](https://stripe.com) でアカウントを作成（まずはテストモードで）
2. **Product と Price を作成**（ダッシュボード > 商品カタログ）
   - 商品「DayFlow スタンダード」: 定期 ¥600/月 と 定期 ¥6,000/年 の2つの Price
   - 商品「DayFlow プレミアム」: 定期 ¥1,000/月 と 定期 ¥10,000/年 の2つの Price
   - 4つの Price ID（`price_...`）を控え、`.env` の `STRIPE_PRICE_*` に設定
3. **Customer Portal を有効化**（設定 > Billing > カスタマーポータル）
   - 「プランの変更」「サブスクリプションのキャンセル」「支払い方法の更新」を許可
   - プラン変更を許可する商品に上記4つの Price を追加
4. **Webhook を登録**（開発者 > Webhook > エンドポイントを追加）
   - エンドポイントURL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
   - 購読イベント: `checkout.session.completed` / `customer.subscription.updated` / `customer.subscription.deleted`
   - 発行された署名シークレット（`whsec_...`）を `.env` の `STRIPE_WEBHOOK_SECRET` に設定

### 3. Edge Functions のデプロイ

```sh
# Supabase CLI でログイン・プロジェクトをリンク
supabase login
supabase link --project-ref <project-ref>

# secrets を設定（.env.example をコピーして値を埋める）
cp .env.example .env   # ← .env はコミットしない
supabase secrets set --env-file .env

# 関数をデプロイ
supabase functions deploy create-checkout-session
supabase functions deploy create-portal-session
supabase functions deploy ai-toc-import
# webhook は Stripe からの呼び出しに Supabase の JWT が付かないため --no-verify-jwt 必須
supabase functions deploy stripe-webhook --no-verify-jwt
```

必要な secrets の一覧は `.env.example` を参照してください
（`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_*` ×4 / `ANTHROPIC_API_KEY` / `AI_TOC_MODEL` / `AI_DAILY_LIMIT` / `ALLOWED_ORIGIN`）。

### 4. Anthropic（AI目次取り込み）

1. [Claude Console](https://console.anthropic.com) で API キーを作成し、`ANTHROPIC_API_KEY` に設定
2. モデルは既定で `claude-opus-4-8`（精度優先）。コストを抑えたい場合のみ `AI_TOC_MODEL=claude-haiku-4-5`（$1/$5 per MTok）に切り替え可能
3. 乱用対策として1ユーザーあたり日次 `AI_DAILY_LIMIT` 回（既定20回）まで実行できます

APIキーはすべて Supabase の secrets（サーバー側）のみに保存され、クライアントには一切露出しません。

### 5. デプロイ

静的ファイルのみなので、GitHub Pages・Netlify・Vercel など任意の静的ホスティングに `index.html` と `icon.png.PNG`、`templates/` を配置するだけで動きます。

本番では `.env` の `ALLOWED_ORIGIN` をアプリのオリジン（例: `https://your-app.example.com`）に絞ることを推奨します（CORS と Checkout 戻り先URLの制限に使われます）。

## 動作確認（テストモード）

1. アプリにメールOTPでログイン → 設定の「プランを見る」からスタンダードを選択
2. Stripe のテストカード `4242 4242 4242 4242` で Checkout を完了
3. アプリに戻ると数秒で webhook が `subscriptions` に反映され、クラウド同期が有効化される
4. プレミアムに加入すると、科目画面の「📷 目次を撮って取り込む」が使えるようになる
   （目次写真 → プレビューで編集 → 取り込み。登録された問題は既存の間隔反復でそのまま動きます）
5. 解約は設定の「プランを管理」（Customer Portal）から。期間満了後は同期とAIが無効化されますが、ローカルデータは無傷です

## クラウド同期の仕組み

- 設定画面からメールアドレスでログイン（OTP認証）し、スタンダード以上のプランに加入していると、データがSupabaseに自動同期されます（3秒デバウンス）
- データはログインユーザー本人のみが読み書きできます（Row Level Security で保護）
- ログインしない場合・未課金の場合は端末内（localStorage）のみで動作します

## AI目次取り込みの仕組み（プレミアム）

1. クライアントが目次写真を長辺約1568pxに縮小・JPEG圧縮し、base64 で Edge Function `ai-toc-import` に送信
2. Edge Function が JWT を検証 → `subscriptions` でプレミアムを再確認 → 日次回数を `ai_usage` でカウント
3. Claude API（構造化出力）で「書名＋章→問題リスト」のJSONを生成して返却
4. クライアントはプレビュー画面で編集・削除したうえで、テンプレート取り込みと同じ処理で教材＋問題として登録
