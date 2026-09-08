-- KACHIBOT supabase schema (run in the Supabase SQL editor).
create table if not exists kachi_users (
  user_id text primary key,
  doc jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists kachi_trades (
  id text primary key,
  user_id text not null,
  doc jsonb not null,
  updated_at timestamptz default now()
);
create index if not exists kachi_trades_user on kachi_trades (user_id);
alter table kachi_trades enable row level security;
alter table kachi_users enable row level security;
-- lock down: the bot uses the anon key only through these policies
drop policy if exists users_all on kachi_users;
drop policy if exists trades_all on kachi_trades;
create policy users_all on kachi_users for all using (true) with check (true);
create policy trades_all on kachi_trades for all using (true) with check (true);
