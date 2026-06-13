# DayFlow 課金システム 本番公開ガイド（ゼロ→公開）

このガイドは、DayFlow の課金（Stripe サブスクリプション）＋クラウド同期＋AI目次取り込みを、
**まったくのゼロから本番公開するまで**を、画面操作レベルで順番に説明します。

- 所要時間の目安: **1〜1.5 時間**（待ち時間込み）
- README の「セットアップ」を、実際の作業順に並べ直して具体化したものです。迷ったら README とこのガイドを併用してください。
- まずは **Stripe テストモード**で一通り通し、最後に本番モードへ切り替えるのが安全です（手順 9）。

---

## 0. 全体の流れ

```
[A] アカウント作成        Supabase / Stripe / Anthropic の3つ
        │
[B] Supabase 基盤         SQL 2本実行 → Email(OTP)有効化 → index.html に URL/キー
        │
[C] Stripe 課金           Price 4つ作成 → Customer Portal → Webhook 登録
        │
[D] Anthropic             API キー発行
        │
[E] Edge Functions        secrets 設定 → 関数4つをデプロイ
        │
[F] アプリ公開            静的ホスティングに配置 → ALLOWED_ORIGIN を本番オリジンに
        │
[G] 動作確認              テストカード 4242… で課金 → 同期/AI を確認
        │
[H] 本番化               Stripe を本番モードに切替（live キー＋webhook 再登録）
```

### 用意するもの

| 必要なもの | 取得先 | 用途 |
|---|---|---|
| Supabase アカウント | https://supabase.com | DB・認証・Edge Functions |
| Stripe アカウント | https://stripe.com | 決済・サブスク管理 |
| Anthropic アカウント | https://console.anthropic.com | AI目次取り込み（プレミアム機能） |
| Supabase CLI | `npm i -g supabase` 等 | Edge Functions のデプロイ |
| 静的ホスティング | GitHub Pages / Netlify / Vercel など | `index.html` の公開 |
| 独自SMTP（推奨） | SendGrid / Resend / Amazon SES 等 | OTP メールの送信（公開時はほぼ必須） |

> プラン構成（参考）
> | プラン | 価格 | 解放される機能 |
> |---|---|---|
> | 無料 | ¥0 | 全機能をローカルのみ利用、定番教材テンプレート |
> | スタンダード | ¥600/月・¥6,000/年 | クラウド同期、学習統計 |
> | プレミアム | ¥1,000/月・¥10,000/年 | スタンダード＋AI目次取り込み |

---

## 1. Supabase プロジェクトを作成

1. https://supabase.com にサインアップ／ログイン。
2. ダッシュボードで **New project** をクリック。
   - **Name**: 任意（例: `dayflow`）
   - **Database Password**: 強いパスワードを生成して**控える**（後で使う場面は少ないが紛失注意）。
   - **Region**: 利用者に近いリージョン（日本なら `Northeast Asia (Tokyo)`）。
3. **Create new project** を押し、プロビジョニング完了まで1〜2分待つ。
4. 後で使う2つの値をメモしておく（**Project Settings → API**）:
   - **Project URL**（`https://<project-ref>.supabase.co`）
   - **anon public** キー（`eyJ...` で始まる JWT）
   - `<project-ref>` は URL のサブドメイン部分（例: `wiutmzxnletohxaccgdk`）。Webhook URL でも使います。

---

## 2. データベースをセットアップ（SQL 2本）

SQL は**順番が重要**です。基盤 → 課金 の順で実行します。

1. 左メニュー **SQL Editor** → **New query**。
2. リポジトリの **`supabase_setup.sql`** の中身を**全文コピペ**して **Run**。
   - `dayflow_data` テーブル作成、RLS 有効化、「各ユーザーは自分の行だけ読み書き可」のポリシーが作られます。
3. 続けて新しいクエリで **`supabase_billing_setup.sql`** の中身を**全文コピペ**して **Run**。
   - `subscriptions`（本人のみ SELECT 可・書き込みは service role のみ）、`ai_usage`（日次回数）、
     `increment_ai_usage` / `is_paid_user` 関数が作られます。
   - さらに `dayflow_data` の INSERT/UPDATE が「有効な契約があるユーザー」に限定されます（直叩き対策）。
4. **Table Editor** で `dayflow_data` / `subscriptions` / `ai_usage` の3テーブルが見えれば成功。

> ⚠️ `supabase_billing_setup.sql` は `supabase_setup.sql` の後に実行してください（`dayflow_data` のポリシーを差し替えるため）。

---

## 3. 認証（メール OTP）を有効化

1. 左メニュー **Authentication → Sign In / Providers**。
2. **Email** を有効化（Enable）。
   - このアプリは**メールに届く6桁のOTPコード**でログインします（パスワード不要）。
