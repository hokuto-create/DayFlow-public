-- ============================================================
-- DayFlow 公開版 Supabase セットアップ
-- SupabaseダッシュボードのSQL Editorにこのファイル全体を貼り付けて実行してください。
--
-- 【SQL実行後に必要なダッシュボード設定】
-- Authentication > Sign In / Providers で「Email」を有効にしてください。
-- アプリはメールに届く6桁のOTPコードでログインします（パスワード不要）。
-- 不特定多数に公開する場合、Supabase標準のメール送信は時間あたりの
-- 送信数制限が厳しいため、独自SMTP（Authentication > SMTP Settings）の
-- 設定を強く推奨します。
-- ============================================================

-- ユーザーごとのアプリデータ（1ユーザー1行、アプリの全状態をJSONで保持）
create table if not exists public.dayflow_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  user_email text,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Row Level Security ──
-- RLSを有効化。ポリシーに合致しないアクセスはすべて拒否される。
alter table public.dayflow_data enable row level security;

-- 念のため匿名ロールからの直接アクセス権限も剥奪
-- （RLSポリシーをauthenticatedのみに限定しているため二重の防御）
revoke all on table public.dayflow_data from anon;

-- ログイン済みユーザーは「自分の行（auth.uid() = user_id）」のみ読み書き可能
create policy "Users can read own data"
  on public.dayflow_data for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own data"
  on public.dayflow_data for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own data"
  on public.dayflow_data for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own data"
  on public.dayflow_data for delete
  to authenticated
  using (auth.uid() = user_id);
