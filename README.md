# DayFlow

学習計画・間隔反復・振り返りを1つにまとめた、ビルド不要のシングルファイル学習プランナーPWAです（`index.html` のみで動作）。

## セットアップ

### 1. Supabase（クラウド同期用）

1. [Supabase](https://supabase.com) でプロジェクトを作成
2. SQL Editor に `supabase_setup.sql` の内容を貼り付けて実行
   - `dayflow_data` テーブルの作成、RLS有効化、「各ユーザーは自分のデータのみ読み書き可能」のポリシー設定が行われます
3. Authentication > Sign In / Providers で **Email** を有効化
   - ログインはメールに届く6桁のOTPコードで行います（パスワード不要）
   - 不特定多数に公開する場合は、独自SMTPの設定を強く推奨します（Supabase標準のメール送信は時間あたりの送信数制限が厳しいため）
4. `index.html` 内の `SUPA_URL` / `SUPA_KEY` を自分のプロジェクトの Project URL / anon key に書き換え

### 2. デプロイ

静的ファイルのみなので、GitHub Pages・Netlify・Vercel など任意の静的ホスティングに `index.html` と `icon.png.PNG` を配置するだけで動きます。

## クラウド同期の仕組み

- 設定画面からメールアドレスでログイン（OTP認証）すると、データがSupabaseに自動同期されます
- データはログインユーザー本人のみが読み書きできます（Row Level Security で保護）
- ログインしない場合は端末内（localStorage）のみで動作します