3. 不特定多数に公開するなら **独自SMTP を強く推奨**（**Authentication → SMTP Settings**）。
   - Supabase 標準のメール送信は**時間あたりの送信数制限が厳しく**、利用者が増えると OTP が届かなくなります。
   - SendGrid / Resend / Amazon SES 等の SMTP 情報（ホスト・ポート・ユーザー・パスワード・送信元アドレス）を設定。
4. （任意）**Authentication → URL Configuration** の Site URL を、後で決める本番オリジンに合わせておくと安全です。

---

## 4. index.html にプロジェクト URL とキーを設定

`index.html` の先頭付近（`5938` 行目あたり）の定数を、**手順1でメモした自分の値**に書き換えます。

```js
const SUPA_URL = "https://<project-ref>.supabase.co";   // ← 自分の Project URL
const SUPA_KEY = "eyJ...";                                // ← 自分の anon public キー
```

- `SUPA_KEY` は **anon（公開）キー**です。クライアントに埋め込んで問題ありません（RLS で保護されている）。
  **service_role キーは絶対にここへ入れない**でください。
- この2つを差し替えれば、ログインとローカル動作までは確認できます（課金・AI はこの後の手順で有効化）。

---

## 5. Stripe で Price を4つ作成

> まずは画面右上のトグルが **Test mode（テストモード）**になっていることを確認して作業します。

1. https://stripe.com にサインアップ／ログイン。
2. **商品カタログ（Product catalog）→ 商品を追加** で**商品を2つ**作り、それぞれに**Price を2つ**ぶら下げます。
   - 商品「**DayFlow スタンダード**」
     - 定期（recurring）**¥600 / 月**
     - 定期 **¥6,000 / 年**
   - 商品「**DayFlow プレミアム**」
     - 定期 **¥1,000 / 月**
     - 定期 **¥10,000 / 年**
   - 通貨は **JPY**、課金タイプは **定期的（Recurring）** を選びます。
3. 作成した**4つの Price ID**（`price_...`）を控えます。あとで secrets に入れます:

   | 環境変数 | 対応する Price |
   |---|---|
   | `STRIPE_PRICE_STANDARD_MONTHLY` | スタンダード ¥600/月 |
   | `STRIPE_PRICE_STANDARD_YEARLY`  | スタンダード ¥6,000/年 |
   | `STRIPE_PRICE_PREMIUM_MONTHLY`  | プレミアム ¥1,000/月 |
   | `STRIPE_PRICE_PREMIUM_YEARLY`   | プレミアム ¥10,000/年 |

> Price ID は商品ページの各 Price 行、または Price 詳細の「API ID」からコピーできます。
> 価格は後から変えられないため、間違えたら新しい Price を作り直してください。

---

## 6. Customer Portal を有効化

解約・支払い方法変更・プラン変更は、Stripe の **Customer Portal** で行います。

1. **設定（Settings）→ Billing → カスタマーポータル（Customer Portal）**。
2. 次を**許可（オン）**にする:
   - サブスクリプションのキャンセル
   - 支払い方法の更新
   - プランの変更（Switch plans）
3. 「プランの変更」を許可する対象に、**手順5で作った4つの Price をすべて追加**します。
   - ここに入れ忘れると、ユーザーがポータルでプラン変更できません。
4. **保存**。

---

## 7. Webhook を登録

Stripe の契約状態を Supabase に反映するための Webhook を登録します。

1. **開発者（Developers）→ Webhook → エンドポイントを追加**。
2. **エンドポイント URL**:
   ```
   https://<project-ref>.supabase.co/functions/v1/stripe-webhook
   ```
   `<project-ref>` は手順1の値に置き換え。
3. **送信するイベント**に次の3つを選択:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. 追加後に表示される **署名シークレット（`whsec_...`）**を控えます → `STRIPE_WEBHOOK_SECRET` に使用。

> ℹ️ Stripe からの呼び出しには Supabase の JWT が付かないため、`stripe-webhook` 関数は
> 後の手順で **`--no-verify-jwt`** を付けてデプロイします（手順 8-4）。

---

## 8. Anthropic の API キーを発行

1. https://console.anthropic.com にログイン。
2. **API Keys** で新しいキーを作成し、`sk-ant-...` を控えます → `ANTHROPIC_API_KEY` に使用。
3. モデルは既定で **`claude-opus-4-8`**（精度優先）。コストを抑えたい場合のみ
   `AI_TOC_MODEL=claude-haiku-4-5` に切り替え可能です。
4. 乱用対策として、1ユーザーあたり日次 `AI_DAILY_LIMIT` 回（既定 **20**）まで実行できます。

