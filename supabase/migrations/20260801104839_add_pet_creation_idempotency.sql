-- Generated with Supabase CLI 2.111.0.
alter table public.pets
  add column if not exists client_request_id uuid;

create unique index if not exists pets_client_request_id_uidx
  on public.pets (client_request_id)
  where client_request_id is not null;

comment on column public.pets.client_request_id is 'Idempotency key for pet creation requests';
