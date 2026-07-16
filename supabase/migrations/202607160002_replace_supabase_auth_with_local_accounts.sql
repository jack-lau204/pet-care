-- Compatibility migration for environments that applied the earlier Supabase Auth version.
-- Fresh environments already receive this structure from 202607160001.

alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists password_hash text;

drop trigger if exists auth_user_create_profile on auth.users;
drop function if exists public.create_profile_for_auth_user();

create unique index if not exists profiles_email_lower_uidx
  on public.profiles (lower(email)) where email is not null;

create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists user_sessions_user_idx on public.user_sessions (user_id, expires_at desc);
create index if not exists user_sessions_expiry_idx on public.user_sessions (expires_at);

alter table public.user_sessions enable row level security;
revoke all on table public.user_sessions from anon, authenticated;

comment on table public.user_sessions is 'Hashed opaque login sessions managed by the Express application';