> API キーはすべて Supabase の secrets（サーバー側）にのみ保存され、クライアントには一切露出しません。

---

## 9. Edge Functions をデプロイ

ここで初めてターミナル作業をします。リポジトリのルートで実行します。

### 9-1. CLI でログイン＆プロジェクトをリンク

```sh
supabase login
supabase link --project-ref <project-ref>
```

### 9-2. secrets を設定

`.env.example` をコピーして値を埋めます（**`.env` は絶対にコミットしない**）。

```sh
cp .env.example .env
```

`.env` を編集し、これまで控えた値を入れます:

```dotenv
# --- Stripe ---
STRIPE_SECRET_KEY=sk_test_xxx          # 開発者 > APIキー（テストは sk_test_）
STRIPE_WEBHOOK_SECRET=whsec_xxx        # 手順7の署名シークレット
STRIPE_PRICE_STANDARD_MONTHLY=price_xxx
STRIPE_PRICE_STANDARD_YEARLY=price_xxx
STRIPE_PRICE_PREMIUM_MONTHLY=price_xxx
STRIPE_PRICE_PREMIUM_YEARLY=price_xxx

# --- Anthropic ---
ANTHROPIC_API_KEY=sk-ant-xxx
AI_TOC_MODEL=claude-opus-4-8
AI_DAILY_LIMIT=20

# --- CORS / リダイレクト先の制限 ---
# 開発中は * のままでOK。本番では手順10で自分のオリジンに絞る。
ALLOWED_ORIGIN=*
```

反映:

```sh
supabase secrets set --env-file .env
```

> `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` は Edge Functions に
> **自動で渡される**ため、`.env` に書く必要はありません。

### 9-3. 関数を4つデプロイ

```sh
supabase functions deploy create-checkout-session
supabase functions deploy create-portal-session
supabase functions deploy ai-toc-import
# webhook だけは JWT 検証を外す（Stripe の呼び出しに Supabase JWT が付かないため）
supabase functions deploy stripe-webhook --no-verify-jwt
```

> ⚠️ `stripe-webhook` の `--no-verify-jwt` は**必須**です。付け忘れると、Stripe からの
> Webhook が 401 で弾かれ、課金しても `subscriptions` に反映されません。

### 9-4. デプロイ確認

- Supabase ダッシュボード **Edge Functions** に4つの関数が並んでいればOK。
- 各関数の **Logs** タブで、後の動作確認時にエラーが出ていないか追えます。

---

## 10. アプリを公開（静的ホスティング）

DayFlow は**ビルド不要のシングルファイル PWA**です。次の3点をホスティングに置くだけで動きます。

```
index.html
icon.png.PNG
templates/        （フォルダごと）
```

- **GitHub Pages**: リポジトリ Settings → Pages で公開ブランチ／ディレクトリを指定。
- **Netlify / Vercel**: リポジトリを連携し、ビルドコマンド無し・公開ディレクトリをルートに。

公開できたら**本番オリジン（例: `https://your-app.example.com`）が確定**します。

### ALLOWED_ORIGIN を本番オリジンに絞る（重要）

本番では `.env` の `ALLOWED_ORIGIN` を自分のオリジンに変更し、再設定します:

```dotenv
ALLOWED_ORIGIN=https://your-app.example.com
```

```sh
supabase secrets set --env-file .env
```

- これは **CORS** と **Checkout/Portal の戻り先 URL の制限**（オープンリダイレクト対策）に使われます。
- 末尾スラッシュやパスは含めず、**オリジン（scheme + host）だけ**を指定してください。
- `ALLOWED_ORIGIN` を変えても関数の再デプロイは不要です（secrets は即時反映）。

> 手順4の `SUPA_URL` / `SUPA_KEY` も、公開する `index.html` に反映されているか最終確認を。

---

## 11. 動作確認（テストモード）

Stripe がテストモードのまま、公開URL（またはローカル）で一通り確認します。

1. アプリにアクセスし、**メール OTP でログイン**（届いた6桁コードを入力）。
2. 設定の **「プランを見る」→ スタンダード**を選択 → Checkout へ。
3. Stripe の**テストカード `4242 4242 4242 4242`**（有効期限は未来の任意日、CVC 任意、郵便番号任意）で決済を完了。
4. アプリに戻ると**数秒で Webhook が `subscriptions` に反映**され、**クラウド同期が有効化**されます。
   - 反映されない場合は手順12のトラブルシュートへ。
5. **プレミアム**に加入すると、科目画面の **「📷 目次を撮って取り込む」**が使えるようになります。
   - 目次写真 → プレビューで編集 → 取り込み。登録された問題は既存の間隔反復でそのまま動きます。
6. **解約**は設定の **「プランを管理」（Customer Portal）**から。
   - 期間満了後は同期と AI が無効化されますが、**ローカルデータ（localStorage）は無傷**で使い続けられます。

