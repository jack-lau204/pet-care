alter table public.care_comments
  add column if not exists client_request_id uuid;

create unique index if not exists care_comments_client_request_uidx
  on public.care_comments (client_request_id);

comment on column public.care_comments.client_request_id is
  'Client-generated idempotency key used to prevent duplicate comment submissions';
