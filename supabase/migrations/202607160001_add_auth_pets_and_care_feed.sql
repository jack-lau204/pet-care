create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  password_hash text not null check (char_length(password_hash) between 80 and 300),
  display_name text not null check (char_length(display_name) between 1 and 50),
  role text not null default 'customer' check (role in ('customer', 'staff')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_email_lower_uidx on public.profiles (lower(email));

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

create table if not exists public.pets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  species text not null check (species in ('dog', 'cat', 'other')),
  breed text not null default '' check (char_length(breed) <= 80),
  sex text not null default 'unknown' check (sex in ('male', 'female', 'unknown')),
  birth_date date,
  weight_kg numeric(6,2) check (weight_kg is null or weight_kg > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.grooming_appointments
  add column if not exists owner_id uuid references public.profiles(id) on delete restrict,
  add column if not exists pet_id uuid references public.pets(id) on delete restrict;

alter table public.grooming_appointments alter column manager_token_hash drop not null;

alter table public.grooming_appointments
  drop constraint if exists grooming_appointments_pet_code_check;
alter table public.grooming_appointments
  add constraint grooming_appointments_pet_code_check check (char_length(pet_code) between 1 and 100);
alter table public.grooming_appointments
  drop constraint if exists grooming_appointments_pet_species_check;
alter table public.grooming_appointments
  add constraint grooming_appointments_pet_species_check check (pet_species in ('dog', 'cat', 'other'));

alter table public.grooming_appointments
  drop constraint if exists grooming_appointments_identity_check;
alter table public.grooming_appointments
  add constraint grooming_appointments_identity_check check (
    (owner_id is not null and pet_id is not null)
    or (owner_id is null and pet_id is null and manager_token_hash is not null)
  );

create table if not exists public.care_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete restrict,
  phase text not null check (phase in ('before', 'after')),
  body text not null default '' check (char_length(body) <= 2000),
  status text not null default 'published' check (status in ('published', 'hidden')),
  moderation_reason text not null default '' check (char_length(moderation_reason) <= 300),
  moderated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.care_post_images (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.care_posts(id) on delete cascade,
  object_path text not null unique check (char_length(object_path) between 1 and 500),
  sort_order smallint not null check (sort_order between 0 and 5),
  mime_type text not null default 'image/webp',
  byte_size integer not null check (byte_size > 0 and byte_size <= 8388608),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  created_at timestamptz not null default now(),
  unique (post_id, sort_order)
);

create table if not exists public.care_comments (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid not null unique,
  post_id uuid not null references public.care_posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  status text not null default 'published' check (status in ('published', 'hidden')),
  moderation_reason text not null default '' check (char_length(moderation_reason) <= 300),
  moderated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pets_owner_idx on public.pets (owner_id, created_at);
create index if not exists grooming_appointments_owner_idx
  on public.grooming_appointments (owner_id, scheduled_start);
create index if not exists care_posts_public_feed_idx
  on public.care_posts (created_at desc, id desc) where status = 'published';
create index if not exists care_posts_pet_idx on public.care_posts (pet_id, created_at desc);
create index if not exists care_comments_post_idx
  on public.care_comments (post_id, created_at asc, id asc);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_grooming_appointments_updated_at();
drop trigger if exists pets_set_updated_at on public.pets;
create trigger pets_set_updated_at before update on public.pets
for each row execute function public.set_grooming_appointments_updated_at();
drop trigger if exists care_posts_set_updated_at on public.care_posts;
create trigger care_posts_set_updated_at before update on public.care_posts
for each row execute function public.set_grooming_appointments_updated_at();
drop trigger if exists care_comments_set_updated_at on public.care_comments;
create trigger care_comments_set_updated_at before update on public.care_comments
for each row execute function public.set_grooming_appointments_updated_at();

alter table public.profiles enable row level security;
alter table public.user_sessions enable row level security;
alter table public.pets enable row level security;
alter table public.care_posts enable row level security;
alter table public.care_post_images enable row level security;
alter table public.care_comments enable row level security;
revoke all on table public.profiles, public.user_sessions, public.pets, public.care_posts,
  public.care_post_images, public.care_comments from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'care-dynamics',
  'care-dynamics',
  true,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on table public.profiles is 'Application-managed user accounts and roles';
comment on table public.user_sessions is 'Hashed opaque login sessions managed by the Express application';
comment on table public.pets is 'Customer-owned pet profiles';
comment on table public.care_posts is 'Public before-and-after care feed with moderation support';
comment on table public.care_comments is 'Comments on pet care posts';