### 確認のポイント

- `subscriptions` テーブル（Table Editor）に自分の行ができ、`status=active`、`plan` が正しいか。
- 未課金の別アカウントで Edge Function を直叩きすると **403/401** になる（サーバー側ゲートが効いている）。

---

## 12. トラブルシュート

| 症状 | 主な原因 | 対処 |
|---|---|---|
| 課金しても同期が有効にならない | Webhook が届いていない／`--no-verify-jwt` 付け忘れ | Stripe の Webhook ログでステータス確認。`stripe-webhook` を `--no-verify-jwt` 付きで再デプロイ |
| Webhook が 401 | `stripe-webhook` を JWT 検証ありでデプロイした | `supabase functions deploy stripe-webhook --no-verify-jwt` |
| Webhook が 400（署名エラー） | `STRIPE_WEBHOOK_SECRET` 不一致 | 該当エンドポイントの `whsec_...` を再取得して secrets を更新 |
| Checkout で「プランの指定が正しくありません」 | `STRIPE_PRICE_*` の値ミス | 4つの Price ID を再確認して secrets 再設定 |
| Checkout/Portal で「returnUrl が正しくありません」 | `ALLOWED_ORIGIN` とアプリのオリジン不一致 | `ALLOWED_ORIGIN` を実際の公開オリジンに合わせる |
| ログインメール（OTP）が届かない | Supabase 標準メールのレート制限 | 独自 SMTP を設定（手順3） |
| AI目次取り込みが 403 | プレミアム未加入／プラン判定が未反映 | プレミアム加入と `subscriptions.status` を確認 |
| AI が 429 | 日次上限到達 | `AI_DAILY_LIMIT` を調整、または翌日 |
| 関数のエラー詳細を見たい | — | Supabase **Edge Functions → 該当関数 → Logs** |

---

## 13. 本番モードへの切り替え

テストモードで問題なく動いたら、本番へ切り替えます。

1. Stripe ダッシュボードを **本番モード（Live mode）**に切り替える。
2. **本番モードで Price 4つを作り直す**（テストの Price ID は本番では使えません）→ 手順5・6を本番モードで再実施。
3. **本番の Webhook を登録**（手順7を本番モードで）→ 新しい `whsec_...` を取得。
4. secrets を本番値に更新:
   - `STRIPE_SECRET_KEY` を **`sk_live_...`** に
   - `STRIPE_WEBHOOK_SECRET` を本番 Webhook の `whsec_...` に
   - `STRIPE_PRICE_*` ×4 を**本番の Price ID**に
   ```sh
   supabase secrets set --env-file .env
   ```
5. **Customer Portal を本番モードでも有効化**し、本番 Price 4つをプラン変更対象に追加（手順6）。
6. `ALLOWED_ORIGIN` が本番オリジンになっていることを確認。
7. 本番モードで**実カードによる少額テスト**を1回行い、課金 → 同期反映 → 解約までを確認。

> Edge Functions の**コードは共通**なので、本番化で再デプロイは原則不要です（secrets の差し替えだけ）。
> ただし `--no-verify-jwt` は再デプロイ時に**毎回付け直す**必要がある点に注意。

---

## 14. 公開前 最終チェックリスト

- [ ] `supabase_setup.sql` → `supabase_billing_setup.sql` の順で実行済み
- [ ] Authentication で Email(OTP) 有効化、公開向けは独自 SMTP 設定済み
- [ ] `index.html` の `SUPA_URL` / `SUPA_KEY`（anon）を自分の値に変更済み（service_role は入れていない）
- [ ] Stripe で Price 4つ作成し、ID を控えた
- [ ] Customer Portal を有効化し、4つの Price をプラン変更対象に追加
- [ ] Webhook を登録（3イベント）し、`whsec_...` を取得
- [ ] Anthropic API キーを取得
- [ ] secrets を `supabase secrets set --env-file .env` で設定
- [ ] 関数4つをデプロイ（`stripe-webhook` のみ `--no-verify-jwt`）
- [ ] 静的ホスティングに `index.html` / `icon.png.PNG` / `templates/` を配置
- [ ] `ALLOWED_ORIGIN` を本番オリジンに絞った
- [ ] テストカード `4242…` で課金 → 同期 → AI → 解約まで確認
- [ ] （本番化）`sk_live_` ＋本番 Webhook ＋本番 Price に切り替え、実カードで最終確認
- [ ] `.env` をコミットしていない（`.gitignore` 確認）

---

これで、無料ユーザーはローカルのみで利用、スタンダード以上はクラウド同期、プレミアムは AI目次取り込みまで、
一通りの課金体験が本番で動く状態になります。
