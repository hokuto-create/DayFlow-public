-- ============================================================
-- DayFlow 課金（サブスクリプション）＋ AI目次取り込み セットアップ
-- supabase_setup.sql を実行した後に、このファイル全体を
-- SupabaseダッシュボードのSQL Editorに貼り付けて実行してください。
--
-- 【このSQLの後に必要な作業】
-- 1. Stripe で Product/Price を作成し、Edge Functions の secrets を設定
-- 2. Edge Functions（create-checkout-session / create-portal-session /
--    stripe-webhook / ai-toc-import）をデプロイ
-- 詳細は README.md の「課金＋AI機能のセットアップ」を参照。
-- ============================================================

-- ── ユーザーごとの契約状態 ──
-- 書き込みは Stripe webhook（service role）のみ。クライアントは自分の行の
-- SELECT だけができる。plan/status/current_period_end がサーバー側の正。
create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  plan                   text not null check (plan in ('standard', 'premium')),
  status                 text not null,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

revoke all on table public.subscriptions from anon;
revoke all on table public.subscriptions from authenticated;
grant select on table public.subscriptions to authenticated;

-- 本人のみ SELECT 可。INSERT/UPDATE/DELETE のポリシーは意図的に作らない
-- （RLSにより authenticated からの書き込みは全拒否＝service role のみ書き込み可）。
create policy "Users can read own subscription"
  on public.subscriptions for select
  to authenticated
  using (auth.uid() = user_id);

-- ── AI目次取り込みの日次利用回数（乱用対策） ──
-- クライアントからは一切アクセスさせない（Edge Function が service role で操作）。
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;
revoke all on table public.ai_usage from anon;
revoke all on table public.ai_usage from authenticated;

-- 利用回数を +1 し、上限（p_limit）以内なら true を返す。
-- Edge Function `ai-toc-import` から service role で呼び出す。
create or replace function public.increment_ai_usage(p_user_id uuid, p_limit int)
returns boolean
language plpgsql
as $$
declare
  new_count int;
begin
  insert into public.ai_usage (user_id, day, count)
  values (p_user_id, current_date, 1)
  on conflict (user_id, day)
  do update set count = public.ai_usage.count + 1
  returning count into new_count;
  return new_count <= p_limit;
end;
$$;

revoke execute on function public.increment_ai_usage(uuid, int) from public;
revoke execute on function public.increment_ai_usage(uuid, int) from anon;
revoke execute on function public.increment_ai_usage(uuid, int) from authenticated;

-- ── クラウド同期の書き込みもサーバー側で課金を強制する ──
-- クライアントの同期ゲートはUX目的なので、dayflow_data への INSERT/UPDATE を
-- 「有効なスタンダード以上の契約があるユーザー」に限定する（直叩き対策）。
-- SELECT / DELETE は本人なら引き続き可能（期限切れでも自分のクラウドデータは
-- 読める＝データを人質に取らない）。

-- 呼び出しユーザーが有効な契約を持つか（Edge Function / クライアントの
-- resolvePlan と同じ規則。webhook 遅延に備えて1日の猶予つき）
create or replace function public.is_paid_user()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.user_id = auth.uid()
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null
           or s.current_period_end + interval '1 day' > now())
  );
$$;

drop policy if exists "Users can insert own data" on public.dayflow_data;
drop policy if exists "Users can update own data" on public.dayflow_data;

create policy "Paid users can insert own data"
  on public.dayflow_data for insert
  to authenticated
  with check (auth.uid() = user_id and public.is_paid_user());

create policy "Paid users can update own data"
  on public.dayflow_data for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and public.is_paid_user());
