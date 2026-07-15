create extension if not exists pgcrypto with schema extensions;

create table if not exists public.grooming_appointments (
  id uuid primary key default gen_random_uuid(),
  reference_code text not null unique default (
    'GH-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  client_request_id uuid not null unique,
  manager_token_hash text not null check (manager_token_hash ~ '^[a-f0-9]{64}$'),
  pet_code text not null check (pet_code in ('doubao', 'naitang')),
  pet_name text not null check (char_length(pet_name) between 1 and 50),
  pet_species text not null check (pet_species in ('dog', 'cat')),
  service_code text not null check (service_code in ('basic_wash', 'deep_care', 'wash_and_style')),
  scheduled_start timestamptz not null,
  customer_name text not null check (char_length(customer_name) between 1 and 50),
  customer_phone text not null check (char_length(customer_phone) between 7 and 20),
  notes text not null default '' check (char_length(notes) <= 500),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint grooming_appointments_cancel_state_check check (
    (status = 'confirmed' and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null)
  )
);

create unique index if not exists grooming_appointments_active_slot_uidx
  on public.grooming_appointments (scheduled_start)
  where status = 'confirmed';

create index if not exists grooming_appointments_manager_token_idx
  on public.grooming_appointments (manager_token_hash, scheduled_start);

create or replace function public.set_grooming_appointments_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists grooming_appointments_set_updated_at on public.grooming_appointments;
create trigger grooming_appointments_set_updated_at
before update on public.grooming_appointments
for each row execute function public.set_grooming_appointments_updated_at();

alter table public.grooming_appointments enable row level security;
revoke all on table public.grooming_appointments from anon, authenticated;

comment on table public.grooming_appointments is '宠物洗护预约业务表；仅由服务端 PostgreSQL session pool 访问';
